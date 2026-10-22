/**
 * Nariya — Background Service Worker
 * Central orchestrator: manages rules, debugger proxy, script injection,
 * and communication between all extension components.
 */

import { getAllRules, getSettings } from '../core/storage/storage.js';
import { compileAllRules, applyRules, clearAllDnrRules, getInterceptorRules, activeRuleMap, activeDnrRules } from '../core/rules-engine.js';
import { setupCorsBypass, syncCorsRules } from '../core/cors-bypass.js';
import { dnrRuleMatches } from '../core/url-match.js';
import * as recorder from '../core/recorder.js';
import { syncInterceptorRegistration } from './content-scripts.js';
import { proxyFetch, resolveMockBody } from './handlers/page-handler.js';
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

    // Create Context Menu
    chrome.contextMenus.create({
        id: "send-to-nariya",
        title: "Send to Nariya Repeater",
        contexts: ["link", "selection", "page"]
    });

    await syncRules();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "send-to-nariya") {
        const targetUrl = info.linkUrl || info.selectionText || info.pageUrl;

        // Log to repeater history
        const entry = {
            url: targetUrl || '',
            method: 'GET',
            headers: [],
            body: null,
            source: 'context-menu',
            timestamp: Date.now()
        };
        repeater.addToHistory(entry);

        // Notify UI to refresh repeater history if open
        broadcastToExtensionPages({
            type: 'HISTORY_UPDATED'
        });

        // Open options page if they aren't looking at it
        chrome.runtime.openOptionsPage();
    }
});

chrome.runtime.onStartup.addListener(async () => {
    console.log('[Nariya] Startup');
    await syncRules();
});

// Setup debugger event listener
debuggerProxy.setupEventListener();

// CORS bypass: per-origin session rules kept in sync with open tabs
setupCorsBypass();

// Request recorder: webRequest capture; tell pages when recording toggles
let lastRecordingActive = null;
recorder.setupRecorder(async () => {
    const state = await recorder.getState();
    broadcastToExtensionPages({ type: 'RECORDER_UPDATED', payload: state });
    if (state.active !== lastRecordingActive) {
        lastRecordingActive = state.active;
        await syncInterceptor();
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
            if (!tab.id) continue;
            chrome.tabs.sendMessage(tab.id, {
                target: 'bridge',
                type: 'RECORDING_STATE',
                payload: { enabled: await recorder.isRecordingTab(tab.id) }
            }).catch(() => { });
        }
    }
});

// The rule map lives in memory; rebuild it when the worker wakes up
Promise.all([getAllRules(), getSettings()])
    .then(([rules, settings]) => compileAllRules(settings.globalEnabled ? rules : []))
    .catch(() => { });

// ═══════════════════════════════════════════════════════════════════
//  Rule Syncing
// ═══════════════════════════════════════════════════════════════════

/**
 * Register the MAIN-world interceptor only while something needs it
 */
async function syncInterceptor() {
    try {
        const settings = await getSettings();
        const rules = getInterceptorRules(await getAllRules());
        const recording = (await recorder.getState()).active;
        await syncInterceptorRegistration({
            needed: settings.globalEnabled && (rules.length > 0 || recording),
            sites: settings.interceptorSites || []
        });
    } catch (e) {
        console.warn('[Nariya] Interceptor registration failed:', e);
    }
}

/**
 * Recompile and apply all rules to declarativeNetRequest + content scripts
 */
async function syncRules() {
    const settings = await getSettings();

    // Session rules are wiped on browser restart and depend on open tabs
    await syncCorsRules();
    await syncInterceptor();

    if (!settings.globalEnabled) {
        compileAllRules([]); // empty the in-memory rule maps too
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
    const dnrRules = compileAllRules(allRules);
    await applyRules(dnrRules);

    // 2. Push interceptor rules (mock, delay, proxy) to content scripts
    await broadcastToAllTabs({
        target: 'bridge',
        type: 'UPDATE_INTERCEPTOR_RULES',
        payload: { rules: getInterceptorRules(allRules) }
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

debuggerProxy.setOnResponseReceived((tabId, params, request) => {
    // 1. Analyze for security vulnerabilities and best practices
    const entry = {
        url: params.response?.url || '',
        method: request?.method || 'GET',
        status: params.response?.status,
        requestHeaders: Object.entries(params.response?.requestHeaders || request?.headers || {}).map(([name, value]) => ({ name, value })),
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
        handleBridgeMessage(message, sender, sendResponse);
        return true; // Keep channel open
    }

    // Handle UI messages via the router
    handleUIMessage(message, sender, sendResponse, syncRules);
    return true; // Keep channel open for async responses
});

const TOAST_TITLES = { mock: 'Mock Applied', delay: 'Delay Applied', proxy: 'Sent via Nariya' };

function handleBridgeMessage(message, sender, sendResponse) {
    const tabId = sender.tab?.id;

    switch (message.type) {
        case 'GET_INTERCEPTOR_RULES':
            Promise.all([getAllRules(), getSettings(), recorder.isRecordingTab(tabId)])
                .then(([allRules, settings, recording]) => sendResponse({
                    rules: settings.globalEnabled ? getInterceptorRules(allRules) : [],
                    recording
                }))
                .catch(() => sendResponse({ rules: [], recording: false }));
            break;

        case 'PROXY_FETCH':
            proxyFetch(message.payload || {}, sender)
                .then(sendResponse)
                .catch(e => sendResponse({ ok: false, error: e.message }));
            break;

        case 'RESOLVE_MOCK_BODY':
            resolveMockBody(message.payload || {})
                .then(sendResponse)
                .catch(e => sendResponse({ ok: false, error: e.message }));
            break;

        case 'RECORD_BODY':
            if (tabId !== undefined && message.payload) recorder.attachResponseBody(tabId, message.payload);
            sendResponse({ ok: true });
            break;

        case 'REQUEST_INTERCEPTED': {
            const p = message.payload;
            if (p && TOAST_TITLES[p.type]) {
                let path = p.url;
                try { path = new URL(p.url).pathname; } catch { }
                let msg = `Path: ${path}`;
                if (p.type === 'mock') msg += `\nStatus: ${p.mockedResponse?.status}`;
                if (p.type === 'delay') msg += `\nDelay: ${p.delayMs}ms`;
                if (p.type === 'proxy') msg += `\nStatus: ${p.status}`;

                executionLogs.addLog({
                    ruleType: p.type,
                    ruleName: TOAST_TITLES[p.type],
                    url: p.url || '',
                    method: p.method || 'GET',
                    tabId
                });
                broadcastToExtensionPages({ type: 'EXECUTION_LOG_ADDED' });

                if (tabId) {
                    chrome.tabs.sendMessage(tabId, {
                        type: 'SHOW_NARIYA_TOAST',
                        payload: { title: TOAST_TITLES[p.type], message: msg, ruleType: p.type }
                    }).catch(() => { });
                }
            }
            sendResponse({ ok: true });
            break;
        }

        default:
            sendResponse({ ok: false, error: `Unknown bridge message: ${message.type}` });
    }
}

console.log('[Nariya] Service worker loaded');

// ═══════════════════════════════════════════════════════════════════
//  DNR Rule Feedback (Toasts)
// ═══════════════════════════════════════════════════════════════════

/**
 * Log + toast for a DNR rule that hit a request
 */
function reportDnrMatch(ruleId, request) {
    const rule = activeRuleMap.get(ruleId);
    if (!rule || !request.tabId || request.tabId < 0) return;

    executionLogs.addLog({
        ruleType: rule.type,
        ruleName: rule.config?.name || 'Rule Applied',
        url: request.url || '',
        method: request.method || 'GET',
        tabId: request.tabId
    });
    broadcastToExtensionPages({ type: 'EXECUTION_LOG_ADDED' });

    chrome.tabs.sendMessage(request.tabId, {
        type: 'SHOW_NARIYA_TOAST',
        payload: {
            title: rule.config?.name || 'Rule Applied',
            message: `Matched ${rule.urlFilter || '*'}`,
            ruleType: rule.type
        }
    }).catch(() => { });
}

if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    // Unpacked (developer) installs: Chrome reports every match
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
        reportDnrMatch(info.rule.ruleId, info.request);
    });
} else {
    // Web Store installs: onRuleMatchedDebug does not exist, so evaluate the
    // compiled rules against observed requests ourselves (highest priority wins)
    chrome.webRequest.onBeforeRequest.addListener((details) => {
        if (details.tabId < 0 || activeDnrRules.length === 0) return;
        let best = null;
        for (const dnrRule of activeDnrRules) {
            if ((!best || dnrRule.priority > best.priority) && dnrRuleMatches(dnrRule, details)) best = dnrRule;
        }
        if (best) reportDnrMatch(best.id, details);
    }, { urls: ['<all_urls>'] });
}
