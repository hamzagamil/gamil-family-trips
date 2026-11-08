# TripSync — Daily Trip Planner

A real-time collaborative trip planning web app. Users can create daily trips, join/leave trips, and receive push notifications.

---

## 🚀 Setup Guide

### 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Click **"Add project"** → name it (e.g., `trip-sync`)
3. Follow the wizard (you can disable Google Analytics if you want)

### 2. Add a Web App

1. In your Firebase project, click the **gear icon** → **Project settings**
2. Scroll down → click **"Add app"** → select **Web** (`</>`)
3. Register your app with a nickname (e.g., `trip-sync-web`)
4. **Copy the `firebaseConfig` object** — you'll need it in the next step

### 3. Configure the App

Open **two files** and fill in your Firebase config:

**`js/firebase-config.js`** — Replace the placeholder values:
```javascript
const firebaseConfig = {
    apiKey: "AIzaSyXXXXXXXX",           // from Firebase Console
    authDomain: "your-app.firebaseapp.com",
    projectId: "your-app",
    storageBucket: "your-app.firebasestorage.app",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef"
};
```

**`public/firebase-messaging-sw.js`** — Same config values (this is the service worker):
```javascript
firebase.initializeApp({
    apiKey: "AIzaSyXXXXXXXX",
    authDomain: "your-app.firebaseapp.com",
    projectId: "your-app",
    storageBucket: "your-app.firebasestorage.app",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abcdef"
});
```

### 4. Enable Google Authentication

1. In Firebase Console → **Authentication** → **Sign-in method**
2. Click **Google** → Toggle **Enable**
3. Set a project support email
4. Click **Save**

### 5. Create Firestore Database

1. Firebase Console → **Firestore Database** → **Create database**
2. Choose **Start in test mode** (for development)
3. Select a region close to your users
4. Once created, go to **Rules** tab and paste the rules from `firestore.rules`

### 6. Enable Cloud Messaging (Push Notifications)

1. Firebase Console → **Project settings** → **Cloud Messaging** tab
2. Under **Web Push certificates**, click **Generate key pair**
3. Copy the generated **VAPID key**
4. Paste it in `js/firebase-config.js`:
   ```javascript
   export const VAPID_KEY = "BPxxxxxxxxxxxxxx...";
   ```

### 7. Run the App Locally

The app is bundled with [Vite](https://vite.dev) (Firebase is imported from npm,
not loaded from a CDN). Install dependencies once, then start the dev server:

```bash
npm install
npm run dev          # http://localhost:8080 with hot reload
```

To test the production build (service worker, caching) locally:

```bash
npm run build        # outputs to dist/
npm run preview      # serves dist/ on http://localhost:8080
```

### 8. Deploy to Firebase Hosting

```bash
npm install -g firebase-tools
firebase login
npm run deploy       # = firebase deploy; hosting's predeploy runs `npm run build`
```

Hosting serves the `dist/` folder. `firebase deploy` also deploys
`firestore.rules` and `firestore.indexes.json`.

---

## 📁 Project Structure

```
trip-planner/
├── index.html                  # Main HTML (Vite entry)
├── css/
│   └── styles.css              # Complete styling
├── js/
│   ├── app.js                  # App controller (bundle entry point)
│   ├── firebase-config.js      # Firebase configuration (EDIT THIS)
│   ├── auth.js                 # Google authentication
│   ├── trips.js                # Trip CRUD + real-time listener + rendering
│   ├── frequent-trips.js       # Frequent-trip templates / Quick Add
│   ├── notifications.js        # FCM push notifications + reminders
│   ├── toast.js, utils.js      # Shared helpers
│   └── lazy/                   # Messaging & Functions SDKs, loaded on demand
├── public/                     # Copied to dist/ as-is
│   ├── firebase-messaging-sw.js  # FCM + caching service worker (EDIT THIS)
│   ├── manifest.json
│   └── icon-192.png, icon-512.png
├── vite.config.js              # Build config (+ service worker precache list)
├── firestore.rules             # Security rules
├── firestore.indexes.json      # Firestore indexes
└── README.md                   # This file
```

### Icons

Icons use a **subset** of the Material Symbols Rounded font that only contains
the icons the app uses. If you add a new icon name, add it to the
`icon_names=` list in `index.html` (both URLs, alphabetical order), otherwise it
will render as plain text.

---

## 🔑 Google Authentication — What You Need

To use Google Sign-In, you need:

| Item | Where to Get It |
|------|----------------|
| **Firebase Project** | [Firebase Console](https://console.firebase.google.com) |
| **Firebase Web App Config** | Project Settings → General → Your Apps |
| **Google Sign-In Enabled** | Authentication → Sign-in method → Google |
| **Authorized Domains** | Authentication → Settings → Authorized domains (localhost is auto-added) |

### How It Works
- Firebase Auth handles the **entire OAuth 2.0 flow** with Google
- No need to manually create OAuth credentials in Google Cloud Console — Firebase does this automatically
- The `signInWithPopup(auth, provider)` call opens Google's sign-in popup
- On success, Firebase returns a user object with `uid`, `displayName`, `email`, `photoURL`
- Auth state persists across page refreshes (Firebase stores tokens in IndexedDB)

### For Production
- Add your production domain to **Authorized domains** in Firebase Console
- Consider adding Firebase App Check for additional security

---

## 🔔 Push Notifications — How It Works

### Architecture
```
User Action (join/leave trip)
    → Firestore writes notification docs to target users
    → (Optional) Cloud Function triggers FCM send
    → Service Worker receives push → shows native notification
```

### Client-Side (Already Implemented)
1. **Permission Request**: User clicks "Enable Notifications" → browser asks for permission
2. **FCM Token**: On grant, Firebase Messaging SDK generates a device token
3. **Token Storage**: Token is saved in the user's Firestore document
4. **Foreground Messages**: Handled by `messaging.onMessage()` in `notifications.js`
5. **Background Messages**: Handled by `messaging.onBackgroundMessage()` in `firebase-messaging-sw.js`

### Server-Side (Cloud Function — Optional Enhancement)
To actually **send** push notifications to other users' devices, you need a **Firebase Cloud Function**. Here's a template:

```javascript
// functions/index.js
const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.sendTripNotification = functions.firestore
    .document('users/{userId}/notifications/{notifId}')
    .onCreate(async (snap, context) => {
        const notification = snap.data();
        const userId = context.params.userId;

        // Get user's FCM tokens
        const userDoc = await admin.firestore()
            .collection('users').doc(userId).get();

        const tokens = userDoc.data()?.fcmTokens || [];
        if (tokens.length === 0) return;

        const message = {
            notification: {
                title: 'TripSync',
                body: notification.message
            },
            tokens: tokens
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        console.log(`Sent ${response.successCount} notifications`);

        // Clean up invalid tokens
        const invalidTokens = [];
        response.responses.forEach((resp, idx) => {
            if (!resp.success) invalidTokens.push(tokens[idx]);
        });

        if (invalidTokens.length > 0) {
            await admin.firestore().collection('users').doc(userId).update({
                fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
            });
        }
    });
```

Deploy with:
```bash
cd functions
npm install
firebase deploy --only functions
```

---

## ✨ Features

- ✅ Google Sign-In authentication
- ✅ Create trips with destination + time
- ✅ Predefined destination list with add-new capability
- ✅ All trips sorted by earliest departure
- ✅ Join/leave trips
- ✅ "My Trips" view with personally assigned trips
- ✅ Real-time updates across all users (Firestore listeners)
- ✅ Push notifications infrastructure (FCM)
- ✅ Responsive, mobile-friendly design
- ✅ Dark glassmorphism premium UI
