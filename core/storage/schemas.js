/**
 * Nariya — Rule Schemas
 * Type definitions and validation structures for rules.
 */

export const RULE_TYPES = ['redirect', 'header', 'mock', 'delay', 'script'];

export const CONFIG_SCHEMA = {
    redirect: ['name', 'redirectUrl', 'redirectMode', 'matchPattern', 'priority', 'resourceTypes'],
    header: ['name', 'requestHeaders', 'responseHeaders', 'priority', 'resourceTypes'],
    mock: ['name', 'statusCode', 'statusText', 'body', 'headers'],
    delay: ['name', 'delayMs'],
    script: ['name', 'js', 'css', 'world']
};

export const SETTINGS_SCHEMA = {
    globalEnabled: 'boolean',
    interceptorAutoForward: 'boolean',
    maxRepeaterHistory: 'number',
    theme: 'string',
    allowCorsBypass: 'boolean' // Add as opt-in
};
