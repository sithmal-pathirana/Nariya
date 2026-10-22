/**
 * In-page interceptor: mocks, delays, proxy mode, the private channel and
 * on-demand registration.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension, fetchExpr, sleep } from '../helpers/extension.mjs';
import { startAppServer, startApiServer } from '../helpers/servers.mjs';

let ext, app, api, API, DEV;

before(async () => {
    app = await startAppServer();
    DEV = `http://localhost:${app.port}`;
    api = await startApiServer();
    API = `http://api.test:${api.port}`;
    ext = await launchExtension();
});

after(async () => {
    await ext?.close();
    app?.server.close();
    api?.server.close();
});

beforeEach(async () => {
    await ext.send('CLEAR_ALL_RULES');
    await ext.send('UPDATE_SETTINGS', { interceptorSites: [], globalEnabled: true });
});

const xhrExpr = (url, { method = 'GET', responseType = '', headers = {}, body = null, withCredentials = false } = {}) => `
    new Promise(res => {
        const x = new XMLHttpRequest();
        const events = [];
        x.open(${JSON.stringify(method)}, ${JSON.stringify(url)});
        x.responseType = ${JSON.stringify(responseType)};
        x.withCredentials = ${withCredentials};
        for (const [k, v] of Object.entries(${JSON.stringify(headers)})) x.setRequestHeader(k, v);
        x.onreadystatechange = () => events.push('rs' + x.readyState);
        x.addEventListener('load', () => events.push('load'));
        x.addEventListener('loadend', () => res(JSON.stringify({
            status: x.status, statusText: x.statusText, response: x.response,
            ct: x.getResponseHeader('content-type'), custom: x.getResponseHeader('x-mock'),
            all: x.getAllResponseHeaders(), events
        })));
        x.send(${body === null ? 'null' : JSON.stringify(body)});
    })`;

test('no rules: the page keeps the native fetch/XHR', async () => {
    const page = await ext.open(DEV);
    assert.equal(await page.evaluate('window.__nariya_interceptor_installed__'), undefined);
    assert.match(await page.evaluate('Function.prototype.toString.call(window.fetch)'), /\[native code\]/);
    await page.close();
});

test('mock rule: fetch (string and Request) and XHR get the mocked response', async () => {
    await ext.send('SAVE_RULE', {
        type: 'mock', urlFilter: '/api/*',
        config: { name: 'm', statusCode: 418, statusText: 'Teapot', body: '{"mock":true}', headers: { 'X-Mock': 'yes' } }
    });
    const page = await ext.open(DEV);
    assert.equal(await page.evaluate(fetchExpr('/api/x', {}, 'json')), '[418,{"mock":true}]');
    assert.equal(await page.evaluate(`fetch(new Request('/api/x', { method: 'POST', body: 'a' })).then(r => r.status + ' ' + r.statusText + ' ' + r.headers.get('x-mock'))`), '418 Teapot yes');

    const xhr = JSON.parse(await page.evaluate(xhrExpr('/api/y', { responseType: 'json' })));
    assert.equal(xhr.status, 418);
    assert.deepEqual(xhr.response, { mock: true });
    assert.equal(xhr.ct, 'application/json');
    assert.equal(xhr.custom, 'yes');
    assert.match(xhr.all, /x-mock: yes\r\n/);
    assert.deepEqual(xhr.events, ['rs2', 'rs3', 'rs4', 'load']);

    const text = JSON.parse(await page.evaluate(xhrExpr('/api/z')));
    assert.equal(text.response, '{"mock":true}');

    // Non-matching requests (with a Request body) still go to the network
    assert.equal(await page.evaluate(`fetch(new Request('/other', { method: 'POST', body: 'a' })).then(r => String(r.status))`), '200');
    await page.close();
});

test('mock rule honours its delay and default content type', async () => {
    await ext.send('SAVE_RULE', {
        type: 'mock', urlFilter: '/slow', config: { name: 'slow', statusCode: 200, body: 'hi', delayMs: 600 }
    });
    const page = await ext.open(DEV);
    const took = await page.evaluate(`(async () => { const t = performance.now(); const r = await fetch('/slow'); await r.text(); return performance.now() - t; })()`);
    assert.ok(took >= 550, `took ${took}ms`);
    assert.equal(await page.evaluate(`fetch('/slow').then(r => r.headers.get('content-type'))`), 'application/json');
    await page.close();
});

test('delay rule delays the real request', async () => {
    await ext.send('SAVE_RULE', { type: 'delay', urlFilter: '/delayed', config: { name: 'd', delayMs: 500 } });
    const page = await ext.open(DEV);
    const took = await page.evaluate(`(async () => { const t = performance.now(); await fetch('/delayed'); return performance.now() - t; })()`);
    assert.ok(took >= 450, `took ${took}ms`);
    await page.close();
});

test('proxy rule: requests the server would reject at preflight succeed', async () => {
    await ext.send('SAVE_RULE', { type: 'proxy', urlFilter: `api.test:${api.port}/`, config: { name: 'p' } });
    const page = await ext.open(DEV);

    // /no-options answers OPTIONS with 405, which no header rule can fix
    assert.equal(await page.evaluate(fetchExpr(API + '/no-options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })), '200');

    const echoed = JSON.parse(await page.evaluate(`fetch('${API}/echo?q=1', {
        method: 'PUT', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: '{"a":1}'
    }).then(r => r.text())`));
    assert.equal(echoed.method, 'PUT');
    assert.equal(echoed.headers.authorization, 'Bearer t');
    assert.equal(echoed.body, '{"a":1}');
    assert.equal(echoed.query, '?q=1');
    // The API sees the page's origin, not chrome-extension://
    assert.equal(echoed.headers.origin, DEV);

    const xhr = JSON.parse(await page.evaluate(xhrExpr(API + '/echo', {
        method: 'POST', responseType: 'json', headers: { 'X-Custom': 'c' }, body: 'plain'
    })));
    assert.equal(xhr.status, 200);
    assert.equal(xhr.response.headers['x-custom'], 'c');
    assert.equal(xhr.response.body, 'plain');

    const form = JSON.parse(await page.evaluate(`(() => { const f = new FormData(); f.append('k', 'v'); return fetch('${API}/echo', { method: 'POST', body: f }).then(r => r.text()); })()`));
    assert.match(form.headers['content-type'], /multipart\/form-data; boundary=/);
    assert.match(form.body, /name="k"\r\n\r\nv/);

    // Response headers are all readable (no CORS exposure limits)
    assert.equal(await page.evaluate(`fetch('${API}/a').then(r => r.headers.get('x-server'))`), 'nariya-test');
    await page.close();
});

test('proxy streams responses, reports progress and supports abort', async () => {
    await ext.send('SAVE_RULE', { type: 'proxy', urlFilter: `api.test:${api.port}/`, config: { name: 'p' } });
    const page = await ext.open(DEV);

    // fetch: the first chunk arrives long before the response ends
    const timing = JSON.parse(await page.evaluate(`(async () => {
        const t0 = performance.now();
        const res = await fetch('${API}/stream');
        const reader = res.body.getReader();
        const first = await reader.read();
        const tFirst = performance.now() - t0;
        let text = new TextDecoder().decode(first.value);
        for (;;) { const { done, value } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
        return JSON.stringify({ tFirst, tAll: performance.now() - t0, text });
    })()`));
    assert.equal(timing.text, 'chunk0\nchunk1\nchunk2\n');
    assert.ok(timing.tFirst < timing.tAll - 400, JSON.stringify(timing));

    // XHR: progress per chunk, upload events for the body
    const xhr = JSON.parse(await page.evaluate(`new Promise(res => {
        const x = new XMLHttpRequest();
        const ev = { progress: 0, upload: [], partial: [] };
        x.open('POST', '${API}/stream');
        x.upload.onloadstart = () => ev.upload.push('loadstart');
        x.upload.onload = () => ev.upload.push('load');
        x.onprogress = () => { ev.progress++; ev.partial.push(x.responseText.length); };
        x.onload = () => res(JSON.stringify({ ...ev, text: x.responseText }));
        x.send('payload');
    })`));
    assert.ok(xhr.progress >= 3, JSON.stringify(xhr));
    assert.deepEqual(xhr.upload, ['loadstart', 'load']);
    assert.ok(xhr.partial[0] < xhr.text.length, 'responseText grows while loading');

    // Abort mid-stream: the page sees AbortError and the server sees the hang-up
    api.log.length = 0;
    const aborted = await page.evaluate(`(async () => {
        const ctl = new AbortController();
        const res = await fetch('${API}/stream', { signal: ctl.signal });
        const reader = res.body.getReader();
        await reader.read();
        ctl.abort();
        try { await reader.read(); return 'not aborted'; } catch (e) { return e.name; }
    })()`);
    assert.equal(aborted, 'AbortError');
    await sleep(500);
    assert.ok(api.log.some(l => l.path === '/stream' && l.aborted), 'server saw the client abort');
    await page.close();
});

test('proxy: two dev origins calling one API at once each send their own Origin', async (t) => {
    await ext.send('SAVE_RULE', { type: 'proxy', urlFilter: `api.test:${api.port}/`, config: { name: 'p' } });
    const app2 = await startAppServer();
    t.after(() => app2.server.close());
    const DEV2 = `http://localhost:${app2.port}`;
    const a = await ext.open(DEV);
    const b = await ext.open(DEV2);
    const call = (page) => page.evaluate(`Promise.all([1, 2, 3].map(i => fetch('${API}/slow-origin?ms=300&i=' + i).then(r => r.json()).then(j => j.origin)))`);
    const [fromA, fromB] = await Promise.all([call(a), call(b)]);
    assert.deepEqual(fromA, [DEV, DEV, DEV]);
    assert.deepEqual(fromB, [DEV2, DEV2, DEV2]);
    await a.close();
    await b.close();
});

test('proxy is refused for pages outside the CORS bypass sites', async () => {
    await ext.send('SAVE_RULE', { type: 'proxy', urlFilter: `api.test:${api.port}/`, config: { name: 'p' } });
    const page = await ext.open(`http://other.test:${app.port}`);
    assert.match(await page.evaluate(fetchExpr(API + '/no-options', { method: 'POST', body: '{}' })), /^FAIL/);
    await page.close();
});

test('page scripts cannot hijack the channel or forge rules', async () => {
    await ext.send('SAVE_RULE', { type: 'mock', urlFilter: '/api/*', config: { name: 'm', statusCode: 418, body: '{}' } });
    const page = await ext.open(DEV);
    // Old window.postMessage protocol no longer does anything
    await page.evaluate(`window.postMessage({ source: 'nariya-bridge', type: 'UPDATE_INTERCEPTOR_RULES', payload: { rules: [{ type: 'mock', urlFilter: '/evil', config: { statusCode: 299 } }] } }, '*')`);
    // Asking for a new port after the handshake must not steal it
    const stolen = await page.evaluate(`new Promise(res => {
        let got = false;
        document.addEventListener('nariya:port', e => { got = !!(e.ports && e.ports[0]); }, true);
        document.dispatchEvent(new Event('nariya:hello'));
        setTimeout(() => res(got), 100);
    })`);
    assert.equal(stolen, false);
    await sleep(200);
    assert.equal(await page.evaluate(fetchExpr('/evil')), '200');
    assert.equal(await page.evaluate(fetchExpr('/api/x')), '418');
    await page.close();
});

test('interceptor only runs on the listed sites', async () => {
    await ext.send('SAVE_RULE', { type: 'mock', urlFilter: '/api/*', config: { name: 'm', statusCode: 418, body: '{}' } });
    await ext.send('UPDATE_SETTINGS', { interceptorSites: ['other.test'] });
    const dev = await ext.open(DEV);
    assert.equal(await dev.evaluate('window.__nariya_interceptor_installed__'), undefined);
    const other = await ext.open(`http://other.test:${app.port}`);
    assert.equal(await other.evaluate(fetchExpr('/api/x')), '418');
    await dev.close();
    await other.close();
});

test('removing the last rule unregisters the interceptor', async () => {
    const { data } = await ext.send('SAVE_RULE', { type: 'delay', urlFilter: '/x', config: { name: 'd', delayMs: 10 } });
    const registered = () => ext.worker.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map(s => s.id));
    assert.deepEqual(await registered(), ['nariya-interceptor']);
    await ext.send('DELETE_RULE', { id: data.id });
    assert.deepEqual(await registered(), []);
});
