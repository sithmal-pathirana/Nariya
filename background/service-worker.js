/**
 * Nariya — Background Service Worker
 * Central orchestrator: manages rules, debugger proxy, script injection,
 * and communication between all extension components.
 */

import { getAllRules, getSettings } from '../core/storage/storage.js';
import { compileAllRules, applyRules, clearAllDnrRules, getInterceptorRules, activeRuleMap } from '../core/rules-engine.js';
import * as debuggerProxy from '../core/debugger-proxy.js';
import * as repeater from '../core/repeater.js';
import * as analyzer from '../core/analyzer.js';
import * as executionLogs from '../core/execution-logs.js';
import { handleUIMessage } from './message-router.js';
import { runInSandbox } from './offscreen-manager.js';

// ═══════════════════════════════════════════════════════════════════
//  Initialization
// ═══════════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async (details) => {
    console.log(`[Nariya] Installed (${details.reason})`);
    await syncRules();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[Nariya] Startup');
    await syncRules();
});

// Setup debugger event listener
debuggerProxy.setupEventListener();

// ═══════════════════════════════════════════════════════════════════
//  Rule Syncing
// ═══════════════════════════════════════════════════════════════════

/**
 * Recompile and apply all rules to declarativeNetRequest + content scripts
 */
async function syncRules() {
    const settings = await getSettings();

    if (!settings.globalEnabled) {
        await clearAllDnrRules();
        await broadcastToAllTabs({
            target: 'bridge',
            type: 'CLEAR_INTERCEPTOR_RULES',
            payload: {}
        });
        return;
    }

    const allRules = await getAllRules();

    // 1. Compile & apply DNR rules (redirect, header)
    const dnrRules = compileAllRules(allRules, settings);
    await applyRules(dnrRules);

    // 2. Push interceptor rules (mock, delay) to content scripts
    const interceptorRules = getInterceptorRules(allRules);
    await broadcastToAllTabs({
        target: 'bridge',
        type: 'UPDATE_INTERCEPTOR_RULES',
        payload: { rules: interceptorRules }
    });
}

/**
 * Broadcast a message to all tabs
 */
async function broadcastToAllTabs(message) {
    try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
                chrome.tabs.sendMessage(tab.id, message).catch(() => { });
            }
        }
    } catch (e) {
        console.warn('[Nariya] Broadcast error:', e);
    }
}

/**
 * Inject the interceptor script into a specific tab
 */
async function injectInterceptor(tabId) {
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['content/interceptor.js'],
            world: 'MAIN',
            injectImmediately: true
        });
    } catch (e) {
        console.warn(`[Nariya] Failed to inject interceptor into tab ${tabId}:`, e);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  Tab Events — inject interceptor on navigation
// ═══════════════════════════════════════════════════════════════════

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') return;
    if (!tab.url || tab.url.startsWith('chrome://')) return;

    const settings = await getSettings();
    if (!settings.globalEnabled) return;

    const allRules = await getAllRules();
    const interceptorRules = getInterceptorRules(allRules);

    if (interceptorRules.length > 0) {
        await injectInterceptor(tabId);

        // Send rules to the newly injected interceptor
        setTimeout(() => {
            chrome.tabs.sendMessage(tabId, {
                target: 'bridge',
                type: 'UPDATE_INTERCEPTOR_RULES',
                payload: { rules: interceptorRules }
            }).catch(() => { });
        }, 100);
    }
});

// ═══════════════════════════════════════════════════════════════════
//  Debugger Proxy Callbacks
// ═══════════════════════════════════════════════════════════════════

debuggerProxy.setOnRequestPaused(async (tabId, params) => {
    let requestToForward = null;
    let autoFinished = false;

    // 1. Check auto-mutate script
    const settings = await getSettings();
    if (settings.interceptorAutoMutate && settings.interceptorAutoMutateScript) {
        try {
            const result = await runInSandbox(settings.interceptorAutoMutateScript, { request: params.request });
            if (result.ok && result.data && result.data.request) {
                const req = result.data.request;
                const mods = {
                    url: req.url,
                    method: req.method,
                    postData: req.body || req.postData,
                    headers: Object.entries(req.headers || {}).map(([name, value]) => ({ name, value }))
                };
                await debuggerProxy.continueRequest(tabId, params.requestId, mods);
                autoFinished = true;
                requestToForward = req;
            }
        } catch (e) {
            console.error('[Nariya] Auto-mutate script failed:', e);
        }
    }

    // 2. Log to repeater history
    const entry = {
        url: requestToForward?.url || params.request?.url || '',
        method: requestToForward?.method || params.request?.method || 'GET',
        headers: Object.entries(requestToForward?.headers || params.request?.headers || {}).map(([name, value]) => ({ name, value })),
        body: requestToForward?.body || requestToForward?.postData || params.request?.postData || null,
        source: autoFinished ? 'interceptor-auto' : 'interceptor-proxy',
        timestamp: Date.now()
    };
    repeater.addToHistory(entry);

    // 3. Notify connected dashboard UIs (if we didn't auto-forward)
    if (!autoFinished) {
        broadcastToExtensionPages({
            type: 'REQUEST_PAUSED',
            payload: { tabId, ...params, historyEntry: entry }
        });
    }
});

debuggerProxy.setOnResponseReceived((tabId, params) => {
    // 1. Analyze for security vulnerabilities and best practices
    const entry = {
        url: params.response?.url || '',
        method: 'GET', // Method is unfortunately not usually present in response Received payload
        requestHeaders: Object.entries(params.response?.requestHeaders || {}).map(([name, value]) => ({ name, value })),
        responseHeaders: Object.entries(params.response?.headers || {}).map(([name, value]) => ({ name, value }))
    };

    const newIssues = analyzer.analyzeAndStore(entry);

    if (newIssues.length > 0) {
        broadcastToExtensionPages({
            type: 'ANALYZER_ISSUES_FOUND',
            payload: newIssues
        });
    }

    // 2. Broadcast for repeater/interceptor listeners
    broadcastToExtensionPages({
        type: 'RESPONSE_RECEIVED',
        payload: { tabId, ...params }
    });
});

/**
 * Broadcast to extension pages (popup, dashboard)
 */
function broadcastToExtensionPages(message) {
    chrome.runtime.sendMessage(message).catch(() => { });
}

// ═══════════════════════════════════════════════════════════════════
//  Message Handler
// ═══════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return;

    // Handle bridge messages (from content script)
    if (message.from === 'bridge') {
        handleBridgeMessage(message);
        return;
    }

    // Handle UI messages via the router
    handleUIMessage(message, sender, sendResponse, syncRules);
    return true; // Keep channel open for async responses
});

function handleBridgeMessage(message) {
    switch (message.type) {
        case 'REQUEST_INTERCEPTED':
            // Log intercepted request
            if (message.payload) {
                repeater.addToHistory({
                    url: message.payload.url,
                    method: message.payload.method,
                    source: `interceptor-${message.payload.type}`,
                    timestamp: Date.now()
                });
            }
            break;
    }
}

console.log('[Nariya] Service worker loaded');

// ═══════════════════════════════════════════════════════════════════
//  DNR Rule Feedback (Toasts)
// ═══════════════════════════════════════════════════════════════════

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
        if (!info.request.tabId || info.request.tabId === -1) return;

        const ruleId = info.rule.ruleId;
        if (ruleId >= 100000) {
            const rule = activeRuleMap.get(ruleId);
            if (rule) {
                // 1. Add to execution logs
                executionLogs.addLog({
                    ruleType: rule.type,
                    ruleName: rule.config?.name || 'Rule Applied',
                    url: info.request.url || '',
                    method: info.request.method || 'GET',
                    tabId: info.request.tabId
                });

                // 2. Broadcast to UI
                broadcastToExtensionPages({
                    type: 'EXECUTION_LOG_ADDED'
                });

                // 3. Send Toast to Tab
                chrome.tabs.sendMessage(info.request.tabId, {
                    type: 'SHOW_NARIYA_TOAST',
                    payload: {
                        title: rule.config?.name || 'Rule Applied',
                        message: `Matched ${rule.urlFilter || '*'}`,
                        ruleType: rule.type
                    }
                }).catch(() => { });
            }
        }
    });
}
