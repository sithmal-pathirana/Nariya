/**
 * Launch Chromium with the unpacked extension (no special flags beyond
 * loading it) and expose helpers to drive it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function launchExtension() {
    const context = await chromium.launchPersistentContext('', {
        headless: true,
        // Full Chromium: the headless shell cannot load extensions
        channel: 'chromium',
        executablePath: process.env.NARIYA_CHROMIUM || undefined,
        args: [
            `--disable-extensions-except=${EXTENSION_DIR}`,
            `--load-extension=${EXTENSION_DIR}`,
            '--host-resolver-rules=MAP *.test 127.0.0.1'
        ]
    });

    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;

    // An extension page to send runtime messages from (like the dashboard)
    const extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${extensionId}/ui/popup/popup.html`);

    /** Send a message to the service worker as an extension UI page would */
    const send = (type, payload = {}) => extPage.evaluate(
        ([type, payload]) => new Promise(res => chrome.runtime.sendMessage({ type, payload }, res)),
        [type, payload]
    );

    /** Open a page and wait for Nariya's content scripts to settle */
    const open = async (url) => {
        const page = await context.newPage();
        const errors = [];
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        page.errors = errors;
        await page.goto(url);
        await sleep(400);
        return page;
    };

    await sleep(500);
    return { context, worker, extensionId, extPage, send, open, close: () => context.close() };
}

/** Expression for page.evaluate that runs fetch and reports "status" or "FAIL" */
export function fetchExpr(url, init = {}, read = 'status') {
    const reader = read === 'json' ? 'r.json().then(j => JSON.stringify([r.status, j]))'
        : read === 'text' ? 'r.text().then(t => r.status + " " + t)'
            : 'String(r.status)';
    return `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(r => ${reader}).catch(e => 'FAIL ' + e.message)`;
}
