/**
 * Nariya — Postman / HAR export
 * Turns recorder entries (core/recorder.js) into a Postman v2.1 collection
 * with ready-to-run tests, or a HAR 1.2 file. Pure functions, no chrome.* use.
 *
 * Entry shape: { id, url, method, requestHeaders: [[k, v]], requestBody:
 *   { text } | { formData: { key: [values] } } | null, status, statusText,
 *   responseHeaders: [[k, v]], responseBody: string|null, durationMs, startedAt }
 */

const POSTMAN_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

// Headers Postman sets itself, or that only make sense in the browser
const DROPPED_HEADERS = new Set([
    'host', 'connection', 'content-length', 'cookie', 'origin', 'referer',
    'user-agent', 'accept-encoding', 'priority', 'dnt', 'upgrade-insecure-requests'
]);

// Secret-bearing headers moved into collection variables
const SECRET_HEADERS = {
    'x-api-key': 'apiKey',
    'x-auth-token': 'authToken',
    'x-access-token': 'accessToken',
    'x-csrf-token': 'csrfToken',
    'x-xsrf-token': 'csrfToken'
};

const header = (headers, name) =>
    headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null;

function hostVariableName(origin, multipleOrigins) {
    if (!multipleOrigins) return 'baseUrl';
    const host = new URL(origin).host.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '');
    return `baseUrl_${host}`;
}

/**
 * Replace ids and UUIDs in a path with placeholders so repeated calls dedupe
 * ("/users/42" and "/users/43" are the same endpoint)
 */
export function pathTemplate(pathname) {
    return pathname.split('/').map((seg) => {
        if (/^\d+$/.test(seg)) return ':id';
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
        if (/^[0-9a-f]{24}$/i.test(seg)) return ':id';
        return seg;
    }).join('/');
}

function tryParseJson(text) {
    if (typeof text !== 'string' || !text.trim()) return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
}

function jsString(value) {
    return JSON.stringify(value);
}

/**
 * Postman test script for one recorded call
 */
export function buildTests(entry) {
    const lines = [];
    if (entry.status) {
        lines.push(`pm.test(${jsString(`Status code is ${entry.status}`)}, function () {`);
        lines.push(`    pm.response.to.have.status(${entry.status});`);
        lines.push('});');
    }

    const contentType = header(entry.responseHeaders || [], 'content-type');
    if (contentType) {
        const mime = contentType.split(';')[0].trim();
        lines.push(`pm.test(${jsString(`Content-Type is ${mime}`)}, function () {`);
        lines.push(`    pm.expect(pm.response.headers.get('Content-Type')).to.include(${jsString(mime)});`);
        lines.push('});');
    }

    const json = tryParseJson(entry.responseBody);
    if (Array.isArray(json)) {
        lines.push('pm.test("Response is an array", function () {');
        lines.push('    pm.expect(pm.response.json()).to.be.an("array");');
        lines.push('});');
        const first = json[0];
        if (first && typeof first === 'object' && !Array.isArray(first)) {
            const keys = Object.keys(first).slice(0, 10);
            lines.push(`pm.test("Items have the expected fields", function () {`);
            lines.push('    const items = pm.response.json();');
            lines.push(`    if (items.length) pm.expect(items[0]).to.include.keys(${keys.map(jsString).join(', ')});`);
            lines.push('});');
        }
    } else if (json && typeof json === 'object') {
        const keys = Object.keys(json).slice(0, 10);
        if (keys.length) {
            lines.push('pm.test("Response has the expected fields", function () {');
            lines.push(`    pm.expect(pm.response.json()).to.include.keys(${keys.map(jsString).join(', ')});`);
            lines.push('});');
        }
    }

    const budget = Math.max(1000, Math.ceil(((entry.durationMs || 0) * 3) / 100) * 100);
    lines.push(`pm.test("Response time is below ${budget}ms", function () {`);
    lines.push(`    pm.expect(pm.response.responseTime).to.be.below(${budget});`);
    lines.push('});');
    return lines;
}

function buildBody(entry, contentType) {
    const body = entry.requestBody;
    if (!body) return undefined;

    if (body.formData) {
        const pairs = Object.entries(body.formData).flatMap(([key, values]) =>
            (Array.isArray(values) ? values : [values]).map(value => ({ key, value: String(value) })));
        return /multipart/i.test(contentType || '')
            ? { mode: 'formdata', formdata: pairs.map(p => ({ ...p, type: 'text' })) }
            : { mode: 'urlencoded', urlencoded: pairs };
    }

    if (body.text == null || body.text === '') return undefined;

    if (/x-www-form-urlencoded/i.test(contentType || '')) {
        const params = new URLSearchParams(body.text);
        return { mode: 'urlencoded', urlencoded: [...params].map(([key, value]) => ({ key, value })) };
    }

    const isJson = /json/i.test(contentType || '') || tryParseJson(body.text) !== undefined;
    if (/graphql/i.test(contentType || '') || (isJson && tryParseJson(body.text)?.query && /\/graphql/i.test(entry.url))) {
        const gql = tryParseJson(body.text) || {};
        if (typeof gql.query === 'string') {
            return {
                mode: 'graphql',
                graphql: { query: gql.query, variables: JSON.stringify(gql.variables || {}, null, 2) }
            };
        }
    }

    const raw = isJson ? JSON.stringify(tryParseJson(body.text), null, 2) : body.text;
    return {
        mode: 'raw',
        raw,
        options: { raw: { language: isJson ? 'json' : /xml/i.test(contentType || '') ? 'xml' : 'text' } }
    };
}

/**
 * Build a Postman Collection v2.1 from recorded entries.
 * @param {Array} entries
 * @param {{ name?: string, redactSecrets?: boolean, dedupe?: boolean, includeTests?: boolean,
 *           includeExamples?: boolean }} options
 * @returns {Object} collection JSON
 */
export function toPostmanCollection(entries, options = {}) {
    const {
        name = 'Nariya Recording',
        redactSecrets = true,
        dedupe = true,
        includeTests = true,
        includeExamples = true
    } = options;

    let list = entries.filter(e => /^https?:/.test(e.url));
    if (dedupe) {
        const latest = new Map();
        for (const e of list) {
            const u = new URL(e.url);
            latest.set(`${e.method} ${u.origin}${pathTemplate(u.pathname)}`, e);
        }
        list = [...latest.values()].sort((a, b) => a.startedAt - b.startedAt);
    }

    const origins = [...new Set(list.map(e => new URL(e.url).origin))];
    const multipleOrigins = origins.length > 1;
    const variables = new Map();
    for (const origin of origins) variables.set(hostVariableName(origin, multipleOrigins), origin);

    const folders = new Map();
    for (const entry of list) {
        const u = new URL(entry.url);
        const baseVar = hostVariableName(u.origin, multipleOrigins);
        const reqHeaders = [];
        const contentType = header(entry.requestHeaders || [], 'content-type');

        for (const [rawName, rawValue] of entry.requestHeaders || []) {
            const lower = rawName.toLowerCase();
            if (DROPPED_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith(':')) continue;
            let value = rawValue;
            if (lower === 'authorization') {
                const match = /^(Bearer|Token)\s+(.+)$/i.exec(rawValue);
                const varName = 'authToken';
                if (match) {
                    variables.set(varName, redactSecrets ? '' : match[2]);
                    value = `${match[1]} {{${varName}}}`;
                } else {
                    variables.set('authorization', redactSecrets ? '' : rawValue);
                    value = '{{authorization}}';
                }
            } else if (SECRET_HEADERS[lower]) {
                const varName = SECRET_HEADERS[lower];
                variables.set(varName, redactSecrets ? '' : rawValue);
                value = `{{${varName}}}`;
            }
            reqHeaders.push({ key: rawName, value });
        }

        const pathSegments = u.pathname.split('/').filter(Boolean);
        const query = [...u.searchParams].map(([key, value]) => ({ key, value }));
        const url = {
            raw: `{{${baseVar}}}${u.pathname}${u.search}`,
            host: [`{{${baseVar}}}`],
            path: pathSegments
        };
        if (query.length) url.query = query;

        const request = { method: entry.method, header: reqHeaders, url };
        const body = buildBody(entry, contentType);
        if (body) request.body = body;

        const item = { name: `${entry.method} ${u.pathname}`, request };
        if (includeTests) {
            item.event = [{ listen: 'test', script: { type: 'text/javascript', exec: buildTests(entry) } }];
        }
        if (includeExamples && entry.status) {
            const responseJson = tryParseJson(entry.responseBody);
            item.response = [{
                name: `${entry.status} ${entry.statusText || ''}`.trim(),
                originalRequest: request,
                status: entry.statusText || '',
                code: entry.status,
                _postman_previewlanguage: responseJson !== undefined ? 'json' : 'text',
                header: (entry.responseHeaders || []).map(([key, value]) => ({ key, value })),
                body: responseJson !== undefined ? JSON.stringify(responseJson, null, 2) : (entry.responseBody || '')
            }];
        }

        if (!folders.has(u.host)) folders.set(u.host, []);
        folders.get(u.host).push(item);
    }

    const items = folders.size === 1
        ? [...folders.values()][0]
        : [...folders.entries()].map(([host, item]) => ({ name: host, item }));

    return {
        info: {
            name,
            description: `Recorded with Nariya on ${new Date().toISOString()}`,
            schema: POSTMAN_SCHEMA
        },
        item: items,
        variable: [...variables.entries()].map(([key, value]) => ({ key, value, type: 'string' }))
    };
}

/**
 * Build a HAR 1.2 log from recorded entries
 */
export function toHar(entries, { creatorVersion = '0.1.0' } = {}) {
    return {
        log: {
            version: '1.2',
            creator: { name: 'Nariya', version: creatorVersion },
            entries: entries.map((e) => {
                const u = new URL(e.url);
                const reqContentType = header(e.requestHeaders || [], 'content-type') || '';
                const resContentType = header(e.responseHeaders || [], 'content-type') || '';
                const entry = {
                    startedDateTime: new Date(e.startedAt).toISOString(),
                    time: e.durationMs || 0,
                    request: {
                        method: e.method,
                        url: e.url,
                        httpVersion: 'HTTP/1.1',
                        headers: (e.requestHeaders || []).map(([name, value]) => ({ name, value })),
                        queryString: [...u.searchParams].map(([name, value]) => ({ name, value })),
                        cookies: [],
                        headersSize: -1,
                        bodySize: e.requestBody?.text?.length ?? -1
                    },
                    response: {
                        status: e.status || 0,
                        statusText: e.statusText || '',
                        httpVersion: 'HTTP/1.1',
                        headers: (e.responseHeaders || []).map(([name, value]) => ({ name, value })),
                        cookies: [],
                        content: {
                            size: e.responseBody?.length ?? 0,
                            mimeType: resContentType,
                            ...(e.responseBody != null ? { text: e.responseBody } : {})
                        },
                        redirectURL: '',
                        headersSize: -1,
                        bodySize: -1
                    },
                    cache: {},
                    timings: { send: 0, wait: e.durationMs || 0, receive: 0 }
                };
                if (e.requestBody?.text != null) {
                    entry.request.postData = { mimeType: reqContentType, text: e.requestBody.text };
                } else if (e.requestBody?.formData) {
                    entry.request.postData = {
                        mimeType: reqContentType,
                        params: Object.entries(e.requestBody.formData).flatMap(([name, values]) =>
                            (Array.isArray(values) ? values : [values]).map(value => ({ name, value: String(value) })))
                    };
                }
                return entry;
            })
        }
    };
}
