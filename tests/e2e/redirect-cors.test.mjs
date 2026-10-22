/**
 * Redirect rules that send a site's API calls to another origin (e.g.
 * staging → http://localhost:8081) must not then fail on CORS.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension, sleep } from '../helpers/extension.mjs';
import { startAppServer, startApiServer } from '../helpers/servers.mjs';

let ext, app, api, API;

before(async () => {
    app = await startAppServer();
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
    await ext.worker.evaluate(() => chrome.storage.local.remove(['nariya_cors_auto_sites', 'nariya_cors_learned_headers']));
});

// Same-origin XHR, like the app in the bug report (custom auth header)
const xhrExpr = (path, { withCredentials = false } = {}) => `new Promise(res => {
    const x = new XMLHttpRequest();
    x.open('GET', ${JSON.stringify(path)});
    x.withCredentials = ${withCredentials};
    x.setRequestHeader('authorization-provider', 'keycloak');
    x.setRequestHeader('Content-Type', 'application/json');
    x.onload = () => res(x.status + ' ' + x.responseText);
    x.onerror = () => res('FAIL');
    x.send();
})`;

function replaceRule(sourceOrigin) {
    return {
        type: 'redirect',
        urlFilter: `${sourceOrigin}/tbx-setup/supplier/`,
        config: {
            name: 'staging → local',
            redirectMode: 'replace',
            matchPattern: `${sourceOrigin}/tbx-setup/supplier/`,
            redirectUrl: `${API}/`,
            resourceTypes: ['xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'main_frame', 'sub_frame', 'media', 'websocket', 'other']
        }
    };
}

test('page calling its own host, redirected to another origin, works on the first try', async () => {
    const SITE = `http://central.test:${app.port}`;
    await ext.send('SAVE_RULE', replaceRule(SITE));
    const page = await ext.open(SITE);

    const result = await page.evaluate(xhrExpr('/tbx-setup/supplier/supplier-service/v2/accom?h2hCode=198'));
    assert.match(result, /^200 .*"path":"\/supplier-service\/v2\/accom"/, result + '\n' + page.errors.join('\n'));
    const seen = api.log.find(l => l.method === 'GET' && l.path === '/supplier-service/v2/accom');
    assert.equal(seen.headers['authorization-provider'], 'keycloak');

    const { data } = await ext.send('CORS_GET_STATUS');
    assert.ok(data.autoSites.includes('central.test'), JSON.stringify(data.autoSites));
    await page.close();
});

test('credentialed request with a custom header works after the header is learned', async () => {
    const SITE = `http://central.test:${app.port}`;
    await ext.send('SAVE_RULE', replaceRule(SITE));
    const page = await ext.open(SITE);
    await page.evaluate(xhrExpr('/tbx-setup/supplier/a', { withCredentials: true }));
    await sleep(300);
    assert.match(await page.evaluate(xhrExpr('/tbx-setup/supplier/a', { withCredentials: true })), /^200 /);
    await page.close();
});

test('page on a different host than the redirected API is picked up at runtime', async () => {
    // Page app.test calls https?://backend.test/..., which the rule sends to the API
    const PAGE = `http://app.test:${app.port}`;
    const BACKEND = `http://backend.test:${app.port}`;
    await ext.send('SAVE_RULE', replaceRule(BACKEND));
    const page = await ext.open(PAGE);
    await page.evaluate(xhrExpr(`${BACKEND}/tbx-setup/supplier/b`));
    await sleep(400);
    const second = await page.evaluate(xhrExpr(`${BACKEND}/tbx-setup/supplier/b`));
    assert.match(second, /^200 /, second + '\n' + page.errors.join('\n'));
    const { data } = await ext.send('CORS_GET_STATUS');
    assert.ok(data.autoSites.includes('app.test'), JSON.stringify(data.autoSites));
    await page.close();
});

test('listed site calling another host that a rule redirects works on the first try', async () => {
    // localhost is a bypass site by default, so the page script is already there
    const PAGE = `http://localhost:${app.port}`;
    const BACKEND = `http://backend.test:${app.port}`;
    await ext.send('SAVE_RULE', replaceRule(BACKEND));
    await sleep(300);
    const page = await ext.open(PAGE);

    const installed = await page.evaluate('!!window.__nariya_interceptor_installed__');
    const first = await page.evaluate(xhrExpr(`${BACKEND}/tbx-setup/supplier/c`, { withCredentials: true }));
    assert.match(first, /^200 .*"path":"\/c"/, `installed=${installed} ${first}\n${page.errors.join('\n')}`);
    const viaFetch = await page.evaluate(`fetch(new Request('${BACKEND}/tbx-setup/supplier/echo?x=1', {
        method: 'POST', credentials: 'include', headers: { 'authorization-provider': 'k' }, body: 'hello'
    })).then(r => r.json()).then(j => j.method + ' ' + j.body + ' ' + j.headers.origin + ' ' + j.query)`);
    assert.equal(viaFetch, `POST hello ${PAGE} ?x=1`);
    await page.close();
});

test('dashboard shows automatic sites', async () => {
    const SITE = `http://central.test:${app.port}`;
    await ext.send('SAVE_RULE', replaceRule(SITE));
    const dash = await ext.context.newPage();
    await dash.goto(`chrome-extension://${ext.extensionId}/ui/dashboard/dashboard.html`);
    await dash.click('.nav-item[data-tab="settings"]');
    await sleep(400);
    assert.match(await dash.textContent('#corsAutoSites'), /central\.test/);
    await dash.close();
});

test('without a redirect rule, unrelated sites stay untouched', async () => {
    const page = await ext.open(`http://other.test:${app.port}`);
    assert.equal(await page.evaluate(xhrExpr(`${API}/x`)), 'FAIL');
    await page.close();
});
