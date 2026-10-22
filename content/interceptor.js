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
    let redirectRules = [];
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
                redirectRules = rules.filter(r => r.type === 'redirect');
                break;
            }
            case 'RECORDING':
                recording = !!data.enabled;
                break;
            case 'PROXY_EVENT': {
                const stream = proxyStreams.get(data.id);
                if (stream) stream.onEvent(data);
                break;
            }
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

    const hasRules = () => mockRules.length > 0 || delayRules.length > 0 || proxyRules.length > 0 ||
        redirectRules.length > 0;

    // Header names already reported to Nariya for the CORS bypass
    const announcedHeaders = new Set();
    const ANNOUNCE_TIMEOUT_MS = 1000;

    /**
     * Before a cross-origin request with header names Nariya has not seen,
     * ask it to allow them (credentialed preflights need explicit names).
     * Never waits more than a second.
     * @param {string} target - URL the request goes to
     * @param {Iterable<string>} names
     */
    function announceHeaders(target, names) {
        let crossOrigin = false;
        try { crossOrigin = new URL(target).origin !== window.location.origin; } catch { }
        if (!crossOrigin || !port) return null;
        const fresh = [...new Set([...names].map(n => String(n).toLowerCase()))].filter(n => !announcedHeaders.has(n));
        if (fresh.length === 0) return null;
        fresh.forEach(n => announcedHeaders.add(n));
        return Promise.race([
            callExtension('ENSURE_CORS_HEADERS', { headers: fresh }),
            new Promise(resolve => setTimeout(resolve, ANNOUNCE_TIMEOUT_MS))
        ]);
    }

    /**
     * declarativeNetRequest urlFilter → RegExp (copy of core/url-match.js)
     */
    function dnrUrlFilterToRegExp(filter) {
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
     * Where a redirect rule sends this cross-origin call, if it changes the
     * origin. Chrome would otherwise follow the rule's redirect from one
     * foreign origin to another and send the call with "Origin: null",
     * which breaks CORS; going straight to the destination keeps the page's
     * real origin. Same-origin calls are left to the browser-level redirect.
     * @returns {string|null}
     */
    function rewriteForRedirect(url) {
        if (redirectRules.length === 0) return null;
        let from;
        try { from = new URL(url); } catch { return null; }
        if (from.origin === window.location.origin) return null;

        for (const rule of redirectRules) {
            let to = null;
            try {
                if (rule.regexFilter) {
                    const re = new RegExp(rule.regexFilter);
                    if (re.test(url)) {
                        // DNR uses \1 and \0; JS replace uses $1 and $&
                        const substitution = String(rule.regexSubstitution || '')
                            .replace(/\$/g, '$$$$')
                            .replace(/\\(\d)/g, (m, d) => (d === '0' ? '$&' : '$' + d));
                        to = url.replace(re, substitution);
                    }
                } else if (rule.url && dnrUrlFilterToRegExp(rule.urlFilter).test(url)) {
                    to = rule.url;
                }
                if (!to) continue;
                return new URL(to).origin === from.origin ? null : new URL(to).href;
            } catch {
                continue;
            }
        }
        return null;
    }

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

    const NULL_BODY_STATUSES = [101, 103, 204, 205, 304];

    /**
     * Turn a synthetic response into a real Response object.
     * `res.body` may be bytes or a ReadableStream.
     */
    function toFetchResponse(res) {
        const nullBody = NULL_BODY_STATUSES.includes(res.status);
        if (nullBody && res.body instanceof ReadableStream) res.body.cancel().catch(() => { });
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

    const proxyStreams = new Map();

    /**
     * Send a request through the extension's service worker (no CORS there).
     * Resolves as soon as response headers arrive; the body streams in.
     * @param {{ url, method, headers, body: ArrayBuffer|null, credentials }} req
     * @param {AbortSignal} [signal]
     * @returns {Promise<{ status, statusText, headers, url, redirected, body: ReadableStream }>}
     */
    function proxyThroughExtension(req, signal) {
        if (!port) return Promise.reject(new TypeError('Failed to fetch'));
        if (signal?.aborted) return Promise.reject(abortError());

        const id = ++callSeq;
        return new Promise((resolve, reject) => {
            let controller;
            let settled = false;
            const body = new ReadableStream({
                start(c) { controller = c; },
                cancel() {
                    if (!proxyStreams.has(id)) return;
                    proxyStreams.delete(id);
                    port.postMessage({ type: 'PROXY_ABORT', id });
                }
            });

            const fail = (err) => {
                proxyStreams.delete(id);
                if (!settled) { settled = true; reject(err); }
                try { controller.error(err); } catch { }
            };

            proxyStreams.set(id, {
                onEvent(ev) {
                    switch (ev.event) {
                        case 'head':
                            settled = true;
                            resolve({ ...ev.head, body });
                            break;
                        case 'chunk':
                            try { controller.enqueue(new Uint8Array(ev.data)); } catch { }
                            break;
                        case 'end':
                            proxyStreams.delete(id);
                            try { controller.close(); } catch { }
                            break;
                        case 'error':
                            console.warn(`[Nariya] Proxy request failed for ${req.url}: ${ev.error}`);
                            fail(new TypeError('Failed to fetch'));
                            break;
                    }
                }
            });

            signal?.addEventListener('abort', () => {
                if (!proxyStreams.has(id)) return;
                port.postMessage({ type: 'PROXY_ABORT', id });
                fail(abortError());
            }, { once: true });

            port.postMessage({ type: 'PROXY_START', id, payload: req }, req.body ? [req.body] : []);
        });
    }

    async function readAll(stream) {
        return new Uint8Array(await new NativeResponse(stream).arrayBuffer());
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

    /**
     * fetch() arguments aimed at `target` instead of the original URL
     */
    async function retargetFetchArgs(target, input, init, isRequest) {
        if (!isRequest) return [target, init];
        const body = input.method === 'GET' || input.method === 'HEAD' ? undefined : await input.clone().arrayBuffer();
        return [new NativeRequest(target, {
            method: input.method,
            headers: input.headers,
            body,
            mode: input.mode === 'navigate' ? undefined : input.mode,
            credentials: input.credentials,
            cache: input.cache,
            redirect: input.redirect,
            referrerPolicy: input.referrerPolicy,
            integrity: input.integrity,
            keepalive: input.keepalive,
            signal: input.signal
        }), init];
    }

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
            }, signal);
            report('REQUEST_INTERCEPTED', { type: 'proxy', url, method, ruleId: proxyRule.id, status: res.status });

            const contentType = headerValue(res.headers, 'content-type');
            if (recording && isTextual(contentType)) {
                const [forPage, forRecorder] = res.body.tee();
                res.body = forPage;
                readAll(forRecorder)
                    .then(bytes => recordBody(url, method, res.status, contentType, textDecoder.decode(bytes)))
                    .catch(() => { });
            }
            return toFetchResponse(res);
        }

        const redirectTarget = rewriteForRedirect(url);
        if (redirectTarget) args = await retargetFetchArgs(redirectTarget, input, init, isRequest);

        const headerNames = new Headers(isRequest ? input.headers : undefined);
        if (init?.headers) new Headers(init.headers).forEach((value, name) => headerNames.set(name, value));
        const announcing = announceHeaders(redirectTarget || url, headerNames.keys());
        if (announcing) await announcing;

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
     * Make an XHR look like it is receiving `head`, honouring responseType and
     * firing readystatechange / progress / load / loadend like the real thing.
     * Feed the body with chunk(), then call end() (or fail()).
     */
    function beginXhrResponse(xhr, head) {
        const st = stateOf(xhr);
        const fake = { readyState: 1, status: 0, statusText: '' };
        st.fake = fake;

        const contentType = headerValue(head.headers, 'content-type') || '';
        const total = parseInt(headerValue(head.headers, 'content-length'), 10) || 0;
        const chunks = [];
        let loaded = 0;
        let textCache = null;
        let finalResponse = null;
        let done = false;

        const bytesSoFar = () => {
            const all = new Uint8Array(loaded);
            let offset = 0;
            for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
            return all;
        };
        const text = () => {
            if (textCache === null || textCache.loaded !== loaded) {
                textCache = { loaded, value: textDecoder.decode(bytesSoFar()) };
            }
            return textCache.value;
        };
        const isTextType = () => xhr.responseType === '' || xhr.responseType === 'text';

        const define = (prop, get) => Object.defineProperty(xhr, prop, { configurable: true, get });
        define('readyState', () => fake.readyState);
        define('status', () => fake.status);
        define('statusText', () => fake.statusText);
        define('responseURL', () => (fake.readyState >= 2 ? head.url || '' : ''));
        define('responseText', () => (fake.readyState >= 3 ? text() : ''));
        define('response', () => {
            if (done) return finalResponse;
            return isTextType() ? (fake.readyState === 3 ? text() : '') : null;
        });
        define('responseXML', () => (done && xhr.responseType === 'document' ? finalResponse : null));
        Object.defineProperty(xhr, 'getResponseHeader', {
            configurable: true,
            value: (name) => (fake.readyState >= 2 ? headerValue(head.headers, String(name)) : null)
        });
        Object.defineProperty(xhr, 'getAllResponseHeaders', {
            configurable: true,
            value: () => (fake.readyState >= 2
                ? head.headers.map(([k, v]) => `${k.toLowerCase()}: ${v}\r\n`).join('')
                : '')
        });

        fake.readyState = 2;
        fake.status = head.status;
        fake.statusText = head.statusText || '';
        fire(xhr, 'readystatechange');

        return {
            chunk(bytes) {
                if (st.aborted || done || !bytes.byteLength) return;
                chunks.push(bytes);
                loaded += bytes.byteLength;
                fake.readyState = 3;
                fire(xhr, 'readystatechange');
                fire(xhr, 'progress', loaded, total || loaded);
            },
            end() {
                if (st.aborted || done) return;
                const all = bytesSoFar();
                switch (xhr.responseType) {
                    case 'json':
                        try { finalResponse = JSON.parse(text()); } catch { finalResponse = null; }
                        break;
                    case 'arraybuffer':
                        finalResponse = all.buffer;
                        break;
                    case 'blob':
                        finalResponse = new Blob([all], { type: contentType });
                        break;
                    case 'document':
                        finalResponse = new DOMParser().parseFromString(text(), /xml/i.test(contentType) ? 'application/xml' : 'text/html');
                        break;
                    default:
                        finalResponse = text();
                }
                done = true;
                st.pending = false;
                fake.readyState = 4;
                fire(xhr, 'readystatechange');
                fire(xhr, 'load', loaded, total || loaded);
                fire(xhr, 'loadend', loaded, total || loaded);
            },
            text,
            fail() {
                if (st.aborted || done) return;
                done = true;
                failXhr(xhr);
            }
        };
    }

    /**
     * Deliver a complete synthetic response (mocks)
     */
    function fulfillXhr(xhr, res) {
        const response = beginXhrResponse(xhr, res);
        if (stateOf(xhr).aborted) return;
        response.chunk(res.body || new Uint8Array(0));
        response.end();
    }

    function failXhr(xhr) {
        const st = stateOf(xhr);
        st.pending = false;
        st.fake = { readyState: 4, status: 0, statusText: '' };
        Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => st.fake.readyState });
        Object.defineProperty(xhr, 'status', { configurable: true, get: () => 0 });
        fire(xhr, 'readystatechange');
        fire(xhr, 'error');
        fire(xhr, 'loadend');
    }

    /**
     * Upload events for a body the page "sent" (it went via the extension)
     */
    function fireUploadEvents(xhr, size) {
        if (!size) return;
        for (const type of ['loadstart', 'progress', 'load', 'loadend']) {
            const loaded = type === 'loadstart' ? 0 : size;
            xhr.upload.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded, total: size }));
        }
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
        // Rules still match the original URL; the network call goes to the
        // redirect target when a rule would otherwise taint the origin
        const target = rewriteForRedirect(st.url) || url;
        st.networkUrl = resolveUrl(target) || st.url;
        return originalOpen.call(this, method, target, ...(arguments.length > 2 ? [async, ...rest] : []));
    };

    /**
     * Hand the XHR to the browser, capturing the response body if recording
     */
    function xhrSendForReal(xhr, body, url, method) {
        if (recording) {
            xhr.addEventListener('load', () => {
                const rt = xhr.responseType;
                if (rt !== '' && rt !== 'text' && rt !== 'json') return;
                const contentType = xhr.getResponseHeader('content-type');
                if (!isTextual(contentType)) return;
                const text = rt === 'json' ? JSON.stringify(xhr.response) : xhr.responseText;
                recordBody(url, method, xhr.status, contentType, text);
            }, { once: true });
        }
        return originalSend.call(xhr, body);
    }

    xhrProto.setRequestHeader = function (name, value) {
        stateOf(this).headers.push([String(name), String(value)]);
        return originalSetRequestHeader.call(this, name, value);
    };

    xhrProto.abort = function () {
        const st = stateOf(this);
        if (st.pending) {
            st.aborted = true;
            st.pending = false;
            st.abortController?.abort();
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
        const announcing = !mockRule && !proxyRule &&
            announceHeaders(st.networkUrl || url, st.headers.map(([name]) => name));

        if (!delayRule && !mockRule && !proxyRule) {
            if (announcing) {
                // Let Nariya allow the new header names, then send for real
                st.pending = true;
                announcing.then(() => {
                    if (st.aborted) return;
                    st.pending = false;
                    xhrSendForReal(this, body, url, method);
                });
                return;
            }
            return xhrSendForReal(this, body, url, method);
        }

        st.pending = true;
        const xhr = this;
        if (mockRule || proxyRule) fire(xhr, 'loadstart');

        (async () => {
            if (announcing) await announcing;
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
                st.abortController = new AbortController();
                const bodySize = serialized.body?.byteLength || 0;
                const res = await proxyThroughExtension({
                    url, method, headers,
                    body: serialized.body,
                    credentials: credentialsFor(url, xhr.withCredentials ? 'include' : 'same-origin')
                }, st.abortController.signal);
                if (st.aborted) return;
                fireUploadEvents(xhr, bodySize);
                report('REQUEST_INTERCEPTED', { type: 'proxy', url, method, ruleId: proxyRule.id, status: res.status });

                const response = beginXhrResponse(xhr, res);
                const reader = res.body.getReader();
                try {
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done || st.aborted) break;
                        response.chunk(value);
                    }
                } catch {
                    if (!st.aborted) response.fail();
                    return;
                }
                if (st.aborted) return;
                response.end();
                const contentType = headerValue(res.headers, 'content-type');
                if (isTextual(contentType)) recordBody(url, method, res.status, contentType, response.text());
                return;
            }

            // Delay only: now send for real
            st.pending = false;
            xhrSendForReal(xhr, body, url, method);
        })().catch((err) => {
            if (st.aborted) return;
            console.warn('[Nariya] Interceptor error:', err);
            st.pending = false;
            failXhr(xhr);
        });
    };
})();
