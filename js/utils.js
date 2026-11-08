// ==========================================
// Shared helpers
// ==========================================

// Format a Date as YYYY-MM-DD (local time)
export function toDateStr(d) {
    return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0');
}

// Today's date string (YYYY-MM-DD)
export function getTodayStr() {
    return toDateStr(new Date());
}

// Tomorrow's date string (YYYY-MM-DD)
export function getTomorrowStr() {
    return addDays(getTodayStr(), 1);
}

// Shift a YYYY-MM-DD string by `delta` days
export function addDays(dateStr, delta) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return toDateStr(new Date(y, m - 1, d + delta));
}

// Current local time as HH:MM
export function getNowTimeStr() {
    const now = new Date();
    return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
}

// HH:MM (24h) → h:MM AM/PM
export function formatTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const displayHour = h % 12 || 12;
    return `${displayHour}:${String(m).padStart(2, '0')} ${ampm}`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Safe for both text content and quoted attribute values
export function escapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Run fn when the browser is idle (falls back to a short timeout)
export function onIdle(fn, timeout = 3000) {
    if ('requestIdleCallback' in window) {
        requestIdleCallback(fn, { timeout });
    } else {
        setTimeout(fn, 1500);
    }
}

// Notification.permission (web) or the native app's push permission, or
// 'unsupported' where the API doesn't exist (e.g. iOS Safari outside an installed PWA)
export { notificationPermission } from './platform.js';

// ---- Session hint ----
// A small localStorage record of the last signed-in user. index.html reads it
// before first paint to show the app shell instead of the sign-in screen while
// Firebase restores the session.

const SESSION_KEY = 'tripsync:session';

export function readSessionHint() {
    try {
        return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (_) {
        return null;
    }
}

export function writeSessionHint(hint) {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(hint));
    } catch (_) { /* storage unavailable — hint is only an optimisation */ }
}

export function clearSessionHint() {
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch (_) { /* ignore */ }
}
