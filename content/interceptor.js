/**
 * Nariya — Fetch/XHR Interceptor
 * Runs in the page's MAIN world and wraps window.fetch and XMLHttpRequest to
 * apply mock, delay and proxy rules, and to capture response bodies while the
 * request recorder is on.
 *
 * Registered dynamically by the service worker (background/content-scripts.js)
 * only while such rules exist or recording is active.
 *
 * Talks to bridge.js (ISOLATED world) over a private MessageChannel instead of
 * window.postMessage, so page scripts cannot read or forge its traffic. The
 * bridge hands over the port with a synchronously dispatched event; only the
 * first port is accepted.
 */

(function () {
    'use strict';

    // Guard against double injection
    if (window.__nariya_interceptor_installed__) return;
    Object.defineProperty(window, '__nariya_interceptor_installed__', { value: true });

    // Keep pristine references so later page code cannot tamper with them
    const originalFetch = window.fetch;
    const OriginalXHR = window.XMLHttpRequest;
    const xhrProto = OriginalXHR.prototype;
    const originalOpen = xhrProto.open;
    const originalSend = xhrProto.send;
    const originalSetRequestHeader = xhrProto.setRequestHeader;
    const originalAbort = xhrProto.abort;
    const NativeRequest = window.Request;
    const NativeResponse = window.Response;
    const textDecoder = new TextDecoder();
    const textEncoder = new TextEncoder();

    // Rule store
    let mockRules = [];
    let delayRules = [];
    let proxyRules = [];
    let recording = false;

    const MAX_RECORDED_BODY = 256 * 1024;

    // ─── Private channel to bridge.js ───────────────────────────────

    let port = null;
    let callSeq = 0;
    const pendingCalls = new Map();

    document.addEventListener('nariya:port', (event) => {
        if (port || !event.ports || !event.ports[0]) return;
        event.stopImmediatePropagation();
        port = event.ports[0];
        port.onmessage = onPortMessage;
        port.postMessage({ type: 'READY' });
    }, true);

    // In case the bridge loaded first, ask it for a port
    document.dispatchEvent(new Event('nariya:hello'));

    function onPortMessage({ data }) {
        if (!data) return;
        switch (data.type) {
            case 'RULES': {
                const rules = data.rules || [];
                mockRules = rules.filter(r => r.type === 'mock');
                delayRules = rules.filter(r => r.type === 'delay');
                proxyRules = rules.filter(r => r.type === 'proxy');
                break;
            }
            case 'RECORDING':
                recording = !!data.enabled;
                break;
            case 'RESULT': {
                const pending = pendingCalls.get(data.id);
                if (pending) {
                    pendingCalls.delete(data.id);
                    pending(data.result || { ok: false, error: 'No response' });
                }
                break;
            }
        }
    }

    /**
     * Ask the extension for something and wait for the answer
     */
    function callExtension(type, payload, transfer = []) {
        if (!port) return Promise.resolve({ ok: false, error: 'Nariya is not connected' });
        const id = ++callSeq;
        return new Promise((resolve) => {
            pendingCalls.set(id, resolve);
            port.postMessage({ type: 'CALL', id, call: type, payload }, transfer);
        });
    }

    /**
     * Fire-and-forget report to the extension (toasts, recorder)
     */
    function report(type, payload) {
        if (port) port.postMessage({ type, payload });
    }

    // ─── Matching ───────────────────────────────────────────────────

    /**
     * Check if a URL matches a rule's URL filter
     */
    function matchesUrl(url, filter) {
        if (!filter) return false;

        // Exact match
        if (url === filter) return true;

        // Strip query params and hash from both for comparison
        const urlBase = url.split('?')[0].split('#')[0];
        const filterBase = filter.split('?')[0].split('#')[0];

        // Check base URL exact match
        if (urlBase === filterBase) return true;

        // Wildcard match — unanchored like DNR urlFilter, so "/api/*" matches
        // "https://host/api/users" the same way redirect/header rules do
        if (filter.includes('*')) {
            const regex = new RegExp(
                filter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
            );
            return regex.test(url) || regex.test(urlBase);
        }

        // Substring match — check both full URL and base URL
        return url.includes(filter) || urlBase.includes(filterBase);
    }

    const findRule = (rules, url) => rules.find(r => matchesUrl(url, r.urlFilter));

    const hasRules = () => mockRules.length > 0 || delayRules.length > 0 || proxyRules.length > 0;

    function resolveUrl(url) {
        try {
            return new URL(String(url), window.location.href).href;
        } catch {
            return null;
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────

    function abortError() {
        return new DOMException('The user aborted a request.', 'AbortError');
    }

    function sleep(ms, signal) {
        return new Promise((resolve, reject) => {
            if (!ms || ms <= 0) return resolve();
            if (signal?.aborted) return reject(abortError());
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(abortError());
            }, { once: true });
        });
    }

    function base64ToBytes(b64) {
        const bin = atob(b64 || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function headerValue(headers, name) {
        const lower = name.toLowerCase();
        return headers.filter(([k]) => k.toLowerCase() === lower).map(([, v]) => v).join(', ') || null;
    }

    function isTextual(contentType) {
        return !contentType || /json|text|xml|javascript|graphql|x-www-form-urlencoded/i.test(contentType);
    }

    /**
     * Build the synthetic response for a mock rule:
     * { status, statusText, headers: [[name, value]], body: Uint8Array, url }
     */
    async function buildMockResponse(rule, url) {
        const config = rule.config || {};
        const headers = Object.entries(config.headers || {});
        let body;

        if (config.cloudKey) {
            const result = await callExtension('RESOLVE_MOCK_BODY', { ruleId: rule.id });
            if (!result.ok) throw new TypeError(`Nariya: could not load cloud mock (${result.error})`);
            body = base64ToBytes(result.bodyBase64);
            if (!headerValue(headers, 'content-type') && result.contentType) {
                headers.push(['Content-Type', result.contentType]);
            }
        } else {
            body = textEncoder.encode(config.body ?? '{}');
        }

        if (!headerValue(headers, 'content-type')) {
            headers.push(['Content-Type', config.contentType || 'application/json']);
        }

        return {
            status: parseInt(config.statusCode, 10) || 200,
            statusText: config.statusText || '',
            headers,
            body,
            url
        };
    }

    /**
     * Turn a synthetic response into a real Response object
     */
    function toFetchResponse(res) {
        const nullBody = [101, 103, 204, 205, 304].includes(res.status);
        const status = res.status >= 200 && res.status <= 599 ? res.status : 200;
        const response = new NativeResponse(nullBody ? null : res.body, {
            status,
            statusText: res.statusText || '',
            headers: res.headers
        });
        Object.defineProperty(response, 'url', { value: res.url || '' });
        Object.defineProperty(response, 'redirected', { value: !!res.redirected });
        return response;
    }

    /**
     * Send a request through the extension's service worker (no CORS there)
     * @param {{ url, method, headers, body: ArrayBuffer|null, credentials }} req
     */
    async function proxyThroughExtension(req) {
        const transfer = req.body ? [req.body] : [];
        const result = await callExtension('PROXY_FETCH', req, transfer);
        if (!result.ok) {
            console.warn(`[Nariya] Proxy request failed for ${req.url}: ${result.error}`);
            throw new TypeError('Failed to fetch');
        }
        const r = result.response;
        return {
            status: r.status,
            statusText: r.statusText,
            headers: r.headers,
            body: r.body instanceof ArrayBuffer ? new Uint8Array(r.body) : base64ToBytes(r.bodyBase64),
            url: r.url,
            redirected: r.redirected
        };
    }

    function credentialsFor(url, mode) {
        const sameOrigin = new URL(url).origin === window.location.origin;
        if (mode === 'include') return 'include';
        if (mode === 'omit') return 'omit';
        return sameOrigin ? 'include' : 'omit';
    }

    function recordBody(url, method, status, contentType, text) {
        if (!recording || text == null) return;
        report('RECORD_BODY', {
            url, method, status, contentType,
            body: text.length > MAX_RECORDED_BODY ? text.slice(0, MAX_RECORDED_BODY) : text,
            truncated: text.length > MAX_RECORDED_BODY
        });
    }

    // ─── Override fetch ─────────────────────────────────────────────

    window.fetch = function (...args) {
        // Nothing to do: hand straight to the browser, untouched
        if (!hasRules() && !recording) {
            return originalFetch.apply(this, args);
        }

        // Read url/method without building a new Request: new Request(req)
        // consumes req's body, so the real fetch below would then throw
        // "Request object that has already been used".
        const [input, init] = args;
        const isRequest = input instanceof NativeRequest;
        const url = isRequest ? input.url : resolveUrl(input);
        if (!url) return originalFetch.apply(this, args);
        const method = (init?.method || (isRequest ? input.method : 'GET')).toUpperCase();

        return handleFetch(this, args, { input, init, isRequest, url, method });
    };

    async function handleFetch(self, args, { input, init, isRequest, url, method }) {
        const signal = init?.signal || (isRequest ? input.signal : undefined);
        if (signal?.aborted) throw abortError();

        const delayRule = findRule(delayRules, url);
        if (delayRule) {
            const delayMs = parseInt(delayRule.config?.delayMs, 10) || 1000;
            report('REQUEST_INTERCEPTED', { type: 'delay', url, method, ruleId: delayRule.id, delayMs });
            await sleep(delayMs, signal);
        }

        const mockRule = findRule(mockRules, url);
        if (mockRule) {
            const res = await buildMockResponse(mockRule, url);
            report('REQUEST_INTERCEPTED', {
                type: 'mock', url, method, ruleId: mockRule.id,
                mockedResponse: { status: res.status }
            });
            await sleep(parseInt(mockRule.config?.delayMs, 10) || 0, signal);
            return toFetchResponse(res);
        }

        const proxyRule = findRule(proxyRules, url);
        if (proxyRule) {
            // Clone so the caller's Request body stays usable
            const req = isRequest
                ? (init ? new NativeRequest(input.clone(), init) : input.clone())
                : new NativeRequest(input, init);
            const body = method === 'GET' || method === 'HEAD' ? null : await req.arrayBuffer();
            const res = await proxyThroughExtension({
                url: req.url,
                method,
                headers: [...req.headers],
                body: body && body.byteLength > 0 ? body : null,
                credentials: credentialsFor(req.url, req.credentials)
            });
            if (signal?.aborted) throw abortError();
            report('REQUEST_INTERCEPTED', { type: 'proxy', url, method, ruleId: proxyRule.id, status: res.status });
            const contentType = headerValue(res.headers, 'content-type');
            if (isTextual(contentType)) recordBody(url, method, res.status, contentType, textDecoder.decode(res.body));
            return toFetchResponse(res);
        }

        const response = await originalFetch.apply(self, args);

        if (recording) {
            const contentType = response.headers.get('content-type');
            if (isTextual(contentType) && response.type !== 'opaque') {
                response.clone().text()
                    .then(text => recordBody(url, method, response.status, contentType, text))
                    .catch(() => { });
            }
        }
        return response;
    }

    // ─── Override XMLHttpRequest ────────────────────────────────────

    const xhrState = new WeakMap();
    const SYNTHETIC_PROPS = ['readyState', 'status', 'statusText', 'responseText', 'response',
        'responseURL', 'responseXML', 'getResponseHeader', 'getAllResponseHeaders'];

    function stateOf(xhr) {
        let st = xhrState.get(xhr);
        if (!st) {
            st = { headers: [] };
            xhrState.set(xhr, st);
        }
        return st;
    }

    function clearSynthetic(xhr) {
        for (const prop of SYNTHETIC_PROPS) {
            if (Object.prototype.hasOwnProperty.call(xhr, prop)) delete xhr[prop];
        }
    }

    function fire(xhr, type, loaded = 0, total = 0) {
        const isProgress = ['loadstart', 'progress', 'load', 'loadend', 'error', 'abort', 'timeout'].includes(type);
        xhr.dispatchEvent(isProgress
            ? new ProgressEvent(type, { lengthComputable: total > 0, loaded, total })
            : new Event(type));
    }

    /**
     * Make an XHR look like it received `res`, honouring responseType and
     * firing the usual readystatechange / progress / load / loadend events.
     */
    function fulfillXhr(xhr, res) {
        const st = stateOf(xhr);
        const bytes = res.body || new Uint8Array(0);
        const text = textDecoder.decode(bytes);
        const contentType = headerValue(res.headers, 'content-type') || '';
        const fake = { readyState: 1, status: 0, statusText: '' };
        st.fake = fake;

        let response;
        switch (xhr.responseType) {
            case 'json':
                try { response = JSON.parse(text); } catch { response = null; }
                break;
            case 'arraybuffer':
                response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
                break;
            case 'blob':
                response = new Blob([bytes], { type: contentType });
                break;
            case 'document':
                response = new DOMParser().parseFromString(text, /xml/i.test(contentType) ? 'application/xml' : 'text/html');
                break;
            default:
                response = text;
        }

        const define = (prop, get) => Object.defineProperty(xhr, prop, { configurable: true, get });
        define('readyState', () => fake.readyState);
        define('status', () => fake.status);
        define('statusText', () => fake.statusText);
        define('responseURL', () => (fake.readyState >= 2 ? res.url || '' : ''));
        define('responseText', () => (fake.readyState >= 3 ? text : ''));
        define('response', () => (fake.readyState === 4 ? response : (xhr.responseType === '' || xhr.responseType === 'text') && fake.readyState === 3 ? text : null));
        define('responseXML', () => (fake.readyState === 4 && xhr.responseType === 'document' ? response : null));
        Object.defineProperty(xhr, 'getResponseHeader', {
            configurable: true,
            value: (name) => (fake.readyState >= 2 ? headerValue(res.headers, String(name)) : null)
        });
        Object.defineProperty(xhr, 'getAllResponseHeaders', {
            configurable: true,
            value: () => (fake.readyState >= 2
                ? res.headers.map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`).join('')
                : '')
        });

        const total = bytes.byteLength;
        fake.readyState = 2;
        fake.status = res.status;
        fake.statusText = res.statusText || '';
        fire(xhr, 'readystatechange');
        if (st.aborted) return;
        fake.readyState = 3;
        fire(xhr, 'readystatechange');
        fire(xhr, 'progress', total, total);
        fake.readyState = 4;
        fire(xhr, 'readystatechange');
        fire(xhr, 'load', total, total);
        fire(xhr, 'loadend', total, total);
    }

    function failXhr(xhr) {
        const st = stateOf(xhr);
        st.fake = { readyState: 4, status: 0, statusText: '' };
        Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => st.fake.readyState });
        Object.defineProperty(xhr, 'status', { configurable: true, get: () => 0 });
        fire(xhr, 'readystatechange');
        fire(xhr, 'error');
        fire(xhr, 'loadend');
    }

    /**
     * Normalize any XHR body (string, FormData, Blob, URLSearchParams, ...)
     * into bytes plus the content type the browser would have sent.
     */
    async function serializeXhrBody(body) {
        if (body == null) return { body: null, contentType: null };
        if (body instanceof Document) {
            body = new XMLSerializer().serializeToString(body);
        }
        const req = new NativeRequest('https://nariya.invalid/', { method: 'POST', body });
        const buf = await req.arrayBuffer();
        return { body: buf.byteLength > 0 ? buf : null, contentType: req.headers.get('content-type') };
    }

    xhrProto.open = function (method, url, async, ...rest) {
        const st = stateOf(this);
        st.method = String(method || 'GET').toUpperCase();
        st.url = resolveUrl(url) || String(url);
        st.async = async !== false;
        st.headers = [];
        st.aborted = false;
        st.pending = false;
        clearSynthetic(this);
        return originalOpen.call(this, method, url, ...(arguments.length > 2 ? [async, ...rest] : []));
    };

    xhrProto.setRequestHeader = function (name, value) {
        stateOf(this).headers.push([String(name), String(value)]);
        return originalSetRequestHeader.call(this, name, value);
    };

    xhrProto.abort = function () {
        const st = stateOf(this);
        if (st.pending) {
            st.aborted = true;
            st.pending = false;
            if (st.fake) st.fake.readyState = 0;
            fire(this, 'abort');
            fire(this, 'loadend');
            return;
        }
        return originalAbort.call(this);
    };

    xhrProto.send = function (body) {
        const st = stateOf(this);
        const { url, method } = st;

        // Sync XHR cannot wait for async work; leave it alone
        if (!url || !st.async || (!hasRules() && !recording)) {
            return originalSend.call(this, body);
        }

        const delayRule = findRule(delayRules, url);
        const mockRule = findRule(mockRules, url);
        const proxyRule = !mockRule && findRule(proxyRules, url);

        if (!delayRule && !mockRule && !proxyRule) {
            if (recording) {
                this.addEventListener('load', () => {
                    const rt = this.responseType;
                    if (rt !== '' && rt !== 'text' && rt !== 'json') return;
                    const contentType = this.getResponseHeader('content-type');
                    if (!isTextual(contentType)) return;
                    const text = rt === 'json' ? JSON.stringify(this.response) : this.responseText;
                    recordBody(url, method, this.status, contentType, text);
                }, { once: true });
            }
            return originalSend.call(this, body);
        }

        st.pending = true;
        const xhr = this;
        if (mockRule || proxyRule) fire(xhr, 'loadstart');

        (async () => {
            if (delayRule) {
                const delayMs = parseInt(delayRule.config?.delayMs, 10) || 1000;
                report('REQUEST_INTERCEPTED', { type: 'delay', url, method, ruleId: delayRule.id, delayMs });
                await sleep(delayMs);
                if (st.aborted) return;
            }

            if (mockRule) {
                const res = await buildMockResponse(mockRule, url);
                report('REQUEST_INTERCEPTED', {
                    type: 'mock', url, method, ruleId: mockRule.id,
                    mockedResponse: { status: res.status }
                });
                await sleep(parseInt(mockRule.config?.delayMs, 10) || 0);
                if (st.aborted) return;
                st.pending = false;
                fulfillXhr(xhr, res);
                return;
            }

            if (proxyRule) {
                const serialized = await serializeXhrBody(method === 'GET' || method === 'HEAD' ? null : body);
                const headers = [...st.headers];
                if (serialized.contentType && !headerValue(headers, 'content-type')) {
                    headers.push(['Content-Type', serialized.contentType]);
                }
                const res = await proxyThroughExtension({
                    url, method, headers,
                    body: serialized.body,
                    credentials: credentialsFor(url, xhr.withCredentials ? 'include' : 'same-origin')
                });
                if (st.aborted) return;
                st.pending = false;
                report('REQUEST_INTERCEPTED', { type: 'proxy', url, method, ruleId: proxyRule.id, status: res.status });
                const contentType = headerValue(res.headers, 'content-type');
                if (isTextual(contentType)) recordBody(url, method, res.status, contentType, textDecoder.decode(res.body));
                fulfillXhr(xhr, res);
                return;
            }

            // Delay only: now send for real
            st.pending = false;
            originalSend.call(xhr, body);
        })().catch((err) => {
            if (st.aborted) return;
            console.warn('[Nariya] Interceptor error:', err);
            st.pending = false;
            failXhr(xhr);
        });
    };
})();
