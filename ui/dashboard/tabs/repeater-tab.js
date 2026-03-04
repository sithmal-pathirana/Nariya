// repeater-tab.js - Handles the Repeater UI in the dashboard

import { sendMessage } from '../../shared/messaging.js';
import { escapeHtml } from '../../shared/utils.js';

// HTML IDs: repeaterMethod, repeaterUrl, repeaterHeaders, repeaterBody,
//           sendRequestBtn, historyList, historySearch, clearHistoryBtn,
//           responseStatus, responseDuration, responseBodyContent, responseHeadersContent,
//           preRequestScript, postResponseScript, scriptConsoleOutput
const historyList = document.getElementById('historyList');
const repUrlInput = document.getElementById('repeaterUrl');
const repMethodSelect = document.getElementById('repeaterMethod');
const repHeadersInput = document.getElementById('repeaterHeaders');
const repBodyInput = document.getElementById('repeaterBody');
const sendRequestBtn = document.getElementById('sendRequestBtn');
const responseBodyContent = document.getElementById('responseBodyContent');
const responseHeadersContent = document.getElementById('responseHeadersContent');
const repStatus = document.getElementById('responseStatus');
const repDuration = document.getElementById('responseDuration');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

// Response sub-tabs
const respTabs = document.querySelectorAll('.resp-tab');
const responseBody = document.getElementById('responseBody');
const responseHeaders = document.getElementById('responseHeaders');
const responseScripts = document.getElementById('responseScripts');

let currentHistory = [];

export function initRepeaterTab() {
    if (!sendRequestBtn || !repUrlInput) {
        console.warn('[Nariya] Repeater tab elements not found');
        return;
    }

    // Response sub-tab switching
    respTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            respTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const which = tab.dataset.resp;
            if (responseBody) responseBody.style.display = which === 'body' ? '' : 'none';
            if (responseHeaders) responseHeaders.style.display = which === 'headers' ? '' : 'none';
            if (responseScripts) responseScripts.style.display = which === 'scripts' ? '' : 'none';
        });
    });

    sendRequestBtn.addEventListener('click', async () => {
        sendRequestBtn.disabled = true;
        sendRequestBtn.textContent = 'Sending...';
        if (responseBodyContent) responseBodyContent.textContent = 'Waiting for response...';
        if (repStatus) repStatus.textContent = '';
        if (repDuration) repDuration.textContent = '';

        const entry = {
            url: repUrlInput.value,
            method: repMethodSelect.value,
            body: repBodyInput.value
        };

        try {
            const headersRaw = repHeadersInput.value.trim();
            if (headersRaw) {
                const parsed = JSON.parse(headersRaw);
                if (Array.isArray(parsed)) {
                    entry.headers = parsed;
                } else {
                    entry.headers = Object.entries(parsed).map(([name, value]) => ({ name, value }));
                }
            } else {
                entry.headers = [];
            }
        } catch (e) {
            alert('Invalid JSON in headers:\n' + e.message);
            resetSendBtn();
            return;
        }

        const res = await sendMessage('REPEATER_REPLAY', { entry });

        if (res.ok) {
            const data = res.data;
            if (repStatus) {
                repStatus.textContent = `${data.status} ${data.statusText || ''}`;
                repStatus.className = `response-status status-${String(data.status).charAt(0)}xx`;
            }
            if (repDuration) repDuration.textContent = `${data.time}ms`;

            let bodyText = data.body;
            try {
                if (bodyText && (bodyText.trim().startsWith('{') || bodyText.trim().startsWith('['))) {
                    bodyText = JSON.stringify(JSON.parse(bodyText), null, 2);
                }
            } catch { }

            if (responseBodyContent) responseBodyContent.textContent = bodyText || '(Empty response body)';

            if (responseHeadersContent && data.headers) {
                responseHeadersContent.textContent = data.headers.map(h => `${h.name}: ${h.value}`).join('\n');
            }
        } else {
            if (repStatus) {
                repStatus.textContent = 'Error';
                repStatus.className = 'response-status status-5xx';
            }
            if (responseBodyContent) responseBodyContent.textContent = res.error || 'Failed to send request';
        }

        resetSendBtn();
        loadRepeaterHistory();
    });

    if (clearHistoryBtn) {
        clearHistoryBtn.addEventListener('click', async () => {
            if (confirm('Clear all repeater history?')) {
                await sendMessage('REPEATER_CLEAR');
                await loadRepeaterHistory();
                repUrlInput.value = '';
                repHeadersInput.value = '';
                repBodyInput.value = '';
                if (responseBodyContent) responseBodyContent.textContent = 'Send a request to see the response...';
                if (repStatus) repStatus.textContent = '';
                if (repDuration) repDuration.textContent = '';
            }
        });
    }
}

function resetSendBtn() {
    if (sendRequestBtn) {
        sendRequestBtn.disabled = false;
        sendRequestBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
            Send`;
    }
}

export async function loadRepeaterHistory(silent = false) {
    const res = await sendMessage('REPEATER_GET_HISTORY');
    if (!res.ok) return;

    currentHistory = res.data || [];

    if (!historyList) return;

    if (currentHistory.length === 0) {
        historyList.innerHTML = '<div class="empty-state-sm">No request history</div>';
        return;
    }

    historyList.innerHTML = currentHistory.map(entry => {
        let path = entry.url;
        let host = '';
        try {
            const urlObj = new URL(entry.url);
            path = urlObj.pathname + urlObj.search;
            host = urlObj.hostname;
        } catch { }

        return `
      <div class="history-item" data-id="${entry.id}">
        <div class="history-method method-${entry.method}">${entry.method}</div>
        <div class="history-details">
          <div class="history-path" title="${escapeHtml(entry.url)}">${escapeHtml(path)}</div>
          <div class="history-host">${escapeHtml(host)}</div>
        </div>
      </div>
    `;
    }).join('');

    historyList.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('click', () => {
            historyList.querySelectorAll('.history-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');

            const entry = currentHistory.find(e => e.id === item.dataset.id);
            if (entry) {
                repUrlInput.value = entry.url;
                repMethodSelect.value = entry.method;
                const headersObj = {};
                (entry.headers || []).forEach(h => { headersObj[h.name] = h.value; });
                repHeadersInput.value = Object.keys(headersObj).length > 0 ? JSON.stringify(headersObj, null, 2) : '';
                repBodyInput.value = entry.body || '';
            }
        });
    });
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}
