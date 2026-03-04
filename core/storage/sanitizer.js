/**
 * Nariya — Data Sanitizer
 * Validates and sanitizes rule data before saving/importing.
 */

import { RULE_TYPES, CONFIG_SCHEMA } from './schemas.js';

export function sanitizeRule(rule) {
    if (!rule || typeof rule !== 'object') throw new Error('Invalid rule object');

    // Basic fields
    const sanitized = {
        id: typeof rule.id === 'string' ? rule.id : undefined,
        type: typeof rule.type === 'string' && RULE_TYPES.includes(rule.type) ? rule.type : 'redirect',
        urlFilter: typeof rule.urlFilter === 'string' ? rule.urlFilter.substring(0, 1000) : '*',
        enabled: typeof rule.enabled === 'boolean' ? rule.enabled : true,
        createdAt: typeof rule.createdAt === 'number' ? rule.createdAt : Date.now(),
        updatedAt: Date.now()
    };

    // Strip ID if undefined to allow generation
    if (!sanitized.id) delete sanitized.id;

    // Config object
    sanitized.config = {};
    if (rule.config && typeof rule.config === 'object') {
        const allowedKeys = CONFIG_SCHEMA[sanitized.type] || [];
        for (const key of allowedKeys) {
            if (rule.config[key] !== undefined) {
                // Ensure arrays/objects are properly copied to strip prototypes
                if (Array.isArray(rule.config[key])) {
                    sanitized.config[key] = JSON.parse(JSON.stringify(rule.config[key]));
                } else if (typeof rule.config[key] === 'object' && rule.config[key] !== null) {
                    sanitized.config[key] = JSON.parse(JSON.stringify(rule.config[key]));
                } else {
                    sanitized.config[key] = String(rule.config[key]) === rule.config[key] ? String(rule.config[key]) : rule.config[key];
                }
            }
        }
    }

    return sanitized;
}

export function sanitizeImportedRules(rules) {
    if (!Array.isArray(rules)) throw new Error('rules must be an array');
    const validRules = [];

    for (const rule of rules) {
        try {
            validRules.push(sanitizeRule(rule));
        } catch (e) {
            console.warn('[Nariya] Skipped invalid imported rule:', e.message);
        }
    }

    return validRules;
}
