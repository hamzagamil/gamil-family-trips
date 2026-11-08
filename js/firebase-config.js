// ==========================================
// Firebase Configuration
// ==========================================
// INSTRUCTIONS:
// 1. Go to https://console.firebase.google.com
// 2. Create a new project (or use an existing one)
// 3. Add a Web App to your project
// 4. Copy the Firebase config object below
// 5. Enable Google Sign-In in Authentication > Sign-in method
// 6. Create a Firestore database (start in test mode for development)
// 7. Enable Cloud Messaging and generate a VAPID key
//    (Project Settings > Cloud Messaging > Web Push certificates)

import { initializeApp } from 'firebase/app';
import { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "AIzaSyBuIUJPsRNnTiAMNqu8o3VBSpePnhmCRzg",
    authDomain: "daily-trip-planner.firebaseapp.com",
    projectId: "daily-trip-planner",
    storageBucket: "daily-trip-planner.firebasestorage.app",
    messagingSenderId: "999427034595",
    appId: "1:999427034595:web:4035a389eadf044258a4d6"
};

// VAPID Key for Web Push Notifications
// Generate this in Firebase Console > Project Settings > Cloud Messaging > Web Push certificates
export const VAPID_KEY = "BPvP2vJJVaNWJXdhHUIVXAO3iS22oqGUPaDprnHL3v7MPwPC_5NPFDf-HW5tzSUmO_ZYudmor9APundwI4PKfVI";

export const app = initializeApp(firebaseConfig);

// initializeAuth (instead of getAuth) skips setting up the popup/redirect
// resolver at startup; auth.js passes it to signInWithPopup when needed.
export const auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence]
});

// Persistent cache: returning users get trips from IndexedDB instantly while
// the server catches up. Falls back to memory automatically if IndexedDB is
// unavailable (e.g. some private-browsing modes).
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// ==========================================
// Lazy SDK loaders
// ==========================================
// Messaging and Functions are split into their own chunks and only fetched
// when needed (notifications enabled / driver assignment).

let _messagingPromise = null;
export function ensureMessaging() {
    if (!_messagingPromise) {
        _messagingPromise = import('./lazy/messaging.js')
            .then((m) => m.load(app))
            .catch((err) => {
                console.warn('Failed to load Firebase Messaging SDK:', err);
                _messagingPromise = null; // allow retry
                return null;
            });
    }
    return _messagingPromise;
}

let _functionsPromise = null;
export function ensureFunctions() {
    if (!_functionsPromise) {
        _functionsPromise = import('./lazy/functions.js')
            .then((m) => m.load(app))
            .catch((err) => {
                console.warn('Failed to load Firebase Functions SDK:', err);
                _functionsPromise = null;
                return null;
            });
    }
    return _functionsPromise;
}
