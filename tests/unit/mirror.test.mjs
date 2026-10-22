import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeDrive, readDriveRules } from '../../core/storage/mirror.js';

test('writeDrive uploads the JSON and retries once with a fresh token on 401', async () => {
    const calls = [];
    const tokens = ['stale', 'fresh'];
    const dropped = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        return { ok: init.headers.Authorization === 'Bearer fresh', status: init.headers.Authorization === 'Bearer fresh' ? 200 : 401 };
    };
    await writeDrive('[1]', 'file123', { fetchImpl, getToken: async () => tokens.shift(), dropToken: async t => dropped.push(t) });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://www.googleapis.com/upload/drive/v3/files/file123?uploadType=media');
    assert.equal(calls[1].init.method, 'PATCH');
    assert.equal(calls[1].init.body, '[1]');
    assert.deepEqual(dropped, ['stale']);
});

test('writeDrive reports other failures and a missing file id', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403 });
    await assert.rejects(writeDrive('[]', 'f', { fetchImpl, getToken: async () => 't', dropToken: async () => { } }), /HTTP 403/);
    await assert.rejects(writeDrive('[]', null, { fetchImpl }), /not connected/);
});

test('readDriveRules returns the stored array or null', async () => {
    const ok = async () => ({ ok: true, text: async () => '[{"id":"a"}]' });
    assert.deepEqual(await readDriveRules('f', 't', ok), [{ id: 'a' }]);
    const notArray = async () => ({ ok: true, text: async () => '{"x":1}' });
    assert.equal(await readDriveRules('f', 't', notArray), null);
    const missing = async () => ({ ok: false, status: 404 });
    assert.equal(await readDriveRules('f', 't', missing), null);
});
