// ==========================================
// Join Requests (admins)
// ==========================================
//
// New accounts start as status 'pending' and can't see trips (firestore.rules)
// until an admin approves them. Admins (admin: true on their users doc, set in
// the Firebase Console) get a "Join Requests" list in the profile sheet and a
// count badge on their avatar. Decisions go through the setUserApproval Cloud
// Function: clients can't write anyone's status.

import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { db, ensureFunctions } from './firebase-config.js';
import { Toast } from './toast.js';
import { escapeHtml } from './utils.js';

export const Approvals = (() => {
    const section = document.getElementById('profile-approvals-section');
    const divider = document.getElementById('profile-approvals-divider');
    const list = document.getElementById('approvals-list');
    const badges = document.querySelectorAll('.approvals-badge');

    let unsubscribe = null;
    let requests = [];
    const busy = new Set(); // uids with a decision in flight

    function init() {
        list.addEventListener('click', onListClick);
    }

    // Called by Auth whenever the signed-in user's admin flag is known
    function setAdmin(isAdmin) {
        if (isAdmin && !unsubscribe) start();
        else if (!isAdmin && unsubscribe) stop();
    }

    function start() {
        section.classList.remove('hidden');
        divider.classList.remove('hidden');
        list.innerHTML = '<p class="approvals-empty">Loading…</p>';
        unsubscribe = onSnapshot(
            query(collection(db, 'users'), where('status', 'in', ['pending', 'declined'])),
            (snap) => {
                requests = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
                // Pending first, then newest request first
                requests.sort((a, b) =>
                    (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1) ||
                    millis(b.requestedAt) - millis(a.requestedAt));
                render();
            },
            (err) => {
                console.error('Could not load join requests:', err);
                list.innerHTML = '<p class="approvals-empty">Could not load join requests.</p>';
            }
        );
    }

    function stop() {
        if (unsubscribe) unsubscribe();
        unsubscribe = null;
        requests = [];
        section.classList.add('hidden');
        divider.classList.add('hidden');
        list.innerHTML = '';
        updateBadges(0);
    }

    function millis(ts) {
        return ts && typeof ts.toMillis === 'function' ? ts.toMillis() : 0;
    }

    function updateBadges(count) {
        badges.forEach((b) => {
            b.textContent = count > 9 ? '9+' : String(count);
            b.classList.toggle('hidden', count === 0);
        });
    }

    function render() {
        updateBadges(requests.filter((r) => r.status === 'pending').length);

        if (requests.length === 0) {
            list.innerHTML = '<p class="approvals-empty">No one is waiting for approval.</p>';
            return;
        }

        list.innerHTML = requests.map((r) => {
            const declined = r.status === 'declined';
            const disabled = busy.has(r.uid) ? ' disabled' : '';
            const photo = r.photoURL
                ? `<img class="approval-photo" src="${escapeHtml(r.photoURL)}" alt="" referrerpolicy="no-referrer">`
                : '<span class="approval-photo"></span>';
            return `
                <div class="approval-item" data-uid="${escapeHtml(r.uid)}">
                    ${photo}
                    <div class="approval-info">
                        <span class="approval-name">${escapeHtml(r.displayName || 'Unnamed user')}</span>
                        <span class="approval-email">${escapeHtml(r.email || '')}</span>
                        ${declined ? '<span class="approval-tag">Declined</span>' : ''}
                    </div>
                    <div class="approval-actions">
                        ${declined ? '' : `
                        <button class="approval-btn decline" data-status="declined" title="Decline" aria-label="Decline"${disabled}>
                            <span class="material-icons-round">close</span>
                        </button>`}
                        <button class="approval-btn approve" data-status="approved" title="Approve" aria-label="Approve"${disabled}>
                            <span class="material-icons-round">check</span>
                        </button>
                    </div>
                </div>`;
        }).join('');
    }

    async function onListClick(e) {
        const btn = e.target.closest('.approval-btn');
        if (!btn || btn.disabled) return;
        const uid = btn.closest('.approval-item')?.dataset.uid;
        const status = btn.dataset.status;
        if (!uid || busy.has(uid)) return;

        const request = requests.find((r) => r.uid === uid);
        const name = request?.displayName || request?.email || 'This user';

        busy.add(uid);
        render();
        try {
            const fns = await ensureFunctions();
            if (!fns) throw new Error('Could not reach the server');
            await fns.httpsCallable('setUserApproval')({ uid, status });
            Toast.show(status === 'approved' ? `${name} can now see trips` : `${name} was declined`, 'success');
        } catch (err) {
            console.error('setUserApproval failed:', err);
            Toast.show('Could not update: ' + err.message, 'error');
        } finally {
            busy.delete(uid);
            render();
        }
    }

    return { init, setAdmin };
})();
