// ==========================================
// Toast notifications
// ==========================================

const ICONS = {
    success: 'check_circle',
    error: 'error',
    info: 'info'
};

/**
 * @param {string} message  plain text (never parsed as HTML)
 * @param {'success'|'error'|'info'} type
 * @param {{ onClick?: Function, duration?: number }} [options]
 *   onClick makes the toast tappable; duration (ms) keeps it on screen longer.
 */
function show(message, type = 'info', options = {}) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const duration = options.duration || 3500;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = document.createElement('span');
    icon.className = 'material-icons-round';
    icon.textContent = ICONS[type] || ICONS.info;

    const text = document.createElement('span');
    text.textContent = message;

    toast.append(icon, text);

    if (options.duration) {
        // The CSS fade-out starts 500ms before the default 3.5s removal
        toast.style.animationDelay = `0s, ${duration - 500}ms`;
    }
    if (options.onClick) {
        toast.classList.add('clickable');
        toast.addEventListener('click', options.onClick);
    }

    container.appendChild(toast);
    setTimeout(() => toast.remove(), duration);
}

export const Toast = { show };
