// ==========================================
// Push Notifications Module (FCM)
// ==========================================
//
// Push notifications are displayed by the service worker
// (public/firebase-messaging-sw.js) — always, even while the app is open,
// because browsers revoke push permission for pushes that show nothing.
// This module only manages permission and keeps the device's FCM token in sync.

import { doc, collection, updateDoc, writeBatch, arrayUnion, arrayRemove, serverTimestamp } from 'firebase/firestore';
import { db, VAPID_KEY, ensureMessaging, ensureFunctions } from './firebase-config.js';
import { Toast } from './toast.js';
import { Auth } from './auth.js';
import { Trips } from './trips.js';
import { onIdle, notificationPermission } from './utils.js';
import {
    isNative, platform, refreshNotificationPermission, requestNotificationPermission,
    nativePushToken, initNativePush
} from './platform.js';

export const Notifications = (() => {
    const btnEnableNotif = document.getElementById('btn-enable-notif');

    // Notification permission popup elements
    const notifPermOverlay = document.getElementById('notif-permission-overlay');
    const notifPermTitle = notifPermOverlay?.querySelector('.notif-permission-title');
    const notifPermDesc = notifPermOverlay?.querySelector('.notif-permission-desc');
    const notifPermEnable = document.getElementById('notif-perm-enable');
    const notifPermLater = document.getElementById('notif-perm-later');

    const defaultPopupTitle = notifPermTitle?.textContent;
    const defaultPopupDesc = notifPermDesc?.textContent;

    const NOTIF_ICON = '/icon-192.png';
    // { uid, token, at } for the token this device last saved to Firestore
    const TOKEN_KEY = 'tripsync:fcm-token';
    // Re-confirm an unchanged token with Firestore at most this often
    const TOKEN_RESAVE_MS = 7 * 24 * 60 * 60 * 1000;

    let tokenSyncScheduled = false;

    function init() {
        btnEnableNotif.addEventListener('click', requestPermission);

        // Notification permission popup buttons
        if (notifPermEnable) {
            notifPermEnable.addEventListener('click', async () => {
                hideNotifPopup();
                await requestPermission();
            });
        }
        if (notifPermLater) {
            notifPermLater.addEventListener('click', () => {
                hideNotifPopup();
                // Remember dismissal for 24 hours
                rememberPopupDismissal();
            });
        }
        // Close popup if clicking overlay background
        if (notifPermOverlay) {
            notifPermOverlay.addEventListener('click', (e) => {
                if (e.target === notifPermOverlay) {
                    hideNotifPopup();
                    rememberPopupDismissal();
                }
            });
        }

        // Update button state based on current permission
        updateButtonState();

        if (isNative) initNative();
    }

    // Native app: push goes through the Firebase iOS/Android SDKs, not the service worker
    function initNative() {
        refreshNotificationPermission().then(updateButtonState);
        initNativePush({
            // FCM rotated this device's token — store the new one
            onToken: (token) => {
                const user = Auth.getUser();
                if (user && notificationPermission() === 'granted') {
                    syncToken(user, { token }).catch((err) => console.warn('Could not sync FCM token:', err.message));
                }
            },
            // Android doesn't display pushes while the app is open; show them in-app
            onForegroundMessage: (n) => {
                if (platform !== 'android') return;
                const text = [n.title, n.body].filter(Boolean).join(' — ');
                if (text) Toast.show(text, 'info', { duration: 8000 });
            }
        }).catch((err) => console.warn('[Notifications] native push init failed:', err.message));
    }

    // ---- Token bookkeeping ----

    function readSavedToken() {
        try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch (_) { return null; }
    }

    function writeSavedToken(value) {
        try {
            if (value) localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
            else localStorage.removeItem(TOKEN_KEY);
        } catch (_) { /* ignore */ }
    }

    /**
     * Called once trips have rendered. In idle time:
     * - permission granted → make sure Firestore has this device's CURRENT token
     *   (tokens rotate, and the browser may have replaced the push subscription);
     * - permission lost although this device had notifications on → drop the
     *   dead token and ask the user to turn notifications back on.
     */
    function onTripsLoaded() {
        if (tokenSyncScheduled) return;
        tokenSyncScheduled = true;

        onIdle(async () => {
            const user = Auth.getUser();
            if (!user) return;

            const permission = isNative ? await refreshNotificationPermission() : notificationPermission();
            const saved = readSavedToken();

            if (permission === 'granted') {
                try {
                    await syncToken(user);
                } catch (err) {
                    console.warn('Could not sync FCM token:', err.message);
                }
            } else if (saved && saved.uid === user.uid) {
                console.warn(`[Notifications] Permission is now "${permission}" — it was previously granted.`);
                await removeTokenFromUser(user.uid, saved.token);
                writeSavedToken(null);
                showNotifPopup({ lost: true });
            }
        });
    }

    // Get the current token and store it if it changed (or hasn't been
    // re-confirmed for a while). A replaced token is removed from Firestore.
    async function syncToken(user, { force = false, token = null } = {}) {
        token = token || await currentToken();
        if (!token) return null;

        const saved = readSavedToken();
        const sameUser = saved && saved.uid === user.uid;
        const unchanged = sameUser && saved.token === token;
        if (!force && unchanged && Date.now() - saved.at < TOKEN_RESAVE_MS) return token;

        const update = { fcmTokens: arrayUnion(token) };
        await updateDoc(doc(db, 'users', user.uid), update);
        if (sameUser && saved.token !== token) {
            await removeTokenFromUser(user.uid, saved.token);
            console.log('[Notifications] FCM token rotated.');
        }
        writeSavedToken({ uid: user.uid, token, at: Date.now() });
        return token;
    }

    // This device's FCM token: native SDK in the app, Web Push via the service worker on the web
    async function currentToken() {
        if (isNative) return nativePushToken();

        const m = await ensureMessaging();
        if (!m) return null;
        const registration = await navigator.serviceWorker.ready;
        return m.getToken({
            vapidKey: VAPID_KEY,
            serviceWorkerRegistration: registration
        });
    }

    async function removeTokenFromUser(uid, token) {
        if (!token) return;
        try {
            await updateDoc(doc(db, 'users', uid), { fcmTokens: arrayRemove(token) });
        } catch (err) {
            console.warn('Could not remove FCM token:', err.message);
        }
    }

    /**
     * Sign-out: detach this device's token from the account so the next person
     * to use the device doesn't receive the previous user's notifications.
     * Must run while still signed in (Firestore rules).
     */
    async function forgetDevice() {
        const saved = readSavedToken();
        const user = Auth.getUser();
        if (saved && user && saved.uid === user.uid) {
            await removeTokenFromUser(user.uid, saved.token);
        }
        writeSavedToken(null);
    }

    function updateButtonState() {
        const notifStatusEl = document.getElementById('notif-status-label');
        const permission = notificationPermission();

        btnEnableNotif.disabled = false;

        if (permission === 'unsupported') {
            if (notifStatusEl) notifStatusEl.textContent = isIos()
                ? 'Add Gamil Family Trips to your Home Screen to enable'
                : 'Not supported on this device';
            btnEnableNotif.disabled = true;
            return;
        }

        if (permission === 'granted') {
            if (notifStatusEl) notifStatusEl.textContent = 'Enabled ✓';
        } else if (permission === 'denied') {
            if (notifStatusEl) notifStatusEl.textContent = isNative
                ? 'Blocked — turn on in phone Settings'
                : 'Blocked — change in browser settings';
        } else {
            if (notifStatusEl) notifStatusEl.textContent = 'Tap to enable';
        }
    }

    async function requestPermission() {
        if (notificationPermission() === 'unsupported') {
            Toast.show(isIos()
                ? 'On iPhone, add Gamil Family Trips to your Home Screen first, then enable notifications'
                : 'Push notifications not supported in this browser', 'error');
            return;
        }

        if (notificationPermission() === 'denied') {
            Toast.show(blockedHelpText(), 'error', { duration: 8000 });
            return;
        }

        if (!isNative && !(await ensureMessaging())) {
            Toast.show('Push notifications not supported in this browser', 'error');
            return;
        }

        try {
            const permission = await requestNotificationPermission();

            if (permission === 'granted') {
                const user = Auth.getUser();
                if (user) {
                    const token = await syncToken(user, { force: true });
                    console.log('FCM Token:', token);
                }

                Toast.show('Notifications enabled!', 'success');
                updateButtonState();

                // Confirm it works (web only — the native app has no service worker)
                if (!isNative) showSystemNotification('Gamil Family Trips Ready! 🚗', {
                    body: 'You will receive trip reminders 30 minutes before departure.',
                    icon: NOTIF_ICON
                });
            } else {
                Toast.show(permission === 'denied' ? blockedHelpText() : 'Notification permission not granted', 'error');
                updateButtonState();
            }
        } catch (error) {
            console.error('Error enabling notifications:', error);
            Toast.show('Failed to enable notifications', 'error');
        }
    }

    function isIos() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    }

    function blockedHelpText() {
        if (isNative) {
            return platform === 'ios'
                ? 'Notifications are off. Turn them on in Settings → Gamil Family Trips → Notifications.'
                : 'Notifications are off. Turn them on in Settings → Apps → Gamil Family Trips → Notifications.';
        }
        return isIos()
            ? 'Notifications are off. Turn them on in Settings → Notifications → Gamil Family Trips.'
            : 'Notifications are blocked. Allow them in your browser\'s site settings for Gamil Family Trips.';
    }

    // Prefer the service worker: `new Notification()` throws on Android Chrome.
    async function showSystemNotification(title, options) {
        if (notificationPermission() !== 'granted') return;
        try {
            const registration = 'serviceWorker' in navigator
                ? await navigator.serviceWorker.getRegistration()
                : null;
            if (registration) {
                await registration.showNotification(title, options);
            } else {
                new Notification(title, options);
            }
        } catch (err) {
            console.warn('Could not show notification:', err.message);
        }
    }

    // Save a notification record to Firestore (for in-app notifications)
    async function sendNotificationToTripUsers(tripId, tripData, action, actingUser) {
        try {
            const assignees = tripData.assignees || [];
            const creatorId = tripData.createdBy;
            const targetUsers = new Set([...assignees.map(a => a.uid), creatorId]);

            // Don't notify the acting user
            targetUsers.delete(actingUser.uid);

            let message = '';

            if (action === 'joined') {
                message = `${actingUser.displayName} joined the trip to ${tripData.destination}`;
            } else if (action === 'left') {
                message = `${actingUser.displayName} left the trip to ${tripData.destination}`;
            } else if (action === 'driver_joined') {
                message = `${actingUser.displayName} joined as driver for trip to ${tripData.destination}`;
            }

            if (!message || targetUsers.size === 0) return;

            const batch = writeBatch(db);
            for (const userId of targetUsers) {
                batch.set(doc(collection(db, 'users', userId, 'notifications')), {
                    message,
                    tripId,
                    type: action,
                    timestamp: serverTimestamp(),
                    read: false
                });
            }

            await batch.commit();
        } catch (error) {
            console.error('Error sending notifications:', error);
        }
    }

    /**
     * Calls the sendDriverNotification Cloud Function (callable) to
     * send FCM pushes after a driver join/replace event.
     *
     * @param {object} params
     *   tripId, type ('driver_assigned'|'driver_replaced'),
     *   oldDriverUid, newDriverName, destination, date, time, riderUids
     */
    async function sendDriverNotificationPush(params) {
        try {
            const fns = await ensureFunctions();
            if (!fns) return;
            const sendDriverNotification = fns.httpsCallable('sendDriverNotification');
            await sendDriverNotification(params);
            console.log('[Notifications] sendDriverNotificationPush sent:', params.type);
        } catch (err) {
            console.warn('[Notifications] sendDriverNotificationPush failed (non-fatal):', err.message);
        }
    }

    // ---- TRIP REMINDERS (in-app) ----
    // The 30-minute reminder notification itself is pushed by the
    // sendTripReminders Cloud Function. While the app is open we also show a
    // toast — but no second system notification.

    let reminderInterval = null;
    const notifiedTripIds = new Set(); // track already-notified trips

    function startReminders() {
        stopReminders();
        // Check immediately, then every 60 seconds
        checkUpcomingTrips();
        reminderInterval = setInterval(checkUpcomingTrips, 60 * 1000);
    }

    function stopReminders() {
        if (reminderInterval) {
            clearInterval(reminderInterval);
            reminderInterval = null;
        }
        notifiedTripIds.clear();
    }

    function checkUpcomingTrips() {
        const user = Auth.getUser();
        if (!user) return;

        const myTrips = Trips.getAssignedTripsToday();
        if (myTrips.length === 0) return;

        const now = new Date();

        myTrips.forEach(trip => {
            // Skip if already notified
            if (notifiedTripIds.has(trip.id)) return;

            // Parse trip time into a Date object for today
            const [hours, minutes] = trip.time.split(':').map(Number);
            const tripDate = new Date();
            tripDate.setHours(hours, minutes, 0, 0);

            // Calculate minutes until trip
            const diffMinutes = Math.floor((tripDate.getTime() - now.getTime()) / (1000 * 60));

            // Notify if trip is within the next 30 minutes (and hasn't passed)
            if (diffMinutes > 0 && diffMinutes <= 30) {
                notifiedTripIds.add(trip.id);

                const timeLabel = diffMinutes === 1
                    ? '1 minute'
                    : `${diffMinutes} minutes`;

                Toast.show(`🚗 Trip to ${trip.destination} departs in ${timeLabel}!`, 'info', { duration: 8000 });
            }
        });
    }

    /**
     * Show the notification permission popup if:
     * - Notifications API is supported
     * - Permission is 'default' (never asked)
     * - User hasn't dismissed the popup in the last 24 hours
     * Called by App.onUserReady() shortly after login.
     */
    function showNotifPopupIfNeeded() {
        if (notificationPermission() !== 'default') return;
        if (readSavedToken()) return; // handled by onTripsLoaded (permission lost)

        // Check if popup was dismissed recently (24-hour cooldown)
        let dismissed = null;
        try { dismissed = localStorage.getItem('notif-popup-dismissed'); } catch (_) { /* ignore */ }
        if (dismissed) {
            const elapsed = Date.now() - parseInt(dismissed, 10);
            const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
            if (elapsed < TWENTY_FOUR_HOURS) return;
        }

        // Show popup with a short delay so the app feels settled first
        setTimeout(() => showNotifPopup(), 2000);
    }

    function showNotifPopup({ lost = false } = {}) {
        if (!notifPermOverlay) return;
        if (notifPermTitle) {
            notifPermTitle.textContent = lost ? 'Notifications were turned off' : defaultPopupTitle;
        }
        if (notifPermDesc) {
            notifPermDesc.textContent = !lost
                ? defaultPopupDesc
                : notificationPermission() === 'denied'
                    ? blockedHelpText()
                    : isNative
                        ? 'Gamil Family Trips notifications were switched off. Turn them back on to keep getting new-trip alerts and departure reminders.'
                        : 'Your browser switched off Gamil Family Trips notifications. Turn them back on to keep getting new-trip alerts and departure reminders.';
        }
        notifPermOverlay.classList.remove('hidden');
    }

    function rememberPopupDismissal() {
        try {
            localStorage.setItem('notif-popup-dismissed', Date.now().toString());
        } catch (_) { /* ignore */ }
    }

    function hideNotifPopup() {
        if (notifPermOverlay) {
            notifPermOverlay.classList.add('hidden');
        }
    }

    // Sign-out: stop reminders and let the next user's session redo token setup
    function reset() {
        stopReminders();
        tokenSyncScheduled = false;
    }

    return {
        init, onTripsLoaded, requestPermission, sendNotificationToTripUsers, sendDriverNotificationPush,
        startReminders, stopReminders, showNotifPopupIfNeeded, forgetDevice, reset, updateButtonState
    };
})();
