// ESLint config for the extension sources. Run with: cd tests && npm run lint
const browser = Object.fromEntries([
    'window', 'document', 'console', 'fetch', 'URL', 'URLSearchParams', 'Headers', 'Request', 'Response',
    'ReadableStream', 'AbortController', 'AbortSignal', 'DOMException', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'TextDecoder', 'TextEncoder', 'atob', 'btoa', 'MessageChannel',
    'MessageEvent', 'Event', 'CustomEvent', 'ProgressEvent', 'Blob', 'File', 'FileReader', 'FormData',
    'DOMParser', 'XMLSerializer', 'Document', 'XMLHttpRequest', 'indexedDB', 'navigator', 'location',
    'performance', 'confirm', 'alert', 'prompt', 'getComputedStyle', 'requestAnimationFrame', 'self',
    'structuredClone', 'crypto', 'chrome'
].map(name => [name, 'readonly']));

export default [
    {
        ignores: ['**/node_modules/**', 'backend/**', 'infra/**', 'dist/**', 'icons/**']
    },
    {
        files: ['**/*.js', '**/*.mjs'],
        languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browser },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }]
        }
    },
    {
        files: ['content/**/*.js', 'sandbox/**/*.js'],
        languageOptions: { sourceType: 'script' }
    },
    {
        files: ['tests/**/*.mjs', 'tools/**/*.mjs'],
        languageOptions: { globals: { ...browser, process: 'readonly', Buffer: 'readonly' } }
    }
];
