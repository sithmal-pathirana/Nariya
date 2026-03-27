/**
 * content/toast.js
 * In-page toast notification system for Nariya Extension.
 * Displays brief popups when rules are executed on the active page.
 */

(() => {
    let container = null;

    function ensureContainer() {
        if (container && document.body.contains(container)) return;
        container = document.createElement('div');
        container.className = 'nariya-toast-container';
        document.body.appendChild(container);
    }

    const ICONS = {
        redirect: '<svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        header: '<svg viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
        mock: '<svg viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        delay: '<svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
    };

    function showToast(title, message, type = 'info', duration = 4000) {
        ensureContainer();

        const toast = document.createElement('div');
        toast.className = `nariya-toast ${type}`;

        const iconHtml = ICONS[type] || ICONS.redirect;

        toast.innerHTML = `
            <div class="nariya-toast-icon">${iconHtml}</div>
            <div class="nariya-toast-content">
                <h4 class="nariya-toast-title">Nariya: ${title}</h4>
                <p class="nariya-toast-message">${message}</p>
            </div>
            <button class="nariya-toast-close" title="Dismiss">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        `;

        const closeBtn = toast.querySelector('.nariya-toast-close');

        let timeoutId;

        const removeToast = () => {
            toast.classList.remove('nariya-toast-show');
            setTimeout(() => {
                if (toast.parentElement) toast.remove();
            }, 300);
            if (timeoutId) clearTimeout(timeoutId);
        };

        closeBtn.addEventListener('click', removeToast);

        container.appendChild(toast);

        // Trigger reflow for animation
        toast.offsetHeight;
        toast.classList.add('nariya-toast-show');

        if (duration > 0) {
            timeoutId = setTimeout(removeToast, duration);
        }
    }

    // Listen for events from background script
    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'SHOW_NARIYA_TOAST') {
            const p = message.payload || {};
            showToast(p.title || 'Rule Executed', p.message || '', p.ruleType || 'info');
        }
    });

})();
