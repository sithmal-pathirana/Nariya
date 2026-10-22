/**
 * Nariya — Request Recorder
 * Records the API calls (fetch / XHR) a tab makes, so they can be exported
 * as a Postman collection or HAR file (see core/postman.js).
 *
 * Request line, headers, body and response status/headers come from
 * chrome.webRequest. Response bodies are not visible there, so the in-page
 * interceptor reports them (RECORD_BODY) and they are merged in here.
 */

const STATE_KEY = 'nariya_recorder_state';
const ENTRIES_KEY = 'nariya_recorder_entries';
const MAX_ENTRIES = 1000;
const BODY_MATCH_WINDOW_MS = 60000;
const MAX_REQUEST_BODY = 256 * 1024;

const RECORDED_TYPES = ['xmlhttprequest', 'other'];
const STATIC_EXT = /\.(js|mjs|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|eot|mp4|webm|mp3)(\?|$)/i;

// { active: boolean, tabId: number|null (null = all tabs), startedAt }
let state = { active: false, tabId: null, startedAt: null };
let entries = [];
const inFlight = new Map();
let onChange = () => { };

const ready = chrome.storage.local.get([STATE_KEY, ENTRIES_KEY]).then((r) => {
    state = r[STATE_KEY] || state;
    entries = r[ENTRIES_KEY] || [];
});

let persistTimer = null;
function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        chrome.storage.local.set({ [ENTRIES_KEY]: entries }).catch(() => { });
    }, 500);
    onChange();
}

/**
 * Is this tab being recorded right now?
 */
export async function isRecordingTab(tabId) {
    await ready;
    return state.active && tabId >= 0 && (state.tabId === null || state.tabId === tabId);
}

export async function getState() {
    await ready;
    return { ...state, count: entries.length };
}

export async function getEntries() {
    await ready;
    return entries;
}

/**
 * Start recording one tab (or every tab with tabId = null)
 */
export async function start(tabId = null) {
    await ready;
    state = { active: true, tabId, startedAt: Date.now() };
    await chrome.storage.local.set({ [STATE_KEY]: state });
    onChange();
    return getState();
}

export async function stop() {
    await ready;
    state = { ...state, active: false };
    inFlight.clear();
    await chrome.storage.local.set({ [STATE_KEY]: state });
    onChange();
    return getState();
}

export async function clear() {
    await ready;
    entries = [];
    inFlight.clear();
    await chrome.storage.local.set({ [ENTRIES_KEY]: [] });
    onChange();
}

export async function deleteEntries(ids) {
    await ready;
    const remove = new Set(ids);
    entries = entries.filter(e => !remove.has(e.id));
    persist();
}

// ─── Capture ─────────────────────────────────────────────────────

function decodeRequestBody(requestBody) {
    if (!requestBody) return null;
    if (requestBody.formData) return { formData: requestBody.formData };
    if (requestBody.raw) {
        const parts = requestBody.raw.filter(p => p.bytes).map(p => new Uint8Array(p.bytes));
        if (parts.length === 0) return requestBody.raw.some(p => p.file) ? { text: '', file: true } : null;
        const total = parts.reduce((n, p) => n + p.byteLength, 0);
        const joined = new Uint8Array(total);
        let offset = 0;
        for (const p of parts) { joined.set(p, offset); offset += p.byteLength; }
        const text = new TextDecoder('utf-8', { fatal: false }).decode(joined.subarray(0, MAX_REQUEST_BODY));
        return { text, truncated: total > MAX_REQUEST_BODY };
    }
    return null;
}

async function shouldRecord(details) {
    if (!(await isRecordingTab(details.tabId))) return false;
    if (details.method === 'OPTIONS') return false;
    if (!RECORDED_TYPES.includes(details.type)) return false;
    if (!/^https?:/.test(details.url)) return false;
    return !STATIC_EXT.test(details.url);
}

async function onBeforeRequest(details) {
    if (!(await shouldRecord(details))) return;
    inFlight.set(details.requestId, {
        id: `${details.requestId}_${Date.now()}`,
        tabId: details.tabId,
        url: details.url,
        method: details.method,
        type: details.type,
        initiator: details.initiator || null,
        startedAt: details.timeStamp,
        requestHeaders: [],
        requestBody: decodeRequestBody(details.requestBody),
        status: 0,
        statusText: '',
        responseHeaders: [],
        responseBody: null
    });
}

function onSendHeaders(details) {
    const entry = inFlight.get(details.requestId);
    if (entry) entry.requestHeaders = (details.requestHeaders || []).map(h => [h.name, h.value ?? '']);
}

function finish(details, error) {
    const entry = inFlight.get(details.requestId);
    if (!entry) return;
    inFlight.delete(details.requestId);
    entry.status = details.statusCode || 0;
    entry.statusText = (details.statusLine || '').split(' ').slice(2).join(' ');
    entry.responseHeaders = (details.responseHeaders || []).map(h => [h.name, h.value ?? '']);
    entry.durationMs = Math.round(details.timeStamp - entry.startedAt);
    entry.error = error || null;
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    persist();
}

/**
 * Attach a response body reported by the in-page interceptor to the most
 * recent matching entry (same tab, method and URL) that has none yet.
 */
export async function attachResponseBody(tabId, payload) {
    await ready;
    const now = Date.now();
    const tryAttach = () => {
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.tabId === tabId && e.responseBody == null && e.method === payload.method &&
                e.url === payload.url && now - e.startedAt < BODY_MATCH_WINDOW_MS) {
                e.responseBody = payload.body;
                e.responseBodyTruncated = !!payload.truncated;
                persist();
                return true;
            }
        }
        return false;
    };
    // The body can arrive before webRequest.onCompleted; retry briefly
    if (!tryAttach()) setTimeout(tryAttach, 1000);
}

/**
 * Register webRequest listeners. Call synchronously at service worker start.
 * @param {Function} changeCallback - called when state or entries change
 */
export function setupRecorder(changeCallback) {
    if (changeCallback) onChange = changeCallback;
    const filter = { urls: ['<all_urls>'], types: RECORDED_TYPES };
    chrome.webRequest.onBeforeRequest.addListener(
        (d) => { onBeforeRequest(d); }, filter, ['requestBody']
    );
    chrome.webRequest.onSendHeaders.addListener(
        onSendHeaders, filter, ['requestHeaders', 'extraHeaders']
    );
    chrome.webRequest.onCompleted.addListener(
        (d) => finish(d), filter, ['responseHeaders', 'extraHeaders']
    );
    chrome.webRequest.onErrorOccurred.addListener(
        (d) => finish(d, d.error), filter
    );
}
