// ==========================================
// Trips Module
// ==========================================

import {
    collection, doc, query, where, orderBy, onSnapshot, getDoc, getDocs,
    addDoc, updateDoc, runTransaction, serverTimestamp
} from 'firebase/firestore';
import { db } from './firebase-config.js';
import { Toast } from './toast.js';
import { Auth } from './auth.js';
import { Notifications } from './notifications.js';
import { FrequentTrips } from './frequent-trips.js';
import { getTodayStr, getTomorrowStr, getNowTimeStr, formatTime, escapeHtml } from './utils.js';

export const Trips = (() => {
    let destinations = [];
    let destinationsPromise = null;

    let unsubscribeTrips = null;
    let loadedTrips = [];      // every trip the current listener returned (1 or 2 dates)
    let allTrips = [];         // trips for viewDate, sorted by time
    let viewDate = null;
    let activeView = 'all-trips';
    let editingTripId = null; // Track if we are editing a trip
    let completedCollapsed = true; // Completed trips section collapsed by default
    const processingTrips = new Set(); // Guard against double-tap on mobile

    // DOM Elements
    const fabCreate = document.getElementById('fab-create');
    const modalOverlay = document.getElementById('modal-overlay');
    const btnCloseModal = document.getElementById('btn-close-modal');
    const formCreateTrip = document.getElementById('form-create-trip');
    const inputDestination = document.getElementById('input-destination');
    const inputTime = document.getElementById('input-time');
    const inputDate = document.getElementById('input-date');
    const suggestionsList = document.getElementById('destination-suggestions');
    const btnSubmitTrip = document.getElementById('btn-submit-trip');

    // One entry per tab. Only the visible tab is rendered on each snapshot;
    // the others are marked dirty and rendered when the user switches to them.
    const lists = {
        'all-trips': {
            el: document.getElementById('trips-list'),
            empty: document.getElementById('empty-trips'),
            myView: false,
            select: (trips) => ({
                active: trips.filter(t => !t.completed),
                completed: trips.filter(t => t.completed)
            })
        },
        'my-trips': {
            el: document.getElementById('my-trips-list'),
            empty: document.getElementById('empty-my-trips'),
            myView: true,
            select: (trips, uid) => {
                const mine = trips.filter(t =>
                    (t.assignees || []).some(a => a.uid === uid) || t.driver?.uid === uid
                );
                return {
                    active: mine.filter(t => !t.completed),
                    completed: mine.filter(t => t.completed)
                };
            }
        },
        'open-driving': {
            el: document.getElementById('open-driving-list'),
            empty: document.getElementById('empty-open-driving'),
            myView: false,
            select: (trips) => ({
                active: trips.filter(t => !t.driver && !t.completed),
                completed: []
            })
        }
    };

    Object.values(lists).forEach((list) => {
        list.cards = new Map();      // tripId → { sig, el }
        list.completedSection = null;
        list.fresh = true;           // next render replaces the list and animates cards in
        list.loading = true;         // no snapshot yet for this date
        list.dirty = true;
    });

    function init() {
        // FAB click
        fabCreate.addEventListener('click', openModal);
        btnCloseModal.addEventListener('click', closeModal);
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeModal();
        });

        // Form submission
        formCreateTrip.addEventListener('submit', handleCreateTrip);

        // Destination autocomplete
        inputDestination.addEventListener('input', handleDestinationInput);
        inputDestination.addEventListener('focus', handleDestinationInput);
        inputDestination.addEventListener('blur', () => {
            setTimeout(() => suggestionsList.classList.add('hidden'), 200);
        });

        // Keyboard close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeModal();
        });
    }

    // ---- DESTINATIONS ----

    // Fetched once, the first time the create/edit modal opens — not at startup.
    function loadDestinations() {
        if (!destinationsPromise) {
            destinationsPromise = getDocs(query(collection(db, 'destinations'), orderBy('name')))
                .then((snapshot) => {
                    const names = new Set(snapshot.docs.map(d => d.data().name).filter(Boolean));
                    destinations.forEach(d => names.add(d)); // keep any added locally meanwhile
                    destinations = [...names].sort();
                    // Refresh suggestions if the user is already typing
                    if (document.activeElement === inputDestination) handleDestinationInput();
                })
                .catch((error) => {
                    console.error('Error loading destinations:', error);
                    destinationsPromise = null; // retry next time the modal opens
                });
        }
        return destinationsPromise;
    }

    function handleDestinationInput() {
        const query = inputDestination.value.trim().toLowerCase();

        if (!query) {
            // Show all destinations
            if (destinations.length === 0) {
                suggestionsList.innerHTML = '';
                suggestionsList.classList.add('hidden');
                return;
            }
            renderSuggestions(destinations, query);
            return;
        }

        const filtered = destinations.filter(d => d.toLowerCase().includes(query));
        const exactMatch = destinations.some(d => d.toLowerCase() === query);

        renderSuggestions(filtered, query, !exactMatch);
    }

    function renderSuggestions(filtered, query, showAddNew = false) {
        const fragment = document.createDocumentFragment();

        filtered.forEach(dest => {
            const li = document.createElement('li');
            li.className = 'suggestion-item';
            li.innerHTML = `<span class="material-icons-round">place</span>${escapeHtml(dest)}`;
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                inputDestination.value = dest;
                suggestionsList.classList.add('hidden');
            });
            fragment.appendChild(li);
        });

        if (showAddNew && query) {
            const li = document.createElement('li');
            li.className = 'suggestion-item add-new';
            li.innerHTML = `<span class="material-icons-round">add_circle</span>Add "${escapeHtml(inputDestination.value.trim())}"`;
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                suggestionsList.classList.add('hidden');
            });
            fragment.appendChild(li);
        }

        suggestionsList.replaceChildren(fragment);
        suggestionsList.classList.toggle('hidden', suggestionsList.children.length === 0);
    }

    async function addDestination(name) {
        const normalized = name.trim();
        if (!normalized) return;

        await loadDestinations();
        const exists = destinations.some(d => d.toLowerCase() === normalized.toLowerCase());
        if (!exists) {
            destinations = [...destinations, normalized].sort();
            try {
                await addDoc(collection(db, 'destinations'), {
                    name: normalized,
                    createdAt: serverTimestamp()
                });
            } catch (error) {
                console.error('Error adding destination:', error);
            }
        }
    }

    // ---- TRIPS LISTENER ----

    /**
     * Listen to trips for `selectedDate`.
     *
     * With autoAdvance (initial page open, viewing today), today and tomorrow are
     * fetched in a single query. If none of today's trips are still upcoming, the
     * view jumps to tomorrow without a second round trip; onDateChange(date) lets
     * the caller update the date bar.
     */
    function startListening(selectedDate, { autoAdvance = false, onDateChange = null } = {}) {
        if (unsubscribeTrips) unsubscribeTrips();

        const today = getTodayStr();
        const tomorrow = getTomorrowStr();
        viewDate = selectedDate || today;
        loadedTrips = [];
        allTrips = [];
        resetLists();

        const prefetchTomorrow = autoAdvance && viewDate === today;
        const loadedDates = prefetchTomorrow ? [today, tomorrow] : [viewDate];

        // deleted == false is filtered server-side so soft-deleted trips aren't downloaded
        const tripsQuery = query(
            collection(db, 'trips'),
            prefetchTomorrow ? where('date', 'in', loadedDates) : where('date', '==', viewDate),
            where('deleted', '==', false)
        );

        // Auto-advance is decided on the first snapshot (possibly from cache) and
        // re-checked once when the first server snapshot arrives.
        let advanceSettled = !prefetchTomorrow;
        let firstSnapshot = true;

        unsubscribeTrips = onSnapshot(tripsQuery, (snapshot) => {
            const fromCache = snapshot.metadata.fromCache;
            loadedTrips = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

            if (firstSnapshot) {
                firstSnapshot = false;
                reportFirstTrips(fromCache, loadedTrips.length);
            }

            if (!advanceSettled) {
                if (!fromCache) advanceSettled = true;
                const now = getNowTimeStr();
                const hasUpcomingToday = loadedTrips.some(t => t.date === today && (t.time || '') >= now);
                const target = hasUpcomingToday ? today : tomorrow;
                if (target !== viewDate) {
                    console.log(target === tomorrow
                        ? 'All today\'s trips passed. Switching to tomorrow.'
                        : 'Upcoming trips found today. Switching back to today.');
                    viewDate = target;
                    resetLists();
                    if (onDateChange) onDateChange(target);
                }
            }

            allTrips = loadedTrips
                .filter(t => t.date === viewDate)
                .sort((a, b) => (a.time || '').localeCompare(b.time || ''));

            Object.values(lists).forEach((list) => {
                list.loading = false;
                list.dirty = true;
            });
            renderList(activeView);
        }, (error) => {
            console.error('Error listening to trips:', error);
            Toast.show('Failed to load trips: ' + error.message, 'error');
        });
    }

    function reportFirstTrips(fromCache, count) {
        performance.mark('tripsync:first-trips');
        const sinceAuth = performance.getEntriesByName('tripsync:auth-resolved').pop();
        const now = performance.now();
        console.info(
            `[perf] first trips snapshot at ${Math.round(now)}ms` +
            (sinceAuth ? ` (${Math.round(now - sinceAuth.startTime)}ms after auth)` : '') +
            ` — ${count} trip(s), fromCache=${fromCache}`
        );
        Notifications.onTripsLoaded();
    }

    function stopListening() {
        if (unsubscribeTrips) unsubscribeTrips();
        unsubscribeTrips = null;
        loadedTrips = [];
        allTrips = [];
        resetLists();
    }

    async function handleCreateTrip(e) {
        e.preventDefault();

        const destination = inputDestination.value.trim();
        const time = inputTime.value;
        const date = inputDate.value;
        const user = Auth.getUser();

        if (!destination || !time || !date || !user) return;

        btnSubmitTrip.disabled = true;
        btnSubmitTrip.innerHTML = '<div class="spinner"></div>Creating...';

        // Timeout to prevent infinite loading
        const timeoutId = setTimeout(() => {
            btnSubmitTrip.disabled = false;
            btnSubmitTrip.innerHTML = '<span class="material-icons-round">check_circle</span>Create Trip';
            Toast.show('Request timed out. Check your Firestore database setup.', 'error');
        }, 15000);

        try {
            if (editingTripId) {
                // Update existing trip
                await updateDoc(doc(db, 'trips', editingTripId), {
                    destination,
                    time,
                    date,
                    updatedAt: serverTimestamp()
                });
                Toast.show(`Trip to ${destination} updated!`, 'success');
            } else {
                // Create new trip. The sendTripReminders Cloud Function picks up
                // notifiedNew == false and notifies drivers (push + in-app).
                await addDoc(collection(db, 'trips'), {
                    destination,
                    time,
                    date,
                    createdBy: user.uid,
                    creatorName: user.displayName,
                    creatorPhoto: user.photoURL,
                    assignees: [],
                    deleted: false,
                    completed: false,
                    notifiedNew: false,
                    createdAt: serverTimestamp()
                });
                Toast.show(`Trip to ${destination} created!`, 'success');

                // Prompt to save as frequent trip (smart suppression built-in)
                setTimeout(() => FrequentTrips.showSavePrompt(destination, time), 800);
            }

            clearTimeout(timeoutId);

            // Add destination in background (non-blocking)
            addDestination(destination).catch(err => console.warn('Destination save failed:', err));

            closeModal();
            formCreateTrip.reset();
            editingTripId = null;

            // Switch main view to the trip's date to show the new trip
            const viewDatePicker = document.getElementById('view-date-picker');
            if (viewDatePicker && viewDatePicker.value !== date) {
                viewDatePicker.value = date;
                // Dispatch change event to trigger re-listening
                viewDatePicker.dispatchEvent(new Event('change'));
            }
        } catch (error) {
            clearTimeout(timeoutId);
            console.error('Error creating trip:', error);
            Toast.show('Failed to create trip: ' + error.message, 'error');
        } finally {
            btnSubmitTrip.disabled = false;
            const btnLabel = editingTripId ? 'Update Trip' : 'Create Trip';
            btnSubmitTrip.innerHTML = `<span class="material-icons-round">check_circle</span>${btnLabel}`;
        }
    }

    async function deleteTrip(tripId) {
        if (!confirm('Are you sure you want to delete this trip?')) return;

        try {
            await updateDoc(doc(db, 'trips', tripId), {
                deleted: true,
                deletedAt: serverTimestamp()
            });
            Toast.show('Trip deleted', 'success');
        } catch (error) {
            console.error('Error deleting trip:', error);
            Toast.show('Failed to delete trip', 'error');
        }
    }

    async function completeTrip(tripId) {
        if (!confirm('Mark this trip as completed?')) return;

        try {
            await updateDoc(doc(db, 'trips', tripId), {
                completed: true,
                completedAt: serverTimestamp()
            });
            Toast.show('Trip marked as completed! ✅', 'success');
        } catch (error) {
            console.error('Error completing trip:', error);
            Toast.show('Failed to complete trip', 'error');
        }
    }

    async function assignToTrip(tripId) {
        const user = Auth.getUser();
        if (!user) return;
        if (processingTrips.has(`assign-${tripId}`)) return;
        processingTrips.add(`assign-${tripId}`);

        try {
            const tripRef = doc(db, 'trips', tripId);

            // The transaction returns the updated trip, so no extra read is needed
            const updatedTrip = await runTransaction(db, async (transaction) => {
                const tripDoc = await transaction.get(tripRef);
                if (!tripDoc.exists()) throw new Error('Trip not found');

                const data = tripDoc.data();
                const assignees = data.assignees || [];

                // Check if already assigned
                if (assignees.some(a => a.uid === user.uid)) {
                    throw new Error('Already assigned');
                }

                assignees.push({
                    uid: user.uid,
                    displayName: user.displayName,
                    photoURL: user.photoURL
                });

                transaction.update(tripRef, { assignees });
                return { ...data, assignees };
            });

            Toast.show('You joined the trip!', 'success');
            Notifications.sendNotificationToTripUsers(tripId, updatedTrip, 'joined', user);
        } catch (error) {
            if (error.message === 'Already assigned') {
                Toast.show('You are already assigned to this trip', 'info');
            } else {
                console.error('Error assigning to trip:', error);
                Toast.show('Failed to join trip', 'error');
            }
        } finally {
            processingTrips.delete(`assign-${tripId}`);
        }
    }

    async function unassignFromTrip(tripId) {
        const user = Auth.getUser();
        if (!user) return;
        if (processingTrips.has(`unassign-${tripId}`)) return;
        processingTrips.add(`unassign-${tripId}`);

        try {
            const tripRef = doc(db, 'trips', tripId);

            const updatedTrip = await runTransaction(db, async (transaction) => {
                const tripDoc = await transaction.get(tripRef);
                if (!tripDoc.exists()) throw new Error('Trip not found');

                const data = tripDoc.data();
                const assignees = (data.assignees || []).filter(a => a.uid !== user.uid);
                transaction.update(tripRef, { assignees });
                return { ...data, assignees };
            });

            Toast.show('You left the trip', 'info');
            Notifications.sendNotificationToTripUsers(tripId, updatedTrip, 'left', user);
        } catch (error) {
            console.error('Error unassigning from trip:', error);
            Toast.show('Failed to leave trip', 'error');
        } finally {
            processingTrips.delete(`unassign-${tripId}`);
        }
    }

    async function joinAsDriver(tripId) {
        const user = Auth.getUser();
        if (!user) return;
        if (processingTrips.has(`driver-${tripId}`)) return;
        processingTrips.add(`driver-${tripId}`);

        try {
            const tripRef = doc(db, 'trips', tripId);

            const tripDoc = await getDoc(tripRef);
            if (!tripDoc.exists()) return;

            const tripData = tripDoc.data();
            const currentDriver = tripData.driver;

            if (currentDriver && currentDriver.uid === user.uid) {
                Toast.show('You are already the driver', 'info');
                return;
            }

            if (currentDriver) {
                const confirmReplace = confirm(`${currentDriver.displayName} is already the driver. Do you want to replace them?`);
                if (!confirmReplace) return;
            }

            await updateDoc(tripRef, {
                driver: {
                    uid: user.uid,
                    displayName: user.displayName,
                    photoURL: user.photoURL
                }
            });

            // Build list of users to notify: all riders + trip creator (excluding the new driver)
            const notifyUids = new Set(
                (tripData.assignees || []).map(a => a.uid)
            );
            notifyUids.add(tripData.createdBy); // always notify the trip creator
            notifyUids.delete(user.uid); // don't notify the new driver themselves
            const riderUids = [...notifyUids];

            // Notify via Cloud Function callable.
            // IMPORTANT: use else-if — when replacing a driver the Cloud
            // Function already notifies BOTH the old driver AND all riders,
            // so a second 'driver_assigned' call would duplicate pushes.
            if (currentDriver && currentDriver.uid !== user.uid) {
                // Driver replacement — notifies old driver + riders in one call
                Notifications.sendDriverNotificationPush({
                    tripId,
                    type: 'driver_replaced',
                    oldDriverUid: currentDriver.uid,
                    newDriverName: user.displayName,
                    destination: tripData.destination,
                    date: tripData.date,
                    time: tripData.time,
                    riderUids
                });
            } else if (riderUids.length > 0) {
                // First-time driver assignment — notify riders + creator only
                Notifications.sendDriverNotificationPush({
                    tripId,
                    type: 'driver_assigned',
                    oldDriverUid: null,
                    newDriverName: user.displayName,
                    destination: tripData.destination,
                    date: tripData.date,
                    time: tripData.time,
                    riderUids
                });
            }

            Toast.show('You are now the driver!', 'success');
        } catch (error) {
            console.error('Error joining as driver:', error);
            Toast.show('Failed to join as driver', 'error');
        } finally {
            processingTrips.delete(`driver-${tripId}`);
        }
    }

    async function leaveAsDriver(tripId) {
        const user = Auth.getUser();
        if (!user) return;

        try {
            await updateDoc(doc(db, 'trips', tripId), {
                driver: null
            });
            Toast.show('You are no longer the driver', 'info');
        } catch (error) {
            console.error('Error leaving as driver:', error);
            Toast.show('Failed to leave as driver', 'error');
        }
    }

    // ---- RENDERING ----

    // Called by App when the user switches tabs
    function setActiveView(viewName) {
        if (!lists[viewName]) return;
        activeView = viewName;
        renderList(viewName);
    }

    function resetLists() {
        Object.values(lists).forEach((list) => {
            list.fresh = true;
            list.loading = true;
            list.dirty = true;
        });
        renderList(activeView);
    }

    function renderList(viewName) {
        const list = lists[viewName];
        if (!list || !list.dirty) return;
        list.dirty = false;

        const user = Auth.getUser();

        if (list.fresh) {
            list.el.replaceChildren();
            list.cards.clear();
            list.completedSection = null;
        }

        if (list.loading) {
            // Waiting for the first snapshot of this date — show placeholders
            list.empty.classList.add('hidden');
            if (!list.el.firstElementChild) list.el.append(...createSkeletons(3));
            return;
        }

        const animate = list.fresh;
        list.fresh = false;

        if (!user) return;
        const { active, completed } = list.select(allTrips, user.uid);

        if (active.length === 0 && completed.length === 0) {
            list.el.replaceChildren();
            list.cards.clear();
            list.completedSection = null;
            list.empty.classList.remove('hidden');
            return;
        }
        list.empty.classList.add('hidden');

        list.cards = reconcile(list.el, active, list.cards,
            (trip, index) => createTripCard(trip, index, { myView: list.myView, animate }));

        if (completed.length > 0) {
            if (!list.completedSection) list.completedSection = createCompletedSection();
            updateCompletedSection(list.completedSection, completed, list.myView, animate);
            if (list.el.lastElementChild !== list.completedSection.section) {
                list.el.appendChild(list.completedSection.section);
            }
        } else if (list.completedSection) {
            list.completedSection.section.remove();
            list.completedSection = null;
        }
    }

    // Everything a card displays — if this is unchanged the existing card is kept,
    // so unrelated field updates (notifiedNew, notified30min…) cost nothing.
    function cardSignature(trip) {
        return JSON.stringify([
            trip.destination, trip.time, trip.date, trip.createdBy, trip.creatorName,
            trip.creatorPhoto, !!trip.completed, trip.driver || null, trip.assignees || []
        ]);
    }

    /**
     * Keyed update of `container`'s leading children to match `trips`:
     * unchanged cards are kept in place, changed ones replaced, stale ones removed.
     * Elements after the managed cards (the completed section) stay at the end.
     */
    function reconcile(container, trips, prevCards, build) {
        const nextCards = new Map();

        trips.forEach((trip, index) => {
            const sig = cardSignature(trip);
            const prev = prevCards.get(trip.id);
            let el;
            if (prev && prev.sig === sig) {
                el = prev.el;
            } else {
                if (prev) prev.el.remove();
                el = build(trip, index);
            }
            nextCards.set(trip.id, { sig, el });

            const current = container.children[index];
            if (current !== el) container.insertBefore(el, current || null);
        });

        prevCards.forEach((entry, id) => {
            if (!nextCards.has(id)) entry.el.remove();
        });

        return nextCards;
    }

    function createSkeletons(count) {
        return Array.from({ length: count }, () => {
            const el = document.createElement('div');
            el.className = 'trip-skeleton';
            el.setAttribute('aria-hidden', 'true');
            el.innerHTML = '<div class="skeleton-line wide"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div>';
            return el;
        });
    }

    /**
     * Builds a collapsible "Completed Trips" accordion section. The section is
     * kept between renders; updateCompletedSection() refreshes its contents.
     */
    function createCompletedSection() {
        const section = document.createElement('div');
        section.className = 'completed-section';

        const header = document.createElement('button');
        header.className = 'completed-section-header';
        header.innerHTML = `
            <span class="material-icons-round">check_circle</span>
            <span class="completed-section-title"></span>
            <span class="material-icons-round completed-chevron ${completedCollapsed ? '' : 'expanded'}">expand_more</span>
        `;

        const body = document.createElement('div');
        body.className = 'completed-section-body';
        if (completedCollapsed) body.classList.add('collapsed');

        header.addEventListener('click', () => {
            completedCollapsed = !completedCollapsed;
            // Keep every tab's completed section in sync
            Object.values(lists).forEach((list) => {
                const s = list.completedSection;
                if (!s) return;
                s.body.classList.toggle('collapsed', completedCollapsed);
                s.chevron.classList.toggle('expanded', !completedCollapsed);
            });
        });

        section.appendChild(header);
        section.appendChild(body);
        return {
            section,
            body,
            title: header.querySelector('.completed-section-title'),
            chevron: header.querySelector('.completed-chevron'),
            cards: new Map()
        };
    }

    function updateCompletedSection(completedSection, trips, myView, animate) {
        completedSection.title.textContent = `Completed Trips (${trips.length})`;
        completedSection.body.classList.toggle('collapsed', completedCollapsed);
        completedSection.chevron.classList.toggle('expanded', !completedCollapsed);
        completedSection.cards = reconcile(completedSection.body, trips, completedSection.cards,
            (trip, index) => createTripCard(trip, index, { myView, animate, isCompleted: true }));
    }

    function avatarImg(src, alt, size) {
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${size}" height="${size}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
    }

    function createTripCard(trip, index, { animate = false, isCompleted = false } = {}) {
        const user = Auth.getUser();
        const isCreator = trip.createdBy === user?.uid;
        const isAssigned = (trip.assignees || []).some(a => a.uid === user?.uid);
        const isDriver = trip.driver?.uid === user?.uid;
        const assigneeCount = (trip.assignees || []).length;
        const canComplete = (isDriver || isCreator) && !isCompleted;

        const card = document.createElement('div');
        card.className = `trip-card${isCompleted ? ' completed' : ''}`;
        if (animate) {
            // Stagger only the first few cards so long lists don't trickle in
            card.style.animationDelay = `${Math.min(index, 6) * 0.05}s`;
            // Once shown, stop animating so moving the card never replays it
            card.addEventListener('animationend', () => card.classList.add('settled'), { once: true });
        } else {
            card.classList.add('settled');
        }

        const displayTime = formatTime(trip.time);
        const firstName = (name) => escapeHtml((name || '').split(' ')[0]);

        // Build assignee chips
        let assigneeChips = '';
        (trip.assignees || []).forEach(a => {
            const isMe = a.uid === user?.uid;
            assigneeChips += `
                <span class="assignee-chip ${isMe ? 'is-me' : ''}">
                    ${avatarImg(a.photoURL, a.displayName, 24)}
                    ${firstName(a.displayName)}${isMe ? ' (You)' : ''}
                </span>`;
        });

        // Driver section
        const driverInfo = trip.driver ? `
            <div class="trip-driver">
                <span class="driver-label">DRIVER</span>
                <div class="assignee-chip ${isDriver ? 'is-me' : ''}">
                    ${avatarImg(trip.driver.photoURL, trip.driver.displayName, 24)}
                    ${firstName(trip.driver.displayName)}${isDriver ? ' (You)' : ''}
                </div>
            </div>
        ` : '';

        card.innerHTML = `
            <div class="trip-card-header">
                <div class="trip-destination">
                    <span class="material-icons-round">place</span>
                    <span class="trip-dest-name">${escapeHtml(trip.destination)}</span>
                </div>
                <div class="trip-time-badge">
                    <span class="material-icons-round">schedule</span>
                    ${displayTime}
                </div>
                ${isCompleted ? '<span class="completed-badge"><span class="material-icons-round">check_circle</span> Completed</span>' : ''}
                ${isCreator && !isCompleted ? `
                <div class="trip-actions">
                    <button class="btn-icon edit" title="Edit Trip">
                        <span class="material-icons-round">edit</span>
                    </button>
                    <button class="btn-icon delete" title="Delete Trip">
                        <span class="material-icons-round">delete</span>
                    </button>
                </div>
                ` : ''}
            </div>
            <div class="trip-meta">
                <span class="trip-meta-item">
                    <span class="material-icons-round">group</span>
                    ${assigneeCount} rider${assigneeCount !== 1 ? 's' : ''}
                </span>
            </div>
            ${driverInfo}
            ${assigneeChips ? `
                <div class="trip-riders">
                    <span class="driver-label">RIDERS</span>
                    <div class="trip-assignees">${assigneeChips}</div>
                </div>
            ` : ''}
            <div class="trip-card-footer">
                <div class="trip-creator">
                    ${avatarImg(trip.creatorPhoto, trip.creatorName, 22)}
                    Created by ${firstName(trip.creatorName)}
                </div>
                ${isCompleted ? '' : `
                <div class="trip-footer-actions">
                    <button class="btn-assign driver ${isDriver ? 'leave' : 'join'}">
                        <span class="material-icons-round">drive_eta</span>
                        ${isDriver ? 'Leave Drive' : 'Drive'}
                    </button>
                    <button class="btn-assign ${isAssigned ? 'leave' : 'join'}">
                        <span class="material-icons-round">${isAssigned ? 'person_remove' : 'person_add'}</span>
                        ${isAssigned ? 'Leave' : 'Join'}
                    </button>
                    ${canComplete ? `
                    <button class="btn-complete" title="Mark as Completed">
                        <span class="material-icons-round">task_alt</span>
                        Complete
                    </button>
                    ` : ''}
                </div>
                `}
            </div>
        `;

        // Bind assign/unassign and drive buttons only for active trips
        if (!isCompleted) {
            const btnAssign = card.querySelector('.btn-assign:not(.driver)');
            btnAssign.addEventListener('click', () => {
                if (isAssigned) {
                    unassignFromTrip(trip.id);
                } else {
                    assignToTrip(trip.id);
                }
            });

            // Bind Drive
            const btnDrive = card.querySelector('.btn-assign.driver');
            btnDrive.addEventListener('click', () => {
                if (isDriver) {
                    leaveAsDriver(trip.id);
                } else {
                    joinAsDriver(trip.id);
                }
            });

            // Bind complete button
            if (canComplete) {
                card.querySelector('.btn-complete').addEventListener('click', (e) => {
                    e.stopPropagation();
                    completeTrip(trip.id);
                });
            }
        }

        // Bind Edit/Delete
        if (isCreator && !isCompleted) {
            card.querySelector('.btn-icon.edit').addEventListener('click', (e) => {
                e.stopPropagation();
                openEditModal(trip);
            });
            card.querySelector('.btn-icon.delete').addEventListener('click', (e) => {
                e.stopPropagation();
                deleteTrip(trip.id);
            });
        }

        return card;
    }

    // ---- MODAL ----

    function openModal() {
        editingTripId = null;
        modalOverlay.querySelector('h2').textContent = 'Create a Trip';
        btnSubmitTrip.innerHTML = '<span class="material-icons-round">check_circle</span>Create Trip';

        modalOverlay.classList.remove('hidden');
        inputDestination.value = '';
        inputTime.value = '';
        inputDate.value = getTomorrowStr();
        loadDestinations();
        inputDestination.focus();
    }

    function openEditModal(trip) {
        editingTripId = trip.id;
        modalOverlay.querySelector('h2').textContent = 'Edit Trip';
        btnSubmitTrip.innerHTML = '<span class="material-icons-round">check_circle</span>Update Trip';

        modalOverlay.classList.remove('hidden');
        inputDestination.value = trip.destination;
        inputTime.value = trip.time;
        inputDate.value = trip.date;
        loadDestinations();
        inputDestination.focus();
    }

    function closeModal() {
        modalOverlay.classList.add('hidden');
    }

    // ---- ACCESSORS ----

    // Today's trips the current user has joined (for in-page reminders)
    function getAssignedTripsToday() {
        const user = Auth.getUser();
        if (!user) return [];
        const today = getTodayStr();
        return loadedTrips.filter(t =>
            t.date === today && (t.assignees || []).some(a => a.uid === user.uid)
        );
    }

    return { init, startListening, stopListening, setActiveView, getAssignedTripsToday };
})();
