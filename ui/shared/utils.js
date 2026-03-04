/**
 * Nariya — Shared UI Utils
 */

export function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
}

export function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function formatJson(jsonStr) {
    try {
        return JSON.stringify(JSON.parse(jsonStr), null, 2);
    } catch {
        return jsonStr;
    }
}
