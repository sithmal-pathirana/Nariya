// dashboard.js - Main entry point for Nariya Dashboard

import { sendMessage } from '../shared/messaging.js';
import { initRulesTab, loadRules, getAllRules } from './tabs/rules-tab.js';
import { initInterceptorTab, refreshInterceptorUI } from './tabs/interceptor-tab.js';
import { initRepeaterTab, loadRepeaterHistory } from './tabs/repeater-tab.js';
import { initComparerTab } from './tabs/comparer-tab.js';

// ─── DOM Elements ───
const navButtons = document.querySelectorAll('.nav-item');
const tabPanels = document.querySelectorAll('.tab-panel');
const globalToggle = document.getElementById('globalToggle');
const ruleModal = document.getElementById('ruleModal');

// Sandbox state
const scriptSandbox = document.getElementById('scriptSandbox');
const scriptConsoleOutput = document.getElementById('scriptConsoleOutput');
let sandboxCallbacks = {};
let sandboxReady = false;

// Request handling state
let currentEditingRuleId = null;

// ─── Initialization ───
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Setup Sandbox
    if (scriptSandbox) {
        scriptSandbox.addEventListener('load', () => { sandboxReady = true; });
    }
    window.addEventListener('message', (event) => {
        const { id, ok, data, error } = event.data || {};
        if (id && sandboxCallbacks[id]) {
            sandboxCallbacks[id]({ ok, data, error });
            delete sandboxCallbacks[id];
        }
    });

    // 2. Setup Tabs Navigation — HTML uses <button class="nav-item" data-tab="rules">
    //    and panels use id="tab-rules", so we prefix with "tab-"
    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            navButtons.forEach(b => b.classList.remove('active'));
            tabPanels.forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const panelId = 'tab-' + btn.dataset.tab;
            const target = document.getElementById(panelId);
            if (target) {
                target.classList.add('active');
                if (btn.dataset.tab === 'interceptor') refreshInterceptorUI();
                if (btn.dataset.tab === 'repeater') loadRepeaterHistory();
            }
        });
    });

    // 3. Initialize Tab Modules
    initRulesTab();
    initInterceptorTab();
    initRepeaterTab();
    initComparerTab();

    // 4. Setup Modals & Global State
    setupModals();
    await loadSettings();
    await loadRules();
});

// ─── Global State & Settings ───
const corsToggle = document.getElementById('corsToggle');

async function loadSettings() {
    const res = await sendMessage('GET_SETTINGS');
    if (res.ok && res.data) {
        globalToggle.checked = res.data.globalEnabled;
        if (corsToggle) corsToggle.checked = res.data.allowCorsBypass !== false;
        if (res.data.theme === 'light') {
            document.body.classList.add('light-theme');
        }
    }
}

globalToggle.addEventListener('change', async () => {
    await sendMessage('UPDATE_SETTINGS', { globalEnabled: globalToggle.checked });
});

if (corsToggle) {
    corsToggle.addEventListener('change', async () => {
        await sendMessage('UPDATE_SETTINGS', { allowCorsBypass: corsToggle.checked });
    });
}

// ─── Sandbox Utilities ───
export function runInSandbox(script, context = {}) {
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

export function formatScriptLogs(logs) {
    if (!logs || logs.length === 0) return '';
    return logs.map(l => {
        const prefix = l.level === 'error' ? '❌' : l.level === 'warn' ? '⚠️' : 'ℹ️';
        return `${prefix} ${l.args.join(' ')}`;
    }).join('\n');
}

export function appendToConsole(text) {
    if (scriptConsoleOutput.textContent === 'Script output will appear here...') {
        scriptConsoleOutput.textContent = '';
    }
    scriptConsoleOutput.textContent += text + '\n';
}

// ─── Modal Handling ───
export function openRuleModal(rule = null) {
    currentEditingRuleId = rule ? rule.id : null;
    document.getElementById('modalTitle').textContent = rule ? 'Edit Rule' : 'Add Rule';

    // Reset form
    document.getElementById('ruleName').value = rule?.config?.name || '';
    document.getElementById('ruleUrlFilter').value = rule?.urlFilter || '';
    document.getElementById('ruleType').value = rule?.type || 'redirect';

    // Show appropriate config section
    updateConfigSection();

    // Populate data based on type
    if (rule) {
        const c = rule.config || {};
        switch (rule.type) {
            case 'redirect':
                if (document.getElementById('redirectMode')) document.getElementById('redirectMode').value = c.redirectMode || 'full';
                if (document.getElementById('matchPattern')) document.getElementById('matchPattern').value = c.matchPattern || '';
                document.getElementById('redirectUrl').value = c.redirectUrl || '';
                break;
            case 'header':
                // Header modifications are handled via the header mods container
                break;
            case 'mock':
                document.getElementById('mockStatusCode').value = c.statusCode || 200;
                document.getElementById('mockBody').value = c.body || '';
                break;
            case 'delay':
                document.getElementById('delayMs').value = c.delayMs || 1000;
                break;
            case 'script':
                document.getElementById('scriptJs').value = c.js || '';
                document.getElementById('scriptCss').value = c.css || '';
                break;
        }
    }

    ruleModal.style.display = 'flex';
}

function updateConfigSection() {
    const type = document.getElementById('ruleType').value;
    // Config sections in HTML use ids: configRedirect, configHeader, configMock, configDelay, configScript
    document.querySelectorAll('.config-section').forEach(el => el.style.display = 'none');
    const sectionMap = {
        'redirect': 'configRedirect',
        'header': 'configHeader',
        'mock': 'configMock',
        'delay': 'configDelay',
        'script': 'configScript'
    };
    const section = document.getElementById(sectionMap[type]);
    if (section) section.style.display = 'block';
}

function setupModals() {
    document.getElementById('addRuleBtn').addEventListener('click', () => openRuleModal());

    document.getElementById('ruleType').addEventListener('change', updateConfigSection);

    document.getElementById('cancelRuleBtn').addEventListener('click', () => {
        ruleModal.style.display = 'none';
    });

    // Close modal button
    const closeBtn = document.getElementById('closeModalBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            ruleModal.style.display = 'none';
        });
    }

    // Close on outside click
    window.addEventListener('click', (e) => {
        if (e.target === ruleModal) {
            ruleModal.style.display = 'none';
        }
    });

    // Redirect mode toggle
    const redirectMode = document.getElementById('redirectMode');
    const matchPatternRow = document.getElementById('matchPatternRow');
    if (redirectMode && matchPatternRow) {
        redirectMode.addEventListener('change', () => {
            matchPatternRow.style.display = redirectMode.value === 'replace' ? 'block' : 'none';
        });
    }

    document.getElementById('saveRuleBtn').addEventListener('click', async () => {
        const type = document.getElementById('ruleType').value;
        const urlFilter = document.getElementById('ruleUrlFilter').value.trim();

        if (!urlFilter) {
            alert('URL pattern is required');
            return;
        }

        const rule = {
            id: currentEditingRuleId,
            type,
            urlFilter,
            enabled: true,
            config: {
                name: document.getElementById('ruleName').value.trim() || `${type} rule`
            }
        };

        try {
            switch (type) {
                case 'redirect':
                    rule.config.redirectUrl = document.getElementById('redirectUrl').value.trim();
                    if (!rule.config.redirectUrl) throw new Error('Redirect URL required');
                    const rm = document.getElementById('redirectMode');
                    if (rm) rule.config.redirectMode = rm.value;
                    const mp = document.getElementById('matchPattern');
                    if (mp) rule.config.matchPattern = mp.value;
                    break;
                case 'header':
                    // Collect header modifications from the container
                    const headerMods = [];
                    document.querySelectorAll('#headerModsContainer .header-mod-row').forEach(row => {
                        const headerName = row.querySelector('.header-mod-name')?.value?.trim();
                        const headerValue = row.querySelector('.header-mod-value')?.value?.trim();
                        const headerOp = row.querySelector('.header-mod-op')?.value || 'set';
                        const headerTarget = row.querySelector('.header-mod-target')?.value || 'response';
                        if (headerName) {
                            headerMods.push({ header: headerName, value: headerValue, operation: headerOp, target: headerTarget });
                        }
                    });
                    if (headerMods.length > 0) {
                        rule.config.requestHeaders = headerMods.filter(h => h.target === 'request');
                        rule.config.responseHeaders = headerMods.filter(h => h.target === 'response');
                    }
                    break;
                case 'mock':
                    rule.config.statusCode = parseInt(document.getElementById('mockStatusCode').value) || 200;
                    rule.config.body = document.getElementById('mockBody').value;
                    break;
                case 'delay':
                    rule.config.delayMs = parseInt(document.getElementById('delayMs').value) || 1000;
                    break;
                case 'script':
                    rule.config.js = document.getElementById('scriptJs').value;
                    rule.config.css = document.getElementById('scriptCss').value;
                    break;
            }

            await sendMessage('SAVE_RULE', rule);
            ruleModal.style.display = 'none';
            await loadRules();
        } catch (e) {
            alert('Error saving rule: ' + e.message);
        }
    });
}
