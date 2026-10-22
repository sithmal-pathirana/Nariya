/**
 * Nariya — URL matching
 * Pattern matching for mock / delay / proxy rules. content/interceptor.js
 * carries a copy of matchesUrl (it is a classic script and cannot import),
 * so keep the two in sync.
 */

/**
 * Check if a URL matches a rule's URL filter.
 * Exact URL, exact URL ignoring query/hash, "*" wildcards matched anywhere
 * in the URL (like DNR urlFilter), or plain substring.
 * @param {string} url
 * @param {string} filter
 * @returns {boolean}
 */
export function matchesUrl(url, filter) {
    if (!filter) return false;

    if (url === filter) return true;

    const urlBase = url.split('?')[0].split('#')[0];
    const filterBase = filter.split('?')[0].split('#')[0];

    if (urlBase === filterBase) return true;

    if (filter.includes('*')) {
        const regex = new RegExp(
            filter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
        );
        return regex.test(url) || regex.test(urlBase);
    }

    return url.includes(filter) || urlBase.includes(filterBase);
}

/**
 * Convert a declarativeNetRequest urlFilter into a RegExp.
 * Supports "*", "^" (separator), "|" (start/end anchor) and "||" (domain anchor).
 * Used to tell which DNR rule hit a request in packed builds, where
 * onRuleMatchedDebug is unavailable.
 * @param {string} filter
 * @returns {RegExp}
 */
export function dnrUrlFilterToRegExp(filter) {
    let f = filter || '*';
    let prefix = '';
    let suffix = '';

    if (f.startsWith('||')) {
        prefix = '^[a-z][a-z0-9+.-]*:\\/\\/([^/?#]*\\.)?';
        f = f.slice(2);
    } else if (f.startsWith('|')) {
        prefix = '^';
        f = f.slice(1);
    }
    if (f.endsWith('|')) {
        suffix = '$';
        f = f.slice(0, -1);
    }

    const body = f.split('').map((ch) => {
        if (ch === '*') return '.*';
        if (ch === '^') return '(?:[^a-zA-Z0-9_.%-]|$)';
        return ch.replace(/[.+?${}()|[\]\\/]/g, '\\$&');
    }).join('');

    return new RegExp(prefix + body + suffix, 'i');
}

/**
 * Would this compiled DNR rule match the webRequest details?
 * Covers the conditions Nariya generates (urlFilter / regexFilter,
 * resourceTypes, requestMethods, initiatorDomains, tabIds).
 * @param {Object} dnrRule
 * @param {{ url: string, type: string, method: string, initiator?: string, tabId: number }} details
 */
export function dnrRuleMatches(dnrRule, details) {
    const c = dnrRule.condition || {};
    if (c.resourceTypes && !c.resourceTypes.includes(details.type)) return false;
    if (!c.resourceTypes && details.type === 'main_frame') return false;
    if (c.requestMethods && !c.requestMethods.includes(String(details.method).toLowerCase())) return false;
    if (c.tabIds && !c.tabIds.includes(details.tabId)) return false;
    if (c.initiatorDomains) {
        let host = '';
        try { host = new URL(details.initiator).hostname; } catch { return false; }
        if (!c.initiatorDomains.some(d => host === d || host.endsWith('.' + d))) return false;
    }
    try {
        if (c.regexFilter) return new RegExp(c.regexFilter).test(details.url);
    } catch {
        return false;
    }
    return dnrUrlFilterToRegExp(c.urlFilter).test(details.url);
}
