// comparer-tab.js - Handles the Comparer UI in the dashboard

import { diffLines, diffStats } from '../../../core/differ.js';
import { formatJson } from '../../shared/utils.js';

// HTML IDs: comparerA, comparerB, compareBtn, swapInputsBtn, diffOutput, diffStats, diffContent
const compareBtn = document.getElementById('compareBtn');
const swapInputsBtn = document.getElementById('swapInputsBtn');
const leftInput = document.getElementById('comparerA');
const rightInput = document.getElementById('comparerB');
const diffOutputPanel = document.getElementById('diffOutput');
const diffStatsEl = document.getElementById('diffStats');
const diffContentEl = document.getElementById('diffContent');

export function initComparerTab() {
    if (!compareBtn || !leftInput || !rightInput) {
        console.warn('[Nariya] Comparer tab elements not found');
        return;
    }

    compareBtn.addEventListener('click', () => {
        const leftText = leftInput.value;
        const rightText = rightInput.value;

        if (!leftText && !rightText) {
            if (diffOutputPanel) diffOutputPanel.style.display = 'none';
            return;
        }

        // Format as JSON if possible
        let a = leftText, b = rightText;
        try { a = formatJson(a); } catch { }
        try { b = formatJson(b); } catch { }

        const changes = diffLines(a, b);
        const stats = diffStats(changes);

        if (diffOutputPanel) diffOutputPanel.style.display = 'block';

        if (diffStatsEl) {
            diffStatsEl.innerHTML = `
                <span class="diff-stat diff-add">+${stats.added} Added</span>
                <span class="diff-stat diff-remove">-${stats.removed} Removed</span>
                <span class="diff-stat diff-equal">${stats.unchanged} Unchanged</span>
            `;
        }

        if (diffContentEl) {
            diffContentEl.innerHTML = renderDiff(changes);
        }
    });

    if (swapInputsBtn) {
        swapInputsBtn.addEventListener('click', () => {
            const temp = leftInput.value;
            leftInput.value = rightInput.value;
            rightInput.value = temp;
        });
    }
}

function renderDiff(changes) {
    if (changes.length === 0) return '<div class="diff-line diff-equal" style="padding:8px; text-align:center;">Values are identical</div>';

    let oldLine = 1;
    let newLine = 1;

    // We will build an HTML table for the diff output and a minimap
    let tableHtml = '<table class="vscode-diff-table" style="width: 100%; border-collapse: collapse; font-family: var(--code-font, monospace); font-size: 12px;">';
    let minimapHtml = '<div class="diff-minimap" style="width: 60px; height: 100%; background: var(--bg-tertiary); position: absolute; right: 0; top: 0; opacity: 0.8; overflow: hidden;">';

    changes.forEach(change => {
        const lines = change.value.split('\n');
        // If the last line is just an empty string due to trailing newline, remove it
        if (lines[lines.length - 1] === '') lines.pop();

        lines.forEach(lineStr => {
            const escaped = escapeDiffHtml(lineStr);
            let rowClass = '';
            let prefix = ' ';
            let renderOld = '';
            let renderNew = '';
            let mapColor = 'transparent';

            if (change.type === 'add') {
                rowClass = 'diff-add';
                prefix = '+';
                renderNew = newLine++;
                mapColor = 'var(--success)';
            } else if (change.type === 'remove') {
                rowClass = 'diff-remove';
                prefix = '-';
                renderOld = oldLine++;
                mapColor = 'var(--danger)';
            } else {
                rowClass = 'diff-equal';
                renderOld = oldLine++;
                renderNew = newLine++;
            }

            // Table Row
            tableHtml += `
                <tr class="${rowClass}" style="line-height: 1.4;">
                    <td class="diff-line-num" style="width: 40px; text-align: right; user-select: none; color: var(--text-muted); opacity: 0.6; padding: 0 8px; border-right: 1px solid var(--border);">${renderOld}</td>
                    <td class="diff-line-num" style="width: 40px; text-align: right; user-select: none; color: var(--text-muted); opacity: 0.6; padding: 0 8px; border-right: 1px solid var(--border);">${renderNew}</td>
                    <td class="diff-prefix" style="width: 20px; text-align: center; user-select: none; font-weight: bold; opacity: 0.7;">${prefix}</td>
                    <td class="diff-content" style="white-space: pre-wrap; word-break: break-all; padding: 0 8px;">${escaped || ' '}</td>
                </tr>
            `;

            // Minimap line
            minimapHtml += `<div style="height: 2px; width: 100%; background: ${mapColor};"></div>`;
        });
    });

    tableHtml += '</table>';
    minimapHtml += '</div>';

    return `
        <div style="position: relative; padding-right: 60px; overflow-x: auto; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius);">
            ${tableHtml}
            ${minimapHtml}
        </div>
    `;
}

function escapeDiffHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
}
