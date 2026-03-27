/**
 * Nariya — Request Analyzer
 * Analyzes network requests and responses for security, performance, and best practice issues.
 */

const SECURITY_HEADERS = {
    'strict-transport-security': { level: 'high', help: 'Missing HSTS header makes the site vulnerable to downgrade attacks.' },
    'x-content-type-options': { level: 'medium', help: 'Missing nocniff can lead to MIME-sniffing vulnerabilities.' },
    'x-frame-options': { level: 'medium', help: 'Missing X-Frame-Options allows clickjacking.' },
    'content-security-policy': { level: 'high', help: 'Missing CSP increases risk of XSS attacks.' }
};

const DANGEROUS_HEADERS = [
    'x-powered-by',
    'server',
    'x-aspnet-version'
];

const MAX_ISSUES = 1000;
let identifiedIssues = [];

/**
 * Get all identified issues
 */
export function getIssues() {
    return identifiedIssues;
}

/**
 * Clear all identified issues
 */
export function clearIssues() {
    identifiedIssues = [];
}

/**
 * Identify issues in a single request/response cycle and store them
 * @param {Object} entry - { url, method, requestHeaders, responseHeaders, status, ... }
 * @returns {Array} Array of newly identified issues
 */
export function analyzeAndStore(entry) {
    const issues = [];
    if (!entry.responseHeaders) return issues;

    const resHeaders = entry.responseHeaders.reduce((acc, h) => {
        acc[h.name.toLowerCase()] = h.value;
        return acc;
    }, {});

    // 1. Missing Security Headers
    for (const [header, info] of Object.entries(SECURITY_HEADERS)) {
        if (!resHeaders[header]) {
            issues.push({
                type: 'missing_header',
                header,
                level: info.level,
                message: `Missing ${header}`,
                help: info.help
            });
        }
    }

    // 2. Information Disclosure
    for (const header of DANGEROUS_HEADERS) {
        if (resHeaders[header]) {
            issues.push({
                type: 'info_disclosure',
                header,
                level: 'low',
                message: `Exposing ${header}: ${resHeaders[header]}`,
                help: 'Revealing server technologies aids attackers in finding specific vulnerabilities.'
            });
        }
    }

    // 3. CORS Misconfiguration
    const acao = resHeaders['access-control-allow-origin'];
    const acac = resHeaders['access-control-allow-credentials'];
    if (acao === '*' && acac === 'true') {
        issues.push({
            type: 'cors_vulnerability',
            level: 'high',
            message: 'Insecure CORS Configuration',
            help: 'Allowing credentials with a wildcard origin allows any site to access authenticated data.'
        });
    }

    // 4. Basic Authentication Over HTTP
    if (entry.url && entry.url.startsWith('http://')) {
        const auth = entry.requestHeaders?.find(h => h.name.toLowerCase() === 'authorization');
        if (auth && auth.value.toLowerCase().startsWith('basic ')) {
            issues.push({
                type: 'insecure_auth',
                level: 'high',
                message: 'Basic Auth over unencrypted HTTP',
                help: 'Credentials are sent in plaintext and can be easily intercepted.'
            });
        }
    }

    if (issues.length > 0) {
        const enrichedIssues = issues.map(issue => ({
            ...issue,
            id: `issue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            url: entry.url,
            method: entry.method || 'GET',
            timestamp: Date.now()
        }));

        identifiedIssues.unshift(...enrichedIssues);

        if (identifiedIssues.length > MAX_ISSUES) {
            identifiedIssues = identifiedIssues.slice(0, MAX_ISSUES);
        }

        return enrichedIssues;
    }

    return issues;
}
