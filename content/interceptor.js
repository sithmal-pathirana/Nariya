/**
 * Nariya — Fetch/XHR Interceptor
 * Injected into the page's MAIN world to override window.fetch and XMLHttpRequest.
 * Receives rule configuration via window.postMessage from bridge.js.
 *
 * This file is injected via chrome.scripting.executeScript({ world: "MAIN" })
 */

(function () {
    'use strict';

    // Guard against double injection
    if (window.__nariya_interceptor_installed__) return;
    window.__nariya_interceptor_installed__ = true;

    // Rule store
    let mockRules = [];
    let delayRules = [];

    // Listen for rule config from bridge.js
    window.addEventListener('message', (event) => {
        if (event.source !== window) return;
        if (!event.data || event.data.source !== 'nariya-bridge') return;

        const { type, payload } = event.data;

        switch (type) {
            case 'UPDATE_INTERCEPTOR_RULES':
                mockRules = (payload.rules || []).filter(r => r.type === 'mock');
                delayRules = (payload.rules || []).filter(r => r.type === 'delay');
                console.log(`[Nariya] Interceptor updated: ${mockRules.length} mock, ${delayRules.length} delay rules`);
                break;

            case 'CLEAR_INTERCEPTOR_RULES':
                mockRules = [];
                delayRules = [];
                break;
        }
    });

    /**
     * Check if a URL matches a rule's URL filter
     */
    function matchesUrl(url, filter) {
        if (!filter) return false;

        // Exact match
        if (url === filter) return true;

        // Wildcard match
        if (filter.includes('*')) {
            const regex = new RegExp(
                '^' + filter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
            );
            return regex.test(url);
        }

        // Substring match
        return url.includes(filter);
    }

    /**
     * Find matching mock rule for a URL
     */
    function findMockRule(url) {
        return mockRules.find(r => matchesUrl(url, r.urlFilter));
    }

    /**
     * Find matching delay rule for a URL
     */
    function findDelayRule(url) {
        return delayRules.find(r => matchesUrl(url, r.urlFilter));
    }

    /**
     * Report intercepted request back to bridge
     */
    function reportRequest(data) {
        window.postMessage({
            source: 'nariya-interceptor',
            type: 'REQUEST_INTERCEPTED',
            payload: data
        }, '*');
    }

    // ─── Override fetch ─────────────────────────────────────────────

    const originalFetch = window.fetch;

    window.fetch = async function (...args) {
        const request = new Request(...args);
        const url = request.url;

        // Check for mock rule
        const mockRule = findMockRule(url);
        if (mockRule) {
            const config = mockRule.config || {};
            const status = config.statusCode || 200;
            const headers = config.headers || { 'Content-Type': 'application/json' };
            const body = config.body || '{}';

            reportRequest({
                type: 'mock',
                url,
                method: request.method,
                ruleId: mockRule.id,
                mockedResponse: { status, body: body.substring(0, 200) }
            });

            return new Response(body, {
                status,
                statusText: config.statusText || 'OK',
                headers: new Headers(headers)
            });
        }

        // Check for delay rule
        const delayRule = findDelayRule(url);
        if (delayRule) {
            const delayMs = delayRule.config?.delayMs || 1000;

            reportRequest({
                type: 'delay',
                url,
                method: request.method,
                ruleId: delayRule.id,
                delayMs
            });

            await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        return originalFetch.apply(this, args);
    };

    // ─── Override XMLHttpRequest ────────────────────────────────────

    const OriginalXHR = window.XMLHttpRequest;
    const originalOpen = OriginalXHR.prototype.open;
    const originalSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function (method, url, ...rest) {
        this.__nariya_url = new URL(url, window.location.href).href;
        this.__nariya_method = method;
        return originalOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function (body) {
        const url = this.__nariya_url;
        const method = this.__nariya_method;

        // Check for mock rule
        const mockRule = findMockRule(url);
        if (mockRule) {
            const config = mockRule.config || {};
            const status = config.statusCode || 200;
            const responseBody = config.body || '{}';

            reportRequest({
                type: 'mock',
                url,
                method,
                ruleId: mockRule.id,
                mockedResponse: { status, body: responseBody.substring(0, 200) }
            });

            // Simulate async response
            setTimeout(() => {
                Object.defineProperty(this, 'status', { writable: true, value: status });
                Object.defineProperty(this, 'statusText', { writable: true, value: config.statusText || 'OK' });
                Object.defineProperty(this, 'responseText', { writable: true, value: responseBody });
                Object.defineProperty(this, 'response', { writable: true, value: responseBody });
                Object.defineProperty(this, 'readyState', { writable: true, value: 4 });

                if (typeof this.onreadystatechange === 'function') {
                    this.onreadystatechange();
                }
                this.dispatchEvent(new Event('load'));
                this.dispatchEvent(new Event('loadend'));
            }, 0);

            return;
        }

        // Check for delay rule
        const delayRule = findDelayRule(url);
        if (delayRule) {
            const delayMs = delayRule.config?.delayMs || 1000;

            reportRequest({
                type: 'delay',
                url,
                method,
                ruleId: delayRule.id,
                delayMs
            });

            setTimeout(() => {
                originalSend.call(this, body);
            }, delayMs);

            return;
        }

        return originalSend.call(this, body);
    };

    console.log('[Nariya] Interceptor installed');
})();
