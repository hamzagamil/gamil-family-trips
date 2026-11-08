// ==========================================
// Firebase Cloud Messaging Service Worker
// ==========================================
// This file MUST be at the root of your domain (e.g., /firebase-messaging-sw.js)
// It displays push notifications and caches the app shell so repeat launches
// load instantly.
//
// Lives in public/ so Vite copies it to dist/ unchanged; the build then fills
// in BUILD_ID and PRECACHE_ASSETS (see vite.config.js).

importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging-compat.js');

// Initialize Firebase in the service worker
firebase.initializeApp({
    apiKey: "AIzaSyBuIUJPsRNnTiAMNqu8o3VBSpePnhmCRzg",
    authDomain: "daily-trip-planner.firebaseapp.com",
    projectId: "daily-trip-planner",
    storageBucket: "daily-trip-planner.firebasestorage.app",
    messagingSenderId: "999427034595",
    appId: "1:999427034595:web:4035a389eadf044258a4d6"
});

// ==========================================
// Push handler — ALWAYS shows a notification
// ==========================================
// Browsers require every push to display a notification. The Firebase SDK's
// own handler skips the notification whenever a TripSync window is visible
// (it hands the message to the page instead). Safari treats those as silent
// pushes and revokes the site's push permission after a few — which is why
// notifications used to stop after 2–3 days until the user re-enabled them.
//
// This listener is registered BEFORE firebase.messaging() (which adds the
// SDK's push listener) and stops the event from reaching it. The SDK is still
// initialised so it keeps handling 'pushsubscriptionchange' (token rotation).
self.addEventListener('push', (event) => {
    event.stopImmediatePropagation();

    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (_) {
        payload = { notification: { body: event.data ? event.data.text() : '' } };
    }

    const notification = payload.notification || {};
    const data = payload.data || {};
    const title = notification.title || data.title || 'Gamil Family Trips';
    const tag = notification.tag || data.tag || undefined;

    event.waitUntil((async () => {
        const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const appVisible = windows.some((c) => c.visibilityState === 'visible');

        await self.registration.showNotification(title, {
            body: notification.body || data.body || '',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag,
            // Re-alert when a notification with the same tag is replaced
            renotify: !!tag,
            // Still shown while the app is open (required), just without sound/vibration
            silent: appVisible,
            requireInteraction: data.type === 'reminder',
            data: { ...data, link: (payload.fcmOptions && payload.fcmOptions.link) || '/' }
        });
    })());
});

// Initialised after the push listener above so that listener runs first
firebase.messaging();

// ==========================================
// Notification click handler
// ==========================================
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const data = event.notification.data || {};
    // For new_trip notifications we want to land on the app root;
    // in the future you could deep-link to a specific trip.
    const targetUrl = data.type === 'new_trip'
        ? `${self.location.origin}/?tripId=${data.tripId || ''}`
        : self.location.origin + '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // If a window for this app is already open, navigate it
            for (const client of windowClients) {
                if (client.url.startsWith(self.location.origin) && 'focus' in client) {
                    client.navigate(targetUrl);
                    return client.focus();
                }
            }
            // Otherwise, open a new window at the target URL
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});

// ==========================================
// PWA Cache Management
// ==========================================
// Replaced at build time: a hash of the build output, and the list of
// content-hashed files under /assets/. Dev builds keep the placeholders.
const BUILD_ID = '__BUILD_ID__';
const PRECACHE_ASSETS = [/* __PRECACHE_ASSETS__ */];

const SHELL_CACHE = `tripsync-shell-${BUILD_ID}`;
const ASSETS_CACHE_PREFIX = 'tripsync-assets-';
const ASSETS_CACHE = `${ASSETS_CACHE_PREFIX}${BUILD_ID}`;
const RUNTIME_CACHE = 'tripsync-runtime-v2';

// Un-hashed same-origin files (from public/) — refreshed in the background
const SHELL_ASSETS = [
    '/',
    '/manifest.json',
    '/icon-192.png',
    '/icon-512.png'
];

// Cross-origin hosts whose GETs we want to cache (Google Fonts)
const CACHEABLE_ORIGINS = [
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com'
];

function addAllSettled(cacheName, urls) {
    return caches.open(cacheName).then((cache) =>
        // Individual adds so one bad URL doesn't abort the whole install
        Promise.all(urls.map((url) =>
            cache.add(url).catch((err) => console.warn('[SW] Failed to cache', url, err))
        ))
    );
}

// Pre-cache the app shell and this build's JS/CSS on install
self.addEventListener('install', (event) => {
    console.log(`[SW] Installing build ${BUILD_ID}`);
    event.waitUntil(Promise.all([
        addAllSettled(SHELL_CACHE, SHELL_ASSETS),
        addAllSettled(ASSETS_CACHE, PRECACHE_ASSETS)
    ]));
    self.skipWaiting();
});

// Clean old caches and claim clients on activate. The previous build's assets
// cache is kept, so a page that was opened before this deploy can still
// lazy-load its chunks (Firebase Hosting no longer serves them).
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            // caches.keys() lists caches in creation order
            const previousAssets = cacheNames
                .filter((name) => name.startsWith(ASSETS_CACHE_PREFIX) && name !== ASSETS_CACHE)
                .pop();
            const keep = new Set([SHELL_CACHE, ASSETS_CACHE, RUNTIME_CACHE, previousAssets]);
            return Promise.all(
                cacheNames
                    .filter((name) => !keep.has(name))
                    .map((name) => caches.delete(name))
            );
        }).then(() => clients.claim())
    );
});

// Stale-while-revalidate: serve cache instantly, refresh in background.
// `cacheKey` lets all navigations (/, /?tripId=…) share one cached page.
function staleWhileRevalidate(event, cacheName, cacheKey = event.request) {
    return caches.open(cacheName).then((cache) =>
        cache.match(cacheKey).then((cached) => {
            const networkPromise = fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200) {
                        cache.put(cacheKey, response.clone());
                    }
                    return response;
                })
                .catch(() => cached); // offline: fall back to whatever we had

            if (cached) {
                // Keep the SW alive until the background refresh is stored
                event.waitUntil(networkPromise.catch(() => {}));
                return cached;
            }
            return networkPromise;
        })
    );
}

// Content-hashed files never change: any cache hit (this build or the previous
// one) is valid, otherwise fetch and store in this build's cache.
function cacheFirst(request) {
    return caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
            if (response && response.status === 200) {
                const copy = response.clone();
                caches.open(ASSETS_CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
        });
    });
}

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);
    const sameOrigin = url.origin === self.location.origin;

    // Firestore/Auth/FCM/Functions calls go to other origins and are never
    // intercepted — only same-origin files and Google Fonts are handled here.
    if (sameOrigin) {
        if (event.request.mode === 'navigate') {
            // App shell: instant from cache, refreshed in the background.
            // Standalone pages (privacy.html, delete-account.html) go to the network.
            if (url.pathname === '/' || url.pathname === '/index.html') {
                event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, '/'));
            }
        } else if (url.pathname.startsWith('/assets/')) {
            event.respondWith(cacheFirst(event.request));
        } else if (url.pathname !== '/firebase-messaging-sw.js') {
            event.respondWith(staleWhileRevalidate(event, SHELL_CACHE));
        }
        return;
    }

    if (CACHEABLE_ORIGINS.includes(url.origin)) {
        // Google Fonts — versioned URLs, safe to serve from cache
        event.respondWith(staleWhileRevalidate(event, RUNTIME_CACHE));
    }
});
