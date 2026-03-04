/**
 * Nariya — Rules Engine
 * Compiles user-defined rules into chrome.declarativeNetRequest rules
 * and manages dynamic/session rule registration.
 */

// Rule ID offset to prevent collisions with other extensions
const RULE_ID_BASE = 100000;

// Maximum rules per scope
const MAX_DYNAMIC_RULES = 5000;
const MAX_SESSION_RULES = 5000;

/**
 * Convert a user-friendly URL pattern to a declarativeNetRequest urlFilter
 * @param {string} pattern
 * @returns {string}
 */
function toUrlFilter(pattern) {
    // If it already looks like a dnr filter, return as-is
    if (pattern.startsWith('||') || pattern.startsWith('|') || pattern.includes('^')) {
        return pattern;
    }
    // Convert wildcard (*) pattern
    if (pattern.includes('*')) {
        return pattern;
    }
    // Plain URL or domain — match as substring
    return `*${pattern}*`;
}

/**
 * Parse header modification string "Name: Value" or just "Name"
 * @param {string} str
 * @returns {{ header: string, value?: string }}
 */
function parseHeader(str) {
    const colonIdx = str.indexOf(':');
    if (colonIdx === -1) {
        return { header: str.trim() };
    }
    return {
        header: str.slice(0, colonIdx).trim(),
        value: str.slice(colonIdx + 1).trim()
    };
}

/**
 * Compile a single user rule into a declarativeNetRequest rule
 * @param {Object} rule - User rule from storage
 * @param {number} ruleId - Numeric rule ID for DNR
 * @returns {Object|null} DNR rule or null if not applicable
 */
function compileRule(rule, ruleId) {
    if (!rule.enabled) return null;

    const condition = {
        urlFilter: toUrlFilter(rule.urlFilter || '*'),
        resourceTypes: rule.config?.resourceTypes || [
            'main_frame', 'sub_frame', 'stylesheet', 'script',
            'image', 'font', 'object', 'xmlhttprequest', 'ping',
            'csp_report', 'media', 'websocket', 'webtransport',
            'webbundle', 'other'
        ]
    };

    switch (rule.type) {
        case 'redirect': {
            if (!rule.config?.redirectUrl) return null;
            const mode = rule.config.redirectMode || 'full';

            if (mode === 'replace') {
                // Partial match & replace: use regexFilter + regexSubstitution
                // Convert user-friendly wildcard (*) to regex capture groups
                let matchPattern = rule.config.matchPattern || rule.urlFilter || '';
                let replacePattern = rule.config.redirectUrl || '';

                // If the user used simple wildcards, convert them
                if (!matchPattern.includes('(') && matchPattern.includes('*')) {
                    // Replace each * with a numbered capture group
                    let groupIdx = 0;
                    matchPattern = matchPattern.replace(/\*/g, () => {
                        groupIdx++;
                        return '(.*)';
                    });
                    // Also convert * in replace pattern to back-references
                    let refIdx = 0;
                    replacePattern = replacePattern.replace(/\*/g, () => {
                        refIdx++;
                        return '\\' + refIdx;
                    });
                }

                return {
                    id: ruleId,
                    priority: rule.config?.priority || 1,
                    action: {
                        type: 'redirect',
                        redirect: { regexSubstitution: replacePattern }
                    },
                    condition: {
                        regexFilter: matchPattern,
                        resourceTypes: condition.resourceTypes
                    }
                };
            }

            // Default: full URL redirect
            return {
                id: ruleId,
                priority: rule.config?.priority || 1,
                action: {
                    type: 'redirect',
                    redirect: { url: rule.config.redirectUrl }
                },
                condition
            };
        }

        case 'header': {
            const requestHeaders = [];
            const responseHeaders = [];

            // Process request header modifications
            if (rule.config?.requestHeaders) {
                for (const mod of rule.config.requestHeaders) {
                    const headerMod = { header: mod.header, operation: mod.operation };
                    if (mod.operation !== 'remove' && mod.value !== undefined) {
                        headerMod.value = mod.value;
                    }
                    requestHeaders.push(headerMod);
                }
            }

            // Process response header modifications
            if (rule.config?.responseHeaders) {
                for (const mod of rule.config.responseHeaders) {
                    const headerMod = { header: mod.header, operation: mod.operation };
                    if (mod.operation !== 'remove' && mod.value !== undefined) {
                        headerMod.value = mod.value;
                    }
                    responseHeaders.push(headerMod);
                }
            }

            if (requestHeaders.length === 0 && responseHeaders.length === 0) return null;

            const action = { type: 'modifyHeaders' };
            if (requestHeaders.length > 0) action.requestHeaders = requestHeaders;
            if (responseHeaders.length > 0) action.responseHeaders = responseHeaders;

            return {
                id: ruleId,
                priority: rule.config?.priority || 1,
                action,
                condition
            };
        }

        // Mock and delay rules are handled by the content script interceptor,
        // not by declarativeNetRequest
        case 'mock':
        case 'delay':
        case 'script':
            return null;

        default:
            console.warn(`[Nariya] Unknown rule type: ${rule.type}`);
            return null;
    }
}

/**
 * Compile all user rules into DNR rules
 * @param {Array} userRules - All rules from storage
 * @param {Object} settings - User settings including allowCorsBypass
 * @returns {Array} Compiled DNR rules
 */
export function compileAllRules(userRules, settings = {}) {
    const dnrRules = [];
    let ruleId = RULE_ID_BASE;

    for (const rule of userRules) {
        const compiled = compileRule(rule, ruleId);
        if (compiled) {
            dnrRules.push(compiled);
            ruleId++;
        }
    }

    if (settings.allowCorsBypass) {
        dnrRules.push({
            id: ruleId++,
            priority: 1,
            action: {
                type: 'modifyHeaders',
                responseHeaders: [
                    { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
                    { header: 'Access-Control-Allow-Methods', operation: 'set', value: '*' },
                    { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' }
                ]
            },
            condition: {
                urlFilter: '*', // Apply to all URLs
                resourceTypes: ['xmlhttprequest', 'other'] // Target fetch/XHR API calls
            }
        });
    }

    return dnrRules;
}

/**
 * Apply compiled rules to chrome.declarativeNetRequest
 * Distributes rules across dynamic and session scopes if needed.
 * @param {Array} dnrRules - Compiled DNR rules
 */
export async function applyRules(dnrRules) {
    // Split rules into dynamic and session batches
    const dynamicRules = dnrRules.slice(0, MAX_DYNAMIC_RULES);
    const sessionRules = dnrRules.slice(MAX_DYNAMIC_RULES, MAX_DYNAMIC_RULES + MAX_SESSION_RULES);

    if (dnrRules.length > MAX_DYNAMIC_RULES + MAX_SESSION_RULES) {
        console.warn(
            `[Nariya] Rule count (${dnrRules.length}) exceeds combined limit ` +
            `(${MAX_DYNAMIC_RULES + MAX_SESSION_RULES}). Some rules will be dropped.`
        );
    }

    // Get existing rule IDs to remove
    const existingDynamic = await chrome.declarativeNetRequest.getDynamicRules();
    const existingSession = await chrome.declarativeNetRequest.getSessionRules();

    const dynamicRemoveIds = existingDynamic
        .filter(r => r.id >= RULE_ID_BASE)
        .map(r => r.id);
    const sessionRemoveIds = existingSession
        .filter(r => r.id >= RULE_ID_BASE)
        .map(r => r.id);

    // Apply dynamic rules
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: dynamicRemoveIds,
        addRules: dynamicRules
    });

    // Apply session rules
    await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: sessionRemoveIds,
        addRules: sessionRules
    });

    console.log(
        `[Nariya] Applied ${dynamicRules.length} dynamic + ${sessionRules.length} session rules`
    );
}

/**
 * Clear all Nariya-managed DNR rules
 */
export async function clearAllDnrRules() {
    const existingDynamic = await chrome.declarativeNetRequest.getDynamicRules();
    const existingSession = await chrome.declarativeNetRequest.getSessionRules();

    const dynamicRemoveIds = existingDynamic
        .filter(r => r.id >= RULE_ID_BASE)
        .map(r => r.id);
    const sessionRemoveIds = existingSession
        .filter(r => r.id >= RULE_ID_BASE)
        .map(r => r.id);

    if (dynamicRemoveIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: dynamicRemoveIds,
            addRules: []
        });
    }

    if (sessionRemoveIds.length > 0) {
        await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: sessionRemoveIds,
            addRules: []
        });
    }
}

/**
 * Get content-script-handled rules (mock, delay)
 * These bypass DNR and are sent to the content script interceptor.
 * @param {Array} userRules
 * @returns {Array}
 */
export function getInterceptorRules(userRules) {
    return userRules.filter(
        r => r.enabled && (r.type === 'mock' || r.type === 'delay')
    );
}

/**
 * Get script injection rules
 * @param {Array} userRules
 * @returns {Array}
 */
export function getScriptRules(userRules) {
    return userRules.filter(r => r.enabled && r.type === 'script');
}
