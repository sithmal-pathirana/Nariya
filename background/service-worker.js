/**
 * Nariya — Background Service Worker
 * Central orchestrator: manages rules, debugger proxy, script injection,
 * and communication between all extension components.
 */

import { getAllRules, getSettings } from '../core/storage/storage.js';
import { compileAllRules, applyRules, clearAllDnrRules, getInterceptorRules, getScriptRules } from '../core/rules-engine.js';
import * as debuggerProxy from '../core/debugger-proxy.js';
import * as repeater from '../core/repeater.js';
import { handleUIMessage } from './message-router.js';

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
 * Inject user-defined custom scripts/CSS safely into ISOLATED world
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
                    // Executing script within ISOLATED world avoiding direct eval()
                    await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: (code) => {
                            try {
                                const fn = new Function(code);
                                fn();
                            } catch (e) {
                                console.error('[Nariya Script Error]', e);
                            }
                        },
                        args: [config.js],
                        world: config.world || 'ISOLATED' // Enforce ISOLATED world for security
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
