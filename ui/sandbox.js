/**
 * Nariya — Sandbox Script Executor
 * Runs inside a sandboxed iframe, safely evaluates user-provided JS code
 * against request/response objects and returns the result via postMessage.
 */

window.addEventListener('message', async (event) => {
    const { id, script, context } = event.data;
    if (!id || !script) return;

    try {
        // Build an isolated function that receives the context variables
        // The user script can modify 'request' or 'response' and return it
        const fn = new Function(
            'request', 'response', 'console',
            `"use strict";
            const __logs = [];
            const __console = {
                log: (...args) => __logs.push({ level: 'log', args: args.map(String) }),
                warn: (...args) => __logs.push({ level: 'warn', args: args.map(String) }),
                error: (...args) => __logs.push({ level: 'error', args: args.map(String) }),
                info: (...args) => __logs.push({ level: 'info', args: args.map(String) }),
            };
            try {
                const __result = (function(request, response, console) {
                    ${script}
                })(request, response, __console);
                return { result: __result, logs: __logs, request, response };
            } catch(e) {
                return { error: e.message, logs: __logs, request, response };
            }`
        );

        const output = fn(
            context?.request ? JSON.parse(JSON.stringify(context.request)) : null,
            context?.response ? JSON.parse(JSON.stringify(context.response)) : null,
            null // console placeholder, overridden inside
        );

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
