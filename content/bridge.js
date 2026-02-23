/**
 * Nariya — Bridge Content Script
 * Runs in the ISOLATED world. Relays messages between the page-level
 * interceptor.js (MAIN world) and the background service worker.
 */

(function () {
    'use strict';

    // ─── Page → Service Worker ──────────────────────────────────────
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'nariya-interceptor') return;

        // Forward to service worker
        chrome.runtime.sendMessage({
            from: 'bridge',
            type: event.data.type,
            payload: event.data.payload
        }).catch(() => {
            // Service worker may not be ready
        });
    });

    // ─── Service Worker → Page ──────────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.target !== 'bridge') return;

        switch (message.type) {
            case 'UPDATE_INTERCEPTOR_RULES':
                window.postMessage({
                    source: 'nariya-bridge',
                    type: 'UPDATE_INTERCEPTOR_RULES',
                    payload: message.payload
                }, '*');
                sendResponse({ ok: true });
                break;

            case 'CLEAR_INTERCEPTOR_RULES':
                window.postMessage({
                    source: 'nariya-bridge',
                    type: 'CLEAR_INTERCEPTOR_RULES',
                    payload: {}
                }, '*');
                sendResponse({ ok: true });
                break;

            case 'PING':
                sendResponse({ ok: true, from: 'bridge' });
                break;

            default:
                break;
        }

        return true; // Keep message channel open for async
    });
})();
