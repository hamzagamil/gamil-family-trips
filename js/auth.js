// ==========================================
// Authentication Module
// ==========================================

import {
    onAuthStateChanged, signInWithPopup, signInWithCredential, signOut as firebaseSignOut,
    GoogleAuthProvider, OAuthProvider, browserPopupRedirectResolver, revokeAccessToken
} from 'firebase/auth';
import { doc, setDoc, updateDoc, onSnapshot, serverTimestamp } from 'firebase/firestore';
import { auth, db, ensureFunctions } from './firebase-config.js';
import { isNative, platform, nativeGoogleSignIn, nativeAppleSignIn, nativeSignOut } from './platform.js';
import { Toast } from './toast.js';
import { App } from './app.js';
import { Notifications } from './notifications.js';
import { Approvals } from './approvals.js';
import { readSessionHint, writeSessionHint, clearSessionHint, notificationPermission } from './utils.js';

export const Auth = (() => {
    let currentUser = null;
    const provider = new GoogleAuthProvider();

    // Live listener on users/{uid}: approval status, admin flag and role
    let unsubscribeProfile = null;
    // Trip listeners etc. are running (App.onUserReady was called)
    let appStarted = false;
    // The first-login role picker was already offered this session
    let rolePickerOffered = false;

    // ---- DOM refs ----
    const authScreen = document.getElementById('auth-screen');
    const appScreen = document.getElementById('app-screen');
    const btnGoogleSignin = document.getElementById('btn-google-signin');
    const btnSignout = document.getElementById('btn-signout');
    const btnAppleSignin = document.getElementById('btn-apple-signin');
    const btnDeleteAccount = document.getElementById('btn-delete-account');

    // Waiting-for-approval screen
    const pendingCard = document.querySelector('#pending-screen .pending-card');
    const pendingIcon = document.getElementById('pending-icon');
    const pendingTitle = document.getElementById('pending-title');
    const pendingText = document.getElementById('pending-text');
    const pendingEmail = document.getElementById('pending-email');
    const btnPendingNotify = document.getElementById('btn-pending-notify');
    const btnPendingSignout = document.getElementById('btn-pending-signout');
    const btnPendingDelete = document.getElementById('btn-pending-delete');

    // Top-nav avatar (desktop)
    const userAvatar = document.getElementById('user-avatar');
    const userPhoto = document.getElementById('user-photo');

    // Bottom-nav profile tab (mobile)
    const bottomNavProfile = document.getElementById('bottom-nav-profile');
    const bottomNavPhoto = document.getElementById('bottom-nav-photo');

    // Profile sheet
    const profileSheetOverlay = document.getElementById('profile-sheet-overlay');
    const profileSheetClose = document.getElementById('profile-sheet-close');
    const profileSheetPhoto = document.getElementById('profile-sheet-photo');
    const profileSheetName = document.getElementById('profile-sheet-name');
    const profileSheetEmail = document.getElementById('profile-sheet-email');
    const profileRoleBadge = document.getElementById('profile-sheet-role-badge');
    const profileRoleChipIcon = document.getElementById('profile-role-chip-icon');
    const profileRoleChipLbl = document.getElementById('profile-role-chip-label');
    const psDriverBtn = document.getElementById('ps-btn-driver');
    const psRiderBtn = document.getElementById('ps-btn-rider');
    const notifStatusLabel = document.getElementById('notif-status-label');

    // Role picker overlay (legacy full-screen picker, used on first login)
    const roleOverlay = document.getElementById('role-selection-overlay');
    const roleBtnDriver = document.getElementById('role-btn-driver');
    const roleBtnRider = document.getElementById('role-btn-rider');

    // Kept for backwards-compat references in other modules
    const menuPhoto = document.getElementById('menu-photo');
    const menuName = document.getElementById('menu-name');
    const menuEmail = document.getElementById('menu-email');
    const menuRoleDisplay = document.getElementById('menu-role-display');
    const menuRoleIcon = document.getElementById('menu-role-icon');
    const menuRoleLabel = document.getElementById('menu-role-label');

    const signInButtonHtml = btnGoogleSignin.innerHTML;
    const appleButtonHtml = btnAppleSignin ? btnAppleSignin.innerHTML : '';

    // Sign in with Apple: required next to Google sign-in in the iOS app
    // (App Store guideline 4.8). Uses the native Apple sheet.
    const appleSignInAvailable = isNative && platform === 'ios';

    // ---- Init ----

    function init() {
        btnGoogleSignin.addEventListener('click', signIn);
        btnSignout.addEventListener('click', signOut);
        if (btnAppleSignin && appleSignInAvailable) {
            btnAppleSignin.classList.remove('hidden');
            btnAppleSignin.addEventListener('click', signInWithApple);
        }
        if (btnDeleteAccount) btnDeleteAccount.addEventListener('click', deleteAccount);
        if (btnPendingDelete) btnPendingDelete.addEventListener('click', deleteAccount);
        if (btnPendingSignout) btnPendingSignout.addEventListener('click', signOut);
        if (btnPendingNotify) {
            btnPendingNotify.addEventListener('click', async () => {
                await Notifications.requestPermission();
                updatePendingNotifyButton();
            });
        }
        Approvals.init();

        // Open profile sheet — desktop top-nav avatar
        userAvatar.addEventListener('click', (e) => {
            e.stopPropagation();
            openProfileSheet();
        });

        // Open profile sheet — mobile bottom-nav Profile tab
        if (bottomNavProfile) {
            bottomNavProfile.addEventListener('click', (e) => {
                e.stopPropagation();
                openProfileSheet();
            });
        }

        // Close sheet — X button
        if (profileSheetClose) {
            profileSheetClose.addEventListener('click', closeProfileSheet);
        }

        // Close sheet — clicking the overlay backdrop
        if (profileSheetOverlay) {
            profileSheetOverlay.addEventListener('click', (e) => {
                if (e.target === profileSheetOverlay) closeProfileSheet();
            });
        }

        // Close sheet — Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeProfileSheet();
        });

        // Role cards inside the profile sheet
        if (psDriverBtn) psDriverBtn.addEventListener('click', () => selectRole('driver'));
        if (psRiderBtn) psRiderBtn.addEventListener('click', () => selectRole('rider'));

        // Legacy full-screen role picker buttons (first-login flow)
        if (roleBtnDriver) roleBtnDriver.addEventListener('click', () => selectRole('driver'));
        if (roleBtnRider) roleBtnRider.addEventListener('click', () => selectRole('rider'));

        // Returning user: fill in avatar/name from the last session right away
        // (index.html already swapped the sign-in screen for the app shell).
        const hint = readSessionHint();
        if (hint) {
            applyProfileToUI(hint);
            if (hint.role) updateRoleUI(hint.role);
        }

        // Listen for auth state
        onAuthStateChanged(auth, handleAuthState);
    }

    // ---- Profile Sheet open / close ----

    function openProfileSheet() {
        if (!profileSheetOverlay) return;
        profileSheetOverlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        updateNotifStatusLabel();
    }

    function closeProfileSheet() {
        if (!profileSheetOverlay) return;
        profileSheetOverlay.classList.add('hidden');
        document.body.style.overflow = '';
    }

    function updateNotifStatusLabel() {
        if (!notifStatusLabel) return;
        Notifications.updateButtonState();
    }

    // ---- Sign In / Out ----

    async function signIn() {
        try {
            setSigningIn(btnGoogleSignin);
            if (isNative) {
                // Popups don't work in the app's WebView: use the OS Google sign-in sheet
                const { idToken, accessToken } = await nativeGoogleSignIn();
                await signInWithCredential(auth, GoogleAuthProvider.credential(idToken, accessToken));
            } else {
                // initializeAuth() was set up without a resolver, so pass it here
                await signInWithPopup(auth, provider, browserPopupRedirectResolver);
            }
        } catch (error) {
            handleSignInError(error);
        }
    }

    async function signInWithApple() {
        try {
            setSigningIn(btnAppleSignin);
            const { idToken, nonce } = await nativeAppleSignIn();
            const credential = new OAuthProvider('apple.com').credential({ idToken, rawNonce: nonce });
            await signInWithCredential(auth, credential);
        } catch (error) {
            handleSignInError(error);
        }
    }

    function setSigningIn(button) {
        btnGoogleSignin.disabled = true;
        if (btnAppleSignin) btnAppleSignin.disabled = true;
        button.innerHTML = '<div class="spinner"></div><span>Signing in...</span>';
    }

    function resetSignInButtons() {
        btnGoogleSignin.disabled = false;
        btnGoogleSignin.innerHTML = signInButtonHtml;
        if (btnAppleSignin) {
            btnAppleSignin.disabled = false;
            btnAppleSignin.innerHTML = appleButtonHtml;
        }
    }

    function handleSignInError(error) {
        resetSignInButtons();
        // The user closed the sign-in sheet: not worth an error toast
        const msg = String(error?.message || '');
        if (error?.code === 'auth/popup-closed-by-user' || /cancel/i.test(msg)) return;
        console.error('Sign-in error:', error);
        Toast.show('Sign-in failed: ' + msg, 'error');
    }

    async function signOut() {
        try {
            closeProfileSheet();
            // Detach this device's push token while we still have write access
            await Notifications.forgetDevice();
            await firebaseSignOut(auth);
            await nativeSignOut();
        } catch (error) {
            console.error('Sign-out error:', error);
            Toast.show('Sign-out failed', 'error');
        }
    }

    // ---- Account deletion ----
    // Required by the App Store (5.1.1(v)) and Google Play. The deleteAccount
    // Cloud Function removes the user's data and their Firebase Auth account.

    async function deleteAccount() {
        if (!currentUser) return;
        const ok = confirm(
            'Delete your Gamil Family Trips account?\n\n' +
            'Your profile, frequent trips and notifications will be permanently deleted, ' +
            'you will be removed from all trips, and trips you created will be deleted. ' +
            'This cannot be undone.'
        );
        if (!ok) return;

        setDeleteButtonsDisabled(true);
        try {
            // Sign in with Apple accounts: revoke the app's Apple tokens too
            // (Apple requires this when an account is deleted). Needs a fresh
            // authorization code, so Apple asks the user to confirm once more.
            const usesApple = auth.currentUser?.providerData.some((p) => p.providerId === 'apple.com');
            if (usesApple && appleSignInAvailable) {
                try {
                    const { authorizationCode } = await nativeAppleSignIn();
                    if (authorizationCode) await revokeAccessToken(auth, authorizationCode);
                } catch (err) {
                    console.warn('Apple token revocation failed:', err.message);
                }
            }

            const fns = await ensureFunctions();
            if (!fns) throw new Error('Could not reach the server');
            // Drop this device's push token while we still have write access
            await Notifications.forgetDevice().catch(() => {});
            await fns.httpsCallable('deleteAccount')();

            closeProfileSheet();
            await firebaseSignOut(auth).catch(() => {});
            await nativeSignOut();
            Toast.show('Your account has been deleted', 'success');
        } catch (error) {
            console.error('Account deletion failed:', error);
            Toast.show('Could not delete account: ' + error.message, 'error');
        } finally {
            setDeleteButtonsDisabled(false);
        }
    }

    function setDeleteButtonsDisabled(disabled) {
        if (btnDeleteAccount) btnDeleteAccount.disabled = disabled;
        if (btnPendingDelete) btnPendingDelete.disabled = disabled;
    }

    // ---- Auth state ----

    function handleAuthState(user) {
        performance.mark('tripsync:auth-resolved');

        if (user) {
            const hint = readSessionHint();
            const sameUser = hint && hint.uid === user.uid;
            const cachedRole = sameUser ? hint.role : null;
            // Hints written before approvals existed have no status: those
            // accounts predate approvals, so they count as approved.
            const cachedStatus = sameUser ? (hint.status || 'approved') : 'pending';

            currentUser = {
                uid: user.uid,
                displayName: user.displayName || 'Anonymous',
                email: user.email,
                photoURL: user.photoURL || generateAvatar(user.displayName),
                createdAt: user.metadata.creationTime,
                role: cachedRole,
                status: cachedStatus,
                admin: sameUser ? hint.admin === true : false
            };

            applyProfileToUI(currentUser);
            if (cachedRole) updateRoleUI(cachedRole);
            saveSessionHint();

            resetSignInButtons();
            authScreen.classList.remove('active');
            appScreen.classList.add('active');
            document.documentElement.classList.add('has-session');

            // Approved last time → start the trip listeners immediately; the
            // profile listener below corrects things if that has changed.
            applyStatus(cachedStatus);
            if (currentUser.admin && cachedStatus === 'approved') Approvals.setAdmin(true);

            syncProfile(user.uid);
        } else {
            const wasStarted = appStarted;
            currentUser = null;
            appStarted = false;
            rolePickerOffered = false;
            stopProfileListener();
            Approvals.setAdmin(false);
            clearSessionHint();
            closeProfileSheet();
            document.documentElement.classList.remove('has-session', 'awaiting-approval');
            authScreen.classList.add('active');
            appScreen.classList.remove('active');
            if (roleOverlay) roleOverlay.classList.add('hidden');
            if (wasStarted) App.onUserSignedOut();
        }
    }

    // Show the app (approved) or the waiting screen (pending / declined)
    function applyStatus(status) {
        if (status === 'approved') {
            document.documentElement.classList.remove('awaiting-approval');
            if (!appStarted) {
                appStarted = true;
                App.onUserReady(currentUser);
            }
        } else {
            showPendingScreen(status);
            document.documentElement.classList.add('awaiting-approval');
            closeProfileSheet();
            if (roleOverlay) roleOverlay.classList.add('hidden');
            if (appStarted) {
                appStarted = false;
                App.onUserSignedOut(); // stop trip listeners and reminders
            }
        }
    }

    function showPendingScreen(status) {
        const declined = status === 'declined';
        if (pendingCard) pendingCard.classList.toggle('declined', declined);
        if (pendingIcon) pendingIcon.textContent = declined ? 'block' : 'hourglass_top';
        if (pendingTitle) pendingTitle.textContent = declined ? 'Access not approved' : 'Waiting for approval';
        if (pendingText) {
            pendingText.textContent = declined
                ? 'An admin declined access for this account. If you think this is a mistake, contact the family member who invited you.'
                : "An admin needs to approve your account before you can see and join trips. This screen updates by itself once you're approved.";
        }
        if (pendingEmail && currentUser) pendingEmail.textContent = currentUser.email || currentUser.displayName;
        updatePendingNotifyButton();
    }

    // Offer push permission so the "You're in!" notification can reach them
    function updatePendingNotifyButton() {
        if (!btnPendingNotify) return;
        const declined = currentUser?.status === 'declined';
        const permission = notificationPermission();
        btnPendingNotify.classList.toggle('hidden', declined || permission === 'granted' || permission === 'unsupported');
    }

    // Save the profile (creating the doc as a pending request on first sign-in)
    // and follow the doc live: approval, admin flag and role all live there.
    async function syncProfile(uid) {
        const userDocRef = doc(db, 'users', uid);
        const profile = {
            displayName: currentUser.displayName,
            email: currentUser.email,
            photoURL: currentUser.photoURL,
            lastSeen: serverTimestamp()
        };

        stopProfileListener();
        // includeMetadataChanges: act only on server-confirmed snapshots. A
        // cache-only view of the doc can lack fields (e.g. status) and would
        // wrongly flip an approved user to the waiting screen.
        unsubscribeProfile = onSnapshot(userDocRef, { includeMetadataChanges: true }, (snap) => {
            if (!currentUser || currentUser.uid !== uid) return; // signed out meanwhile
            if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
            onProfileSnapshot(snap);
        }, (err) => {
            // Offline with nothing cached — keep the cached state
            console.warn('Could not load user profile:', err.message);
        });

        try {
            await updateDoc(userDocRef, profile);
        } catch (err) {
            if (err.code !== 'not-found') {
                console.warn('Profile sync failed:', err.message);
                return;
            }
            // First sign-in: create the account as a join request.
            // firestore.rules only allow status 'pending' here.
            try {
                await setDoc(userDocRef, { ...profile, status: 'pending', requestedAt: serverTimestamp() });
            } catch (createErr) {
                console.warn('Could not create profile:', createErr.message);
            }
        }
    }

    function onProfileSnapshot(snap) {
        const data = snap.exists() ? snap.data() : null;
        // No doc yet → it's being created as a pending request.
        // A doc without status predates approvals → approved.
        const status = data ? (data.status || 'approved') : 'pending';
        const role = data?.role || null;
        const admin = data?.admin === true;

        const prevRole = currentUser.role;
        currentUser.status = status;
        currentUser.role = role;
        currentUser.admin = admin;
        saveSessionHint();

        applyStatus(status);
        Approvals.setAdmin(admin && status === 'approved');

        if (status !== 'approved') return;
        if (role) {
            if (role !== prevRole) updateRoleUI(role);
        } else if (!rolePickerOffered) {
            rolePickerOffered = true;
            showRolePicker();
        }
    }

    function stopProfileListener() {
        if (unsubscribeProfile) unsubscribeProfile();
        unsubscribeProfile = null;
    }

    function saveSessionHint() {
        if (!currentUser) return;
        writeSessionHint({
            uid: currentUser.uid,
            displayName: currentUser.displayName,
            email: currentUser.email,
            photoURL: currentUser.photoURL,
            role: currentUser.role || null,
            status: currentUser.status || null,
            admin: currentUser.admin === true
        });
    }

    function applyProfileToUI(profile) {
        userPhoto.src = profile.photoURL;
        if (bottomNavPhoto) bottomNavPhoto.src = profile.photoURL;
        if (profileSheetPhoto) profileSheetPhoto.src = profile.photoURL;
        if (profileSheetName) profileSheetName.textContent = profile.displayName;
        if (profileSheetEmail) profileSheetEmail.textContent = profile.email;

        // Backwards-compat hidden fields
        if (menuPhoto) menuPhoto.src = profile.photoURL;
        if (menuName) menuName.textContent = profile.displayName;
        if (menuEmail) menuEmail.textContent = profile.email;
    }

    // ---- Role Picker (full-screen, first-login) ----

    function showRolePicker() {
        if (!roleOverlay) return;
        if (roleBtnDriver) roleBtnDriver.classList.remove('selected');
        if (roleBtnRider) roleBtnRider.classList.remove('selected');
        if (currentUser && currentUser.role) {
            if (currentUser.role === 'driver' && roleBtnDriver) roleBtnDriver.classList.add('selected');
            else if (roleBtnRider) roleBtnRider.classList.add('selected');
        }
        roleOverlay.classList.remove('hidden');
    }

    async function selectRole(role) {
        // Update profile-sheet role cards
        if (psDriverBtn) psDriverBtn.classList.toggle('selected', role === 'driver');
        if (psRiderBtn) psRiderBtn.classList.toggle('selected', role === 'rider');

        // Update legacy role picker buttons
        if (roleBtnDriver) roleBtnDriver.classList.toggle('selected', role === 'driver');
        if (roleBtnRider) roleBtnRider.classList.toggle('selected', role === 'rider');

        setTimeout(async () => {
            await saveRole(role);
            if (roleOverlay) roleOverlay.classList.add('hidden');
        }, 350);
    }

    async function saveRole(role) {
        if (!currentUser) return;
        try {
            await updateDoc(doc(db, 'users', currentUser.uid), { role });
            currentUser.role = role;
            saveSessionHint();
            updateRoleUI(role);
            Toast.show(
                role === 'driver' ? '🚗 Account type set to Driver!' : '🪑 Account type set to Rider!',
                'success'
            );
        } catch (err) {
            console.error('Failed to save role:', err);
            Toast.show('Could not save account type', 'error');
        }
    }

    // ---- Role UI helpers ----

    function updateRoleUI(role) {
        // Profile sheet hero chip
        if (profileRoleBadge) {
            profileRoleBadge.classList.remove('hidden', 'role-driver', 'role-rider');
            profileRoleBadge.classList.add(role === 'driver' ? 'role-driver' : 'role-rider');
        }
        if (profileRoleChipIcon) {
            profileRoleChipIcon.textContent = role === 'driver' ? 'drive_eta' : 'airline_seat_recline_normal';
        }
        if (profileRoleChipLbl) {
            profileRoleChipLbl.textContent = role === 'driver' ? 'Driver' : 'Rider';
        }

        // Profile sheet role cards — mark the active one
        if (psDriverBtn) psDriverBtn.classList.toggle('selected', role === 'driver');
        if (psRiderBtn) psRiderBtn.classList.toggle('selected', role === 'rider');

        // Legacy badge: kept in sync for any module that reads it, but always
        // hidden (un-hiding it showed a stray "drive_eta Driver" in the profile sheet)
        if (menuRoleDisplay) {
            if (menuRoleIcon) menuRoleIcon.textContent = role === 'driver' ? 'drive_eta' : 'airline_seat_recline_normal';
            if (menuRoleLabel) menuRoleLabel.textContent = role === 'driver' ? 'Driver' : 'Rider';
        }
    }

    function generateAvatar(name) {
        const initials = (name || 'A').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
        return `https://ui-avatars.com/api/?name=${encodeURIComponent(initials)}&background=6366f1&color=fff&size=128`;
    }

    function getUser() { return currentUser; }
    function getUserRole() { return currentUser ? currentUser.role : null; }

    return { init, getUser, getUserRole, showRolePicker, saveRole, openProfileSheet, closeProfileSheet };
})();
