// logs-tab.js - Handles the Execution Logs UI in the dashboard

import { sendMessage } from '../../shared/messaging.js';
import { escapeHtml } from '../../shared/utils.js';

const executionLogsList = document.getElementById('executionLogsList');
const clearLogsBtn = document.getElementById('clearLogsBtn');

export function initLogsTab() {
    if (!executionLogsList) return;

    // Listen for new logs from the background
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'EXECUTION_LOG_ADDED') {
            loadExecutionLogs();
        }
    });

    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', async () => {
            if (confirm('Clear all execution logs?')) {
                await sendMessage('LOGS_CLEAR');
                loadExecutionLogs();
            }
        });
    }
}

export async function loadExecutionLogs() {
    if (!executionLogsList) return;

    const res = await sendMessage('LOGS_GET');
    if (!res.ok) return;

    const logs = res.data || [];

    if (logs.length === 0) {
        executionLogsList.innerHTML = '<div class="empty-state">No rules have been executed yet. Keep the extension active and browse.</div>';
        return;
    }

    executionLogsList.innerHTML = logs.map(log => {
        const time = new Date(log.timestamp).toLocaleTimeString();
        let path = log.url;
        let host = '';
        try {
            const u = new URL(log.url);
            path = u.pathname + u.search;
            host = u.hostname;
        } catch { }

        // Use the same badge colors as the Rules tab
        let badgeColor = 'var(--text-muted)';
        if (log.ruleType === 'redirect') badgeColor = '#3b82f6';
        if (log.ruleType === 'header') badgeColor = '#8b5cf6';
        if (log.ruleType === 'mock') badgeColor = '#10b981';
        if (log.ruleType === 'delay') badgeColor = '#f59e0b';

        return `
            <div class="log-item" style="background: var(--bg-secondary); border-left: 3px solid ${badgeColor}; padding: 12px; margin-bottom: 8px; border-radius: 4px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
                    <div>
                        <span style="color: ${badgeColor}; font-weight: bold; font-size: 11px; text-transform: uppercase; margin-right: 8px;">${escapeHtml(log.ruleType)}</span>
                        <strong style="color: var(--text-primary); font-size: 14px;">${escapeHtml(log.ruleName)}</strong>
                    </div>
                    <span style="color: var(--text-muted); font-size: 12px;">${time}</span>
                </div>
                <div style="font-family: var(--font-mono); font-size: 13px; color: var(--text-secondary);">
                    <strong>${escapeHtml(log.method)}</strong> ${escapeHtml(host)} <span style="color: var(--text-muted);">${escapeHtml(path)}</span>
                </div>
            </div>
        `;
    }).join('');
}
