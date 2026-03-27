/**
 * offscreen-manager.js
 * Manages the lifecycle and communication with the Chrome offscreen document,
 * providing the service worker with a secure way to evaluate JavaScript in a sandbox.
 */

const OFFSCREEN_DOCUMENT_PATH = '/sandbox/offscreen.html';
let creatingPromise = null;

async function setupOffscreenDocument() {
    // Check if it already exists
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)]
    });

    if (existingContexts.length > 0) {
        return;
    }

    // Creating multiple offscreen documents simultaneously will throw,
    // so we serialize the creation using a Promise.
    if (creatingPromise) {
        await creatingPromise;
        return;
    }

    creatingPromise = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.IFRAME_SCRIPTING],
        justification: 'Securely evaluate user-defined scripts in an isolated sandbox for interceptor auto-mutate logic.'
    });

    await creatingPromise;
    creatingPromise = null;
}

/**
 * Execute a script inside the sandbox environment via the offscreen document.
 * @param {string} script 
 * @param {Object} context 
 * @returns {Promise<Object>}
 */
export async function runInSandbox(script, context = {}) {
    await setupOffscreenDocument();

    const id = 'sb_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

    try {
        const response = await chrome.runtime.sendMessage({
            type: 'RUN_IN_SANDBOX',
            payload: { id, script, context }
        });

        if (response) {
            return response;
        } else {
            return { ok: false, error: chrome.runtime.lastError?.message || 'No response from sandbox' };
        }
    } catch (err) {
        return { ok: false, error: err.message };
    }
}
