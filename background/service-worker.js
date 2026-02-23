/**
 * Nariya — Background Service Worker
 * Central orchestrator: manages rules, debugger proxy, script injection,
 * and communication between all extension components.
 */

import { getAllRules, getSettings, saveRule, deleteRule, toggleRule, importRules, exportRules, clearAllRules, updateSettings } from '../lib/storage.js';
import { compileAllRules, applyRules, clearAllDnrRules, getInterceptorRules, getScriptRules } from '../lib/rules-engine.js';
import * as debuggerProxy from '../lib/debugger-proxy.js';
import * as repeater from '../lib/repeater.js';

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
    const dnrRules = compileAllRules(allRules);
    await applyRules(dnrRules);

    // 2. Push interceptor rules (mock, delay) to content scripts
    const interceptorRules = getInterceptorRules(allRules);
    await broadcastToAllTabs({
        target: 'bridge',
        type: 'UPDATE_INTERCEPTOR_RULES',
        payload: { rules: interceptorRules }
    });

    // 3. Inject custom scripts
    const scriptRules = getScriptRules(allRules);
    await injectCustomScripts(scriptRules);
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

/**
 * Inject user-defined custom scripts/CSS
 */
async function injectCustomScripts(scriptRules) {
    for (const rule of scriptRules) {
        const config = rule.config || {};
        const urlPattern = rule.urlFilter || '<all_urls>';

        try {
            const tabs = await chrome.tabs.query({ url: urlPattern });

            for (const tab of tabs) {
                if (!tab.id) continue;

                if (config.js) {
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: (code) => { eval(code); },
                        args: [config.js],
                        world: config.world || 'MAIN'
                    });
                }

                if (config.css) {
                    await chrome.scripting.insertCSS({
                        target: { tabId: tab.id },
                        css: config.css
                    });
                }
            }
        } catch (e) {
            console.warn(`[Nariya] Script injection error for rule ${rule.id}:`, e);
        }
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

    // Inject custom scripts for matching tabs
    const scriptRules = getScriptRules(allRules);
    const matchingScripts = scriptRules.filter(r => {
        if (!r.urlFilter) return true;
        try {
            return tab.url.includes(r.urlFilter) ||
                new RegExp(r.urlFilter.replace(/\*/g, '.*')).test(tab.url);
        } catch {
            return false;
        }
    });

    if (matchingScripts.length > 0) {
        await injectCustomScripts(matchingScripts);
    }
});

// ═══════════════════════════════════════════════════════════════════
//  Debugger Proxy Callbacks
// ═══════════════════════════════════════════════════════════════════

debuggerProxy.setOnRequestPaused((tabId, params) => {
    // Log to repeater history
    const entry = {
        url: params.request?.url || '',
        method: params.request?.method || 'GET',
        headers: Object.entries(params.request?.headers || {}).map(([name, value]) => ({ name, value })),
        body: params.request?.postData || null,
        source: 'interceptor-proxy',
        timestamp: Date.now()
    };
    repeater.addToHistory(entry);

    // Notify connected dashboard UIs
    broadcastToExtensionPages({
        type: 'REQUEST_PAUSED',
        payload: { tabId, ...params, historyEntry: entry }
    });
});

debuggerProxy.setOnResponseReceived((tabId, params) => {
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

    // Handle UI messages (from popup / dashboard)
    handleUIMessage(message, sender, sendResponse);
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

async function handleUIMessage(message, sender, sendResponse) {
    try {
        switch (message.type) {

            // ── Rule Management ─────────────────────────────────────
            case 'GET_ALL_RULES': {
                const rules = await getAllRules();
                sendResponse({ ok: true, data: rules });
                break;
            }

            case 'SAVE_RULE': {
                const rule = await saveRule(message.payload);
                await syncRules();
                sendResponse({ ok: true, data: rule });
                break;
            }

            case 'DELETE_RULE': {
                await deleteRule(message.payload.id);
                await syncRules();
                sendResponse({ ok: true });
                break;
            }

            case 'TOGGLE_RULE': {
                await toggleRule(message.payload.id, message.payload.enabled);
                await syncRules();
                sendResponse({ ok: true });
                break;
            }

            case 'IMPORT_RULES': {
                const count = await importRules(message.payload.rules);
                await syncRules();
                sendResponse({ ok: true, data: { imported: count } });
                break;
            }

            case 'EXPORT_RULES': {
                const json = await exportRules();
                sendResponse({ ok: true, data: json });
                break;
            }

            case 'CLEAR_ALL_RULES': {
                await clearAllRules();
                await syncRules();
                sendResponse({ ok: true });
                break;
            }

            // ── Settings ────────────────────────────────────────────
            case 'GET_SETTINGS': {
                const settings = await getSettings();
                sendResponse({ ok: true, data: settings });
                break;
            }

            case 'UPDATE_SETTINGS': {
                const updated = await updateSettings(message.payload);
                await syncRules();
                sendResponse({ ok: true, data: updated });
                break;
            }

            // ── Debugger Proxy ──────────────────────────────────────
            case 'DEBUGGER_ATTACH': {
                await debuggerProxy.attach(message.payload.tabId, message.payload.options);
                sendResponse({ ok: true });
                break;
            }

            case 'DEBUGGER_DETACH': {
                await debuggerProxy.detach(message.payload.tabId);
                sendResponse({ ok: true });
                break;
            }

            case 'DEBUGGER_IS_ATTACHED': {
                const attached = debuggerProxy.isAttached(message.payload.tabId);
                sendResponse({ ok: true, data: { attached } });
                break;
            }

            case 'DEBUGGER_CONTINUE_REQUEST': {
                await debuggerProxy.continueRequest(
                    message.payload.tabId,
                    message.payload.requestId,
                    message.payload.modifications
                );
                sendResponse({ ok: true });
                break;
            }

            case 'DEBUGGER_CONTINUE_RESPONSE': {
                await debuggerProxy.continueResponse(
                    message.payload.tabId,
                    message.payload.requestId,
                    message.payload.modifications
                );
                sendResponse({ ok: true });
                break;
            }

            case 'DEBUGGER_GET_RESPONSE_BODY': {
                const body = await debuggerProxy.getResponseBody(
                    message.payload.tabId,
                    message.payload.requestId
                );
                sendResponse({ ok: true, data: body });
                break;
            }

            case 'DEBUGGER_GET_PAUSED': {
                const paused = debuggerProxy.getPausedRequests(message.payload.tabId);
                const entries = Array.from(paused.values());
                sendResponse({ ok: true, data: entries });
                break;
            }

            case 'DEBUGGER_GET_ATTACHED_TABS': {
                const tabs = debuggerProxy.getAttachedTabs();
                sendResponse({ ok: true, data: tabs });
                break;
            }

            // ── Repeater ────────────────────────────────────────────
            case 'REPEATER_GET_HISTORY': {
                const history = repeater.getHistory(message.payload || {});
                sendResponse({ ok: true, data: history });
                break;
            }

            case 'REPEATER_REPLAY': {
                const entry = message.payload.entry;
                const overrides = message.payload.overrides || {};
                const result = await repeater.replay(entry, overrides);
                sendResponse({ ok: true, data: result });
                break;
            }

            case 'REPEATER_CLEAR': {
                repeater.clearHistory();
                sendResponse({ ok: true });
                break;
            }

            // ── Misc ────────────────────────────────────────────────
            case 'GET_ACTIVE_TAB': {
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                sendResponse({ ok: true, data: tab });
                break;
            }

            case 'GET_ALL_TABS': {
                const tabs = await chrome.tabs.query({});
                sendResponse({
                    ok: true,
                    data: tabs.map(t => ({ id: t.id, title: t.title, url: t.url }))
                });
                break;
            }

            default:
                sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
        }
    } catch (err) {
        console.error('[Nariya] Message handler error:', err);
        sendResponse({ ok: false, error: err.message });
    }
}

console.log('[Nariya] Service worker loaded');
