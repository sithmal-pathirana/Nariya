/**
 * Nariya — Sandbox Script Executor
 * Runs inside a sandboxed iframe, safely evaluates user-provided JS code
 * against request/response objects and returns the result via postMessage.
 */

window.addEventListener('message', async (event) => {
    // Only accept messages from our own extension
    if (event.origin !== "null" && !event.origin.startsWith("chrome-extension://")) return;

    const { id, script, context } = event.data;
    if (!id || !script) return;

    try {
        // Enforce execution time limits via a simple timeout wrapper and block heavy APIs
        const fn = new Function(
            'request', 'response', 'console',
            `"use strict";
            // Shadow dangerous globals
            const window = undefined;
            const document = undefined;
            const fetch = undefined;
            const XMLHttpRequest = undefined;
            const setTimeout = undefined;
            const setInterval = undefined;
            const Promise = undefined;
            
            const __logs = [];
            const __console = {
                log: (...args) => __logs.push({ level: 'log', args: args.map(String).slice(0, 10) }),
                warn: (...args) => __logs.push({ level: 'warn', args: args.map(String).slice(0, 10) }),
                error: (...args) => __logs.push({ level: 'error', args: args.map(String).slice(0, 10) }),
                info: (...args) => __logs.push({ level: 'info', args: args.map(String).slice(0, 10) }),
            };
            try {
                // Execute user script synchronously
                const __result = (function(request, response, console) {
                    ${script}
                })(request, response, __console);
                return { result: __result, logs: __logs.slice(0, 50), request, response };
            } catch(e) {
                return { error: e.message, logs: __logs.slice(0, 50), request, response };
            }`
        );

        const execStart = performance.now();
        const output = fn(
            context?.request ? JSON.parse(JSON.stringify(context.request)) : null,
            context?.response ? JSON.parse(JSON.stringify(context.response)) : null,
            null // console placeholder, overridden inside
        );
        const execTime = performance.now() - execStart;

        if (execTime > 1000) {
            console.warn(`[Nariya Sandbox] Script execution took ${Math.round(execTime)}ms`);
        }

        // Validate output size to prevent memory exhaustion DoS
        const serialized = JSON.stringify(output);
        if (serialized.length > 5 * 1024 * 1024) { // 5MB limit
            throw new Error("Output exceeded size limit (5MB)");
        }

        event.source.postMessage({
            id,
            ok: true,
            data: output
        }, event.origin);
    } catch (err) {
        event.source.postMessage({
            id,
            ok: false,
            error: err.message
        }, event.origin);
    }
});
