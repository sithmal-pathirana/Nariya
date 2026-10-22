/**
 * Nariya — Page Call Handler
 * Requests coming from the in-page interceptor via bridge.js:
 * proxying fetch/XHR through the service worker and loading cloud mock bodies.
 */

import { getAllRules, getSettings } from '../../core/storage/storage.js';
import { isBypassOrigin } from '../../core/cors-bypass.js';
import { matchesUrl } from '../../core/url-match.js';

const PROXY_TIMEOUT_MS = 60000;

// Session rules that give proxied requests the page's Origin instead of
// chrome-extension://<id>, which many backends reject. One rule per API host.
const ORIGIN_RULE_ID_BASE = 910000;
const ORIGIN_RULE_ID_MAX = 910999;
const originRules = new Map(); // host -> { id, origin }
let originRulesChain = null;
const MOCK_CACHE_TTL_MS = 5 * 60 * 1000;
const mockBodyCache = new Map();

function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
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

async function loadOriginRules() {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    for (const r of rules) {
        if (r.id < ORIGIN_RULE_ID_BASE || r.id > ORIGIN_RULE_ID_MAX) continue;
        originRules.set(r.condition.requestDomains[0], { id: r.id, origin: r.action.requestHeaders[0].value });
    }
}

/**
 * Make the service worker's requests to `host` carry `origin` as Origin.
 * Two dev origins proxying to the same API host at the same moment share
 * the rule; the most recent one wins.
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

function senderOrigin(sender) {
    if (sender.origin && sender.origin !== 'null') return sender.origin;
    try { return new URL(sender.url).origin; } catch { return null; }
}

/**
 * Perform a page's request from the service worker, where CORS does not
 * apply (host_permissions), so no preflight is sent at all. Only allowed
 * for pages on the CORS bypass sites and URLs matched by an enabled proxy rule.
 * @param {{ url, method, headers: Array, bodyBase64?, credentials }} req
 * @param {chrome.runtime.MessageSender} sender
 */
export async function proxyFetch(req, sender) {
    const settings = await getSettings();
    if (!settings.globalEnabled) return { ok: false, error: 'Nariya is disabled' };

    const origin = senderOrigin(sender);
    if (!origin || !isBypassOrigin(origin, settings)) {
        return { ok: false, error: `${origin} is not in the CORS bypass sites list` };
    }

    let target;
    try { target = new URL(req.url); } catch { return { ok: false, error: 'Invalid URL' }; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return { ok: false, error: 'Only http(s) URLs can be proxied' };
    }

    const rules = await getAllRules();
    const rule = rules.find(r => r.enabled && r.type === 'proxy' && matchesUrl(req.url, r.urlFilter));
    if (!rule) return { ok: false, error: 'No enabled proxy rule matches this URL' };

    const headers = new Headers();
    for (const [name, value] of req.headers || []) {
        try { headers.append(name, value); } catch { /* forbidden or invalid header */ }
    }
    const method = String(req.method || 'GET').toUpperCase();

    await setProxyOrigin(target.hostname, origin);

    try {
        const res = await fetch(req.url, {
            method,
            headers,
            body: req.bodyBase64 && method !== 'GET' && method !== 'HEAD' ? base64ToBytes(req.bodyBase64) : undefined,
            credentials: req.credentials === 'include' ? 'include' : 'omit',
            redirect: 'follow',
            cache: 'no-store',
            signal: AbortSignal.timeout(PROXY_TIMEOUT_MS)
        });
        const body = await res.arrayBuffer();
        return {
            ok: true,
            response: {
                status: res.status,
                statusText: res.statusText,
                headers: [...res.headers],
                bodyBase64: bufferToBase64(body),
                url: res.url,
                redirected: res.redirected
            }
        };
    } catch (e) {
        return { ok: false, error: e.message || 'Network error' };
    }
}

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
