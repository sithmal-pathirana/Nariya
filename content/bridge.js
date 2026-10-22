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

            case 'PROXY_START':
                startProxy(data.id, data.payload);
                break;

            case 'PROXY_ABORT': {
                const proxyPort = proxyPorts.get(data.id);
                proxyPorts.delete(data.id);
                if (proxyPort) proxyPort.disconnect();
                break;
            }

            case 'CALL': {
                let result;
                if (data.call === 'RESOLVE_MOCK_BODY') {
                    result = await toServiceWorker('RESOLVE_MOCK_BODY', data.payload);
                } else {
                    result = { ok: false, error: `Unknown call ${data.call}` };
                }
                port.postMessage({ type: 'RESULT', id: data.id, result: result || { ok: false } });
                break;
            }
        }
    }

    // ─── Proxied requests (streamed over a runtime port) ────────────

    const proxyPorts = new Map();

    function startProxy(id, req) {
        const toPage = (event, extra = {}, transfer = []) =>
            port?.postMessage({ type: 'PROXY_EVENT', id, event, ...extra }, transfer);

        let proxyPort;
        try {
            proxyPort = chrome.runtime.connect({ name: 'nariya-proxy' });
        } catch {
            toPage('error', { error: 'Extension unavailable (reload the page)' });
            return;
        }
        proxyPorts.set(id, proxyPort);
        let ended = false;

        proxyPort.onMessage.addListener((msg) => {
            switch (msg.type) {
                case 'head':
                    toPage('head', { head: msg.head });
                    break;
                case 'chunk': {
                    const data = base64ToBuffer(msg.data);
                    toPage('chunk', { data }, [data]);
                    break;
                }
                case 'end':
                case 'error':
                    ended = true;
                    proxyPorts.delete(id);
                    toPage(msg.type, { error: msg.error });
                    break;
            }
        });
        proxyPort.onDisconnect.addListener(() => {
            if (ended || !proxyPorts.has(id)) return;
            proxyPorts.delete(id);
            toPage('error', { error: 'Connection to Nariya closed' });
        });

        const request = { ...req };
        if (request.body) request.bodyBase64 = bufferToBase64(request.body);
        delete request.body;
        proxyPort.postMessage({ type: 'start', request });
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
