/**
 * Nariya — Page Call Handler
 * Requests coming from the in-page interceptor via bridge.js:
 * proxying fetch/XHR through the service worker (streamed over a runtime
 * port) and loading cloud mock bodies.
 */

import { getAllRules, getSettings } from '../../core/storage/storage.js';
import { isBypassOrigin } from '../../core/cors-bypass.js';
import { matchesUrl } from '../../core/url-match.js';

export const PROXY_PORT_NAME = 'nariya-proxy';

// Time allowed until response headers arrive; the body may stream for longer
const PROXY_HEADERS_TIMEOUT_MS = 60000;

// Session rules that give proxied requests the page's Origin instead of
// chrome-extension://<id>, which many backends reject. One rule per API host.
const ORIGIN_RULE_ID_BASE = 910000;
const ORIGIN_RULE_ID_MAX = 910999;
const originRules = new Map(); // host -> { id, origin }
let originRulesChain = null;

// Per API host: which Origin the rule currently carries, how many requests
// are waiting for their response headers with it, and who is queued for a
// different Origin. Requests from two dev origins to the same host take
// turns, so each one is sent with its own Origin.
const originGates = new Map(); // host -> { origin, inFlight, queue: [{ origin, resolve }] }

const MOCK_CACHE_TTL_MS = 5 * 60 * 1000;
const mockBodyCache = new Map();

function bufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
}

function base64ToBytes(b64) {
    const bin = atob(b64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

// ─── Origin rewriting ────────────────────────────────────────────

async function loadOriginRules() {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    for (const r of rules) {
        if (r.id < ORIGIN_RULE_ID_BASE || r.id > ORIGIN_RULE_ID_MAX) continue;
        originRules.set(r.condition.requestDomains[0], { id: r.id, origin: r.action.requestHeaders[0].value });
    }
}

/**
 * Make the service worker's requests to `host` carry `origin` as Origin
 */
function setProxyOrigin(host, origin) {
    originRulesChain = (originRulesChain || loadOriginRules()).then(async () => {
        const current = originRules.get(host);
        if (current?.origin === origin) return;
        const used = new Set([...originRules.values()].map(r => r.id));
        let id = current?.id;
        for (let i = ORIGIN_RULE_ID_BASE; !id && i <= ORIGIN_RULE_ID_MAX; i++) if (!used.has(i)) id = i;
        if (!id) return;
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [id],
            addRules: [{
                id,
                priority: 1,
                action: {
                    type: 'modifyHeaders',
                    requestHeaders: [{ header: 'Origin', operation: 'set', value: origin }]
                },
                condition: {
                    requestDomains: [host],
                    initiatorDomains: [chrome.runtime.id],
                    tabIds: [chrome.tabs.TAB_ID_NONE],
                    resourceTypes: ['xmlhttprequest']
                }
            }]
        });
        originRules.set(host, { id, origin });
    }).catch((e) => console.warn('[Nariya] Could not set proxy Origin rule:', e));
    return originRulesChain;
}

function drainGate(host, gate) {
    while (gate.queue.length > 0) {
        const next = gate.queue[0];
        if (gate.inFlight > 0 && next.origin !== gate.origin) break;
        gate.queue.shift();
        gate.inFlight++;
        gate.origin = next.origin;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            gate.inFlight--;
            drainGate(host, gate);
        };
        next.resolve(setProxyOrigin(host, next.origin).then(() => release));
    }
}

/**
 * Wait until requests to `host` can be sent with `origin`.
 * @returns {Promise<Function>} release — call once response headers arrive
 */
export function acquireOrigin(host, origin) {
    let gate = originGates.get(host);
    if (!gate) {
        gate = { origin: null, inFlight: 0, queue: [] };
        originGates.set(host, gate);
    }
    return new Promise((resolve) => {
        gate.queue.push({ origin, resolve });
        drainGate(host, gate);
    });
}

// ─── Proxy ───────────────────────────────────────────────────────

function senderOrigin(sender) {
    if (sender?.origin && sender.origin !== 'null') return sender.origin;
    try { return new URL(sender.url).origin; } catch { return null; }
}

/**
 * Only pages on the CORS bypass sites, and only URLs matched by an
 * enabled proxy rule, may be proxied.
 * @returns {Promise<{ ok: true, origin, target } | { ok: false, error }>}
 */
async function checkProxyRequest(req, sender) {
    const settings = await getSettings();
    if (!settings.globalEnabled) return { ok: false, error: 'Nariya is disabled' };

    const origin = senderOrigin(sender);
    if (!origin || !(await isBypassOrigin(origin, settings))) {
        return { ok: false, error: `${origin} is not in the CORS bypass sites list` };
    }

    let target;
    try { target = new URL(req.url); } catch { return { ok: false, error: 'Invalid URL' }; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return { ok: false, error: 'Only http(s) URLs can be proxied' };
    }

    const rules = await getAllRules();
    if (!rules.some(r => r.enabled && r.type === 'proxy' && matchesUrl(req.url, r.urlFilter))) {
        return { ok: false, error: 'No enabled proxy rule matches this URL' };
    }
    return { ok: true, origin, target };
}

/**
 * Serve one proxied request over a runtime port opened by bridge.js.
 * The page's request is performed here, where CORS does not apply
 * (host_permissions), so no preflight is sent. The response is streamed
 * back: { type: 'head' }, then { type: 'chunk' }..., then { type: 'end' }
 * or { type: 'error' }. Disconnecting the port aborts the request.
 *
 * Request message: { type: 'start', request: { url, method, headers: [[k, v]],
 *   bodyBase64?, credentials } }
 * @param {chrome.runtime.Port} port
 */
export function handleProxyPort(port) {
    const controller = new AbortController();
    let finished = false;

    const post = (msg) => {
        try { port.postMessage(msg); } catch { finished = true; controller.abort(); }
    };
    const finish = (msg) => {
        if (finished) return;
        finished = true;
        post(msg);
        try { port.disconnect(); } catch { }
    };

    port.onDisconnect.addListener(() => {
        if (!finished) {
            finished = true;
            controller.abort();
        }
    });

    port.onMessage.addListener(async (msg) => {
        if (msg?.type !== 'start') return;
        const req = msg.request || {};

        const check = await checkProxyRequest(req, port.sender);
        if (!check.ok) return finish({ type: 'error', error: check.error });

        const headers = new Headers();
        for (const [name, value] of req.headers || []) {
            try { headers.append(name, value); } catch { /* forbidden or invalid header */ }
        }
        const method = String(req.method || 'GET').toUpperCase();

        const release = await acquireOrigin(check.target.hostname, check.origin);
        if (finished) return release();

        const headersTimer = setTimeout(() => controller.abort(new Error('Timed out waiting for response headers')), PROXY_HEADERS_TIMEOUT_MS);
        let res;
        try {
            res = await fetch(req.url, {
                method,
                headers,
                body: req.bodyBase64 && method !== 'GET' && method !== 'HEAD' ? base64ToBytes(req.bodyBase64) : undefined,
                credentials: req.credentials === 'include' ? 'include' : 'omit',
                redirect: 'follow',
                cache: 'no-store',
                signal: controller.signal
            });
        } catch (e) {
            return finish({ type: 'error', error: controller.signal.reason?.message || e.message || 'Network error' });
        } finally {
            clearTimeout(headersTimer);
            release();
        }

        post({
            type: 'head',
            head: {
                status: res.status,
                statusText: res.statusText,
                headers: [...res.headers],
                url: res.url,
                redirected: res.redirected
            }
        });

        try {
            if (res.body) {
                const reader = res.body.getReader();
                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    post({ type: 'chunk', data: bufferToBase64(value) });
                }
            }
            finish({ type: 'end' });
        } catch (e) {
            finish({ type: 'error', error: e.message || 'Stream error' });
        }
    });
}

// ─── Cloud mocks ─────────────────────────────────────────────────

/**
 * Load the body of a mock stored in cloud object storage
 * @param {{ ruleId: string }} payload
 */
export async function resolveMockBody({ ruleId }) {
    const rules = await getAllRules();
    const rule = rules.find(r => r.id === ruleId);
    const key = rule?.config?.cloudKey;
    if (!key) return { ok: false, error: 'Rule has no cloud key' };

    const cached = mockBodyCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.result;

    const { sessionToken } = await chrome.storage.local.get('sessionToken');
    if (!sessionToken) return { ok: false, error: 'Sign in to Nariya Cloud to use cloud mocks' };

    const { backendUrl } = await getSettings();
    try {
        const urlRes = await fetch(`${backendUrl}/api/mocks/url?key=${encodeURIComponent(key)}`, {
            headers: { Authorization: `Bearer ${sessionToken}` }
        });
        const urlData = await urlRes.json();
        if (!urlRes.ok || !urlData.signedUrl) throw new Error(urlData.error || `HTTP ${urlRes.status}`);

        const bodyRes = await fetch(urlData.signedUrl);
        if (!bodyRes.ok) throw new Error(`Object storage returned HTTP ${bodyRes.status}`);
        const result = {
            ok: true,
            bodyBase64: bufferToBase64(await bodyRes.arrayBuffer()),
            contentType: bodyRes.headers.get('content-type')
        };
        mockBodyCache.set(key, { result, expires: Date.now() + MOCK_CACHE_TTL_MS });
        return result;
    } catch (e) {
        return { ok: false, error: e.message };
    }
}
