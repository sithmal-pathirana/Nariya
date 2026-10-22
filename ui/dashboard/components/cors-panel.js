// cors-panel.js - Live CORS bypass status in Settings: active origins,
// learned headers and recent preflights (with a one-click proxy rule for
// servers that reject them)

import { sendMessage } from '../../shared/messaging.js';
import { showToast } from '../../shared/utils.js';

const activeOrigins = document.getElementById('corsActiveOrigins');
const learnedHeaders = document.getElementById('corsLearnedHeaders');
const autoSites = document.getElementById('corsAutoSites');
const preflightList = document.getElementById('corsPreflightList');

let createProxyRule = () => { };

function chips(container, values, emptyText) {
    container.replaceChildren();
    if (!values.length) {
        const empty = document.createElement('span');
        empty.className = 'cors-empty';
        empty.textContent = emptyText;
        container.appendChild(empty);
        return;
    }
    for (const value of values) {
        const chip = document.createElement('span');
        chip.className = 'cors-chip';
        chip.textContent = value;
        container.appendChild(chip);
    }
}

function renderPreflights(preflights) {
    preflightList.replaceChildren();
    if (!preflights.length) {
        const empty = document.createElement('span');
        empty.className = 'cors-empty';
        empty.textContent = 'No preflights from your dev sites yet.';
        preflightList.appendChild(empty);
        return;
    }
    for (const p of preflights.slice(0, 20)) {
        const row = document.createElement('div');
        row.className = `cors-preflight ${p.ok ? 'ok' : 'fail'}`;
        row.title = `${new Date(p.ts).toLocaleTimeString()} — from ${p.initiator}`;

        const status = document.createElement('span');
        status.className = 'cors-preflight-status';
        status.textContent = p.status || 'ERR';

        const text = document.createElement('div');
        text.style.cssText = 'flex: 1; min-width: 0;';
        const url = document.createElement('div');
        url.className = 'cors-preflight-url';
        url.textContent = p.url;
        text.appendChild(url);
        if (p.hint) {
            const hint = document.createElement('div');
            hint.className = 'cors-preflight-hint';
            hint.textContent = p.hint;
            text.appendChild(hint);
        }

        row.append(status, text);

        if (!p.ok) {
            const btn = document.createElement('button');
            btn.className = 'btn btn-ghost';
            btn.style.cssText = 'font-size: 11px; padding: 2px 8px; white-space: nowrap;';
            btn.textContent = 'Create proxy rule';
            btn.addEventListener('click', () => {
                const u = new URL(p.url);
                createProxyRule(`${u.host}/`);
            });
            row.appendChild(btn);
        }
        preflightList.appendChild(row);
    }
}

export async function loadCorsStatus() {
    if (!activeOrigins) return;
    const res = await sendMessage('CORS_GET_STATUS');
    if (!res.ok) return;
    const { enabled, origins, learnedHeaders: learned, preflights } = res.data;
    chips(activeOrigins, enabled ? origins : [], enabled ? 'Open a page on one of the sites above.' : 'CORS Bypass is off.');
    chips(autoSites, res.data.autoSites || [], 'None (added when a redirect rule sends a site\'s calls elsewhere)');
    chips(learnedHeaders, learned, 'None yet');
    renderPreflights(preflights);
}

/**
 * @param {{ onCreateProxyRule: (urlFilter: string) => void }} options
 */
export function initCorsPanel({ onCreateProxyRule }) {
    if (!activeOrigins) return;
    createProxyRule = onCreateProxyRule;

    document.getElementById('refreshCorsStatusBtn')?.addEventListener('click', loadCorsStatus);
    document.getElementById('clearAutoSitesBtn')?.addEventListener('click', async () => {
        await sendMessage('CORS_CLEAR_AUTO_SITES');
        showToast('Automatic sites cleared (sites from redirect rules stay while the rules exist)', 'success');
        loadCorsStatus();
    });
    document.getElementById('clearLearnedHeadersBtn')?.addEventListener('click', async () => {
        await sendMessage('CORS_CLEAR_LEARNED');
        showToast('Learned headers cleared', 'success');
        loadCorsStatus();
    });
    document.getElementById('clearPreflightsBtn')?.addEventListener('click', async () => {
        await sendMessage('CORS_CLEAR_PREFLIGHTS');
        loadCorsStatus();
    });
}
