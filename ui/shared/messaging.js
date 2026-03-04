/**
 * Nariya — Shared Messaging Utility
 * Wraps chrome.runtime.sendMessage in a Promise.
 */

export function sendMessage(type, payload = {}) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('[Nariya] Messaging Error:', chrome.runtime.lastError.message);
                resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                resolve(response || { ok: false });
            }
        });
    });
}
