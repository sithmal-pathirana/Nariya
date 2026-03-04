/**
 * Nariya — Debugger Message Handler
 */

import * as debuggerProxy from '../../core/debugger-proxy.js';

export async function handle(message, sendResponse) {
    switch (message.type) {
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
    }
}
