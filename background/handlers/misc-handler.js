/**
 * Nariya — Misc Message Handler
 */

import { getSettings, updateSettings } from '../../core/storage/storage.js';

export async function handle(message, sendResponse, syncRulesFn) {
    switch (message.type) {
        case 'GET_SETTINGS': {
            const settings = await getSettings();
            sendResponse({ ok: true, data: settings });
            break;
        }
        case 'UPDATE_SETTINGS': {
            const updated = await updateSettings(message.payload);
            await syncRulesFn();
            sendResponse({ ok: true, data: updated });
            break;
        }
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
    }
}
