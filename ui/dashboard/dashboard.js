// dashboard.js - Main entry point for Nariya Dashboard

import { sendMessage } from '../shared/messaging.js';
import { showToast, escapeHtml } from '../shared/utils.js';
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
let isDirty = false;

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

    // 7. Listen for record response from interceptor
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'RECORD_RESPONSE' && msg.data) {
            openRuleModal({
                type: 'mock',
                urlFilter: msg.data.url,
                group: 'Recorded Mocks',
                config: {
                    name: `Recorded: ${msg.data.url}`,
                    statusCode: msg.data.status,
                    headers: msg.data.headers || {},
                    body: msg.data.body || '',
                    delayMs: 0
                }
            });
        }
    });
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
        showToast('Directory acquired! Nariya will attempt to sync `nariya_rules.json` here.', 'success');
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
        showToast(`Google Drive connected! File ID: ${fileId}\nNariya will sync rules to nariya_rules.json in your Drive.`, 'success');
    } catch (err) {
        console.error('Google Drive auth failed:', err);
        showToast('Failed to connect Google Drive: ' + (err.message || err), 'error');
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

function createMockHeaderRow(name = '', value = '') {
    const row = document.createElement('div');
    row.className = 'header-mod-row';
    row.style.display = 'flex';
    row.style.gap = '8px';
    row.style.alignItems = 'center';
    
    row.innerHTML = `
        <input type="text" class="text-input header-name" placeholder="Header Name (e.g. Content-Type)" style="flex:1" value="${escapeHtml(name)}">
        <input type="text" class="text-input header-value" placeholder="Value" style="flex:2" value="${escapeHtml(value)}">
        <button type="button" class="btn btn-ghost delete-header-btn" title="Remove" style="padding: 6px; color: var(--accent-red);">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
    `;
    
    row.querySelector('.delete-header-btn').addEventListener('click', () => row.remove());
    document.getElementById('mockHeadersContainer').appendChild(row);
}

// ─── Modal Handling ───
export function openRuleModal(rule = null) {
    currentEditingRuleId = rule ? rule.id : null;
    const isEdit = rule && rule.id;
    const isDuplicate = rule && !rule.id;
    document.getElementById('modalTitle').textContent = isEdit ? 'Edit Rule' : isDuplicate ? 'Duplicate Rule' : 'Add Rule';

    isDirty = false;
    document.getElementById('saveRuleBtn')?.classList.remove('is-dirty');

    // Reset form
    document.getElementById('ruleName').value = rule?.config?.name || '';
    document.getElementById('ruleGroup').value = rule?.group || 'Default';
    document.getElementById('ruleUrlFilter').value = rule?.urlFilter || '';
    document.getElementById('ruleType').value = rule?.type || 'redirect';
    
    // Advanced options
    document.getElementById('rulePriority').value = rule?.config?.priority || 1;
    const rTypes = rule?.config?.resourceTypes || ['xmlhttprequest', 'script', 'stylesheet', 'image', 'font', 'main_frame', 'sub_frame', 'media', 'websocket', 'other'];
    document.querySelectorAll('.resource-type-cb').forEach(cb => {
        cb.checked = rTypes.includes(cb.value);
    });

    document.getElementById('mockHeadersContainer').innerHTML = '';
    
    // Reset URL tester
    document.getElementById('testUrlResult').innerHTML = '';
    document.getElementById('testUrlResult').className = '';
    if (document.getElementById('testUrlRedirectResult')) {
        document.getElementById('testUrlRedirectResult').style.display = 'none';
    }

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
                document.getElementById('mockDelayMs').value = c.delayMs || 0;
                
                if (c.headers) {
                    Object.entries(c.headers).forEach(([k, v]) => createMockHeaderRow(k, v));
                }

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
                // Update body size
                const mockBody = document.getElementById('mockBody');
                if (mockBody) {
                    mockBody.dispatchEvent(new Event('input'));
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

    const saveMockTemplateBtn = document.getElementById('saveMockTemplateBtn');
    if (saveMockTemplateBtn) {
        saveMockTemplateBtn.addEventListener('click', () => {
            const name = document.getElementById('mockTemplateName').value.trim();
            saveMockTemplate(name);
            document.getElementById('mockTemplateName').value = '';
        });
        loadMockTemplates();
    }

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

    const ruleModal = document.getElementById('ruleModal');
    
    // Dirty tracking
    const markDirty = () => {
        isDirty = true;
        document.getElementById('saveRuleBtn')?.classList.add('is-dirty');
    };
    ruleModal.addEventListener('input', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            markDirty();
        }
    });
    ruleModal.addEventListener('change', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            markDirty();
        }
    });

    const attemptCloseModal = () => {
        if (isDirty) {
            if (!confirm('You have unsaved changes. Are you sure you want to discard them?')) {
                return;
            }
        }
        ruleModal.style.display = 'none';
    };

    document.getElementById('ruleType').addEventListener('change', updateConfigSection);

    document.getElementById('cancelRuleBtn').addEventListener('click', attemptCloseModal);

    // Close modal button
    const closeBtn = document.getElementById('closeModalBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', attemptCloseModal);
    }

    // Close on outside click
    window.addEventListener('click', (e) => {
        if (e.target === ruleModal) {
            attemptCloseModal();
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

    // URL Tester Logic
    const toggleUrlTesterBtn = document.getElementById('toggleUrlTesterBtn');
    const urlTesterPanel = document.getElementById('urlTesterPanel');
    const testUrlInput = document.getElementById('testUrlInput');
    const ruleUrlFilter = document.getElementById('ruleUrlFilter');
    const testUrlResult = document.getElementById('testUrlResult');
    const testUrlRedirectResult = document.getElementById('testUrlRedirectResult');

    if (toggleUrlTesterBtn && urlTesterPanel) {
        toggleUrlTesterBtn.addEventListener('click', () => {
            const isHidden = urlTesterPanel.style.display === 'none';
            urlTesterPanel.style.display = isHidden ? 'block' : 'none';
            toggleUrlTesterBtn.textContent = isHidden ? 'Hide Tester' : 'Test URL Match';
        });

        const evaluateUrl = () => {
            const url = testUrlInput.value.trim();
            const pattern = ruleUrlFilter.value.trim();
            if (!url || !pattern) {
                testUrlResult.innerHTML = '';
                testUrlResult.className = '';
                testUrlRedirectResult.style.display = 'none';
                return;
            }
            
            const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
            const regex = new RegExp(regexStr);
            const isMatch = regex.test(url);
            
            if (isMatch) {
                testUrlResult.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-green)"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> <span style="color:var(--accent-green)">Pattern Matches</span>';
                testUrlResult.className = 'match-success';
                
                const type = document.getElementById('ruleType').value;
                const mode = document.getElementById('redirectMode')?.value;
                if (type === 'redirect' && mode === 'replace') {
                    const matchPattern = document.getElementById('matchPattern')?.value.trim();
                    const replacePattern = document.getElementById('redirectUrl')?.value.trim();
                    if (matchPattern && replacePattern) {
                        try {
                            let rRegexStr = matchPattern;
                            let rSubst = replacePattern;
                            if (!rRegexStr.includes('(') && rRegexStr.includes('*')) {
                                rRegexStr = rRegexStr.replace(/\\\*/g, '.*').replace(/\*/g, '(.*)');
                                let refIdx = 0;
                                rSubst = rSubst.replace(/\*/g, () => { refIdx++; return '$' + refIdx; });
                            }
                            const rRegex = new RegExp(rRegexStr);
                            if (rRegex.test(url)) {
                                const newUrl = url.replace(rRegex, rSubst);
                                testUrlRedirectResult.textContent = `Redirects to: ${newUrl}`;
                                testUrlRedirectResult.style.display = 'block';
                            }
                        } catch(e) {}
                    }
                } else {
                     testUrlRedirectResult.style.display = 'none';
                }
            } else {
                testUrlResult.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--accent-red)"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg> <span style="color:var(--accent-red)">No Match</span>';
                testUrlResult.className = 'match-fail';
                testUrlRedirectResult.style.display = 'none';
            }
        };

        testUrlInput.addEventListener('input', evaluateUrl);
        ruleUrlFilter.addEventListener('input', evaluateUrl);
        document.getElementById('redirectUrl')?.addEventListener('input', evaluateUrl);
        document.getElementById('matchPattern')?.addEventListener('input', evaluateUrl);
    }

    // Mock Status Preset
    const mockStatusPreset = document.getElementById('mockStatusPreset');
    const mockStatusCode = document.getElementById('mockStatusCode');
    if (mockStatusPreset && mockStatusCode) {
        mockStatusPreset.addEventListener('change', () => {
            if (mockStatusPreset.value) mockStatusCode.value = mockStatusPreset.value;
        });
    }

    // Mock Body Formatting & Size
    const formatMockJsonBtn = document.getElementById('formatMockJsonBtn');
    const minifyMockJsonBtn = document.getElementById('minifyMockJsonBtn');
    const mockBody = document.getElementById('mockBody');
    const mockBodySize = document.getElementById('mockBodySize');
    
    const updateMockBodySize = () => {
        if (!mockBody || !mockBodySize) return;
        const bytes = new Blob([mockBody.value]).size;
        let formatted = bytes + ' B';
        if (bytes > 1024) formatted = (bytes / 1024).toFixed(1) + ' KB';
        if (bytes > 1024 * 1024) formatted = (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        mockBodySize.textContent = formatted;
    };
    
    if (mockBody) mockBody.addEventListener('input', updateMockBodySize);

    if (formatMockJsonBtn && mockBody) {
        formatMockJsonBtn.addEventListener('click', () => {
            try { mockBody.value = JSON.stringify(JSON.parse(mockBody.value), null, 2); updateMockBodySize(); }
            catch(e) { showToast('Invalid JSON', 'error'); }
        });
    }
    if (minifyMockJsonBtn && mockBody) {
        minifyMockJsonBtn.addEventListener('click', () => {
            try { mockBody.value = JSON.stringify(JSON.parse(mockBody.value)); updateMockBodySize(); }
            catch(e) { showToast('Invalid JSON', 'error'); }
        });
    }

    // Mock Headers Logic
    const addMockHeaderBtn = document.getElementById('addMockHeaderBtn');
    if (addMockHeaderBtn) {
        addMockHeaderBtn.addEventListener('click', () => createMockHeaderRow());
    }

    // Mock Content-Type Chips
    document.querySelectorAll('.content-type-chips .chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const cType = chip.dataset.type;
            let ctRow = null;
            document.querySelectorAll('#mockHeadersContainer .header-mod-row').forEach(row => {
                if (row.querySelector('.header-name').value.toLowerCase() === 'content-type') ctRow = row;
            });
            if (ctRow) {
                ctRow.querySelector('.header-value').value = cType;
            } else {
                createMockHeaderRow('Content-Type', cType);
            }
            if (cType === 'application/json' && mockBody && !mockBody.value.trim()) {
                mockBody.value = '{\n  "message": "success"\n}';
                updateMockBodySize();
            }
        });
    });

    document.getElementById('saveRuleBtn').addEventListener('click', async () => {
        const type = document.getElementById('ruleType').value;
        const urlFilter = document.getElementById('ruleUrlFilter').value.trim();

        if (!urlFilter) {
            showToast('URL pattern is required', 'error');
            return;
        }

        const rule = {
            id: currentEditingRuleId,
            type,
            urlFilter,
            group: document.getElementById('ruleGroup').value.trim() || 'Default',
            enabled: true,
            config: {
                name: document.getElementById('ruleName').value.trim() || `${type} rule`,
                priority: parseInt(document.getElementById('rulePriority').value) || 1,
                resourceTypes: Array.from(document.querySelectorAll('.resource-type-cb:checked')).map(cb => cb.value)
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
                    rule.config.delayMs = parseInt(document.getElementById('mockDelayMs').value) || 0;
                    
                    const mockHeaders = {};
                    document.querySelectorAll('#mockHeadersContainer .header-mod-row').forEach(row => {
                        const hName = row.querySelector('.header-name').value.trim();
                        const hValue = row.querySelector('.header-value').value.trim();
                        if (hName) mockHeaders[hName] = hValue;
                    });
                    if (Object.keys(mockHeaders).length > 0) rule.config.headers = mockHeaders;

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
            isDirty = false;
            document.getElementById('saveRuleBtn').classList.remove('is-dirty');
            ruleModal.style.display = 'none';
            await loadRules();
        } catch (e) {
            showToast('Error saving rule: ' + e.message, 'error');
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
                showToast('Please select a file to upload to the Cloud.', 'error');
                return;
            }

            const { sessionToken } = await chrome.storage.local.get('sessionToken');
            if (!sessionToken) {
                showToast('You must be signed in to upload assets to Oracle Object DB.', 'error');
                return;
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
                showToast('Successfully uploaded mock asset to Oracle Object DB!', 'success');
            } catch (err) {
                showToast('Upload failed: ' + err.message, 'error');
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
        showToast('Template loaded! Adjust the URL Pattern if necessary, then click "Save Rule".', 'success');
    }
}

// ─── Mock Templates ───

async function saveMockTemplate(name) {
    if (!name) {
        showToast('Template name required', 'error');
        return;
    }
    const statusCode = parseInt(document.getElementById('mockStatusCode').value) || 200;
    const delayMs = parseInt(document.getElementById('mockDelayMs').value) || 0;
    const body = document.getElementById('mockBody').value;
    const headers = {};
    document.querySelectorAll('#mockHeadersContainer .header-mod-row').forEach(row => {
        const hName = row.querySelector('.header-name').value.trim();
        const hValue = row.querySelector('.header-value').value.trim();
        if (hName) headers[hName] = hValue;
    });

    const config = { statusCode, delayMs, body, headers };
    const { nariya_mock_templates = {} } = await chrome.storage.local.get('nariya_mock_templates');
    nariya_mock_templates[name] = config;
    await chrome.storage.local.set({ nariya_mock_templates });
    showToast(`Template "${name}" saved`, 'success');
    loadMockTemplates();
}

async function loadMockTemplates() {
    const list = document.getElementById('mockTemplatesList');
    if (!list) return;
    const { nariya_mock_templates = {} } = await chrome.storage.local.get('nariya_mock_templates');
    list.innerHTML = '';
    
    Object.keys(nariya_mock_templates).forEach(name => {
        const chip = document.createElement('div');
        chip.className = 'chip';
        chip.style = 'display: flex; align-items: center; gap: 4px; padding: 4px 8px; background: var(--bg-tertiary); border-radius: var(--radius-sm); font-size: 13px; border: 1px solid var(--border);';
        
        const label = document.createElement('span');
        label.textContent = name;
        label.style.cursor = 'pointer';
        label.onclick = () => applyMockTemplate(nariya_mock_templates[name]);
        
        const delBtn = document.createElement('span');
        delBtn.innerHTML = '&times;';
        delBtn.style = 'cursor: pointer; color: var(--accent-red); margin-left: 4px; font-weight: bold;';
        delBtn.onclick = () => deleteMockTemplate(name);
        
        chip.appendChild(label);
        chip.appendChild(delBtn);
        list.appendChild(chip);
    });
}

function applyMockTemplate(template) {
    document.getElementById('mockStatusCode').value = template.statusCode || 200;
    document.getElementById('mockDelayMs').value = template.delayMs || 0;
    document.getElementById('mockBody').value = template.body || '';
    
    document.getElementById('mockHeadersContainer').innerHTML = '';
    if (template.headers) {
        Object.entries(template.headers).forEach(([k, v]) => createMockHeaderRow(k, v));
    }
    
    // Update body size
    const mockBody = document.getElementById('mockBody');
    if (mockBody) {
        mockBody.dispatchEvent(new Event('input'));
    }
    showToast('Mock template applied', 'success');
}

async function deleteMockTemplate(name) {
    const { nariya_mock_templates = {} } = await chrome.storage.local.get('nariya_mock_templates');
    delete nariya_mock_templates[name];
    await chrome.storage.local.set({ nariya_mock_templates });
    showToast(`Template "${name}" deleted`, 'success');
    loadMockTemplates();
}
