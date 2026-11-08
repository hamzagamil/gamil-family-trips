# Publishing Gamil Family Trips (TripSync) to the App Store and Google Play

The web app is wrapped with [Capacitor 8](https://capacitorjs.com). One codebase, three targets:

| Target | Built from | Sign-in | Push |
|---|---|---|---|
| Web / PWA | `dist/` → Firebase Hosting | Google popup | Web Push (service worker) |
| Android | `android/` (Gradle) | Native Google sheet | Firebase Android SDK |
| iOS | `ios/` (Xcode, built on GitHub Actions macOS) | Native Google sheet + Sign in with Apple | Firebase iOS SDK (APNs) |

App ID / bundle ID (both stores, permanent): **`com.dailytripplanner.app`**

---

## Already done

- Capacitor iOS and Android projects, app icons, splash screens
- Firebase apps registered (Android `1:999427034595:android:23d00b9ac7dc6cb258a4d6`, iOS `1:999427034595:ios:2dbc94f88200b8b158a4d6`); config files are in `android/app/google-services.json` and `ios/App/App/GoogleService-Info.plist`
- Android upload keystore `android/keystore/tripsync-upload.jks`, passwords in `android/keystore.properties`. SHA-1 and SHA-256 fingerprints (upload key and debug key) added to Firebase
- In-app **Delete account** (Profile → bottom) + `deleteAccount` Cloud Function
- Sign in with Apple button (iOS app only)
- `public/privacy.html` and `public/delete-account.html`
- `.github/workflows/ios-release.yml`: signed iOS build on GitHub's macOS runner, optional TestFlight upload (same setup as Mathani)

---

## 1. Before anything else

- [ ] **Back up the Android keystore.** Copy `android/keystore/tripsync-upload.jks` **and** `android/keystore.properties` to a password manager or another safe place. These files are git-ignored. If you lose them you have to ask Google support to reset the upload key.
- [ ] Deploy: `npm run deploy`. This deploys hosting (the privacy and delete-account pages, plus web app changes), the `deleteAccount` function, and the Firestore rules.
- [ ] Open https://daily-trip-planner.web.app/privacy.html and /delete-account.html and check they load.

## 2. Firebase console

- [ ] **Authentication → Sign-in method → Add provider → Apple → Enable.** For native iOS sign-in you can leave the Services ID and OAuth fields empty.
- [ ] **Project settings → Cloud Messaging → Apple app configuration → APNs Authentication Key → Upload** the `.p8` key from step 3, plus its Key ID and your Team ID.
- [ ] If the web API key is restricted (Google Cloud console → APIs & Services → Credentials → "Browser key"), the native apps send requests from `https://localhost` (Android) and `capacitor://localhost` (iOS). Add those, or remove the HTTP-referrer restriction from that key.

## 3. Apple Developer / App Store Connect

TripSync uses the same team as Mathani (Mercury Engineering & Consultations LLC, `YJBH85NYZU`) and the **same Apple Distribution certificate** (`C:\Users\Hamza\keys\ios-distribution.p12`). Only the App ID and the provisioning profile are new.

- [ ] developer.apple.com → **Identifiers → +** → App IDs → App: description "Gamil Family Trip Planner" (done), explicit bundle ID `com.dailytripplanner.app`. Tick **Push Notifications** and **Sign in with Apple**.
- [ ] **Profiles → +** → *App Store Connect* → App ID `com.dailytripplanner.app` → certificate "Apple Distribution: Mercury Engineering & Consultations LLC" → name it exactly **`TripSync App Store`** → download the file into `C:\Users\Hamza\keys\TripSync_App_Store.mobileprovision`.
- [ ] **Keys → +** → enable *Apple Push Notifications service (APNs)* → download the `.p8` file (you can download it only once) → upload it to Firebase (step 2). If the team already has an APNs key, you can reuse it.
- [ ] App Store Connect app: **"Gamil Family Trips"**, Apple ID `6832356261`, SKU `Trips` (done).

## 4. GitHub Actions (iOS builds without a Mac, like Mathani)

macOS runners are **free on public repos**. On a private repo, macOS minutes count 10× against the free quota (2,000 min/month on GitHub Free, so about 200 macOS minutes, or roughly 10–15 builds a month).

- [ ] Create the repo and push it (`gh repo create tripsync --public --source . --push`, or `--private`). First check that `git status` does **not** list `android/keystore.properties` or any `*.jks`.
- [ ] Add the repository secrets (Settings → Secrets and variables → Actions). From PowerShell, with the GitHub CLI:
  ```powershell
  $k = "C:\Users\Hamza\keys"
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("$k\ios-distribution.p12")) | gh secret set IOS_DIST_CERT_P12_BASE64
  Get-Content "$k\ios-distribution.p12.password" -Raw | gh secret set IOS_DIST_CERT_PASSWORD
  [Convert]::ToBase64String([IO.File]::ReadAllBytes("$k\TripSync_App_Store.mobileprovision")) | gh secret set IOS_APPSTORE_PROFILE_BASE64
  # Same App Store Connect team API key as Mathani (Users and Access → Integrations → App Store Connect API)
  gh secret set APP_STORE_CONNECT_KEY_ID
  gh secret set APP_STORE_CONNECT_ISSUER_ID
  Get-Content "path\to\AuthKey_XXXXXX.p8" -Raw | gh secret set APP_STORE_CONNECT_PRIVATE_KEY
  ```
  GitHub secrets can't be read back from the Mathani repo. If you no longer have the `.p8`, create a new team API key (role *App Manager*).
- [ ] **Actions → iOS release → Run workflow**. Run it once with *upload_to_testflight* off to check that it builds and signs (the `.ipa` is kept as an artifact). Then run it again with the box ticked. The build number defaults to the workflow run number.
- [ ] Install from TestFlight on an iPhone and test: Google sign-in, Apple sign-in, enabling notifications (create a trip from another account and check the push arrives), and Delete account (use a test account).
- [ ] The certificate and profile expire on **22 Oct 2027** (same date as Mathani's). Renew both then and update the secrets in both repos.

## 5. Google Play

- [ ] Build the bundle: `npm run android:bundle` (needs **JDK 21**: set `JAVA_HOME` to a JDK 21. Android Studio's bundled Java 25 is too new for this Gradle version.) Output: `android/app/build/outputs/bundle/release/app-release.aab`
- [ ] Play Console → **Create app** → upload the `.aab` to **Testing → Internal testing** and accept **Play App Signing**.
- [ ] **Setup → App signing** → copy the *App signing key* SHA-1 and SHA-256 and add them to Firebase. Without them, Google sign-in fails in builds installed from Play:
  ```
  firebase apps:android:sha:create 1:999427034595:android:23d00b9ac7dc6cb258a4d6 <SHA1>
  firebase apps:android:sha:create 1:999427034595:android:23d00b9ac7dc6cb258a4d6 <SHA256>
  firebase apps:sdkconfig ANDROID 1:999427034595:android:23d00b9ac7dc6cb258a4d6 --out android/app/google-services.json
  ```
  Then rebuild and upload with `versionCode` bumped.
- [ ] **Personal developer account?** Google requires a **closed test with at least 12 testers for 14 continuous days** before you can apply for production.

## 6. Store listings

**Both stores**
- Privacy policy URL: `https://daily-trip-planner.web.app/privacy.html`
- Account deletion URL (Play asks for it): `https://daily-trip-planner.web.app/delete-account.html`
- Category: Travel (or Productivity)
- Screenshots: sign in, take them on a phone, and show the trip list, creating a trip and joining a trip. iOS requires 6.9" iPhone screenshots (1320×2868). Play needs at least 2 phone screenshots.
- Play graphics: `store-assets/play-icon-512.png` and `store-assets/play-feature-graphic.png`

**Apple: App Privacy ("nutrition label")**. Data used for App Functionality, linked to the user, **not** used for tracking:
- Contact Info → Name, Email Address
- Identifiers → User ID, Device ID (the push token)
- User Content → Other User Content (trips)

**Google Play: Data safety**
- Collected (not shared): Personal info → Name, Email address, User IDs. App activity → Other user-generated content. Device or other IDs.
- Purpose: App functionality, Account management. Encrypted in transit: Yes. Users can request deletion: Yes.

**App Review notes (Apple)**: "Sign in with Google or Sign in with Apple. Any account works. After signing in, choose Driver or Rider, then tap + to create a trip. Account deletion: Profile → Delete account."

## 7. Each new release

1. Make the change, then `npm run build:native` (builds the web app and copies it into both native projects).
2. Android: bump `versionCode` (and `versionName`) in `android/app/build.gradle`, run `npm run android:bundle` and upload the bundle.
3. iOS: for a new version number, bump `MARKETING_VERSION` (both entries) in `ios/App/App.xcodeproj/project.pbxproj`, then push and run **Actions → iOS release** with *upload_to_testflight* ticked.
4. Web: `npm run deploy` as before.

Web-only changes (HTML/CSS/JS) still need a new store build to reach app users. The native apps ship the web files inside the app; they don't load them from Firebase Hosting.

## Regenerating icons

Edit `scripts/make-icons.mjs` (or put your own 1024×1024 `assets/icon-only.png` there), then run `npm run assets:generate`.
