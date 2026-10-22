/**
 * Rules file mirror (folder), cloud mocks, rule templates, and the packaged
 * (Web Store) build
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { launchExtension, fetchExpr, sleep, EXTENSION_DIR } from '../helpers/extension.mjs';
import { startAppServer } from '../helpers/servers.mjs';
import { buildZip, collectFiles } from '../../tools/package.mjs';

let ext, app, DEV;

before(async () => {
    app = await startAppServer();
    DEV = `http://localhost:${app.port}`;
    ext = await launchExtension();
});

after(async () => {
    await ext?.close();
    app?.server.close();
});

test('folder storage: every rule change is written to nariya_rules.json', async () => {
    // A real folder needs the OS picker; the origin-private file system gives
    // the same kind of directory handle without a dialog
    await ext.extPage.evaluate(async () => {
        const { saveDirectoryHandle } = await import('/core/storage/mirror.js');
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('rules-test', { create: true });
        await saveDirectoryHandle(dir);
    });
    await ext.send('UPDATE_SETTINGS', { storageEngine: 'native', enableCloudSync: false });
    await ext.send('SAVE_RULE', { type: 'delay', urlFilter: '/mirror-check', config: { name: 'Mirrored rule', delayMs: 5 } });
    await sleep(1500); // debounce + write from the service worker

    const written = await ext.extPage.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('rules-test');
        const file = await (await dir.getFileHandle('nariya_rules.json')).getFile();
        return JSON.parse(await file.text());
    });
    assert.ok(written.some(r => r.config?.name === 'Mirrored rule'), JSON.stringify(written));

    const { data: status } = await ext.send('MIRROR_STATUS');
    assert.equal(status.ok, true);
    assert.equal(status.engine, 'native');

    // Rules already in a folder can be read back for import
    const readBack = await ext.extPage.evaluate(async () => {
        const { readRulesFromDirectory } = await import('/core/storage/mirror.js');
        const root = await navigator.storage.getDirectory();
        return (await readRulesFromDirectory(await root.getDirectoryHandle('rules-test'))).length;
    });
    assert.ok(readBack >= 1);

    await ext.send('CLEAR_ALL_RULES');
    await ext.send('UPDATE_SETTINGS', { storageEngine: 'browser' });
});

test('cloud mock: body is fetched from the backend\'s signed URL', async (t) => {
    const seen = [];
    const backend = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        seen.push({ path: url.pathname, auth: req.headers.authorization });
        if (url.pathname === '/api/mocks/url') {
            if (req.headers.authorization !== 'Bearer test-session') {
                res.writeHead(401);
                return res.end('{"error":"Unauthorized"}');
            }
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ signedUrl: `http://127.0.0.1:${backend.address().port}/object/${url.searchParams.get('key')}` }));
        }
        if (url.pathname.startsWith('/object/')) {
            res.setHeader('Content-Type', 'text/csv');
            return res.end('id,name\n1,Ada\n');
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise(r => backend.listen(0, '127.0.0.1', r));
    t.after(() => backend.close());

    await ext.worker.evaluate(() => chrome.storage.local.set({ sessionToken: 'test-session' }));
    await ext.send('UPDATE_SETTINGS', { backendUrl: `http://127.0.0.1:${backend.address().port}` });
    await ext.send('SAVE_RULE', { type: 'mock', urlFilter: '/report.csv', config: { name: 'cloud', statusCode: 200, cloudKey: 'user_1/mocks/report.csv' } });

    const page = await ext.open(DEV);
    const result = await page.evaluate(`fetch('/report.csv').then(async r => r.status + '|' + r.headers.get('content-type') + '|' + await r.text())`);
    assert.equal(result, '200|text/csv|id,name\n1,Ada\n');
    assert.ok(seen.some(s => s.path === '/api/mocks/url' && s.auth === 'Bearer test-session'));
    await page.close();

    await ext.send('CLEAR_ALL_RULES');
    await ext.worker.evaluate(() => chrome.storage.local.remove('sessionToken'));
    await ext.send('UPDATE_SETTINGS', { backendUrl: 'http://localhost:8080' });
});

test('rule templates open from the Rules tab', async () => {
    const dash = await ext.context.newPage();
    const errors = [];
    dash.on('pageerror', e => errors.push(e.message));
    await dash.goto(`chrome-extension://${ext.extensionId}/ui/dashboard/dashboard.html`);
    await sleep(400);
    await dash.click('#openTemplatesBtn');
    assert.ok(await dash.isVisible('#templatesModal'));
    await dash.click('.template-card[data-template="mock500"]');
    await sleep(200);
    assert.ok(await dash.isVisible('#ruleModal'));
    assert.equal(await dash.inputValue('#ruleType'), 'mock');
    assert.equal(await dash.inputValue('#ruleUrlFilter'), '/api/*');
    assert.deepEqual(errors, []);
    await dash.close();
});

test('packaged build (store zip contents) loads and works', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nariya-pkg-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of collectFiles()) {
        fs.mkdirSync(path.join(dir, path.dirname(name)), { recursive: true });
        fs.copyFileSync(path.join(EXTENSION_DIR, name), path.join(dir, name));
    }
    assert.ok(!fs.existsSync(path.join(dir, 'tests')) && !fs.existsSync(path.join(dir, 'backend')));
    assert.ok(buildZip(collectFiles().map(name => ({ name, data: fs.readFileSync(path.join(EXTENSION_DIR, name)) }))).length > 1000);

    const packaged = await launchExtension({ dir });
    t.after(() => packaged.close());
    await packaged.send('SAVE_RULE', { type: 'mock', urlFilter: '/api/*', config: { name: 'm', statusCode: 418, body: '{}' } });
    const page = await packaged.open(DEV);
    assert.equal(await page.evaluate(fetchExpr('/api/x')), '418');
});
