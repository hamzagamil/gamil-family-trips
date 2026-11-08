// ==========================================
// Platform layer — web (browser / PWA) vs native app (Capacitor iOS/Android)
// ==========================================
//
// The app is one codebase. In the App Store / Play Store builds it runs inside
// a Capacitor WebView, where browser popups, service workers and Web Push are
// not available. Everything that differs lives here; the native plugins are
// imported lazily so the web bundle doesn't grow.

import { Capacitor } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform(); // 'web' | 'ios' | 'android'

// ---- Native sign-in ----
// The plugin runs the OS sign-in sheet (skipNativeAuth: true in
// capacitor.config.json); the resulting credential signs in the Firebase JS SDK,
// so the rest of the app (Firestore, auth state) is unchanged.

// IMPORTANT: never resolve a Promise with a Capacitor plugin object (no
// `.then(m => m.Plugin)`, no `return plugin` from an async function). A Promise
// checks the value for a `then` method; the plugin proxy answers every property
// with a native method, so `then` becomes a native call that never replies and
// the Promise hangs forever. The loaders below resolve to the *module*, and the
// plugin is read from it only after the await.

let _authPlugin = null;
function authModule() {
    if (!_authPlugin) {
        _authPlugin = import('@capacitor-firebase/authentication')
            .catch((err) => { _authPlugin = null; throw err; });
    }
    return _authPlugin;
}

/** Native Google sign-in → { idToken, accessToken } */
export async function nativeGoogleSignIn() {
    const plugin = (await authModule()).FirebaseAuthentication;
    const result = await plugin.signInWithGoogle({ skipNativeAuth: true });
    return result.credential || {};
}

/** Native Sign in with Apple → { idToken, nonce, authorizationCode } */
export async function nativeAppleSignIn() {
    const plugin = (await authModule()).FirebaseAuthentication;
    const result = await plugin.signInWithApple({ skipNativeAuth: true });
    return result.credential || {};
}

/** Clear the native Google/Apple session so the next sign-in shows the account picker. */
export async function nativeSignOut() {
    if (!isNative) return;
    try {
        const plugin = (await authModule()).FirebaseAuthentication;
        await plugin.signOut();
    } catch (err) {
        console.warn('[platform] native sign-out failed:', err.message);
    }
}

// ---- Native push (FCM via the Firebase iOS/Android SDKs) ----

let _messagingPlugin = null;
function messagingModule() {
    if (!_messagingPlugin) {
        _messagingPlugin = import('@capacitor-firebase/messaging')
            .catch((err) => { _messagingPlugin = null; throw err; });
    }
    return _messagingPlugin;
}

// Native permission is async to read; cache it so callers can keep reading it
// synchronously (refreshed at startup, on resume and after every request).
let nativePermission = 'default';

function mapNativePermission(receive) {
    if (receive === 'granted') return 'granted';
    if (receive === 'denied') return 'denied';
    return 'default'; // 'prompt' | 'prompt-with-rationale'
}

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export function notificationPermission() {
    if (isNative) return nativePermission;
    return 'Notification' in window ? Notification.permission : 'unsupported';
}

export async function refreshNotificationPermission() {
    if (!isNative) return notificationPermission();
    try {
        const plugin = (await messagingModule()).FirebaseMessaging;
        const { receive } = await plugin.checkPermissions();
        nativePermission = mapNativePermission(receive);
    } catch (err) {
        console.warn('[platform] checkPermissions failed:', err.message);
    }
    return nativePermission;
}

export async function requestNotificationPermission() {
    if (!isNative) return Notification.requestPermission();
    const plugin = (await messagingModule()).FirebaseMessaging;
    const { receive } = await plugin.requestPermissions();
    nativePermission = mapNativePermission(receive);
    return nativePermission;
}

/** The FCM registration token for this device (native SDK). */
export async function nativePushToken() {
    const plugin = (await messagingModule()).FirebaseMessaging;
    const { token } = await plugin.getToken();
    return token || null;
}

/**
 * One-time native push setup:
 * - Android notification channels — the channel IDs must match the ones the
 *   Cloud Functions send to (functions/index.js → android.notification.channelId)
 * - token rotation and foreground-message callbacks
 */
export async function initNativePush({ onToken, onForegroundMessage }) {
    if (!isNative) return;
    const plugin = (await messagingModule()).FirebaseMessaging;

    if (platform === 'android') {
        const channels = [
            { id: 'new_trips', name: 'New trips', description: 'When someone creates a new trip' },
            { id: 'trip_reminders', name: 'Departure reminders', description: '30 minutes before your trip departs' },
            { id: 'driver_updates', name: 'Driver updates', description: 'When a driver joins or is replaced on your trip' }
        ];
        for (const c of channels) {
            try {
                await plugin.createChannel({ ...c, importance: 4, visibility: 1, vibration: true });
            } catch (err) {
                console.warn('[platform] createChannel failed:', c.id, err.message);
            }
        }
    }

    await plugin.addListener('tokenReceived', ({ token }) => {
        if (token) onToken?.(token);
    });

    // iOS shows foreground notifications itself (presentationOptions);
    // Android does not, so the app surfaces them in-app instead.
    await plugin.addListener('notificationReceived', ({ notification }) => {
        onForegroundMessage?.(notification || {});
    });

    // Permission may be changed in the OS Settings while the app is backgrounded
    try {
        const { App } = await import('@capacitor/app');
        App.addListener('resume', () => { refreshNotificationPermission(); });
    } catch (_) { /* optional */ }
}
