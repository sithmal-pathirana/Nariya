/**
 * Request recorder → Postman collection, and the dashboard UI around it
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launchExtension, sleep } from '../helpers/extension.mjs';
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

test('records a tab\'s fetch/XHR calls with bodies and exports Postman', async () => {
    const page = await ext.open(DEV);
    const tabId = await ext.worker.evaluate(async (url) => (await chrome.tabs.query({})).find(t => t.url.startsWith(url)).id, DEV);

    await ext.send('RECORDER_CLEAR');
    await ext.send('RECORDER_START', { tabId });
    await sleep(500); // interceptor registration + injection

    await page.evaluate(`(async () => {
        await fetch('${API}/users', { headers: { Authorization: 'Bearer abc' } }).then(r => r.json());
        await fetch('${API}/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ada' }) }).then(r => r.text());
        await new Promise(res => { const x = new XMLHttpRequest(); x.open('GET', '${API}/items/7'); x.onload = res; x.send(); });
    })()`);
    await sleep(1500);

    // A second, unrecorded tab
    const other = await ext.open(DEV);
    await other.evaluate(`fetch('${API}/not-recorded')`);
    await sleep(300);

    const { data } = await ext.send('RECORDER_GET');
    const byPath = Object.fromEntries(data.entries.map(e => [new URL(e.url).pathname, e]));
    assert.ok(byPath['/users'] && byPath['/echo'] && byPath['/items/7'], JSON.stringify(Object.keys(byPath)));
    assert.equal(byPath['/not-recorded'], undefined, 'other tab not recorded');
    assert.equal(byPath['/users'].status, 200);
    assert.ok(byPath['/users'].requestHeaders.some(([k, v]) => k.toLowerCase() === 'authorization' && v === 'Bearer abc'));
    assert.equal(byPath['/users'].responseBody, '[{"id":1,"name":"Ada"},{"id":2,"name":"Linus"}]');
    assert.equal(byPath['/echo'].requestBody.text, '{"name":"Ada"}');
    assert.match(byPath['/items/7'].responseBody, /"path":"\/items\/7"/);
    assert.equal(data.entries.filter(e => e.method === 'OPTIONS').length, 0, 'preflights skipped');

    await ext.send('RECORDER_STOP');
    await page.close();
    await other.close();
});

test('dashboard: recorder tab exports a Postman collection; no console errors', async () => {
    const dash = await ext.context.newPage();
    const errors = [];
    dash.on('pageerror', e => errors.push(e.message));
    dash.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await dash.goto(`chrome-extension://${ext.extensionId}/ui/dashboard/dashboard.html`);
    await sleep(500);

    await dash.click('.nav-item[data-tab="recorder"]');
    await sleep(300);
    const rows = await dash.$$eval('#recorderTableBody tr', trs => trs.length);
    assert.ok(rows >= 3, `rows: ${rows}`);

    const [download] = await Promise.all([
        dash.waitForEvent('download'),
        dash.click('#recorderExportPostmanBtn')
    ]);
    assert.match(download.suggestedFilename(), /\.postman_collection\.json$/);
    const fs = await import('node:fs/promises');
    const collection = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.match(collection.info.schema, /v2\.1\.0/);
    const names = collection.item.map(i => i.name);
    assert.ok(names.includes('GET /users') && names.includes('POST /echo'), names.join(', '));
    const users = collection.item.find(i => i.name === 'GET /users');
    assert.ok(users.event[0].script.exec.join('\n').includes('to.be.an("array")'));

    // Settings: CORS panel and new fields render
    await dash.click('.nav-item[data-tab="settings"]');
    await sleep(300);
    assert.equal(await dash.inputValue('#corsSitesInput'), 'localhost\n127.0.0.1');
    assert.ok(await dash.isVisible('#corsStatusPanel'));
    assert.equal(await dash.inputValue('#backendUrlInput'), 'http://localhost:8080');

    // Proxy rule type is offered
    assert.ok(await dash.$('#ruleType option[value="proxy"]'));

    assert.deepEqual(errors.filter(e => !/favicon/.test(e)), []);
    await dash.close();
});

test('popup toggles save settings', async () => {
    const popup = await ext.context.newPage();
    await popup.goto(`chrome-extension://${ext.extensionId}/ui/popup/popup.html`);
    await sleep(300);
    await popup.click('#corsToggle + .slider, label:has(#corsToggle)');
    await sleep(300);
    const { data } = await ext.send('GET_SETTINGS');
    assert.equal(data.allowCorsBypass, false);
    assert.equal(data.updates, undefined);
    await ext.send('UPDATE_SETTINGS', { allowCorsBypass: true });
    await popup.close();
});
