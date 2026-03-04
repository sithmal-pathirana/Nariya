// interceptor-tab.js - Handles the Interceptor UI in the dashboard

import { sendMessage } from '../../shared/messaging.js';
import { escapeHtml } from '../../shared/utils.js';
import { runInSandbox, appendToConsole, formatScriptLogs } from '../dashboard.js';

const interceptorTabSelect = document.getElementById('interceptorTabSelect');
const toggleInterceptorBtn = document.getElementById('toggleInterceptorBtn');
const interceptorStatus = document.getElementById('interceptorStatus');
const pausedRequestsList = document.getElementById('pausedRequestsList');
const requestEditor = document.getElementById('requestEditor');

let interceptorAttached = false;
let interceptorTabId = null;

export function initInterceptorTab() {
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

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'REQUEST_PAUSED') {
            loadPausedRequests();
        }
    });

    setInterval(() => {
        if (interceptorAttached) loadPausedRequests();
    }, 3000);
}

export async function refreshInterceptorUI() {
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
