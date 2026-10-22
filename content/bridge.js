/**
 * Nariya — Bridge Content Script
 * Runs in the ISOLATED world. Relays messages between the page-level
 * interceptor.js (MAIN world) and the background service worker.
 *
 * The interceptor is reached over a private MessageChannel: the bridge
 * creates it and hands one port over with a synchronously dispatched DOM
 * event, so page scripts never see the traffic (unlike window.postMessage).
 */

(function () {
    'use strict';

    let port = null;
    let connected = false;
    let lastRules = null;
    let recording = false;

    // ─── Channel setup ──────────────────────────────────────────────

    function offerPort() {
        if (connected) return;
        if (port) port.close();
        const channel = new MessageChannel();
        port = channel.port1;
        port.onmessage = onInterceptorMessage;
        document.dispatchEvent(new MessageEvent('nariya:port', { ports: [channel.port2] }));
    }

    // Interceptor loaded after us and is asking for a port
    document.addEventListener('nariya:hello', (event) => {
        event.stopImmediatePropagation();
        offerPort();
    }, true);

    // Interceptor may already be waiting
    offerPort();

    function pushState() {
        if (!connected) return;
        if (lastRules) port.postMessage({ type: 'RULES', rules: lastRules });
        port.postMessage({ type: 'RECORDING', enabled: recording });
    }

    // ─── Base64 helpers (runtime messaging is JSON-only) ────────────

    function bufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }

    function base64ToBuffer(b64) {
        const bin = atob(b64 || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    function toServiceWorker(type, payload) {
        return chrome.runtime.sendMessage({ from: 'bridge', type, payload })
            .catch((e) => ({ ok: false, error: e.message || 'Extension unavailable' }));
    }

    // ─── Page → Service Worker ──────────────────────────────────────

    async function onInterceptorMessage({ data }) {
        if (!data) return;

        switch (data.type) {
            case 'READY':
                connected = true;
                pushState();
                break;

            case 'REQUEST_INTERCEPTED':
            case 'RECORD_BODY':
                toServiceWorker(data.type, data.payload);
                break;

            case 'CALL': {
                let result;
                if (data.call === 'PROXY_FETCH') {
                    const req = { ...data.payload };
                    if (req.body) req.bodyBase64 = bufferToBase64(req.body);
                    delete req.body;
                    result = await toServiceWorker('PROXY_FETCH', req);
                    if (result?.ok && result.response) {
                        const body = base64ToBuffer(result.response.bodyBase64);
                        result.response = { ...result.response, body, bodyBase64: undefined };
                        port.postMessage({ type: 'RESULT', id: data.id, result }, [body]);
                        return;
                    }
                } else if (data.call === 'RESOLVE_MOCK_BODY') {
                    result = await toServiceWorker('RESOLVE_MOCK_BODY', data.payload);
                } else {
                    result = { ok: false, error: `Unknown call ${data.call}` };
                }
                port.postMessage({ type: 'RESULT', id: data.id, result: result || { ok: false } });
                break;
            }
        }
    }

    // Fetch initial state from service worker
    toServiceWorker('GET_INTERCEPTOR_RULES').then((response) => {
        if (!response) return;
        if (response.rules) lastRules = response.rules;
        recording = !!response.recording;
        pushState();
    });

    // ─── Service Worker → Page ──────────────────────────────────────
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || message.target !== 'bridge') return;

        switch (message.type) {
            case 'UPDATE_INTERCEPTOR_RULES':
                lastRules = message.payload?.rules || [];
                pushState();
                sendResponse({ ok: true });
                break;

            case 'CLEAR_INTERCEPTOR_RULES':
                lastRules = [];
                pushState();
                sendResponse({ ok: true });
                break;

            case 'RECORDING_STATE':
                recording = !!message.payload?.enabled;
                pushState();
                sendResponse({ ok: true });
                break;

            case 'PING':
                sendResponse({ ok: true, from: 'bridge', interceptorConnected: connected });
                break;

            default:
                break;
        }
    });
})();
