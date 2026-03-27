// dashboard.js - Main entry point for Nariya Dashboard

import { sendMessage } from '../shared/messaging.js';
import { initRulesTab, loadRules, getAllRules } from './tabs/rules-tab.js';
import { initInterceptorTab, refreshInterceptorUI } from './tabs/interceptor-tab.js';
import { initRepeaterTab, loadRepeaterHistory } from './tabs/repeater-tab.js';
import { initComparerTab } from './tabs/comparer-tab.js';
import { initAnalyzerTab, loadAnalyzerIssues } from './tabs/analyzer-tab.js';
import { initLogsTab, loadExecutionLogs } from './tabs/logs-tab.js';
import { initAuth } from './components/auth.js';

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
                if (btn.dataset.tab === 'analyzer') loadAnalyzerIssues();
                if (btn.dataset.tab === 'logs') loadExecutionLogs();
            }
        });
    });

    // 3. Initialize Tab Modules
    initRulesTab();
    initInterceptorTab();
    initRepeaterTab();
    initComparerTab();
    initAnalyzerTab();
    initLogsTab();

    // 4. Initialize Auth Integration
    initAuth();

    // 5. Setup Modals & Global State
    setupModals();
    await loadSettings();
    await loadRules();

    // 6. Re-apply settings UI after rules have rendered
    const settingsRes = await sendMessage('GET_SETTINGS');
    if (settingsRes.ok && settingsRes.data) {
        applySettingsUIState(settingsRes.data);
    }
});

// ─── Global State & Settings ───
const corsToggle = document.getElementById('corsToggle');
const cloudSyncToggle = document.getElementById('cloudSyncToggle');

async function loadSettings() {
    const res = await sendMessage('GET_SETTINGS');
    if (res.ok && res.data) {
        globalToggle.checked = res.data.globalEnabled;
        if (corsToggle) corsToggle.checked = res.data.allowCorsBypass !== false;
        if (cloudSyncToggle) cloudSyncToggle.checked = res.data.enableCloudSync === true;
        if (res.data.theme === 'light') {
            document.body.classList.add('light-theme');
        }
        applySettingsUIState(res.data);
    }
}

function applySettingsUIState(settings) {
    const cloudBlock = document.getElementById('cloudStorageBlock');
    const localBlock = document.getElementById('localStorageBlock');
    const isCloud = settings.enableCloudSync === true;

    if (cloudBlock) cloudBlock.style.display = isCloud ? 'block' : 'none';
    if (localBlock) localBlock.style.display = isCloud ? 'none' : 'block';

    // Toggle share features globally
    const shareBtns = document.querySelectorAll('.share-rule, #importShareBtn');
    shareBtns.forEach(btn => {
        btn.style.display = isCloud ? 'inline-flex' : 'none';
    });

    if (!isCloud) {
        const storageEngine = settings.storageEngine || 'browser';
        const radio = document.querySelector(`input[name="storageEngine"][value="${storageEngine}"]`);
        if (radio) radio.checked = true;

        document.getElementById('selectNativeDirBtn').style.display = storageEngine === 'native' ? 'inline-block' : 'none';
        document.getElementById('gdriveAuthBtn').style.display = storageEngine === 'gdrive' ? 'inline-block' : 'none';
    }
}

if (globalToggle) {
    globalToggle.addEventListener('change', async () => {
        await sendMessage('UPDATE_SETTINGS', { globalEnabled: globalToggle.checked });
    });
}

if (corsToggle) {
    corsToggle.addEventListener('change', async () => {
        await sendMessage('UPDATE_SETTINGS', { allowCorsBypass: corsToggle.checked });
    });
}

if (cloudSyncToggle) {
    cloudSyncToggle.addEventListener('change', async () => {
        const settings = { enableCloudSync: cloudSyncToggle.checked };
        await sendMessage('UPDATE_SETTINGS', settings);
        applySettingsUIState(settings);
    });
}

const storageRadios = document.querySelectorAll('input[name="storageEngine"]');
storageRadios.forEach(radio => {
    radio.addEventListener('change', async (e) => {
        const engine = e.target.value;
        document.getElementById('selectNativeDirBtn').style.display = engine === 'native' ? 'inline-block' : 'none';
        document.getElementById('gdriveAuthBtn').style.display = engine === 'gdrive' ? 'inline-block' : 'none';
        await sendMessage('UPDATE_SETTINGS', { storageEngine: engine });
    });
});

document.getElementById('selectNativeDirBtn')?.addEventListener('click', async () => {
    try {
        const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
        alert('Directory acquired! Nariya will attempt to sync `nariya_rules.json` here.');
    } catch (err) {
        console.error('User aborted directory picker.');
    }
});

document.getElementById('gdriveAuthBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('gdriveAuthBtn');
    try {
        btn.textContent = 'Connecting...';
        btn.disabled = true;

        // Get an OAuth token with Drive scope
        const token = await new Promise((resolve, reject) => {
            chrome.identity.getAuthToken({ interactive: true }, (tok) => {
                if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
                if (!tok) return reject(new Error('No token received'));
                resolve(tok);
            });
        });

        // Verify access by searching for existing nariya_rules.json
        const searchRes = await fetch(
            `https://www.googleapis.com/drive/v3/files?q=name='nariya_rules.json'+and+trashed=false&fields=files(id,name)`,
            { headers: { Authorization: `Bearer ${token}` } }
        );
        const searchData = await searchRes.json();

        let fileId;
        if (searchData.files && searchData.files.length > 0) {
            fileId = searchData.files[0].id;
        } else {
            // Create the file if it doesn't exist
            const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ name: 'nariya_rules.json', mimeType: 'application/json' })
            });
            const createData = await createRes.json();
            fileId = createData.id;
        }

        await sendMessage('UPDATE_SETTINGS', { storageEngine: 'gdrive', gdriveFileId: fileId });
        btn.textContent = '✓ Connected';
        btn.style.background = '#10b981';
        alert(`Google Drive connected! File ID: ${fileId}\nNariya will sync rules to nariya_rules.json in your Drive.`);
    } catch (err) {
        console.error('Google Drive auth failed:', err);
        alert('Failed to connect Google Drive: ' + (err.message || err));
        btn.textContent = 'Connect Drive';
        btn.disabled = false;
    }
});

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
    document.getElementById('ruleGroup').value = rule?.group || 'Default';
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
                if (c.cloudKey) {
                    document.getElementById('mockUseCloudToggle').checked = true;
                    document.getElementById('mockCloudKey').value = c.cloudKey;
                    document.getElementById('mockLocalEditor').style.display = 'none';
                    document.getElementById('mockCloudEditor').style.display = 'block';
                } else {
                    document.getElementById('mockUseCloudToggle').checked = false;
                    document.getElementById('mockBody').value = c.body || '';
                    document.getElementById('mockLocalEditor').style.display = 'block';
                    document.getElementById('mockCloudEditor').style.display = 'none';
                }
                break;
            case 'delay':
                document.getElementById('delayMs').value = c.delayMs || 1000;
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
        'delay': 'configDelay'
    };
    const section = document.getElementById(sectionMap[type]);
    if (section) section.style.display = 'block';
}

function setupModals() {
    document.getElementById('addRuleBtn').addEventListener('click', () => openRuleModal());

    const templatesModal = document.getElementById('templatesModal');
    const openTemplatesBtn = document.getElementById('openTemplatesBtn');

    if (openTemplatesBtn && templatesModal) {
        openTemplatesBtn.addEventListener('click', () => {
            templatesModal.style.display = 'flex';
        });

        document.getElementById('closeTemplatesModalBtn').addEventListener('click', () => {
            templatesModal.style.display = 'none';
        });

        document.getElementById('cancelTemplatesBtn').addEventListener('click', () => {
            templatesModal.style.display = 'none';
        });

        // Handle template clicks
        document.querySelectorAll('.template-card').forEach(card => {
            card.addEventListener('click', () => {
                templatesModal.style.display = 'none';
                applyTemplate(card.dataset.template);
            });
        });
    }

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
            group: document.getElementById('ruleGroup').value.trim() || 'Default',
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
                    if (document.getElementById('mockUseCloudToggle').checked) {
                        rule.config.cloudKey = document.getElementById('mockCloudKey').value.trim();
                        if (!rule.config.cloudKey) throw new Error('Cloud Object Key is required when mapping to Oracle Object DB.');
                        rule.config.body = ''; // Clear local body to save space
                    } else {
                        rule.config.body = document.getElementById('mockBody').value;
                        delete rule.config.cloudKey;
                    }
                    break;
                case 'delay':
                    rule.config.delayMs = parseInt(document.getElementById('delayMs').value) || 1000;
                    break;
            }

            await sendMessage('SAVE_RULE', rule);
            ruleModal.style.display = 'none';
            await loadRules();
        } catch (e) {
            alert('Error saving rule: ' + e.message);
        }
    });

    // Cloud Mock Storage logic
    const mockUseCloudToggle = document.getElementById('mockUseCloudToggle');
    if (mockUseCloudToggle) {
        mockUseCloudToggle.addEventListener('change', () => {
            if (mockUseCloudToggle.checked) {
                document.getElementById('mockLocalEditor').style.display = 'none';
                document.getElementById('mockCloudEditor').style.display = 'block';
            } else {
                document.getElementById('mockLocalEditor').style.display = 'block';
                document.getElementById('mockCloudEditor').style.display = 'none';
            }
        });
    }

    const mockCloudUploadBtn = document.getElementById('mockCloudUploadBtn');
    if (mockCloudUploadBtn) {
        mockCloudUploadBtn.addEventListener('click', async () => {
            const fileInput = document.getElementById('mockCloudFileInput');
            if (!fileInput.files.length) {
                return alert('Please select a file to upload to the Cloud.');
            }

            const { sessionToken } = await chrome.storage.local.get('sessionToken');
            if (!sessionToken) {
                return alert('You must be signed in to upload assets to Oracle Object DB.');
            }

            const formData = new FormData();
            formData.append('mockFile', fileInput.files[0]);

            try {
                mockCloudUploadBtn.textContent = 'Uploading...';
                mockCloudUploadBtn.disabled = true;

                const res = await fetch('http://localhost:8080/api/mocks/upload', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${sessionToken}` },
                    body: formData
                });

                const data = await res.json();
                if (!res.ok) throw new Error(data.error);

                document.getElementById('mockCloudKey').value = data.key;
                alert('Successfully uploaded mock asset to Oracle Object DB!');
            } catch (err) {
                alert('Upload failed: ' + err.message);
            } finally {
                mockCloudUploadBtn.textContent = 'Upload';
                mockCloudUploadBtn.disabled = false;
            }
        });
    }
}

function applyTemplate(templateId) {
    const templates = {
        'cors': {
            type: 'header',
            urlFilter: '*',
            config: {
                name: 'Bypass CORS Restrictions',
                responseHeaders: [
                    { header: 'Access-Control-Allow-Origin', value: '*', operation: 'set', target: 'response' },
                    { header: 'Access-Control-Allow-Methods', value: '*', operation: 'set', target: 'response' },
                    { header: 'Access-Control-Allow-Headers', value: '*', operation: 'set', target: 'response' }
                ]
            }
        },
        'mock500': {
            type: 'mock',
            urlFilter: '/api/*',
            config: {
                name: 'Simulate 500 Server Error',
                statusCode: 500,
                body: '{\n  "error": "Internal Server Error",\n  "message": "Simulated by Nariya"\n}'
            }
        },
        'delayAPI': {
            type: 'delay',
            urlFilter: '/api/*',
            config: {
                name: 'Heavy Network Delay (3s)',
                delayMs: 3000
            }
        }
    };

    const preset = templates[templateId];
    if (preset) {
        openRuleModal(preset);
        alert('Template loaded! Adjust the URL Pattern if necessary, then click "Save Rule".');
    }
}
