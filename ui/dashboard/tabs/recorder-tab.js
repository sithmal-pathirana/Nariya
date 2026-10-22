// recorder-tab.js - Request Recorder: record a tab's API calls and export
// them as a Postman collection (with tests) or a HAR file

import { sendMessage } from '../../shared/messaging.js';
import { showToast } from '../../shared/utils.js';
import { toPostmanCollection, toHar } from '../../../core/postman.js';

const tabSelect = document.getElementById('recorderTabSelect');
const startBtn = document.getElementById('recorderStartBtn');
const stopBtn = document.getElementById('recorderStopBtn');
const clearBtn = document.getElementById('recorderClearBtn');
const statusEl = document.getElementById('recorderStatus');
const liveDot = document.getElementById('recorderLiveDot');
const tableBody = document.getElementById('recorderTableBody');
const emptyEl = document.getElementById('recorderEmpty');
const selectAll = document.getElementById('recorderSelectAll');
const filterInput = document.getElementById('recorderFilter');

let entries = [];
const deselected = new Set();

function visibleEntries() {
    const q = (filterInput.value || '').trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(e => `${e.method} ${e.url}`.toLowerCase().includes(q));
}

function selectedEntries() {
    return visibleEntries().filter(e => !deselected.has(e.id));
}

function render() {
    const list = visibleEntries();
    tableBody.replaceChildren();
    emptyEl.style.display = list.length ? 'none' : 'block';

    for (const e of list.slice().reverse()) {
        const tr = document.createElement('tr');

        const cbCell = document.createElement('td');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !deselected.has(e.id);
        cb.addEventListener('change', () => {
            if (cb.checked) deselected.delete(e.id); else deselected.add(e.id);
        });
        cbCell.appendChild(cb);

        const cell = (text, className) => {
            const td = document.createElement('td');
            td.textContent = text;
            if (className) td.className = className;
            return td;
        };

        const statusClass = e.status >= 200 && e.status < 400 ? 'status-ok' : 'status-err';
        const urlCell = cell(e.url, 'url');
        urlCell.title = e.url;
        tr.append(
            cbCell,
            cell(e.method, 'method'),
            urlCell,
            cell(e.error ? 'ERR' : String(e.status || '—'), statusClass),
            cell(e.durationMs != null ? `${e.durationMs}ms` : '—'),
            cell(e.responseBody != null ? '✓' : '—')
        );
        tableBody.appendChild(tr);
    }
}

function renderState(state) {
    const live = !!state?.active;
    startBtn.hidden = live;
    stopBtn.hidden = !live;
    tabSelect.disabled = live;
    liveDot.hidden = !live;
    statusEl.classList.toggle('live', live);
    statusEl.textContent = live
        ? `● Recording ${state.tabId === null ? 'all tabs' : 'tab'} — ${state.count} request(s)`
        : `Not recording — ${state?.count ?? 0} request(s) captured`;
}

async function loadTabs() {
    const res = await sendMessage('GET_ALL_TABS');
    const current = tabSelect.value;
    tabSelect.replaceChildren();
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All tabs';
    tabSelect.appendChild(all);
    for (const tab of res.data || []) {
        if (!tab.url || !/^https?:/.test(tab.url)) continue;
        const opt = document.createElement('option');
        opt.value = String(tab.id);
        opt.textContent = `${tab.title || tab.url}`.slice(0, 80);
        opt.title = tab.url;
        tabSelect.appendChild(opt);
    }
    if ([...tabSelect.options].some(o => o.value === current)) tabSelect.value = current;
    else if (tabSelect.options.length > 1) tabSelect.selectedIndex = 1;
}

export async function loadRecorder() {
    if (!tableBody) return;
    const res = await sendMessage('RECORDER_GET');
    if (!res.ok) return;
    entries = res.data.entries || [];
    renderState(res.data.state);
    render();
}

function download(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeName(name) {
    return name.replace(/[^a-z0-9-_ ]/gi, '').trim().replace(/\s+/g, '_') || 'nariya_recording';
}

export function initRecorderTab() {
    if (!tableBody) return;

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'RECORDER_UPDATED') loadRecorder();
    });

    startBtn.addEventListener('click', async () => {
        const tabId = tabSelect.value === 'all' ? null : parseInt(tabSelect.value, 10);
        await sendMessage('RECORDER_START', { tabId });
        showToast('Recording. Use your app, then come back to export.', 'success');
        loadRecorder();
    });

    stopBtn.addEventListener('click', async () => {
        await sendMessage('RECORDER_STOP');
        loadRecorder();
    });

    clearBtn.addEventListener('click', async () => {
        if (entries.length && !confirm('Clear all recorded requests?')) return;
        deselected.clear();
        await sendMessage('RECORDER_CLEAR');
        loadRecorder();
    });

    selectAll.addEventListener('change', () => {
        for (const e of visibleEntries()) {
            if (selectAll.checked) deselected.delete(e.id); else deselected.add(e.id);
        }
        render();
    });

    filterInput.addEventListener('input', render);

    document.getElementById('recorderExportPostmanBtn').addEventListener('click', () => {
        const list = selectedEntries();
        if (!list.length) return showToast('Nothing selected to export.', 'error');
        const name = document.getElementById('recorderCollectionName').value.trim() || 'Nariya Recording';
        const collection = toPostmanCollection(list, {
            name,
            dedupe: document.getElementById('recorderDedupe').checked,
            redactSecrets: document.getElementById('recorderRedact').checked,
            includeTests: document.getElementById('recorderTests').checked
        });
        download(`${safeName(name)}.postman_collection.json`, collection);
        showToast('Exported. In Postman: Import → choose the file.', 'success');
    });

    document.getElementById('recorderExportHarBtn').addEventListener('click', () => {
        const list = selectedEntries();
        if (!list.length) return showToast('Nothing selected to export.', 'error');
        const name = document.getElementById('recorderCollectionName').value.trim() || 'Nariya Recording';
        download(`${safeName(name)}.har`, toHar(list, { creatorVersion: chrome.runtime.getManifest().version }));
    });

    loadTabs();
    loadRecorder();
}

export { loadTabs as refreshRecorderTabs };
