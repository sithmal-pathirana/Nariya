/**
 * Nariya — Repeater Message Handler
 */

import * as repeater from '../../core/repeater.js';

export async function handle(message, sendResponse) {
    switch (message.type) {
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
    }
}
