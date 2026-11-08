// ==========================================
// Authentication Module
// ==========================================

import {
    onAuthStateChanged, signInWithPopup, signInWithCredential, signOut as firebaseSignOut,
    GoogleAuthProvider, OAuthProvider, browserPopupRedirectResolver, revokeAccessToken
} from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db, ensureFunctions } from './firebase-config.js';
import { isNative, platform, nativeGoogleSignIn, nativeAppleSignIn, nativeSignOut } from './platform.js';
import { Toast } from './toast.js';
import { App } from './app.js';
import { Notifications } from './notifications.js';
import { readSessionHint, writeSessionHint, clearSessionHint } from './utils.js';

export const Auth = (() => {
    let currentUser = null;
    const provider = new GoogleAuthProvider();

    // ---- DOM refs ----
    const authScreen = document.getElementById('auth-screen');
    const appScreen = document.getElementById('app-screen');
    const btnGoogleSignin = document.getElementById('btn-google-signin');
    const btnSignout = document.getElementById('btn-signout');
    const btnAppleSignin = document.getElementById('btn-apple-signin');
    const btnDeleteAccount = document.getElementById('btn-delete-account');

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

        btnDeleteAccount.disabled = true;
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
            btnDeleteAccount.disabled = false;
        }
    }

    // ---- Auth state ----

    function handleAuthState(user) {
        performance.mark('tripsync:auth-resolved');

        if (user) {
            const hint = readSessionHint();
            const cachedRole = hint && hint.uid === user.uid ? hint.role : null;

            currentUser = {
                uid: user.uid,
                displayName: user.displayName || 'Anonymous',
                email: user.email,
                photoURL: user.photoURL || generateAvatar(user.displayName),
                createdAt: user.metadata.creationTime,
                role: cachedRole
            };

            applyProfileToUI(currentUser);
            if (cachedRole) updateRoleUI(cachedRole);
            saveSessionHint();

            // Switch screens and start the trip listeners immediately — the
            // profile read/write below no longer sits in front of them.
            resetSignInButtons();
            authScreen.classList.remove('active');
            appScreen.classList.add('active');
            document.documentElement.classList.add('has-session');

            App.onUserReady(currentUser);

            syncProfile(user.uid, cachedRole);
        } else {
            const wasSignedIn = currentUser !== null;
            currentUser = null;
            clearSessionHint();
            closeProfileSheet();
            document.documentElement.classList.remove('has-session');
            authScreen.classList.add('active');
            appScreen.classList.remove('active');
            if (wasSignedIn) App.onUserSignedOut();
        }
    }

    // Upsert the profile and fetch the stored role in the background
    function syncProfile(uid, cachedRole) {
        const userDocRef = doc(db, 'users', uid);

        setDoc(userDocRef, {
            displayName: currentUser.displayName,
            email: currentUser.email,
            photoURL: currentUser.photoURL,
            lastSeen: serverTimestamp()
        }, { merge: true }).catch((err) => console.warn('Profile sync failed:', err.message));

        getDoc(userDocRef).then((snap) => {
            if (!currentUser || currentUser.uid !== uid) return; // signed out meanwhile
            const role = snap.exists() ? (snap.data().role || null) : null;
            currentUser.role = role;
            saveSessionHint();
            if (role) {
                if (role !== cachedRole) updateRoleUI(role);
            } else {
                showRolePicker();
            }
        }).catch((err) => {
            // Offline with nothing cached — keep the cached role, don't nag with the picker
            console.warn('Could not load user role:', err.message);
        });
    }

    function saveSessionHint() {
        if (!currentUser) return;
        writeSessionHint({
            uid: currentUser.uid,
            displayName: currentUser.displayName,
            email: currentUser.email,
            photoURL: currentUser.photoURL,
            role: currentUser.role || null
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

        // Legacy hidden badge (for any other modules that read it)
        if (menuRoleDisplay) {
            menuRoleDisplay.classList.remove('hidden');
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
