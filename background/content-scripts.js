/**
 * Nariya — Interceptor Registration
 * The MAIN-world interceptor (fetch/XHR wrapper) is only registered while it
 * has something to do (mock / delay / proxy rules, or the recorder is on), and
 * optionally only on the sites the user lists. Pages never get a patched
 * fetch otherwise.
 */

import { normalizeSites } from '../core/cors-bypass.js';

const INTERCEPTOR_ID = 'nariya-interceptor';
const INTERCEPTOR_FILE = 'content/interceptor.js';

/**
 * Build match patterns for a site list (empty = every site)
 * @param {Array|string} sites
 * @returns {string[]}
 */
export function sitesToMatchPatterns(sites) {
    const hosts = normalizeSites(sites);
    if (hosts.length === 0) return ['<all_urls>'];
    const patterns = new Set();
    for (const host of hosts) {
        patterns.add(`*://${host}/*`);
        // Subdomains only make sense for names, not IP literals
        if (!/^[\d.]+$/.test(host) && !host.startsWith('[')) patterns.add(`*://*.${host}/*`);
    }
    return [...patterns];
}

function urlMatchesPatterns(url, patterns) {
    let u;
    try { u = new URL(url); } catch { return false; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (patterns.includes('<all_urls>')) return true;
    return patterns.some(p => {
        const host = p.slice('*://'.length, p.indexOf('/', '*://'.length));
        return host.startsWith('*.')
            ? u.hostname.endsWith(host.slice(1))
            : u.hostname === host;
    });
}

/**
 * Register / update / remove the interceptor content script
 * @param {{ needed: boolean, sites: Array }} options
 */
export async function syncInterceptorRegistration({ needed, sites }) {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [INTERCEPTOR_ID] });

    if (!needed) {
        if (existing.length > 0) {
            await chrome.scripting.unregisterContentScripts({ ids: [INTERCEPTOR_ID] });
        }
        return;
    }

    const matches = sitesToMatchPatterns(sites);
    const sameMatches = existing.length > 0 &&
        JSON.stringify([...existing[0].matches].sort()) === JSON.stringify([...matches].sort());
    if (sameMatches) return;

    const script = {
        id: INTERCEPTOR_ID,
        js: [INTERCEPTOR_FILE],
        matches,
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        persistAcrossSessions: true
    };

    if (existing.length > 0) {
        await chrome.scripting.updateContentScripts([script]);
    } else {
        await chrome.scripting.registerContentScripts([script]);
    }

    // Already-open pages only get registered scripts on their next load,
    // so inject now (the script guards against double injection)
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
        if (!tab.id || !tab.url || !urlMatchesPatterns(tab.url, matches)) continue;
        chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: [INTERCEPTOR_FILE],
            world: 'MAIN',
            injectImmediately: true
        }).catch(() => { });
    }
}
