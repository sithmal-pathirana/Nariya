/**
 * Nariya — Background Message Router
 * Dispatches UI messages to the appropriate modular handler.
 */

import * as rulesHandler from './handlers/rules-handler.js';
import * as debuggerHandler from './handlers/debugger-handler.js';
import * as repeaterHandler from './handlers/repeater-handler.js';
import * as miscHandler from './handlers/misc-handler.js';
import * as storage from '../core/storage/storage.js';
import * as repeater from '../core/repeater.js';
import * as analyzer from '../core/analyzer.js';
import * as executionLogs from '../core/execution-logs.js';
import * as debuggerProxy from '../core/debugger-proxy.js';
import * as recorder from '../core/recorder.js';
import { getCorsStatus, clearLearnedHeaders, clearPreflightLog } from '../core/cors-bypass.js';

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

            // --- Analyzer ---
            case 'ANALYZER_GET_HISTORY': {
                sendResponse({ ok: true, data: analyzer.getIssues() });
                break;
            }
            case 'ANALYZER_CLEAR_HISTORY': {
                analyzer.clearIssues();
                sendResponse({ ok: true });
                break;
            }

            // --- Execution Logs ---
            case 'LOGS_GET': {
                sendResponse({ ok: true, data: executionLogs.getLogs() });
                break;
            }
            case 'LOGS_CLEAR': {
                executionLogs.clearLogs();
                sendResponse({ ok: true });
                break;
            }

            // --- CORS panel ---
            case 'CORS_GET_STATUS': {
                sendResponse({ ok: true, data: await getCorsStatus() });
                break;
            }
            case 'CORS_CLEAR_LEARNED': {
                await clearLearnedHeaders();
                sendResponse({ ok: true });
                break;
            }
            case 'CORS_CLEAR_PREFLIGHTS': {
                await clearPreflightLog();
                sendResponse({ ok: true });
                break;
            }

            // --- Request Recorder ---
            case 'RECORDER_GET': {
                sendResponse({
                    ok: true,
                    data: { state: await recorder.getState(), entries: await recorder.getEntries() }
                });
                break;
            }
            case 'RECORDER_START': {
                sendResponse({ ok: true, data: await recorder.start(message.payload?.tabId ?? null) });
                break;
            }
            case 'RECORDER_STOP': {
                sendResponse({ ok: true, data: await recorder.stop() });
                break;
            }
            case 'RECORDER_CLEAR': {
                await recorder.clear();
                sendResponse({ ok: true });
                break;
            }
            case 'RECORDER_DELETE': {
                await recorder.deleteEntries(message.payload?.ids || []);
                sendResponse({ ok: true });
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
