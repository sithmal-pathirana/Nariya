// analyzer-tab.js - Handles the Analyzer UI in the dashboard

import { sendMessage } from '../../shared/messaging.js';
import { escapeHtml } from '../../shared/utils.js';

const analyzerIssuesList = document.getElementById('analyzerIssuesList');
const analyzerHighCount = document.getElementById('analyzerHighCount');
const analyzerMediumCount = document.getElementById('analyzerMediumCount');
const analyzerLowCount = document.getElementById('analyzerLowCount');
const clearAnalyzerBtn = document.getElementById('clearAnalyzerBtn');

export function initAnalyzerTab() {
    if (!analyzerIssuesList) return;

    // Listen for new issues from the background
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'ANALYZER_ISSUES_FOUND') {
            loadAnalyzerIssues();
        }
    });

    clearAnalyzerBtn.addEventListener('click', async () => {
        if (confirm('Clear all detected issues?')) {
            await sendMessage('ANALYZER_CLEAR_HISTORY');
            loadAnalyzerIssues();
        }
    });
}

export async function loadAnalyzerIssues() {
    if (!analyzerIssuesList) return;

    const res = await sendMessage('ANALYZER_GET_HISTORY');
    if (!res.ok) return;

    const issues = res.data || [];

    if (issues.length === 0) {
        analyzerIssuesList.innerHTML = '<div class="empty-state">No issues detected yet. Browse the web to populate analysis data.</div>';
        updateStats([], 0, 0, 0);
        return;
    }

    let high = 0, medium = 0, low = 0;

    analyzerIssuesList.innerHTML = issues.map(issue => {
        if (issue.level === 'high') high++;
        else if (issue.level === 'medium') medium++;
        else if (issue.level === 'low') low++;

        let badgeClass = 'var(--info)';
        if (issue.level === 'high') badgeClass = 'var(--danger)';
        if (issue.level === 'medium') badgeClass = 'var(--warning)';

        let path = issue.url;
        let host = '';
        try {
            const u = new URL(issue.url);
            path = u.pathname + u.search;
            host = u.hostname;
        } catch { }

        return `
            <div class="analyzer-issue-card" style="background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius); padding: 12px; margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="background: ${badgeClass}; color: #000; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; text-transform: uppercase;">${issue.level}</span>
                        <strong style="font-size: 14px; color: var(--text-primary);">${escapeHtml(issue.message)}</strong>
                    </div>
                    <span style="color: var(--text-muted); font-size: 12px;">${escapeHtml(issue.type)}</span>
                </div>
                
                <div style="margin-bottom: 8px; font-size: 13px; color: var(--text-secondary);">
                    <div style="font-family: var(--font-mono); margin-bottom: 4px;">${escapeHtml(issue.method)} <span title="${escapeHtml(issue.url)}">${escapeHtml(host)} <span style="color: var(--text-muted);">${escapeHtml(path)}</span></span></div>
                </div>

                <div style="background: var(--bg-tertiary); padding: 8px; border-radius: 4px; font-size: 13px; color: var(--text-secondary); border-left: 3px solid ${badgeClass};">
                    ${escapeHtml(issue.help)}
                </div>
            </div>
        `;
    }).join('');

    updateStats(issues, high, medium, low);
}

function updateStats(issues, high, medium, low) {
    if (analyzerHighCount) analyzerHighCount.textContent = high;
    if (analyzerMediumCount) analyzerMediumCount.textContent = medium;
    if (analyzerLowCount) analyzerLowCount.textContent = low;
}
