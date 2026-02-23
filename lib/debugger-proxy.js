/**
 * Nariya — Debugger Proxy
 * Wraps chrome.debugger (CDP) for intercepting and modifying requests/responses.
 */

// Tracks attached debugger sessions
const attachedTabs = new Map();

// Callback for paused requests
let onRequestPaused = null;
let onResponseReceived = null;

/**
 * Set callback for paused requests
 * @param {Function} callback - (tabId, params) => void
 */
export function setOnRequestPaused(callback) {
    onRequestPaused = callback;
}

/**
 * Set callback for responses
 * @param {Function} callback - (tabId, params) => void
 */
export function setOnResponseReceived(callback) {
    onResponseReceived = callback;
}

/**
 * Attach the debugger to a tab and enable network interception
 * @param {number} tabId
 * @param {Object} options - { interceptRequests: bool, interceptResponses: bool }
 */
export async function attach(tabId, options = {}) {
    if (attachedTabs.has(tabId)) {
        console.warn(`[Nariya] Debugger already attached to tab ${tabId}`);
        return;
    }

    const target = { tabId };

    await chrome.debugger.attach(target, '1.3');

    // Enable Fetch domain for request interception
    const patterns = [];

    if (options.interceptRequests !== false) {
        patterns.push({ requestStage: 'Request' });
    }
    if (options.interceptResponses !== false) {
        patterns.push({ requestStage: 'Response' });
    }

    await chrome.debugger.sendCommand(target, 'Fetch.enable', {
        patterns,
        handleAuthRequests: false
    });

    // Also enable Network domain for logging
    await chrome.debugger.sendCommand(target, 'Network.enable', {});

    attachedTabs.set(tabId, {
        attached: true,
        pausedRequests: new Map(),
        options
    });

    console.log(`[Nariya] Debugger attached to tab ${tabId}`);
}

/**
 * Detach the debugger from a tab
 * @param {number} tabId
 */
export async function detach(tabId) {
    if (!attachedTabs.has(tabId)) return;

    try {
        const target = { tabId };
        await chrome.debugger.sendCommand(target, 'Fetch.disable', {});
        await chrome.debugger.sendCommand(target, 'Network.disable', {});
        await chrome.debugger.detach(target);
    } catch (e) {
        // Tab may have been closed
        console.warn(`[Nariya] Error detaching debugger from tab ${tabId}:`, e);
    }

    attachedTabs.delete(tabId);
    console.log(`[Nariya] Debugger detached from tab ${tabId}`);
}

/**
 * Check if debugger is attached to a tab
 * @param {number} tabId
 * @returns {boolean}
 */
export function isAttached(tabId) {
    return attachedTabs.has(tabId);
}

/**
 * Get all attached tab IDs
 * @returns {number[]}
 */
export function getAttachedTabs() {
    return Array.from(attachedTabs.keys());
}

/**
 * Continue a paused request (optionally with modifications)
 * @param {number} tabId
 * @param {string} requestId - CDP request ID
 * @param {Object} modifications - { url, method, postData, headers }
 */
export async function continueRequest(tabId, requestId, modifications = {}) {
    const target = { tabId };
    const session = attachedTabs.get(tabId);

    if (!session) {
        throw new Error(`Debugger not attached to tab ${tabId}`);
    }

    const params = { requestId };

    if (modifications.url) params.url = modifications.url;
    if (modifications.method) params.method = modifications.method;
    if (modifications.postData) {
        params.postData = btoa(modifications.postData);
    }
    if (modifications.headers) {
        params.headers = modifications.headers.map(h => ({
            name: h.name,
            value: h.value
        }));
    }

    await chrome.debugger.sendCommand(target, 'Fetch.continueRequest', params);
    session.pausedRequests.delete(requestId);
}

/**
 * Continue a paused response (optionally with modifications)
 * @param {number} tabId
 * @param {string} requestId
 * @param {Object} modifications - { responseCode, responseHeaders, body }
 */
export async function continueResponse(tabId, requestId, modifications = {}) {
    const target = { tabId };
    const session = attachedTabs.get(tabId);

    if (!session) {
        throw new Error(`Debugger not attached to tab ${tabId}`);
    }

    const params = { requestId };

    if (modifications.responseCode) params.responseCode = modifications.responseCode;
    if (modifications.responseHeaders) {
        params.responseHeaders = modifications.responseHeaders.map(h => ({
            name: h.name,
            value: h.value
        }));
    }
    if (modifications.body !== undefined) {
        params.body = btoa(modifications.body);
    }

    await chrome.debugger.sendCommand(target, 'Fetch.fulfillRequest', params);
    session.pausedRequests.delete(requestId);
}

/**
 * Get the response body for a paused response
 * @param {number} tabId
 * @param {string} requestId
 * @returns {Promise<{ body: string, base64Encoded: boolean }>}
 */
export async function getResponseBody(tabId, requestId) {
    const target = { tabId };
    return chrome.debugger.sendCommand(target, 'Fetch.getResponseBody', { requestId });
}

/**
 * Handle CDP events from chrome.debugger
 * This should be called from the service worker's debugger event listener.
 * @param {{ tabId: number }} source
 * @param {string} method
 * @param {Object} params
 */
export function handleEvent(source, method, params) {
    const tabId = source.tabId;
    const session = attachedTabs.get(tabId);

    if (!session) return;

    switch (method) {
        case 'Fetch.requestPaused': {
            session.pausedRequests.set(params.requestId, {
                ...params,
                tabId,
                timestamp: Date.now()
            });

            if (onRequestPaused) {
                onRequestPaused(tabId, params);
            }
            break;
        }

        case 'Network.responseReceived': {
            if (onResponseReceived) {
                onResponseReceived(tabId, params);
            }
            break;
        }

        default:
            break;
    }
}

/**
 * Get all paused requests for a tab
 * @param {number} tabId
 * @returns {Map}
 */
export function getPausedRequests(tabId) {
    const session = attachedTabs.get(tabId);
    return session ? session.pausedRequests : new Map();
}

/**
 * Setup the chrome.debugger event listener
 * Call this once from the service worker.
 */
export function setupEventListener() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
        handleEvent(source, method, params);
    });

    chrome.debugger.onDetach.addListener((source, reason) => {
        if (source.tabId && attachedTabs.has(source.tabId)) {
            attachedTabs.delete(source.tabId);
            console.log(`[Nariya] Debugger detached from tab ${source.tabId}: ${reason}`);
        }
    });
}
