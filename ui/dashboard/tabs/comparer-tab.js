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
    if (changes.length === 0) return '<div class="diff-line diff-equal">Values are identical</div>';

    return changes.map(change => {
        const typeClass = change.type === 'add' ? 'diff-add' :
            change.type === 'remove' ? 'diff-remove' : 'diff-equal';
        const prefix = change.type === 'add' ? '+' :
            change.type === 'remove' ? '-' : ' ';

        return `<div class="diff-line ${typeClass}"><span class="diff-prefix">${prefix}</span>${escapeDiffHtml(change.value)}</div>`;
    }).join('');
}

function escapeDiffHtml(str) {
    if (str === '\n') return '<span class="diff-newline">\\n</span>';
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}
