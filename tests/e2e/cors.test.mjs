/**
 * CORS bypass in a normal Chrome profile (no --disable-web-security)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension, fetchExpr, sleep } from '../helpers/extension.mjs';
import { startAppServer, startApiServer } from '../helpers/servers.mjs';

let ext, app, api, API, DEV, CHAT;

before(async () => {
    app = await startAppServer();
    DEV = `http://localhost:${app.port}`;
    CHAT = `http://chat.test:${app.port}`;
    api = await startApiServer({ properOrigin: CHAT });
    API = `http://api.test:${api.port}`;
    ext = await launchExtension();
});

after(async () => {
    await ext?.close();
    app?.server.close();
    api?.server.close();
});

test('dev site: simple, credentialed and preflighted requests all pass', async () => {
    const page = await ext.open(DEV);
    const cases = {
        simple: [API + '/a', {}],
        credentials: [API + '/a', { credentials: 'include' }],
        authPreflight: [API + '/b', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, body: '{}' }],
        customHeaderWithCreds: [API + '/c', { method: 'PUT', credentials: 'include', headers: { 'X-Api-Key': 'k', 'Content-Type': 'application/json' }, body: '{}' }],
        deleteWithCreds: [API + '/d', { method: 'DELETE', credentials: 'include', headers: { Authorization: 'Bearer x' } }]
    };
    for (const [name, [url, init]] of Object.entries(cases)) {
        assert.equal(await page.evaluate(fetchExpr(url, init)), '200', name);
    }
    const xhr = await page.evaluate(`new Promise(res => { const x = new XMLHttpRequest(); x.open('GET', '${API}/e'); x.withCredentials = true; x.setRequestHeader('Authorization', 'Bearer y'); x.onload = () => res(String(x.status)); x.onerror = () => res('FAIL'); x.send(); })`);
    assert.equal(xhr, '200', 'XHR withCredentials');
    await page.close();
});

test('site with its own correct CORS headers (Google Chat style) is left alone', async () => {
    const page = await ext.open(CHAT);
    assert.equal(await page.evaluate(fetchExpr(API + '/proper', {
        method: 'POST', credentials: 'include',
        headers: { 'X-Goog-AuthUser': '0', 'Content-Type': 'application/json' }, body: '{}'
    })), '200');
    await page.close();
});

test('site not in the list is not bypassed until added', async () => {
    const page = await ext.open(`http://other.test:${app.port}`);
    assert.match(await page.evaluate(fetchExpr(API + '/a')), /^FAIL/);
    await ext.send('UPDATE_SETTINGS', { corsBypassSites: ['localhost', '127.0.0.1', 'other.test'] });
    await page.reload();
    await sleep(300);
    assert.equal(await page.evaluate(fetchExpr(API + '/a', { credentials: 'include' })), '200');
    await ext.send('UPDATE_SETTINGS', { corsBypassSites: ['localhost', '127.0.0.1'] });
    await page.close();
});

test('two dev servers on the same host each get their own origin', async (t) => {
    const app2 = await startAppServer();
    t.after(() => app2.server.close());
    const a = await ext.open(DEV);
    const b = await ext.open(`http://localhost:${app2.port}`);
    assert.equal(await a.evaluate(fetchExpr(API + '/a', { credentials: 'include' })), '200');
    assert.equal(await b.evaluate(fetchExpr(API + '/a', { credentials: 'include' })), '200');
    await a.close();
    await b.close();
});

test('unknown custom header is learned after the first preflight', async () => {
    const page = await ext.open(DEV);
    const init = { method: 'POST', credentials: 'include', headers: { 'X-Weird-Thing': '1' }, body: '{}' };
    await page.evaluate(fetchExpr(API + '/x', init));
    await sleep(300);
    assert.equal(await page.evaluate(fetchExpr(API + '/x', init)), '200');
    const status = await ext.send('CORS_GET_STATUS');
    assert.ok(status.data.learnedHeaders.includes('x-weird-thing'));
    await page.close();
});

test('rejected preflight is reported in the CORS panel with a proxy hint', async () => {
    await ext.send('CORS_CLEAR_PREFLIGHTS');
    const page = await ext.open(DEV);
    assert.match(await page.evaluate(fetchExpr(API + '/no-options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
    })), /^FAIL/);
    await sleep(300);
    const { data } = await ext.send('CORS_GET_STATUS');
    const entry = data.preflights.find(p => p.url.endsWith('/no-options'));
    assert.ok(entry, 'preflight logged');
    assert.equal(entry.status, 405);
    assert.equal(entry.ok, false);
    assert.match(entry.hint, /Proxy/);
    assert.ok(data.origins.includes(DEV));
    await page.close();
});

test('turning the bypass off restores normal CORS', async () => {
    const page = await ext.open(DEV);
    await ext.send('UPDATE_SETTINGS', { allowCorsBypass: false });
    assert.match(await page.evaluate(fetchExpr(API + '/a')), /^FAIL/);
    await ext.send('UPDATE_SETTINGS', { allowCorsBypass: true });
    assert.equal(await page.evaluate(fetchExpr(API + '/a', { credentials: 'include' })), '200');
    await page.close();
});
