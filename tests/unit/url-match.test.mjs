import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesUrl, dnrUrlFilterToRegExp, dnrRuleMatches, pickAppliedRules } from '../../core/url-match.js';

test('matchesUrl: wildcards match anywhere, like DNR urlFilter', () => {
    assert.ok(matchesUrl('https://host/api/users?x=1', '/api/*'));
    assert.ok(matchesUrl('https://host/api/users', '*/api/*'));
    assert.ok(!matchesUrl('https://host/other', '/api/*'));
});

test('matchesUrl: exact, query-less and substring', () => {
    assert.ok(matchesUrl('https://a.com/x?y=1', 'https://a.com/x'));
    assert.ok(matchesUrl('https://a.com/x', 'a.com/x'));
    assert.ok(!matchesUrl('https://a.com/x', ''));
});

test('dnrUrlFilterToRegExp: anchors and separators', () => {
    assert.ok(dnrUrlFilterToRegExp('||example.com^').test('https://api.example.com/v1'));
    assert.ok(dnrUrlFilterToRegExp('||example.com^').test('https://example.com'));
    assert.ok(!dnrUrlFilterToRegExp('||example.com^').test('https://notexample.com/'));
    assert.ok(dnrUrlFilterToRegExp('|https://a.com/').test('https://a.com/x'));
    assert.ok(!dnrUrlFilterToRegExp('|https://a.com/').test('http://b.com/?https://a.com/'));
    assert.ok(dnrUrlFilterToRegExp('*.json|').test('https://a.com/data.json'));
    assert.ok(!dnrUrlFilterToRegExp('*.json|').test('https://a.com/data.json?x'));
    assert.ok(dnrUrlFilterToRegExp('*api*').test('https://a.com/api/v1'));
});

test('dnrRuleMatches: resource types, methods and regex rules', () => {
    const rule = { condition: { urlFilter: '*api*', resourceTypes: ['xmlhttprequest'] } };
    assert.ok(dnrRuleMatches(rule, { url: 'https://a.com/api', type: 'xmlhttprequest', method: 'GET', tabId: 1 }));
    assert.ok(!dnrRuleMatches(rule, { url: 'https://a.com/api', type: 'image', method: 'GET', tabId: 1 }));
    const noTypes = { condition: { urlFilter: '*' } };
    assert.ok(!dnrRuleMatches(noTypes, { url: 'https://a.com/', type: 'main_frame', method: 'GET', tabId: 1 }));
    const regex = { condition: { regexFilter: '^https://a\\.com/(.*)', resourceTypes: ['script'] } };
    assert.ok(dnrRuleMatches(regex, { url: 'https://a.com/x.js', type: 'script', method: 'GET', tabId: 1 }));
});

test('pickAppliedRules: top redirect wins, otherwise all header rules', () => {
    const req = { url: 'https://a.com/api/x', type: 'xmlhttprequest', method: 'GET', tabId: 1 };
    const types = ['xmlhttprequest'];
    const h1 = { id: 1, priority: 1, action: { type: 'modifyHeaders' }, condition: { urlFilter: '*api*', resourceTypes: types } };
    const h2 = { id: 2, priority: 5, action: { type: 'modifyHeaders' }, condition: { urlFilter: '*a.com*', resourceTypes: types } };
    const r1 = { id: 3, priority: 1, action: { type: 'redirect' }, condition: { urlFilter: '*api*', resourceTypes: types } };
    const r2 = { id: 4, priority: 3, action: { type: 'redirect' }, condition: { urlFilter: '*/x', resourceTypes: types } };
    const miss = { id: 5, priority: 9, action: { type: 'redirect' }, condition: { urlFilter: '*b.com*', resourceTypes: types } };
    assert.deepEqual(pickAppliedRules([h1, h2], req).map(r => r.id), [1, 2]);
    assert.deepEqual(pickAppliedRules([h1, h2, r1, r2, miss], req).map(r => r.id), [4]);
    assert.deepEqual(pickAppliedRules([miss], req), []);
});
