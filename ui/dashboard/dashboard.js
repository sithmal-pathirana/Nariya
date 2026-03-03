/**
 * Nariya — Dashboard Script
 * Full-page options dashboard managing Rules, Interceptor, Repeater, and Comparer.
 */

// ═══════════════════════════════════════════════════════════════════
//  Differ (inline, since we can't import ES modules in options page)
// ═══════════════════════════════════════════════════════════════════

const Differ = (() => {
    function lcsTable(a, b) {
        const m = a.length, n = b.length;
        const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
        return dp;
    }

    function backtrack(dp, a, b) {
        const result = [];
        let i = a.length, j = b.length;
        while (i > 0 || j > 0) {
            if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
                result.unshift({ type: 'equal', value: a[i - 1] }); i--; j--;
            } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
                result.unshift({ type: 'add', value: b[j - 1] }); j--;
            } else {
                result.unshift({ type: 'remove', value: a[i - 1] }); i--;
            }
        }
        return result;
    }

    function diffLines(textA, textB) {
        const lA = textA.split('\n'), lB = textB.split('\n');
        const dp = lcsTable(lA, lB);
        const raw = backtrack(dp, lA, lB);
        let la = 0, lb = 0;
        return raw.map(c => {
            const e = { ...c };
            if (c.type === 'equal') { la++; lb++; e.lineA = la; e.lineB = lb; }
            else if (c.type === 'remove') { la++; e.lineA = la; }
            else { lb++; e.lineB = lb; }
            return e;
        });
    }

    function formatJson(s) {
        try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
    }

    function diffStats(d) {
        let a = 0, r = 0, u = 0;
        for (const c of d) { if (c.type === 'add') a++; else if (c.type === 'remove') r++; else u++; }
        return { added: a, removed: r, unchanged: u };
    }

    return { diffLines, formatJson, diffStats };
})();

// ═══════════════════════════════════════════════════════════════════
//  Messaging
// ═══════════════════════════════════════════════════════════════════

function sendMessage(type, payload = {}) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
            resolve(response || { ok: false });
        });
    });
}

// ═══════════════════════════════════════════════════════════════════
//  Tab Navigation
// ═══════════════════════════════════════════════════════════════════

const navItems = document.querySelectorAll('.nav-item');
const tabPanels = document.querySelectorAll('.tab-panel');

navItems.forEach(item => {
    item.addEventListener('click', () => {
        const tab = item.dataset.tab;
        navItems.forEach(n => n.classList.remove('active'));
        tabPanels.forEach(p => p.classList.remove('active'));
        item.classList.add('active');
        document.getElementById(`tab-${tab}`).classList.add('active');

        // Lazy-load tab data
        if (tab === 'repeater') loadHistory();
        if (tab === 'interceptor') refreshInterceptorUI();
    });
});

// ═══════════════════════════════════════════════════════════════════
//  Global Toggle
// ═══════════════════════════════════════════════════════════════════

const globalToggle = document.getElementById('globalToggle');

async function loadSettings() {
    const res = await sendMessage('GET_SETTINGS');
    if (res.ok) globalToggle.checked = res.data.globalEnabled;
}

globalToggle.addEventListener('change', async () => {
    await sendMessage('UPDATE_SETTINGS', { globalEnabled: globalToggle.checked });
});

// ═══════════════════════════════════════════════════════════════════
//  Rules Tab
// ═══════════════════════════════════════════════════════════════════

const rulesTableBody = document.getElementById('rulesTableBody');
const addRuleBtn = document.getElementById('addRuleBtn');
const importRulesBtn = document.getElementById('importRulesBtn');
const exportRulesBtn = document.getElementById('exportRulesBtn');
const importFileInput = document.getElementById('importFileInput');
const filterChips = document.querySelectorAll('.filter-chip');

let allRules = [];
let currentFilter = 'all';

// Filter chips
filterChips.forEach(chip => {
    chip.addEventListener('click', () => {
        filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentFilter = chip.dataset.filter;
        renderRulesTable();
    });
});

async function loadRules() {
    const res = await sendMessage('GET_ALL_RULES');
    if (res.ok) {
        allRules = res.data || [];
        renderRulesTable();
    }
}

function renderRulesTable() {
    const filtered = currentFilter === 'all'
        ? allRules
        : allRules.filter(r => r.type === currentFilter);

    if (filtered.length === 0) {
        rulesTableBody.innerHTML = `
      <tr class="empty-row"><td colspan="5">
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
            <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/>
          </svg>
          <p>No rules yet. Click "Add Rule" to get started.</p>
        </div>
      </td></tr>`;
        return;
    }

    rulesTableBody.innerHTML = filtered.map(rule => `
    <tr data-id="${rule.id}">
      <td>
        <label class="toggle-switch">
          <input type="checkbox" class="rule-toggle" data-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </td>
      <td><span class="rule-type-badge badge-${rule.type}">${rule.type}</span></td>
      <td>${escapeHtml(rule.config?.name || rule.type + ' rule')}</td>
      <td class="rule-url-cell">${escapeHtml(rule.urlFilter || '*')}</td>
      <td>
        <div class="action-btns">
          <button class="btn-sm edit-rule" data-id="${rule.id}" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-sm delete delete-rule" data-id="${rule.id}" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          </button>
        </div>
      </td>
    </tr>
  `).join('');

    // Bind toggle events
    rulesTableBody.querySelectorAll('.rule-toggle').forEach(toggle => {
        toggle.addEventListener('change', async () => {
            await sendMessage('TOGGLE_RULE', { id: toggle.dataset.id, enabled: toggle.checked });
            await loadRules();
        });
    });

    // Bind edit events
    rulesTableBody.querySelectorAll('.edit-rule').forEach(btn => {
        btn.addEventListener('click', () => {
            const rule = allRules.find(r => r.id === btn.dataset.id);
            if (rule) openRuleModal(rule);
        });
    });

    // Bind delete events
    rulesTableBody.querySelectorAll('.delete-rule').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (confirm('Delete this rule?')) {
                await sendMessage('DELETE_RULE', { id: btn.dataset.id });
                await loadRules();
            }
        });
    });
}

// Import / Export
importRulesBtn.addEventListener('click', () => importFileInput.click());

importFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
        const text = await file.text();
        const rules = JSON.parse(text);
        await sendMessage('IMPORT_RULES', { rules });
        await loadRules();
    } catch (err) {
        alert('Invalid JSON file');
    }
    importFileInput.value = '';
});

exportRulesBtn.addEventListener('click', async () => {
    const res = await sendMessage('EXPORT_RULES');
    if (!res.ok) return;
    const blob = new Blob([res.data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nariya-rules-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
});

// ═══════════════════════════════════════════════════════════════════
//  Rule Editor Modal
// ═══════════════════════════════════════════════════════════════════

const ruleModal = document.getElementById('ruleModal');
const modalTitle = document.getElementById('modalTitle');
const closeModalBtn = document.getElementById('closeModalBtn');
const cancelRuleBtn = document.getElementById('cancelRuleBtn');
const saveRuleBtn = document.getElementById('saveRuleBtn');
const ruleType = document.getElementById('ruleType');

let editingRuleId = null;

const configSections = {
    redirect: document.getElementById('configRedirect'),
    header: document.getElementById('configHeader'),
    mock: document.getElementById('configMock'),
    delay: document.getElementById('configDelay'),
    script: document.getElementById('configScript')
};

addRuleBtn.addEventListener('click', () => openRuleModal());

function openRuleModal(rule = null) {
    editingRuleId = rule?.id || null;
    modalTitle.textContent = rule ? 'Edit Rule' : 'Add Rule';

    document.getElementById('ruleName').value = rule?.config?.name || '';
    document.getElementById('ruleType').value = rule?.type || 'redirect';
    document.getElementById('ruleUrlFilter').value = rule?.urlFilter || '';

    // Reset configs
    document.getElementById('redirectUrl').value = rule?.config?.redirectUrl || '';
    document.getElementById('redirectMode').value = rule?.config?.redirectMode || 'full';
    document.getElementById('matchPattern').value = rule?.config?.matchPattern || '';
    toggleRedirectMode(rule?.config?.redirectMode || 'full');
    document.getElementById('headerRequestConfig').value = rule?.config?.requestHeaders
        ? JSON.stringify(rule.config.requestHeaders, null, 2) : '';
    document.getElementById('headerResponseConfig').value = rule?.config?.responseHeaders
        ? JSON.stringify(rule.config.responseHeaders, null, 2) : '';
    document.getElementById('mockStatusCode').value = rule?.config?.statusCode || 200;
    document.getElementById('mockBody').value = rule?.config?.body || '';
    document.getElementById('delayMs').value = rule?.config?.delayMs || 1000;
    document.getElementById('scriptJs').value = rule?.config?.js || '';
    document.getElementById('scriptCss').value = rule?.config?.css || '';

    showConfigSection(rule?.type || 'redirect');
    ruleModal.style.display = 'flex';
}

function closeRuleModal() {
    ruleModal.style.display = 'none';
    editingRuleId = null;
}

closeModalBtn.addEventListener('click', closeRuleModal);
cancelRuleBtn.addEventListener('click', closeRuleModal);

// Toggle redirect mode UI
const redirectModeSelect = document.getElementById('redirectMode');
const matchPatternRow = document.getElementById('matchPatternRow');
const redirectUrlLabel = document.getElementById('redirectUrlLabel');

function toggleRedirectMode(mode) {
    if (mode === 'replace') {
        matchPatternRow.style.display = 'block';
        redirectUrlLabel.textContent = 'Replace With';
        document.getElementById('redirectUrl').placeholder = 'e.g. https://api.new.com/*/endpoint  or  https://\\1.new.com/\\2';
    } else {
        matchPatternRow.style.display = 'none';
        redirectUrlLabel.textContent = 'Redirect To';
        document.getElementById('redirectUrl').placeholder = 'https://new-url.com/endpoint';
    }
}

redirectModeSelect.addEventListener('change', () => toggleRedirectMode(redirectModeSelect.value));

ruleType.addEventListener('change', () => showConfigSection(ruleType.value));

function showConfigSection(type) {
    Object.values(configSections).forEach(s => s.style.display = 'none');
    if (configSections[type]) configSections[type].style.display = 'block';
}

saveRuleBtn.addEventListener('click', async () => {
    const type = ruleType.value;
    const name = document.getElementById('ruleName').value.trim() || `${type} rule`;
    const urlFilter = document.getElementById('ruleUrlFilter').value.trim();

    const config = { name };

    switch (type) {
        case 'redirect':
            config.redirectUrl = document.getElementById('redirectUrl').value.trim();
            config.redirectMode = document.getElementById('redirectMode').value;
            if (config.redirectMode === 'replace') {
                config.matchPattern = document.getElementById('matchPattern').value.trim();
                if (!config.matchPattern) { alert('Match pattern is required for Replace mode'); return; }
            }
            if (!config.redirectUrl) { alert('Redirect URL / replacement is required'); return; }
            break;
        case 'header':
            try {
                const reqH = document.getElementById('headerRequestConfig').value.trim();
                const resH = document.getElementById('headerResponseConfig').value.trim();
                if (reqH) config.requestHeaders = JSON.parse(reqH);
                if (resH) config.responseHeaders = JSON.parse(resH);
            } catch { alert('Invalid JSON in header config'); return; }
            break;
        case 'mock':
            config.statusCode = parseInt(document.getElementById('mockStatusCode').value) || 200;
            config.body = document.getElementById('mockBody').value;
            config.headers = { 'Content-Type': 'application/json' };
            break;
        case 'delay':
            config.delayMs = parseInt(document.getElementById('delayMs').value) || 1000;
            break;
        case 'script':
            config.js = document.getElementById('scriptJs').value;
            config.css = document.getElementById('scriptCss').value;
            break;
    }

    const rule = {
        type, urlFilter, config,
        ...(editingRuleId ? { id: editingRuleId } : {})
    };

    await sendMessage('SAVE_RULE', rule);
    closeRuleModal();
    await loadRules();
});

// ═══════════════════════════════════════════════════════════════════
//  Interceptor Tab
// ═══════════════════════════════════════════════════════════════════

const interceptorTabSelect = document.getElementById('interceptorTabSelect');
const toggleInterceptorBtn = document.getElementById('toggleInterceptorBtn');
const interceptorStatus = document.getElementById('interceptorStatus');
const pausedRequestsList = document.getElementById('pausedRequestsList');
const requestEditor = document.getElementById('requestEditor');

let interceptorAttached = false;
let interceptorTabId = null;

async function refreshInterceptorUI() {
    // Populate tab list
    const tabsRes = await sendMessage('GET_ALL_TABS');
    if (tabsRes.ok) {
        const currentVal = interceptorTabSelect.value;
        interceptorTabSelect.innerHTML = '<option value="">Select a tab...</option>';
        for (const tab of tabsRes.data) {
            if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
                const opt = document.createElement('option');
                opt.value = tab.id;
                opt.textContent = `${tab.title?.substring(0, 40) || 'Tab'} (${tab.id})`;
                interceptorTabSelect.appendChild(opt);
            }
        }
        if (currentVal) interceptorTabSelect.value = currentVal;
    }

    // Check attached status
    const attachedRes = await sendMessage('DEBUGGER_GET_ATTACHED_TABS');
    if (attachedRes.ok && attachedRes.data.length > 0) {
        interceptorAttached = true;
        interceptorTabId = attachedRes.data[0];
        updateInterceptorStatus(true);
        loadPausedRequests();
    } else {
        interceptorAttached = false;
        updateInterceptorStatus(false);
    }
}

function updateInterceptorStatus(attached) {
    const indicator = interceptorStatus.querySelector('.status-indicator');
    const label = interceptorStatus.querySelector('span:last-child');

    if (attached) {
        indicator.className = 'status-indicator online';
        label.textContent = `Attached to tab ${interceptorTabId}`;
        toggleInterceptorBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
      Detach`;
    } else {
        indicator.className = 'status-indicator offline';
        label.textContent = 'Not attached to any tab';
        toggleInterceptorBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      Attach`;
    }
}

toggleInterceptorBtn.addEventListener('click', async () => {
    if (interceptorAttached) {
        await sendMessage('DEBUGGER_DETACH', { tabId: interceptorTabId });
        interceptorAttached = false;
        interceptorTabId = null;
        updateInterceptorStatus(false);
        pausedRequestsList.innerHTML = '<div class="empty-state-sm">No paused requests</div>';
    } else {
        const tabId = parseInt(interceptorTabSelect.value);
        if (!tabId) { alert('Select a tab first'); return; }
        const res = await sendMessage('DEBUGGER_ATTACH', { tabId, options: {} });
        if (res.ok) {
            interceptorAttached = true;
            interceptorTabId = tabId;
            updateInterceptorStatus(true);
        } else {
            alert('Failed to attach: ' + (res.error || 'Unknown error'));
        }
    }
});

async function loadPausedRequests() {
    if (!interceptorTabId) return;
    const res = await sendMessage('DEBUGGER_GET_PAUSED', { tabId: interceptorTabId });
    if (!res.ok || res.data.length === 0) {
        pausedRequestsList.innerHTML = '<div class="empty-state-sm">No paused requests</div>';
        return;
    }

    pausedRequestsList.innerHTML = res.data.map(req => `
    <div class="paused-item" data-request-id="${req.requestId}">
      <span class="paused-method">${req.request?.method || 'GET'}</span>
      <span class="paused-url">${escapeHtml(req.request?.url || '')}</span>
    </div>
  `).join('');

    pausedRequestsList.querySelectorAll('.paused-item').forEach(item => {
        item.addEventListener('click', () => {
            const reqId = item.dataset.requestId;
            const req = res.data.find(r => r.requestId === reqId);
            if (req) openRequestEditor(req);
        });
    });
}

function openRequestEditor(req) {
    requestEditor.style.display = 'block';
    document.getElementById('editMethod').value = req.request?.method || 'GET';
    document.getElementById('editUrl').value = req.request?.url || '';
    document.getElementById('editHeaders').value = JSON.stringify(req.request?.headers || {}, null, 2);
    document.getElementById('editBody').value = req.request?.postData || '';
    requestEditor.dataset.requestId = req.requestId;
    requestEditor.dataset.responseStatusCode = req.responseStatusCode || '';
}

document.getElementById('cancelEditBtn').addEventListener('click', () => {
    requestEditor.style.display = 'none';
});

document.getElementById('forwardEditBtn').addEventListener('click', async () => {
    const requestId = requestEditor.dataset.requestId;
    const responseCode = requestEditor.dataset.responseStatusCode;

    const modifications = {
        url: document.getElementById('editUrl').value,
        method: document.getElementById('editMethod').value,
    };

    try {
        const headersRaw = document.getElementById('editHeaders').value.trim();
        if (headersRaw) {
            const parsed = JSON.parse(headersRaw);
            modifications.headers = Object.entries(parsed).map(([name, value]) => ({ name, value }));
        }
    } catch { }

    const body = document.getElementById('editBody').value;
    if (body) modifications.postData = body;

    // If it's a response-stage pause, use continueResponse; otherwise continueRequest
    if (responseCode) {
        await sendMessage('DEBUGGER_CONTINUE_RESPONSE', {
            tabId: interceptorTabId, requestId, modifications
        });
    } else {
        await sendMessage('DEBUGGER_CONTINUE_REQUEST', {
            tabId: interceptorTabId, requestId, modifications
        });
    }

    requestEditor.style.display = 'none';
    loadPausedRequests();
});

// Listen for real-time paused request notifications
chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'REQUEST_PAUSED') {
        loadPausedRequests();
    }
});

// Poll for paused requests when attached
setInterval(() => {
    if (interceptorAttached) loadPausedRequests();
}, 3000);

// ═══════════════════════════════════════════════════════════════════
//  Repeater Tab
// ═══════════════════════════════════════════════════════════════════

const historyList = document.getElementById('historyList');
const historySearch = document.getElementById('historySearch');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');
const sendRequestBtn = document.getElementById('sendRequestBtn');
const repeaterMethod = document.getElementById('repeaterMethod');
const repeaterUrl = document.getElementById('repeaterUrl');
const repeaterHeaders = document.getElementById('repeaterHeaders');
const repeaterBody = document.getElementById('repeaterBody');
const responseStatus = document.getElementById('responseStatus');
const responseDuration = document.getElementById('responseDuration');
const responseBodyContent = document.getElementById('responseBodyContent');
const responseHeadersContent = document.getElementById('responseHeadersContent');
const respTabs = document.querySelectorAll('.resp-tab');

// Response sub-tabs
respTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        respTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const which = tab.dataset.resp;
        document.getElementById('responseBody').style.display = which === 'body' ? 'block' : 'none';
        document.getElementById('responseHeaders').style.display = which === 'headers' ? 'block' : 'none';
        document.getElementById('responseScripts').style.display = which === 'scripts' ? 'block' : 'none';
    });
});

async function loadHistory() {
    const filter = {};
    const searchVal = historySearch.value.trim();
    if (searchVal) filter.urlContains = searchVal;
    filter.limit = 100;

    const res = await sendMessage('REPEATER_GET_HISTORY', filter);
    if (!res.ok || res.data.length === 0) {
        historyList.innerHTML = '<div class="empty-state-sm">No request history</div>';
        return;
    }

    historyList.innerHTML = res.data.map(entry => {
        const methodClass = `method-${entry.method.toLowerCase()}`;
        const time = new Date(entry.timestamp).toLocaleTimeString();
        const urlShort = entry.url.replace(/^https?:\/\//, '').substring(0, 40);
        return `
      <div class="history-item" data-id="${entry.id}">
        <span class="history-method ${methodClass}">${entry.method}</span>
        <span class="history-url" title="${escapeHtml(entry.url)}">${escapeHtml(urlShort)}</span>
        <span class="history-time">${time}</span>
      </div>
    `;
    }).join('');

    historyList.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('click', () => {
            historyList.querySelectorAll('.history-item').forEach(i => i.classList.remove('selected'));
            item.classList.add('selected');
            const entry = res.data.find(e => e.id === item.dataset.id);
            if (entry) loadIntoRepeater(entry);
        });
    });
}

function loadIntoRepeater(entry) {
    repeaterMethod.value = entry.method || 'GET';
    repeaterUrl.value = entry.url || '';
    repeaterHeaders.value = entry.headers ? JSON.stringify(entry.headers, null, 2) : '';
    repeaterBody.value = entry.body || '';
}

historySearch.addEventListener('input', debounce(loadHistory, 300));

clearHistoryBtn.addEventListener('click', async () => {
    await sendMessage('REPEATER_CLEAR');
    await loadHistory();
});

sendRequestBtn.addEventListener('click', async () => {
    const url = repeaterUrl.value.trim();
    if (!url) { alert('Enter a URL'); return; }

    const method = repeaterMethod.value;
    let headers = [];
    try {
        const raw = repeaterHeaders.value.trim();
        if (raw) headers = JSON.parse(raw);
    } catch { alert('Invalid JSON in headers'); return; }

    const body = repeaterBody.value || null;

    sendRequestBtn.disabled = true;
    sendRequestBtn.textContent = 'Sending...';

    const entry = { url, method, headers, body };
    const res = await sendMessage('REPEATER_REPLAY', { entry, overrides: {} });

    sendRequestBtn.disabled = false;
    sendRequestBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
    Send`;

    if (res.ok) {
        const data = res.data;
        const statusClass = data.status >= 200 && data.status < 300 ? 'status-2xx'
            : data.status >= 300 && data.status < 400 ? 'status-3xx'
                : data.status >= 400 && data.status < 500 ? 'status-4xx' : 'status-5xx';

        responseStatus.className = `response-status ${statusClass}`;
        responseStatus.textContent = `${data.status} ${data.statusText}`;
        responseDuration.textContent = `${data.duration}ms`;

        // Try to pretty-format JSON
        let body = data.body;
        try { body = JSON.stringify(JSON.parse(data.body), null, 2); } catch { }
        responseBodyContent.textContent = body;

        responseHeadersContent.textContent = (data.headers || [])
            .map(h => `${h.name}: ${h.value}`).join('\n');

        loadHistory();
    }
});

// ═══════════════════════════════════════════════════════════════════
//  Comparer Tab
// ═══════════════════════════════════════════════════════════════════

const comparerA = document.getElementById('comparerA');
const comparerB = document.getElementById('comparerB');
const compareBtn = document.getElementById('compareBtn');
const swapInputsBtn = document.getElementById('swapInputsBtn');
const diffOutput = document.getElementById('diffOutput');
const diffStats = document.getElementById('diffStats');
const diffContent = document.getElementById('diffContent');

compareBtn.addEventListener('click', () => {
    const textA = Differ.formatJson(comparerA.value);
    const textB = Differ.formatJson(comparerB.value);

    if (!textA && !textB) { alert('Paste text into both panes'); return; }

    const lineDiff = Differ.diffLines(textA, textB);
    const stats = Differ.diffStats(lineDiff);

    // Render stats
    diffStats.innerHTML = `
    <span class="diff-stat-added">+${stats.added} added</span>
    <span class="diff-stat-removed">-${stats.removed} removed</span>
    <span class="diff-stat-unchanged">${stats.unchanged} unchanged</span>
  `;

    // Render diff lines
    diffContent.innerHTML = lineDiff.map(chunk => {
        const lineNum = chunk.lineA || chunk.lineB || '';
        const typeClass = chunk.type === 'add' ? 'added' : chunk.type === 'remove' ? 'removed' : 'equal';
        return `
      <div class="diff-line ${typeClass}">
        <span class="diff-line-number">${lineNum}</span>
        <span class="diff-line-content">${escapeHtml(chunk.value)}</span>
      </div>
    `;
    }).join('');

    diffOutput.style.display = 'block';
});

swapInputsBtn.addEventListener('click', () => {
    const tmp = comparerA.value;
    comparerA.value = comparerB.value;
    comparerB.value = tmp;
});

// ═══════════════════════════════════════════════════════════════════
//  Sandbox Script Execution
// ═══════════════════════════════════════════════════════════════════

const scriptSandbox = document.getElementById('scriptSandbox');
const scriptConsoleOutput = document.getElementById('scriptConsoleOutput');
let sandboxCallbacks = {};
let sandboxReady = false;

// Listen for sandbox responses
window.addEventListener('message', (event) => {
    const { id, ok, data, error } = event.data || {};
    if (id && sandboxCallbacks[id]) {
        sandboxCallbacks[id]({ ok, data, error });
        delete sandboxCallbacks[id];
    }
});

// Wait for sandbox iframe to load
scriptSandbox.addEventListener('load', () => { sandboxReady = true; });

function runInSandbox(script, context = {}) {
    return new Promise((resolve, reject) => {
        if (!sandboxReady || !scriptSandbox.contentWindow) {
            reject(new Error('Sandbox not ready'));
            return;
        }
        const id = 'sb_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
        const timeout = setTimeout(() => {
            delete sandboxCallbacks[id];
            reject(new Error('Script execution timed out (10s)'));
        }, 10000);

        sandboxCallbacks[id] = (result) => {
            clearTimeout(timeout);
            resolve(result);
        };

        scriptSandbox.contentWindow.postMessage({ id, script, context }, '*');
    });
}

function formatScriptLogs(logs) {
    if (!logs || logs.length === 0) return '';
    return logs.map(l => {
        const prefix = l.level === 'error' ? '❌' : l.level === 'warn' ? '⚠️' : 'ℹ️';
        return `${prefix} ${l.args.join(' ')}`;
    }).join('\n');
}

function appendToConsole(text) {
    if (scriptConsoleOutput.textContent === 'Script output will appear here...') {
        scriptConsoleOutput.textContent = '';
    }
    scriptConsoleOutput.textContent += text + '\n';
}

// ═══════════════════════════════════════════════════════════════════
//  Interceptor Script Runner
// ═══════════════════════════════════════════════════════════════════

document.getElementById('runInterceptorScriptBtn').addEventListener('click', async () => {
    const script = document.getElementById('interceptorScript').value.trim();
    if (!script) { alert('Write a script first'); return; }

    const request = {
        url: document.getElementById('editUrl').value,
        method: document.getElementById('editMethod').value,
        headers: {},
        body: document.getElementById('editBody').value
    };
    try {
        const headersRaw = document.getElementById('editHeaders').value.trim();
        if (headersRaw) request.headers = JSON.parse(headersRaw);
    } catch { }

    try {
        const result = await runInSandbox(script, { request });
        if (result.ok && result.data) {
            const logs = formatScriptLogs(result.data.logs);
            if (logs) appendToConsole('[Interceptor Script]\n' + logs);
            // Apply modifications back to the editor
            if (result.data.request) {
                const r = result.data.request;
                if (r.url) document.getElementById('editUrl').value = r.url;
                if (r.method) document.getElementById('editMethod').value = r.method;
                if (r.headers) document.getElementById('editHeaders').value = JSON.stringify(r.headers, null, 2);
                if (r.body) document.getElementById('editBody').value = r.body;
            }
            if (result.data.error) {
                appendToConsole('❌ Script error: ' + result.data.error);
            }
        } else {
            appendToConsole('❌ Sandbox error: ' + (result.error || 'Unknown'));
        }
    } catch (e) {
        appendToConsole('❌ ' + e.message);
    }
});

// ═══════════════════════════════════════════════════════════════════
//  Utilities
// ═══════════════════════════════════════════════════════════════════

function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ═══════════════════════════════════════════════════════════════════
//  Init
// ═══════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadRules();
});
