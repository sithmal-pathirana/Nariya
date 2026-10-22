import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPostmanCollection, toHar, pathTemplate, buildTests } from '../../core/postman.js';

const entry = (over = {}) => ({
    id: Math.random().toString(36),
    url: 'https://api.example.com/users/42?expand=true',
    method: 'GET',
    requestHeaders: [['Authorization', 'Bearer secret-token'], ['Accept', 'application/json'], ['Cookie', 'sid=1'], ['sec-ch-ua', 'x']],
    requestBody: null,
    status: 200,
    statusText: 'OK',
    responseHeaders: [['Content-Type', 'application/json; charset=utf-8']],
    responseBody: '{"id":42,"name":"Ada"}',
    durationMs: 120,
    startedAt: 1000,
    ...over
});

test('pathTemplate collapses ids and uuids', () => {
    assert.equal(pathTemplate('/users/42/orders/3f2b8c1e-1d2a-4b5c-9d8e-7f6a5b4c3d2e'), '/users/:id/orders/:uuid');
});

test('collection: v2.1 schema, baseUrl variable, redacted bearer token', () => {
    const c = toPostmanCollection([entry()], { name: 'My API' });
    assert.equal(c.info.name, 'My API');
    assert.match(c.info.schema, /v2\.1\.0/);
    const item = c.item[0];
    assert.equal(item.name, 'GET /users/42');
    assert.equal(item.request.url.raw, '{{baseUrl}}/users/42?expand=true');
    assert.deepEqual(item.request.url.query, [{ key: 'expand', value: 'true' }]);
    const headers = Object.fromEntries(item.request.header.map(h => [h.key, h.value]));
    assert.equal(headers.Authorization, 'Bearer {{authToken}}');
    assert.equal(headers.Cookie, undefined);
    assert.equal(headers['sec-ch-ua'], undefined);
    const vars = Object.fromEntries(c.variable.map(v => [v.key, v.value]));
    assert.equal(vars.baseUrl, 'https://api.example.com');
    assert.equal(vars.authToken, '');
    assert.equal(toPostmanCollection([entry()], { redactSecrets: false }).variable.find(v => v.key === 'authToken').value, 'secret-token');
});

test('collection: tests and example response', () => {
    const item = toPostmanCollection([entry()]).item[0];
    const script = item.event[0].script.exec.join('\n');
    assert.match(script, /pm\.response\.to\.have\.status\(200\)/);
    assert.match(script, /include\.keys\("id", "name"\)/);
    assert.match(script, /application\/json/);
    assert.equal(item.response[0].code, 200);
    assert.match(item.response[0].body, /"name": "Ada"/);
});

test('collection: dedupe by endpoint, folders per host', () => {
    const c = toPostmanCollection([
        entry({ url: 'https://api.example.com/users/1', startedAt: 1 }),
        entry({ url: 'https://api.example.com/users/2', startedAt: 2 }),
        entry({ url: 'https://auth.example.com/token', method: 'POST', startedAt: 3 })
    ]);
    assert.equal(c.item.length, 2, 'one folder per host');
    const api = c.item.find(f => f.name === 'api.example.com');
    assert.equal(api.item.length, 1);
    assert.equal(api.item[0].request.url.raw, '{{baseUrl_api_example_com}}/users/2');
    assert.equal(toPostmanCollection([entry({ url: 'https://a.com/x/1' }), entry({ url: 'https://a.com/x/2' })], { dedupe: false }).item.length, 2);
});

test('collection: JSON, urlencoded, multipart and GraphQL bodies', () => {
    const json = toPostmanCollection([entry({ method: 'POST', requestHeaders: [['Content-Type', 'application/json']], requestBody: { text: '{"a":1}' } })]).item[0];
    assert.equal(json.request.body.mode, 'raw');
    assert.equal(json.request.body.options.raw.language, 'json');
    assert.equal(json.request.body.raw, '{\n  "a": 1\n}');

    const form = toPostmanCollection([entry({ method: 'POST', requestHeaders: [['Content-Type', 'application/x-www-form-urlencoded']], requestBody: { text: 'a=1&b=2' } })]).item[0];
    assert.deepEqual(form.request.body.urlencoded, [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);

    const multi = toPostmanCollection([entry({ method: 'POST', requestHeaders: [['Content-Type', 'multipart/form-data; boundary=x']], requestBody: { formData: { k: ['v'] } } })]).item[0];
    assert.equal(multi.request.body.mode, 'formdata');

    const gql = toPostmanCollection([entry({ url: 'https://a.com/graphql', method: 'POST', requestHeaders: [['Content-Type', 'application/json']], requestBody: { text: '{"query":"{ me { id } }","variables":{"x":1}}' } })]).item[0];
    assert.equal(gql.request.body.mode, 'graphql');
    assert.equal(gql.request.body.graphql.query, '{ me { id } }');
});

test('buildTests: array responses and time budget', () => {
    const lines = buildTests(entry({ responseBody: '[{"id":1,"name":"x"}]', durationMs: 900 })).join('\n');
    assert.match(lines, /to\.be\.an\("array"\)/);
    assert.match(lines, /below\(2700\)/);
});

test('HAR export', () => {
    const har = toHar([entry({ method: 'POST', requestBody: { text: '{}' } })]);
    assert.equal(har.log.version, '1.2');
    const e = har.log.entries[0];
    assert.equal(e.request.method, 'POST');
    assert.equal(e.request.postData.text, '{}');
    assert.equal(e.response.status, 200);
    assert.equal(e.response.content.text, '{"id":42,"name":"Ada"}');
});
