/**
 * Nariya — Rules Message Handler
 */

import { getAllRules, saveRule, deleteRule, toggleRule, importRules, exportRules, clearAllRules } from '../../core/storage/storage.js';

export async function handle(message, sendResponse, syncRulesFn) {
    switch (message.type) {
        case 'GET_ALL_RULES': {
            const rules = await getAllRules();
            sendResponse({ ok: true, data: rules });
            break;
        }
        case 'SAVE_RULE': {
            const rule = await saveRule(message.payload);
            await syncRulesFn();
            sendResponse({ ok: true, data: rule });
            break;
        }
        case 'DELETE_RULE': {
            await deleteRule(message.payload.id);
            await syncRulesFn();
            sendResponse({ ok: true });
            break;
        }
        case 'TOGGLE_RULE': {
            await toggleRule(message.payload.id, message.payload.enabled);
            await syncRulesFn();
            sendResponse({ ok: true });
            break;
        }
        case 'IMPORT_RULES': {
            const count = await importRules(message.payload.rules);
            await syncRulesFn();
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
            await syncRulesFn();
            sendResponse({ ok: true });
            break;
        }
    }
}
