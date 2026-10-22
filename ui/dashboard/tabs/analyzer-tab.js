// analyzer-tab.js - Handles the Analyzer UI in the dashboard

import { sendMessage } from '../../shared/messaging.js';
import { escapeHtml } from '../../shared/utils.js';

const analyzerIssuesList = document.getElementById('analyzerIssuesList');
const analyzerHighCount = document.getElementById('analyzerHighCount');
const analyzerMediumCount = document.getElementById('analyzerMediumCount');
const analyzerLowCount = document.getElementById('analyzerLowCount');
const clearAnalyzerBtn = document.getElementById('clearAnalyzerBtn');
const analyzerFilterChips = document.querySelectorAll('#analyzerFilterBar .filter-chip');

let currentAnalyzerFilter = 'all';

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

    if (analyzerFilterChips) {
        analyzerFilterChips.forEach(chip => {
            chip.addEventListener('click', () => {
                analyzerFilterChips.forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                currentAnalyzerFilter = chip.dataset.filter;
                loadAnalyzerIssues();
            });
        });
    }
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
    issues.forEach(issue => {
        if (issue.level === 'high') high++;
        else if (issue.level === 'medium') medium++;
        else if (issue.level === 'low') low++;
    });

    const filteredIssues = currentAnalyzerFilter === 'all' 
        ? issues 
        : issues.filter(issue => issue.level === currentAnalyzerFilter);

    if (filteredIssues.length === 0) {
        analyzerIssuesList.innerHTML = `<div class="empty-state">No ${currentAnalyzerFilter !== 'all' ? currentAnalyzerFilter + ' ' : ''}issues detected.</div>`;
    } else {
        analyzerIssuesList.innerHTML = filteredIssues.map(issue => {
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
                <div class="analyzer-issue-card">
                    <div class="analyzer-issue-header">
                        <div style="display: flex; align-items: center; gap: 8px;">
                            <span class="analyzer-issue-badge" style="background: ${badgeClass};">${issue.level}</span>
                            <strong class="analyzer-issue-title">${escapeHtml(issue.message)}</strong>
                        </div>
                        <span class="analyzer-issue-type">${escapeHtml(issue.type)}</span>
                    </div>
                    
                    <div class="analyzer-issue-meta">
                        <div class="analyzer-issue-url">${escapeHtml(issue.method)} <span title="${escapeHtml(issue.url)}">${escapeHtml(host)} <span style="color: var(--text-muted);">${escapeHtml(path)}</span></span></div>
                    </div>

                    <div class="analyzer-issue-help" style="border-left: 3px solid ${badgeClass};">
                        ${escapeHtml(issue.help)}
                    </div>
                </div>
            `;
        }).join('');
    }

    updateStats(issues, high, medium, low);
}

function updateStats(issues, high, medium, low) {
    if (analyzerHighCount) analyzerHighCount.textContent = high;
    if (analyzerMediumCount) analyzerMediumCount.textContent = medium;
    if (analyzerLowCount) analyzerLowCount.textContent = low;
}
