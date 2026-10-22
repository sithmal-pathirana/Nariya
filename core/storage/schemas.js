/**
 * Nariya — Rule Schemas
 * Type definitions and validation structures for rules.
 */

export const RULE_TYPES = ['redirect', 'header', 'mock', 'delay', 'proxy'];

export const CONFIG_SCHEMA = {
    redirect: ['name', 'redirectUrl', 'redirectMode', 'matchPattern', 'priority', 'resourceTypes'],
    header: ['name', 'requestHeaders', 'responseHeaders', 'priority', 'resourceTypes'],
    mock: ['name', 'statusCode', 'statusText', 'body', 'headers', 'cloudKey', 'contentType', 'delayMs'],
    delay: ['name', 'delayMs'],
    proxy: ['name']
};

export const SETTINGS_SCHEMA = {
    globalEnabled: 'boolean',
    interceptorAutoForward: 'boolean',
    maxRepeaterHistory: 'number',
    theme: 'string',
    allowCorsBypass: 'boolean',
    corsBypassSites: 'array',
    corsAllowHeaders: 'array',
    interceptorSites: 'array',
    backendUrl: 'string',
    storageEngine: 'string',
    gdriveFileId: 'string',
    enableCloudSync: 'boolean'
};
