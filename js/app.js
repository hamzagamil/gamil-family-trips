// ==========================================
// Main App Controller (bundle entry point)
// ==========================================

import { Toast } from './toast.js';
import { Auth } from './auth.js';
import { Trips } from './trips.js';
import { FrequentTrips } from './frequent-trips.js';
import { Notifications } from './notifications.js';
import { getTodayStr, getTomorrowStr, addDays } from './utils.js';
import { isNative } from './platform.js';

export const App = (() => {
    // DOM Elements
    const navTabs = document.querySelectorAll('.nav-tab');
    const bottomNavTabs = document.querySelectorAll('.bottom-nav-tab');
    const views = document.querySelectorAll('.view');
    const viewDatePicker = document.getElementById('view-date-picker');
    const currentDateEl = document.getElementById('current-date');
    const dateLabel = document.getElementById('date-label');
    const btnPrevDay = document.getElementById('btn-prev-day');
    const btnNextDay = document.getElementById('btn-next-day');

    // PWA Install
    let deferredPrompt = null;
    const pwaInstallBanner = document.getElementById('pwa-install-banner');
    const pwaInstallBtn = document.getElementById('pwa-install-btn');
    const pwaDismissBtn = document.getElementById('pwa-dismiss-btn');
    const pwaInstallItem = document.getElementById('pwa-install-item');

    function init() {
        // Set current date
        setCurrentDate();

        // Service worker: registered after the page has loaded so its install
        // (pre-caching the app shell) doesn't compete with startup requests.
        // Not in the native app: its files ship inside the app bundle and push
        // goes through the native Firebase SDK.
        if (isNative) {
            document.documentElement.classList.add('native-app');
        } else if ('serviceWorker' in navigator) {
            if (document.readyState === 'complete') registerServiceWorker();
            else window.addEventListener('load', registerServiceWorker, { once: true });
        }

        // A lazily-loaded chunk failed to load (usually: a deploy removed it
        // while this page was open). Reload once to pick up the new build.
        window.addEventListener('vite:preloadError', (event) => {
            event.preventDefault();
            let alreadyReloaded = false;
            try { alreadyReloaded = sessionStorage.getItem('tripsync:chunk-reload') === '1'; } catch (_) { /* ignore */ }
            if (alreadyReloaded) return;
            try { sessionStorage.setItem('tripsync:chunk-reload', '1'); } catch (_) { /* ignore */ }
            window.location.reload();
        });

        // Date picker change
        viewDatePicker.addEventListener('change', (e) => {
            const selectedDate = e.target.value;
            if (selectedDate) {
                updateDateLabel(selectedDate);
                Trips.startListening(selectedDate);
            }
        });

        // Previous / Next day buttons
        btnPrevDay.addEventListener('click', () => changeDay(-1));
        btnNextDay.addEventListener('click', () => changeDay(1));

        // Tab navigation (desktop top bar)
        navTabs.forEach(tab => {
            tab.addEventListener('click', () => switchView(tab.dataset.view));
        });

        // Bottom nav tabs (mobile) — mirror the same switchView logic
        bottomNavTabs.forEach(tab => {
            if (tab.dataset.view) tab.addEventListener('click', () => switchView(tab.dataset.view));
        });

        // PWA Install prompt
        setupPwaInstall();

        // Initialize modules
        Trips.init();
        FrequentTrips.init();
        Notifications.init();
        Auth.init(); // last: its auth callback starts the other modules' listeners
    }

    // ---- Service Worker ----

    function registerServiceWorker() {
        navigator.serviceWorker.register('/firebase-messaging-sw.js')
            .then(reg => {
                // A new version was installed in the background. The current page
                // keeps working; offer a reload instead of forcing one.
                reg.addEventListener('updatefound', () => {
                    const newWorker = reg.installing;
                    if (!newWorker) return;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'activated' && navigator.serviceWorker.controller) {
                            Toast.show('Gamil Family Trips was updated — tap to refresh', 'info', {
                                duration: 10000,
                                onClick: () => window.location.reload()
                            });
                        }
                    });
                });
            })
            .catch(err => console.error('Service Worker registration failed', err));
    }

    // ---- Date Navigation ----

    function setCurrentDate() {
        const today = getTodayStr();
        viewDatePicker.value = today;
        updateDateLabel(today);

        const now = new Date();
        const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        currentDateEl.textContent = now.toLocaleDateString('en-US', options);
    }

    function changeDay(delta) {
        const current = viewDatePicker.value;
        if (!current) return;

        viewDatePicker.value = addDays(current, delta);
        viewDatePicker.dispatchEvent(new Event('change'));
    }

    // Reflect a date chosen by the app itself (auto-advance) without re-listening
    function showDate(dateStr) {
        viewDatePicker.value = dateStr;
        updateDateLabel(dateStr);
    }

    function updateDateLabel(dateStr) {
        if (!dateLabel) return;

        const today = getTodayStr();

        if (dateStr === today) {
            dateLabel.textContent = 'Today';
        } else if (dateStr === getTomorrowStr()) {
            dateLabel.textContent = 'Tomorrow';
        } else if (dateStr === addDays(today, -1)) {
            dateLabel.textContent = 'Yesterday';
        } else {
            // Show day name for other dates
            const [y, m, day] = dateStr.split('-').map(Number);
            const dateObj = new Date(y, m - 1, day);
            dateLabel.textContent = dateObj.toLocaleDateString('en-US', {
                weekday: 'short', month: 'short', day: 'numeric'
            });
        }
    }

    // ---- View Switching ----

    function switchView(viewName) {
        // Update desktop top tabs
        navTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.view === viewName);
        });

        // Update mobile bottom tabs
        bottomNavTabs.forEach(tab => {
            tab.classList.toggle('active', tab.dataset.view === viewName);
        });

        // Update views
        views.forEach(view => {
            view.classList.toggle('active', view.id === `view-${viewName}`);
        });

        // Lists for hidden tabs are rendered lazily
        Trips.setActiveView(viewName);
    }

    // ---- PWA Install ----

    function setupPwaInstall() {
        // Listen for the beforeinstallprompt event
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
            console.log('[PWA] Install prompt captured');

            // Show install banner if not dismissed before
            let dismissed = null;
            try { dismissed = localStorage.getItem('pwa-install-dismissed'); } catch (_) { /* ignore */ }
            if (!dismissed) {
                pwaInstallBanner.classList.remove('hidden');
            }

            // Show install menu item
            if (pwaInstallItem) {
                pwaInstallItem.classList.remove('hidden');
            }
        });

        // Install button click (banner)
        if (pwaInstallBtn) {
            pwaInstallBtn.addEventListener('click', triggerInstall);
        }

        // Install button click (menu item)
        if (pwaInstallItem) {
            pwaInstallItem.addEventListener('click', triggerInstall);
        }

        // Dismiss button
        if (pwaDismissBtn) {
            pwaDismissBtn.addEventListener('click', () => {
                pwaInstallBanner.classList.add('hidden');
                try { localStorage.setItem('pwa-install-dismissed', 'true'); } catch (_) { /* ignore */ }
            });
        }

        // Listen for successful install
        window.addEventListener('appinstalled', () => {
            console.log('[PWA] App installed successfully');
            deferredPrompt = null;
            pwaInstallBanner.classList.add('hidden');
            if (pwaInstallItem) {
                pwaInstallItem.classList.add('hidden');
            }
            Toast.show('Gamil Family Trips installed! 🎉', 'success');
        });
    }

    async function triggerInstall() {
        if (!deferredPrompt) {
            Toast.show('App already installed or not available', 'info');
            return;
        }

        // Show the install prompt
        deferredPrompt.prompt();

        const { outcome } = await deferredPrompt.userChoice;
        console.log('[PWA] User choice:', outcome);

        if (outcome === 'accepted') {
            pwaInstallBanner.classList.add('hidden');
        }

        deferredPrompt = null;
    }

    // ---- On User Ready ----

    function onUserReady(user) {
        console.log('User ready:', user.displayName);
        // autoAdvance: on page open, fetch today + tomorrow together and jump
        // to tomorrow if today has nothing left — not on manual navigation.
        const today = getTodayStr();
        showDate(today);
        Trips.startListening(today, { autoAdvance: true, onDateChange: showDate });
        // Start listening for frequent trip templates
        FrequentTrips.startListening();
        // Start checking for upcoming trips every 60 seconds
        Notifications.startReminders();
        // Show notification permission popup if not yet enabled
        Notifications.showNotifPopupIfNeeded();
    }

    function onUserSignedOut() {
        Trips.stopListening();
        FrequentTrips.stopListening();
        Notifications.reset();
    }

    return { init, onUserReady, onUserSignedOut };
})();

// Module scripts run after the document is parsed, so the DOM is ready here
App.init();
