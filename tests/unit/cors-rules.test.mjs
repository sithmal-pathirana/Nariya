import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSites, buildCorsRules, CORS_RULE_ID_BASE } from '../../core/cors-bypass.js';
import { sitesToMatchPatterns } from '../../background/content-scripts.js';

test('normalizeSites accepts hosts, URLs and wildcards', () => {
    assert.deepEqual(
        normalizeSites('localhost\nhttps://Dev.Example.com:8443/app, *.foo.io [::1]:3000'),
        ['localhost', 'dev.example.com', 'foo.io', '[::1]']
    );
});

test('buildCorsRules: exact origin, credentials, host + per-tab rules', () => {
    const rules = buildCorsRules({
        sites: ['localhost'],
        tabs: [
            { id: 7, url: 'http://localhost:3000/app' },
            { id: 8, url: 'http://localhost:5173/' },
            { id: 9, url: 'https://mail.google.com/' }
        ],
        rememberedOrigins: ['http://localhost:3000', 'http://localhost:5173', 'https://evil.com'],
        allowHeaders: ['*', 'authorization']
    });

    assert.equal(rules.length, 3, 'one host rule + two tab rules; google and evil.com untouched');
    const [host, tabA, tabB] = rules;
    assert.equal(host.id, CORS_RULE_ID_BASE);
    assert.deepEqual(host.condition.initiatorDomains, ['localhost']);
    assert.equal(host.condition.tabIds, undefined);

    const header = (rule, name) => rule.action.responseHeaders.find(h => h.header === name);
    assert.equal(header(host, 'Access-Control-Allow-Origin').value, 'http://localhost:5173', 'most recent origin');
    assert.equal(header(tabA, 'Access-Control-Allow-Origin').value, 'http://localhost:3000');
    assert.deepEqual(tabA.condition.tabIds, [7]);
    assert.ok(tabA.priority > host.priority);
    assert.equal(header(tabB, 'Access-Control-Allow-Credentials').value, 'true');
    assert.equal(header(tabB, 'Access-Control-Allow-Headers').operation, 'append');
    for (const rule of rules) {
        assert.notEqual(header(rule, 'Access-Control-Allow-Origin').value, '*');
    }
});

test('sitesToMatchPatterns', () => {
    assert.deepEqual(sitesToMatchPatterns([]), ['<all_urls>']);
    assert.deepEqual(sitesToMatchPatterns(['localhost', '127.0.0.1']), ['*://localhost/*', '*://*.localhost/*', '*://127.0.0.1/*']);
});
