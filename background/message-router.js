/**
 * Nariya — Background Message Router
 * Dispatches UI messages to the appropriate modular handler.
 */

import * as rulesHandler from './handlers/rules-handler.js';
import * as debuggerHandler from './handlers/debugger-handler.js';
import * as repeaterHandler from './handlers/repeater-handler.js';
import * as miscHandler from './handlers/misc-handler.js';

/**
 * Handle UI messages (from popup / dashboard)
 */
export async function handleUIMessage(message, sender, sendResponse, syncRulesFn) {
    try {
        switch (message.type) {
            // ── Rule Management ──
            case 'GET_ALL_RULES':
            case 'SAVE_RULE':
            case 'DELETE_RULE':
            case 'TOGGLE_RULE':
            case 'IMPORT_RULES':
            case 'EXPORT_RULES':
            case 'CLEAR_ALL_RULES':
                await rulesHandler.handle(message, sendResponse, syncRulesFn);
                break;

            // ── Debugger Proxy ──
            case 'DEBUGGER_ATTACH':
            case 'DEBUGGER_DETACH':
            case 'DEBUGGER_IS_ATTACHED':
            case 'DEBUGGER_CONTINUE_REQUEST':
            case 'DEBUGGER_CONTINUE_RESPONSE':
            case 'DEBUGGER_GET_RESPONSE_BODY':
            case 'DEBUGGER_GET_PAUSED':
            case 'DEBUGGER_GET_ATTACHED_TABS':
                await debuggerHandler.handle(message, sendResponse);
                break;

            // ── Repeater ──
            case 'REPEATER_GET_HISTORY':
            case 'REPEATER_REPLAY':
            case 'REPEATER_CLEAR':
                await repeaterHandler.handle(message, sendResponse);
                break;

            // ── Misc & Settings ──
            case 'GET_SETTINGS':
            case 'UPDATE_SETTINGS':
            case 'GET_ACTIVE_TAB':
            case 'GET_ALL_TABS':
                await miscHandler.handle(message, sendResponse, syncRulesFn);
                break;

            default:
                sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
        }
    } catch (err) {
        console.error('[Nariya] Message handler error:', err);
        sendResponse({ ok: false, error: err.message });
    }
}
