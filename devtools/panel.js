// panel.js - Logic for the Nariya DevTools Panel

import { sendMessage } from '../ui/shared/messaging.js';
import { escapeHtml } from '../ui/shared/utils.js';

const activeRulesBody = document.getElementById('activeRulesBody');
const activeRulesCount = document.getElementById('activeRulesCount');
const globalEnableToggle = document.getElementById('globalEnableToggle');
const openDashboardBtn = document.getElementById('openDashboardBtn');
const attachTabBtn = document.getElementById('attachTabBtn');
const detachTabBtn = document.getElementById('detachTabBtn');

const inspectedTabId = chrome.devtools.inspectedWindow.tabId;

async function bootstrap() {
    // 1. Sync global settings
    const settingsRes = await sendMessage('GET_SETTINGS');
    if (settingsRes.ok) {
        globalEnableToggle.checked = settingsRes.data.globalEnabled;
    }

    // 2. Load Active Rules
    await loadActiveRules();

    // 3. Listen for changes
    globalEnableToggle.addEventListener('change', async () => {
        await sendMessage('UPDATE_SETTINGS', { updates: { globalEnabled: globalEnableToggle.checked } });
    });

    openDashboardBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // 4. Interceptor logic
    attachTabBtn.addEventListener('click', async () => {
        attachTabBtn.innerText = 'Attaching...';
        attachTabBtn.disabled = true;

        await sendMessage('DEBUGGER_ATTACH', { tabId: inspectedTabId });

        attachTabBtn.style.display = 'none';
        attachTabBtn.innerText = 'Attach to Current Tab';
        attachTabBtn.disabled = false;

        detachTabBtn.style.display = 'inline-block';
    });

    detachTabBtn.addEventListener('click', async () => {
        await sendMessage('DEBUGGER_DETACH', { tabId: inspectedTabId });
        detachTabBtn.style.display = 'none';
        attachTabBtn.style.display = 'inline-block';
    });
}

async function loadActiveRules() {
    chrome.devtools.inspectedWindow.eval('window.location.href', async (url) => {
        const rulesRes = await sendMessage('GET_ALL_RULES');
        if (!rulesRes.ok) return;

        const allRules = rulesRes.data.filter(rule => rule.enabled);

        // Very rudimentary URL matching logic visually for DevTools pane
        const activeRules = allRules.filter(rule => {
            if (!rule.urlFilter || rule.urlFilter === '*') return true;
            const regex = new RegExp('^' + rule.urlFilter.split('*').join('.*') + '$');
            return regex.test(url) || url.includes(rule.urlFilter.replace(/\*/g, ''));
        });

        activeRulesCount.innerText = activeRules.length;

        if (activeRules.length === 0) {
            activeRulesBody.innerHTML = '<tr><td colspan="3" class="empty-state">No active rules for this tab.</td></tr>';
            return;
        }

        activeRulesBody.innerHTML = activeRules.map(rule => `
            <tr>
                <td><span class="badge badge-info">${rule.type}</span></td>
                <td style="font-family: monospace; font-size: 11px;">${escapeHtml(rule.urlFilter || '*')}</td>
                <td><button class="btn btn-ghost" onclick="window.openDash('${rule.id}')">Edit</button></td>
            </tr>
        `).join('');
    });
}

// Map globally for inline click handlers
window.openDash = (ruleId) => {
    chrome.runtime.openOptionsPage();
};

document.addEventListener('DOMContentLoaded', bootstrap);
