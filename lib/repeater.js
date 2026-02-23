/**
 * Nariya — Repeater
 * Logs intercepted requests and enables replay with modifications.
 */

const MAX_HISTORY = 500;

// In-memory request history
let requestHistory = [];

/**
 * Add a request to the history
 * @param {Object} entry - { url, method, headers, body, responseStatus, responseHeaders, responseBody, timestamp }
 * @returns {Object} The stored entry with ID
 */
export function addToHistory(entry) {
    const stored = {
        id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        url: entry.url || '',
        method: entry.method || 'GET',
        headers: entry.headers || [],
        body: entry.body || null,
        responseStatus: entry.responseStatus || null,
        responseHeaders: entry.responseHeaders || [],
        responseBody: entry.responseBody || null,
        timestamp: entry.timestamp || Date.now(),
        source: entry.source || 'interceptor'
    };

    requestHistory.unshift(stored);

    // Cap history
    if (requestHistory.length > MAX_HISTORY) {
        requestHistory = requestHistory.slice(0, MAX_HISTORY);
    }

    return stored;
}

/**
 * Get the request history
 * @param {Object} filter - { method, urlContains, limit }
 * @returns {Array}
 */
export function getHistory(filter = {}) {
    let results = [...requestHistory];

    if (filter.method) {
        results = results.filter(r => r.method === filter.method);
    }

    if (filter.urlContains) {
        const q = filter.urlContains.toLowerCase();
        results = results.filter(r => r.url.toLowerCase().includes(q));
    }

    if (filter.limit) {
        results = results.slice(0, filter.limit);
    }

    return results;
}

/**
 * Get a single history entry by ID
 * @param {string} id
 * @returns {Object|null}
 */
export function getHistoryEntry(id) {
    return requestHistory.find(r => r.id === id) || null;
}

/**
 * Clear
 */
export function clearHistory() {
    requestHistory = [];
}

/**
 * Replay a request with optional overrides
 * @param {Object} entry - Original request entry
 * @param {Object} overrides - { url, method, headers, body }
 * @returns {Promise<Object>} - { status, statusText, headers, body, duration }
 */
export async function replay(entry, overrides = {}) {
    const url = overrides.url || entry.url;
    const method = overrides.method || entry.method;
    const body = overrides.body !== undefined ? overrides.body : entry.body;

    // Build headers
    const headers = new Headers();
    const headerList = overrides.headers || entry.headers || [];
    for (const h of headerList) {
        try {
            headers.set(h.name, h.value);
        } catch (e) {
            // Skip invalid headers
        }
    }

    const fetchOptions = {
        method,
        headers,
        mode: 'cors',
        cache: 'no-store'
    };

    // Only attach body for non-GET/HEAD methods
    if (body && !['GET', 'HEAD'].includes(method.toUpperCase())) {
        fetchOptions.body = body;
    }

    const startTime = performance.now();

    try {
        const response = await fetch(url, fetchOptions);
        const duration = Math.round(performance.now() - startTime);

        // Collect response headers
        const respHeaders = [];
        response.headers.forEach((value, name) => {
            respHeaders.push({ name, value });
        });

        // Read body as text
        let respBody;
        try {
            respBody = await response.text();
        } catch {
            respBody = '[Binary or unreadable body]';
        }

        const result = {
            status: response.status,
            statusText: response.statusText,
            headers: respHeaders,
            body: respBody,
            duration,
            timestamp: Date.now()
        };

        // Add the replay result to history as well
        addToHistory({
            url,
            method,
            headers: headerList,
            body,
            responseStatus: response.status,
            responseHeaders: respHeaders,
            responseBody: respBody,
            source: 'repeater'
        });

        return result;
    } catch (err) {
        return {
            status: 0,
            statusText: 'Network Error',
            headers: [],
            body: err.message,
            duration: Math.round(performance.now() - startTime),
            timestamp: Date.now(),
            error: true
        };
    }
}
