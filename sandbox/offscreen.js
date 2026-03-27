/**
 * offscreen.js - Brokers message communication between the background worker
 * and the sandboxed execution environment (`sandbox.html`).
 */

const sandboxIframe = document.getElementById('sandbox');
let sandboxReady = false;

sandboxIframe.addEventListener('load', () => {
    sandboxReady = true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'RUN_IN_SANDBOX') {
        const { id, script, context } = message.payload;

        if (!sandboxReady) {
            sendResponse({ id, ok: false, error: 'Sandbox iframe not ready' });
            return true;
        }

        // Temporarily store the response callback listener
        const messageHandler = (event) => {
            const data = event.data || {};
            // The sandbox sends back data with the same task `id`
            if (data.id === id) {
                window.removeEventListener('message', messageHandler);
                sendResponse(data);
            }
        };

        window.addEventListener('message', messageHandler);

        // Send task to the sandboxed iframe
        sandboxIframe.contentWindow.postMessage({ id, script, context }, '*');

        return true; // Keep port open for asynchronous response
    }
});
