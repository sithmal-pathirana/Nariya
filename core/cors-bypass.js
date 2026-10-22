/**
 * Nariya — CORS Bypass
 * Makes cross-origin fetch/XHR calls work in a normal Chrome profile
 * (no --disable-web-security) for the sites the user develops on.
 *
 * Why not just `Access-Control-Allow-Origin: *`?
 *   - Chrome rejects `*` for credentialed requests (cookies, withCredentials,
 *     credentials:'include'): the exact origin plus
 *     `Access-Control-Allow-Credentials: true` is required.
 *   - `*` in Allow-Methods / Allow-Headers is also treated literally for
 *     credentialed requests, so preflights with Authorization or custom
 *     headers fail.
 *   - Overwriting the headers of every response on the web breaks apps that
 *     already send correct CORS headers (Google Chat, Gmail, ...) and lets any
 *     site read any other site's data.
 *
 * So the bypass is scoped to the *initiator*: only requests made BY pages on
 * the configured sites (default: localhost, 127.0.0.1) get their responses
 * patched, and Access-Control-Allow-Origin is set to that page's exact origin.
 * DNR cannot echo the request's Origin header, so the origin is taken from the
 * tabs the user has open (per-tab rules) and remembered per host so reloads
 * and service-worker requests are covered too.
 */

import { getSettings, getAllRules } from './storage/storage.js';

// Session rule ID range reserved for CORS rules (user rules live below this)
export const CORS_RULE_ID_BASE = 900000;
const CORS_RULE_ID_MAX = 909999;

const ORIGINS_KEY = 'nariya_cors_origins';
const LEARNED_HEADERS_KEY = 'nariya_cors_learned_headers';
const AUTO_SITES_KEY = 'nariya_cors_auto_sites';
const MAX_AUTO_SITES = 50;
const MAX_REMEMBERED_ORIGINS = 50;

export const DEFAULT_CORS_SITES = ['localhost', '127.0.0.1'];

const ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD';

// Request headers allowed on preflight. '*' covers non-credentialed requests;
// credentialed requests need explicit names, so common ones are listed and
// any others seen on preflights are learned (see learnPreflightHeaders).
const DEFAULT_ALLOW_HEADERS = [
    '*', 'authorization', 'content-type', 'accept', 'accept-language',
    'x-requested-with', 'x-api-key', 'x-auth-token', 'x-access-token',
    'x-csrf-token', 'x-xsrf-token', 'x-request-id', 'x-correlation-id',
    'x-client-id', 'x-tenant-id', 'x-user-id', 'x-device-id', 'x-app-version',
    'x-timezone', 'cache-control', 'pragma', 'if-match', 'if-none-match',
    'if-modified-since', 'range', 'baggage', 'sentry-trace', 'traceparent',
    'tracestate', 'apollo-require-preflight', 'x-apollo-operation-name'
];

const EXPOSE_HEADERS = [
    '*', 'content-length', 'content-type', 'content-disposition', 'content-range',
    'etag', 'last-modified', 'location', 'link', 'retry-after', 'authorization',
    'x-request-id', 'x-correlation-id', 'x-total-count', 'x-ratelimit-limit',
    'x-ratelimit-remaining', 'x-ratelimit-reset'
];

const RESOURCE_TYPES = ['xmlhttprequest', 'font', 'other'];

/**
 * Normalize the user's site list: accepts "localhost", "*.example.com",
 * "https://dev.example.com:8443/path" and returns bare hostnames.
 * @param {Array|string} sites
 * @returns {string[]}
 */
export function normalizeSites(sites) {
    const list = Array.isArray(sites) ? sites : String(sites || '').split(/[\s,]+/);
    const hosts = new Set();
    for (const raw of list) {
        let s = String(raw || '').trim().toLowerCase();
        if (!s) continue;
        s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
        s = s.split('/')[0];
        // Strip port, but keep IPv6 literals like [::1]
        s = s.startsWith('[') ? s.slice(0, s.indexOf(']') + 1) : s.split(':')[0];
        if (s) hosts.add(s);
    }
    return [...hosts];
}

function normalizeHeaderNames(names) {
    const list = Array.isArray(names) ? names : String(names || '').split(/[\s,]+/);
    return list.map(h => String(h).trim().toLowerCase())
        .filter(h => /^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(h));
}

/**
 * Does `host` belong to one of the configured sites (exact or subdomain)?
 */
function matchesSite(host, sites) {
    return sites.some(site => host === site || host.endsWith('.' + site));
}

/**
 * Origin of a URL if it is a web page on a bypass site, else null
 */
function bypassOrigin(url, sites) {
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return matchesSite(u.hostname, sites) ? u.origin : null;
    } catch {
        return null;
    }
}

/**
 * @param {string} origin - value for Access-Control-Allow-Origin
 * @param {Object} condition - DNR condition (resourceTypes is added)
 */
function buildRule(id, priority, origin, allowHeaders, condition) {
    return {
        id,
        priority,
        action: {
            type: 'modifyHeaders',
            responseHeaders: [
                // Must be the exact origin (never '*') so credentialed requests pass
                { header: 'Access-Control-Allow-Origin', operation: 'set', value: origin },
                { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
                // Appended so a server's own list is kept and extended
                { header: 'Access-Control-Allow-Methods', operation: 'append', value: ALLOW_METHODS },
                { header: 'Access-Control-Allow-Headers', operation: 'append', value: allowHeaders },
                { header: 'Access-Control-Expose-Headers', operation: 'append', value: EXPOSE_HEADERS.join(', ') },
                // Public page -> localhost/private IP needs this on the preflight
                { header: 'Access-Control-Allow-Private-Network', operation: 'set', value: 'true' }
            ]
        },
        condition: { ...condition, resourceTypes: RESOURCE_TYPES }
    };
}

/**
 * Build the CORS session rules.
 * - One rule per host using the most recently seen origin (covers reloads,
 *   new tabs and service-worker requests, which have no tab).
 * - One higher-priority rule per open tab, so two dev servers on the same
 *   host with different ports (localhost:3000 + localhost:5173) each get
 *   their own exact origin.
 * - For redirect-rule destinations: when a page calls another host and a
 *   rule redirects that call to a third origin, Chrome sends it with
 *   "Origin: null" and no longer counts the page as its initiator. Requests
 *   from bypass tabs to those destinations get "Access-Control-Allow-Origin:
 *   null" (lowest priority, so normal requests keep their real origin).
 * @returns {Array} DNR rules
 */
export function buildCorsRules({ sites, tabs, rememberedOrigins, allowHeaders, redirectTargets = [] }) {
    const rules = [];
    let id = CORS_RULE_ID_BASE;
    const headerValue = allowHeaders.join(', ');
    const initiator = (origin) => ({ initiatorDomains: [new URL(origin).hostname] });

    const byHost = new Map();
    for (const origin of rememberedOrigins) {
        if (bypassOrigin(origin, sites)) byHost.set(new URL(origin).hostname, origin);
    }
    for (const [, origin] of byHost) {
        rules.push(buildRule(id++, 2, origin, headerValue, initiator(origin)));
    }

    const bypassTabIds = [];
    for (const tab of tabs) {
        const origin = tab.url && bypassOrigin(tab.url, sites);
        if (!origin || tab.id === undefined || tab.id < 0) continue;
        if (id > CORS_RULE_ID_MAX) break;
        bypassTabIds.push(tab.id);
        rules.push(buildRule(id++, 3, origin, headerValue, { ...initiator(origin), tabIds: [tab.id] }));
    }

    if (bypassTabIds.length > 0 && redirectTargets.length > 0 && id <= CORS_RULE_ID_MAX) {
        rules.push(buildRule(id++, 1, 'null', headerValue, {
            requestDomains: redirectTargets,
            tabIds: bypassTabIds
        }));
    }

    return rules;
}

// ─── State helpers ───────────────────────────────────────────────

async function getRememberedOrigins() {
    const result = await chrome.storage.local.get(ORIGINS_KEY);
    return result[ORIGINS_KEY] || [];
}

/**
 * Remember an origin (most recent last) so it gets a host-wide rule
 * @returns {Promise<boolean>} true if the list changed
 */
async function rememberOrigin(origin) {
    const origins = await getRememberedOrigins();
    if (origins[origins.length - 1] === origin) return false;
    const next = origins.filter(o => o !== origin);
    next.push(origin);
    await chrome.storage.local.set({ [ORIGINS_KEY]: next.slice(-MAX_REMEMBERED_ORIGINS) });
    return true;
}

async function getLearnedHeaders() {
    const result = await chrome.storage.local.get(LEARNED_HEADERS_KEY);
    return result[LEARNED_HEADERS_KEY] || [];
}

async function getAllowHeaders(settings) {
    const learned = await getLearnedHeaders();
    return [...new Set([
        ...DEFAULT_ALLOW_HEADERS,
        ...normalizeHeaderNames(settings.corsAllowHeaders),
        ...learned
    ])];
}

/**
 * Host a URL pattern is about, e.g. "https://a.com/api/*" or "||a.com^" → "a.com"
 * (null for patterns like "*" or "/api/*" that name no host)
 */
export function patternHost(pattern) {
    let p = String(pattern || '').trim().replace(/^\|\|?/, '').replace(/^\*+/, '');
    p = p.replace(/^\^/, '').replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const host = p.split(/[/:*?^|#\\(]/)[0].toLowerCase();
    return /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host) && (host.includes('.') || host === 'localhost') ? host : null;
}

/**
 * Hosts whose calls an enabled redirect rule sends to a different origin.
 * Pages on those hosts get the CORS bypass automatically, because the
 * redirect turns their own (same-origin) API calls into cross-origin ones.
 * @param {Array} rules - user rules
 * @returns {string[]}
 */
export function redirectRuleSites(rules) {
    const hosts = new Set();
    for (const rule of rules) {
        if (!rule.enabled || rule.type !== 'redirect' || !rule.config?.redirectUrl) continue;
        const source = patternHost(rule.config.redirectMode === 'replace'
            ? rule.config.matchPattern || rule.urlFilter
            : rule.urlFilter);
        if (!source) continue;
        let dest;
        try {
            // Back-references / wildcards in the target do not affect its origin
            dest = new URL(rule.config.redirectUrl.replace(/\\\d|\$\d|\*/g, 'x'));
        } catch {
            continue;
        }
        if (dest.hostname !== source || (dest.port && dest.port !== '443' && dest.port !== '80')) {
            hosts.add(source);
        }
    }
    return [...hosts];
}

/**
 * Destination hosts of enabled redirect rules that leave the source origin
 * @param {Array} rules - user rules
 * @returns {string[]}
 */
export function redirectRuleTargets(rules) {
    const hosts = new Set();
    for (const rule of rules) {
        if (!rule.enabled || rule.type !== 'redirect' || !rule.config?.redirectUrl) continue;
        try {
            hosts.add(new URL(rule.config.redirectUrl.replace(/\\\d|\$\d|\*/g, 'x')).hostname);
        } catch { /* not an absolute URL */ }
    }
    return [...hosts];
}

async function getLearnedSites() {
    const result = await chrome.storage.local.get(AUTO_SITES_KEY);
    return result[AUTO_SITES_KEY] || [];
}

/**
 * Sites added without the user listing them: hosts of cross-origin redirect
 * rules, plus pages seen making requests that a Nariya redirect sent to
 * another origin
 */
async function getAutoSites() {
    return [...new Set([...redirectRuleSites(await getAllRules()), ...(await getLearnedSites())])];
}

/**
 * All bypass sites: the user's list plus the automatic ones
 */
async function getSites(settings) {
    return [...new Set([
        ...normalizeSites(settings.corsBypassSites ?? DEFAULT_CORS_SITES),
        ...(await getAutoSites())
    ])];
}

/**
 * All bypass sites (user list + automatic)
 */
export function getBypassSites(settings) {
    return getSites(settings);
}

let onSitesChanged = () => { };

/**
 * Called whenever automatic bypass sites change (e.g. a page was learned)
 */
export function setOnBypassSitesChanged(callback) {
    onSitesChanged = callback;
}

/**
 * Is this origin (a page) one of the bypass sites?
 */
export async function isBypassOrigin(origin, settings) {
    return !!bypassOrigin(origin, await getSites(settings));
}

// ─── Preflight log (shown in the dashboard's CORS panel) ────────

const PREFLIGHT_LOG_KEY = 'nariya_cors_preflights';
const MAX_PREFLIGHT_LOG = 50;
let preflightLog = [];
let preflightLogLoad = null;

function preflightLogReady() {
    preflightLogLoad ??= chrome.storage.session.get(PREFLIGHT_LOG_KEY)
        .then(r => { preflightLog = r[PREFLIGHT_LOG_KEY] || []; })
        .catch(() => { });
    return preflightLogLoad;
}

async function logPreflight(entry) {
    await preflightLogReady();
    preflightLog.unshift(entry);
    preflightLog = preflightLog.slice(0, MAX_PREFLIGHT_LOG);
    chrome.storage.session.set({ [PREFLIGHT_LOG_KEY]: preflightLog }).catch(() => { });
}

async function onPreflightDone(details) {
    if (details.method !== 'OPTIONS' || !details.initiator) return;
    const settings = await getSettings();
    if (!settings.globalEnabled || !settings.allowCorsBypass) return;
    if (!(await isBypassOrigin(details.initiator, settings))) return;

    const status = details.statusCode || 0;
    const ok = !details.error && status >= 200 && status < 300;
    await logPreflight({
        ts: Date.now(),
        url: details.url,
        initiator: details.initiator,
        status,
        error: details.error || null,
        ok,
        hint: ok ? null : details.error
            ? 'The preflight did not complete (network error).'
            : `The server answered the preflight with HTTP ${status}. Headers cannot fix that; add a "Proxy" rule for this URL.`
    });
}

/**
 * Everything the dashboard's CORS panel shows
 */
export async function getCorsStatus() {
    await preflightLogReady();
    const settings = await getSettings();
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const active = rules
        .filter(r => r.id >= CORS_RULE_ID_BASE && r.id <= CORS_RULE_ID_MAX)
        .map(r => ({
            origin: r.action.responseHeaders.find(h => h.header === 'Access-Control-Allow-Origin')?.value,
            scope: r.condition.tabIds ? 'tab' : 'host'
        }));
    return {
        enabled: !!(settings.globalEnabled && settings.allowCorsBypass),
        sites: normalizeSites(settings.corsBypassSites ?? DEFAULT_CORS_SITES),
        autoSites: await getAutoSites(),
        origins: [...new Set(active.map(a => a.origin).filter(o => o && o !== 'null'))],
        learnedHeaders: await getLearnedHeaders(),
        preflights: preflightLog
    };
}

export async function clearAutoSites() {
    await chrome.storage.local.remove(AUTO_SITES_KEY);
    await syncCorsRules();
    onSitesChanged();
}

export async function clearLearnedHeaders() {
    await chrome.storage.local.remove(LEARNED_HEADERS_KEY);
    await syncCorsRules();
}

export async function clearPreflightLog() {
    await preflightLogReady();
    preflightLog = [];
    await chrome.storage.session.remove(PREFLIGHT_LOG_KEY).catch(() => { });
}

// ─── Rule sync (serialized to avoid duplicate-ID races) ─────────

let syncChain = Promise.resolve();

/**
 * Recompute and apply all CORS session rules
 */
export function syncCorsRules() {
    syncChain = syncChain.then(doSync, doSync);
    return syncChain;
}

async function doSync() {
    try {
        const settings = await getSettings();
        const enabled = settings.globalEnabled && settings.allowCorsBypass;

        let addRules = [];
        if (enabled) {
            const sites = await getSites(settings);
            const tabs = await chrome.tabs.query({});
            const remembered = await getRememberedOrigins();
            // Make sure every open bypass tab has a host-wide fallback too
            for (const tab of tabs) {
                const origin = tab.url && bypassOrigin(tab.url, sites);
                if (origin && !remembered.includes(origin)) remembered.push(origin);
            }
            addRules = buildCorsRules({
                sites,
                tabs,
                rememberedOrigins: remembered,
                allowHeaders: await getAllowHeaders(settings),
                redirectTargets: redirectRuleTargets(await getAllRules())
            });
        }

        const existing = await chrome.declarativeNetRequest.getSessionRules();
        const removeRuleIds = existing
            .filter(r => r.id >= CORS_RULE_ID_BASE && r.id <= CORS_RULE_ID_MAX)
            .map(r => r.id);

        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    } catch (e) {
        console.warn('[Nariya] CORS rule sync failed:', e);
    }
}

// ─── Event wiring ────────────────────────────────────────────────

async function onTabUrl(url) {
    const settings = await getSettings();
    if (!settings.globalEnabled || !settings.allowCorsBypass) return;
    const origin = bypassOrigin(url, await getSites(settings));
    if (origin) await rememberOrigin(origin);
}

/**
 * Learn non-listed request headers from preflights made by bypass sites,
 * so credentialed requests with custom headers start passing. The rule is
 * updated while the preflight is in flight, so usually even the first
 * request succeeds; at worst a retry does.
 */
async function learnPreflightHeaders(details) {
    if (details.method !== 'OPTIONS' || !details.initiator) return;
    const acrh = details.requestHeaders?.find(
        h => h.name.toLowerCase() === 'access-control-request-headers'
    );
    if (!acrh?.value) return;
    await allowRequestHeaders(details.initiator, acrh.value);
}

/**
 * Allow these request header names for credentialed CORS requests from
 * `pageOrigin` (a bypass site). Resolves once the rules are updated.
 * The in-page interceptor calls this before sending a request with a header
 * it has not used yet, so even the first request passes.
 * @param {string} pageOrigin
 * @param {string|string[]} names
 * @returns {Promise<string[]>} header names newly allowed
 */
export async function allowRequestHeaders(pageOrigin, names) {
    const settings = await getSettings();
    if (!settings.globalEnabled || !settings.allowCorsBypass) return [];
    if (!bypassOrigin(pageOrigin, await getSites(settings))) return [];

    const known = new Set(await getAllowHeaders(settings));
    const fresh = normalizeHeaderNames(names).filter(h => !known.has(h));
    if (fresh.length === 0) return [];

    const learned = await getLearnedHeaders();
    await chrome.storage.local.set({ [LEARNED_HEADERS_KEY]: [...new Set([...learned, ...fresh])] });
    console.log(`[Nariya] CORS: now allowing request header(s): ${fresh.join(', ')}`);
    await syncCorsRules();
    return fresh;
}

/**
 * A Nariya redirect just turned a page's request into a cross-origin one.
 * If that page is not a bypass site yet, add it, so the request (or at
 * worst its retry) passes CORS.
 */
async function onRedirect(details) {
    if (!details.initiator || details.tabId < 0) return;
    // Extension (DNR) redirects are internal 307s
    if (details.statusCode !== 307 || !/Internal Redirect/i.test(details.statusLine || '')) return;

    let initiator, target, from;
    try {
        initiator = new URL(details.initiator);
        target = new URL(details.redirectUrl);
        from = new URL(details.url);
    } catch {
        return;
    }
    if (target.origin === initiator.origin) return;
    // HSTS / upgrade-insecure-requests: same URL, https
    if (from.href.replace(/^http:/, 'https:') === target.href) return;

    const settings = await getSettings();
    if (!settings.globalEnabled || !settings.allowCorsBypass) return;
    if (bypassOrigin(details.initiator, await getSites(settings))) return;

    const rules = await getAllRules();
    if (!rules.some(r => r.enabled && r.type === 'redirect')) return;

    const learned = await getLearnedSites();
    if (learned.includes(initiator.hostname)) return;
    learned.push(initiator.hostname);
    await chrome.storage.local.set({ [AUTO_SITES_KEY]: learned.slice(-MAX_AUTO_SITES) });
    await rememberOrigin(initiator.origin);
    console.log(`[Nariya] CORS: ${initiator.hostname} added (a redirect rule sends its calls to ${target.origin})`);
    await syncCorsRules();
    onSitesChanged();
}

/**
 * Register listeners. Must be called synchronously at service worker start.
 */
export function setupCorsBypass() {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (!changeInfo.url) return;
        onTabUrl(changeInfo.url).then(syncCorsRules);
    });
    chrome.tabs.onRemoved.addListener(() => syncCorsRules());
    chrome.tabs.onReplaced.addListener(() => syncCorsRules());

    // 'extraHeaders' is required for Chrome to show CORS preflights to webRequest
    chrome.webRequest.onBeforeSendHeaders.addListener(
        (details) => { learnPreflightHeaders(details); },
        { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] },
        ['requestHeaders', 'extraHeaders']
    );

    chrome.webRequest.onBeforeRedirect.addListener(
        (details) => { onRedirect(details); },
        { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other', 'font'] }
    );

    const preflightFilter = { urls: ['<all_urls>'], types: ['xmlhttprequest', 'other'] };
    chrome.webRequest.onCompleted.addListener(
        (details) => { onPreflightDone(details); }, preflightFilter, ['extraHeaders']
    );
    chrome.webRequest.onErrorOccurred.addListener(
        (details) => { onPreflightDone(details); }, preflightFilter, ['extraHeaders']
    );
}
