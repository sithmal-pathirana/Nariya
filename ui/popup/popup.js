/**
 * Nariya — Popup Script
 * Manages the popup UI: global toggle, rule list, stats, and navigation.
 */

// ─── Messaging Helper ──────────────────────────────────────────

function sendMessage(type, payload = {}) {
    return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
            resolve(response || { ok: false });
        });
    });
}

// ─── DOM References ──────────────────────────────────────────────

const globalToggle = document.getElementById('globalToggle');
const activeCount = document.getElementById('activeCount');
const totalCount = document.getElementById('totalCount');
const interceptedCount = document.getElementById('interceptedCount');
const rulesList = document.getElementById('rulesList');
const addRuleBtn = document.getElementById('addRuleBtn');
const openDashboardBtn = document.getElementById('openDashboard');

// ─── Init ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadRules();
});

// ─── Settings ────────────────────────────────────────────────────

async function loadSettings() {
    const res = await sendMessage('GET_SETTINGS');
    if (res.ok) {
        globalToggle.checked = res.data.globalEnabled;
    }
}

globalToggle.addEventListener('change', async () => {
    await sendMessage('UPDATE_SETTINGS', { globalEnabled: globalToggle.checked });
});

// ─── Rules ───────────────────────────────────────────────────────

async function loadRules() {
    const res = await sendMessage('GET_ALL_RULES');
    if (!res.ok) return;

    const rules = res.data || [];
    const active = rules.filter(r => r.enabled).length;

    activeCount.textContent = active;
    totalCount.textContent = rules.length;

    // Get intercepted count from repeater history
    const historyRes = await sendMessage('REPEATER_GET_HISTORY', { limit: 1 });
    interceptedCount.textContent = historyRes.ok ? (historyRes.data?.length || 0) : 0;

    renderRules(rules);
}

function renderRules(rules) {
    if (rules.length === 0) {
        rulesList.innerHTML = '<div class="empty-state">No rules configured</div>';
        return;
    }

    rulesList.innerHTML = '';

    for (const rule of rules) {
        const item = document.createElement('div');
        item.className = 'rule-item';
        item.innerHTML = `
      <span class="rule-type-badge badge-${rule.type}">${rule.type}</span>
      <div class="rule-details">
        <div class="rule-name">${escapeHtml(rule.config?.name || rule.type + ' rule')}</div>
        <div class="rule-url">${escapeHtml(rule.urlFilter || '*')}</div>
      </div>
      <div class="rule-toggle">
        <label class="toggle-switch">
          <input type="checkbox" data-rule-id="${rule.id}" ${rule.enabled ? 'checked' : ''}>
          <span class="slider"></span>
        </label>
      </div>
    `;

        // Toggle handler
        const toggle = item.querySelector('input[type="checkbox"]');
        toggle.addEventListener('change', async () => {
            await sendMessage('TOGGLE_RULE', { id: rule.id, enabled: toggle.checked });
            await loadRules();
        });

        rulesList.appendChild(item);
    }
}

// ─── Navigation ──────────────────────────────────────────────────

addRuleBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
});

openDashboardBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
});

// ─── Utilities ───────────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}
