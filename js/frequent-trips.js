// ==========================================
// Frequent Trips Module
// ==========================================

import {
    collection, doc, query, where, orderBy, onSnapshot, getDocs,
    addDoc, updateDoc, deleteDoc, serverTimestamp, increment
} from 'firebase/firestore';
import { db } from './firebase-config.js';
import { Toast } from './toast.js';
import { Auth } from './auth.js';
import { getTomorrowStr, formatTime, escapeHtml } from './utils.js';

export const FrequentTrips = (() => {
    const MAX_TEMPLATES = 10;
    let templates = [];
    let unsubscribeTemplates = null;

    // DOM references (set after DOM is ready)
    let quickAddSection = null;
    let quickAddCards = null;
    let profileFrequentSection = null;
    let profileFrequentList = null;
    let profileFrequentCount = null;
    let savePromptOverlay = null;

    function init() {
        quickAddSection = document.getElementById('quick-add-section');
        quickAddCards = document.getElementById('quick-add-cards');
        profileFrequentSection = document.getElementById('profile-frequent-section');
        profileFrequentList = document.getElementById('profile-frequent-list');
        profileFrequentCount = document.getElementById('profile-frequent-count');
        savePromptOverlay = document.getElementById('save-frequent-overlay');

        // Manage link in Quick Add
        const manageLink = document.getElementById('quick-add-manage');
        if (manageLink) {
            manageLink.addEventListener('click', (e) => {
                e.preventDefault();
                // Open profile sheet if not already open
                const overlay = document.getElementById('profile-sheet-overlay');
                if (overlay) overlay.classList.remove('hidden');
                // Scroll to frequent trips section
                setTimeout(() => {
                    if (profileFrequentSection) {
                        profileFrequentSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                }, 300);
            });
        }

        // Add Frequent Trip button in profile
        const btnAddFrequent = document.getElementById('btn-add-frequent');
        if (btnAddFrequent) {
            btnAddFrequent.addEventListener('click', openAddFrequentForm);
        }

        // Save prompt buttons
        if (savePromptOverlay) {
            const btnSave = document.getElementById('save-frequent-confirm');
            const btnNotNow = document.getElementById('save-frequent-dismiss');
            if (btnSave) btnSave.addEventListener('click', handleSavePromptConfirm);
            if (btnNotNow) btnNotNow.addEventListener('click', handleSavePromptDismiss);
        }
    }

    // ---- FIRESTORE LISTENER ----

    function startListening() {
        const user = Auth.getUser();
        if (!user) return;

        if (unsubscribeTemplates) unsubscribeTemplates();

        const templatesQuery = query(
            collection(db, 'users', user.uid, 'frequentTrips'),
            orderBy('createdAt', 'desc')
        );
        unsubscribeTemplates = onSnapshot(templatesQuery, (snapshot) => {
            templates = snapshot.docs.map(d => ({
                id: d.id,
                ...d.data()
            }));
            renderQuickAdd();
            renderProfileManagement();
        }, (error) => {
            console.error('[FrequentTrips] Error listening:', error);
        });
    }

    function stopListening() {
        if (unsubscribeTemplates) {
            unsubscribeTemplates();
            unsubscribeTemplates = null;
        }
    }

    // ---- CRUD OPERATIONS ----

    async function saveTemplate({ destination, time, label }) {
        const user = Auth.getUser();
        if (!user) return;

        if (templates.length >= MAX_TEMPLATES) {
            Toast.show(`Maximum ${MAX_TEMPLATES} frequent trips reached. Remove one first.`, 'error');
            return;
        }

        // Duplicate detection
        const duplicate = templates.find(t =>
            t.destination.toLowerCase() === destination.toLowerCase() &&
            t.time === time
        );
        if (duplicate) {
            Toast.show('This route + time combination already exists!', 'info');
            return;
        }

        try {
            await addDoc(collection(db, 'users', user.uid, 'frequentTrips'), {
                label: label || destination,
                destination,
                time,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
                usageCount: 0,
                lastUsedAt: null
            });
            Toast.show('Frequent trip saved! ⚡', 'success');
        } catch (error) {
            console.error('[FrequentTrips] Error saving template:', error);
            Toast.show('Failed to save frequent trip', 'error');
        }
    }

    async function deleteTemplate(templateId) {
        const user = Auth.getUser();
        if (!user) return;

        try {
            await deleteDoc(doc(db, 'users', user.uid, 'frequentTrips', templateId));
            Toast.show('Frequent trip removed', 'info');
        } catch (error) {
            console.error('[FrequentTrips] Error deleting template:', error);
            Toast.show('Failed to remove frequent trip', 'error');
        }
    }

    async function updateTemplate(templateId, updates) {
        const user = Auth.getUser();
        if (!user) return;

        try {
            await updateDoc(doc(db, 'users', user.uid, 'frequentTrips', templateId), {
                ...updates,
                updatedAt: serverTimestamp()
            });
            Toast.show('Frequent trip updated', 'success');
        } catch (error) {
            console.error('[FrequentTrips] Error updating template:', error);
            Toast.show('Failed to update frequent trip', 'error');
        }
    }

    // ---- CREATE TRIP FROM TEMPLATE ----

    async function createTripFromTemplate(templateId) {
        const user = Auth.getUser();
        if (!user) return;

        const template = templates.find(t => t.id === templateId);
        if (!template) return;

        // Determine date: use tomorrow by default (user modification)
        const date = getTomorrowStr();

        // Duplicate guard: check if same destination+time already exists for that date by this user
        const existingSnap = await getDocs(query(
            collection(db, 'trips'),
            where('date', '==', date),
            where('destination', '==', template.destination),
            where('time', '==', template.time),
            where('createdBy', '==', user.uid),
            where('deleted', '==', false)
        ));

        if (!existingSnap.empty) {
            const proceed = confirm(
                `A trip to "${template.destination}" at ${formatTime(template.time)} already exists for tomorrow. Create anyway?`
            );
            if (!proceed) return;
        }

        // Disable the button while creating
        const btn = quickAddCards?.querySelector(`[data-template-id="${templateId}"] .quick-add-btn`);
        if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<div class="spinner"></div>';
        }

        try {
            await addDoc(collection(db, 'trips'), {
                destination: template.destination,
                time: template.time,
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

            // Update usage stats (non-blocking)
            updateDoc(doc(db, 'users', user.uid, 'frequentTrips', templateId), {
                usageCount: increment(1),
                lastUsedAt: serverTimestamp()
            }).catch(err => console.warn('[FrequentTrips] Usage stats update failed:', err.message));

            Toast.show(`Trip to ${template.destination} created for tomorrow! 🚗`, 'success');

            // Switch view to tomorrow to show the new trip
            const viewDatePicker = document.getElementById('view-date-picker');
            if (viewDatePicker) {
                viewDatePicker.value = date;
                viewDatePicker.dispatchEvent(new Event('change'));
            }
        } catch (error) {
            console.error('[FrequentTrips] Error creating trip from template:', error);
            Toast.show('Failed to create trip: ' + error.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = '<span class="material-icons-round">add</span>';
            }
        }
    }

    // ---- QUICK ADD UI ----

    function renderQuickAdd() {
        if (!quickAddSection || !quickAddCards) return;

        if (templates.length === 0) {
            quickAddSection.classList.add('hidden');
            return;
        }

        quickAddSection.classList.remove('hidden');
        quickAddCards.innerHTML = '';

        templates.forEach(tmpl => {
            const card = document.createElement('div');
            card.className = 'quick-add-card';
            card.dataset.templateId = tmpl.id;

            const icon = getDestinationIcon(tmpl.label || tmpl.destination);

            card.innerHTML = `
                <div class="quick-add-card-info">
                    <span class="quick-add-emoji">${icon}</span>
                    <span class="quick-add-label">${escapeHtml(tmpl.label || tmpl.destination)}</span>
                    <span class="quick-add-time">
                        <span class="material-icons-round">schedule</span>
                        ${formatTime(tmpl.time)}
                    </span>
                </div>
                <button class="quick-add-btn" title="Create trip for tomorrow">
                    <span class="material-icons-round">add</span>
                </button>
            `;

            const btn = card.querySelector('.quick-add-btn');
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                createTripFromTemplate(tmpl.id);
            });

            quickAddCards.appendChild(card);
        });
    }

    // ---- PROFILE MANAGEMENT UI ----

    function renderProfileManagement() {
        if (!profileFrequentList || !profileFrequentCount) return;

        profileFrequentCount.textContent = `${templates.length}/${MAX_TEMPLATES} used`;
        profileFrequentList.innerHTML = '';

        if (templates.length === 0) {
            profileFrequentList.innerHTML = `
                <div class="frequent-empty">
                    <span class="material-icons-round">bolt</span>
                    <p>No frequent trips yet.<br>Create one to quickly add daily trips!</p>
                </div>
            `;
            return;
        }

        templates.forEach(tmpl => {
            const item = document.createElement('div');
            item.className = 'frequent-manage-item';

            const icon = getDestinationIcon(tmpl.label || tmpl.destination);

            item.innerHTML = `
                <div class="frequent-manage-info">
                    <span class="frequent-manage-emoji">${icon}</span>
                    <div class="frequent-manage-text">
                        <span class="frequent-manage-label">${escapeHtml(tmpl.label || tmpl.destination)}</span>
                        <span class="frequent-manage-detail">
                            ${escapeHtml(tmpl.destination)} · ${formatTime(tmpl.time)}
                            ${tmpl.usageCount ? ` · Used ${tmpl.usageCount}×` : ''}
                        </span>
                    </div>
                </div>
                <div class="frequent-manage-actions">
                    <button class="frequent-edit-btn" title="Edit" data-id="${tmpl.id}">
                        <span class="material-icons-round">edit</span>
                    </button>
                    <button class="frequent-delete-btn" title="Delete" data-id="${tmpl.id}">
                        <span class="material-icons-round">delete</span>
                    </button>
                </div>
            `;

            // Edit button
            item.querySelector('.frequent-edit-btn').addEventListener('click', () => {
                openEditFrequentForm(tmpl);
            });

            // Delete button
            item.querySelector('.frequent-delete-btn').addEventListener('click', () => {
                if (confirm(`Remove "${tmpl.label || tmpl.destination}" from frequent trips?`)) {
                    deleteTemplate(tmpl.id);
                }
            });

            profileFrequentList.appendChild(item);
        });
    }

    // ---- ADD / EDIT FREQUENT TRIP FORMS ----

    function openAddFrequentForm() {
        if (templates.length >= MAX_TEMPLATES) {
            Toast.show(`Maximum ${MAX_TEMPLATES} frequent trips reached. Remove one first.`, 'error');
            return;
        }
        showFrequentFormModal({ title: 'Add Frequent Trip', onSubmit: saveTemplate });
    }

    function openEditFrequentForm(tmpl) {
        showFrequentFormModal({
            title: 'Edit Frequent Trip',
            initial: { label: tmpl.label, destination: tmpl.destination, time: tmpl.time },
            onSubmit: (data) => updateTemplate(tmpl.id, data)
        });
    }

    function showFrequentFormModal({ title, initial = {}, onSubmit }) {
        // Remove any existing form modal
        const existing = document.getElementById('frequent-form-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'frequent-form-modal';
        overlay.className = 'frequent-form-overlay';

        overlay.innerHTML = `
            <div class="frequent-form-card">
                <div class="frequent-form-header">
                    <h3>${title}</h3>
                    <button class="frequent-form-close">
                        <span class="material-icons-round">close</span>
                    </button>
                </div>
                <form class="frequent-form-body" autocomplete="off">
                    <div class="form-group">
                        <label>
                            <span class="material-icons-round">place</span>
                            Destination
                        </label>
                        <input type="text" class="frequent-input-destination" placeholder="e.g., Smart Village" value="${escapeHtml(initial.destination || '')}" required>
                    </div>
                    <div class="form-group">
                        <label>
                            <span class="material-icons-round">schedule</span>
                            Departure Time
                        </label>
                        <input type="time" class="frequent-input-time" value="${initial.time || ''}" required>
                    </div>
                    <div class="form-group">
                        <label>
                            <span class="material-icons-round">label</span>
                            Label (optional)
                        </label>
                        <input type="text" class="frequent-input-label" placeholder="e.g., Morning Commute" value="${escapeHtml(initial.label || '')}">
                    </div>
                    <button type="submit" class="btn-primary">
                        <span class="material-icons-round">check_circle</span>
                        Save
                    </button>
                </form>
            </div>
        `;

        document.body.appendChild(overlay);

        // Close
        overlay.querySelector('.frequent-form-close').addEventListener('click', () => overlay.remove());
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        // Submit
        overlay.querySelector('form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const destination = overlay.querySelector('.frequent-input-destination').value.trim();
            const time = overlay.querySelector('.frequent-input-time').value;
            const label = overlay.querySelector('.frequent-input-label').value.trim();

            if (!destination || !time) return;

            await onSubmit({ destination, time, label: label || destination });
            overlay.remove();
        });

        // Focus first input
        overlay.querySelector('.frequent-input-destination').focus();
    }

    // ---- SAVE PROMPT (after trip creation) ----

    let pendingSaveData = null;

    function showSavePrompt(destination, time) {
        // Check suppression
        const key = `ft_suppress_${destination.toLowerCase()}_${time}`;
        const suppressed = localStorage.getItem(key);
        if (suppressed) {
            const suppressedTime = parseInt(suppressed, 10);
            if (Date.now() - suppressedTime < 7 * 24 * 60 * 60 * 1000) return; // 7-day suppression
        }

        // Check if already saved
        const alreadySaved = templates.find(t =>
            t.destination.toLowerCase() === destination.toLowerCase() &&
            t.time === time
        );
        if (alreadySaved) return;

        // Check if at max
        if (templates.length >= MAX_TEMPLATES) return;

        pendingSaveData = { destination, time };

        if (savePromptOverlay) {
            const labelInput = document.getElementById('save-frequent-label');
            if (labelInput) labelInput.value = '';
            const destEl = document.getElementById('save-frequent-dest');
            if (destEl) destEl.textContent = `${destination} at ${formatTime(time)}`;
            savePromptOverlay.classList.remove('hidden');
        }
    }

    async function handleSavePromptConfirm() {
        if (!pendingSaveData) return;

        const labelInput = document.getElementById('save-frequent-label');
        const label = labelInput?.value.trim() || pendingSaveData.destination;

        await saveTemplate({
            destination: pendingSaveData.destination,
            time: pendingSaveData.time,
            label
        });

        pendingSaveData = null;
        if (savePromptOverlay) savePromptOverlay.classList.add('hidden');
    }

    function handleSavePromptDismiss() {
        if (pendingSaveData) {
            // Suppress for 7 days
            const key = `ft_suppress_${pendingSaveData.destination.toLowerCase()}_${pendingSaveData.time}`;
            localStorage.setItem(key, Date.now().toString());
        }
        pendingSaveData = null;
        if (savePromptOverlay) savePromptOverlay.classList.add('hidden');
    }

    // ---- UTILITIES ----

    function getDestinationIcon(label) {
        const l = (label || '').toLowerCase();
        if (l.includes('office') || l.includes('work') || l.includes('company')) return '🏢';
        if (l.includes('gym') || l.includes('sport') || l.includes('fitness')) return '🏋️';
        if (l.includes('home') || l.includes('house')) return '🏠';
        if (l.includes('school') || l.includes('uni') || l.includes('college')) return '🎓';
        if (l.includes('hospital') || l.includes('clinic') || l.includes('doctor')) return '🏥';
        if (l.includes('mall') || l.includes('shop')) return '🛍️';
        if (l.includes('airport')) return '✈️';
        if (l.includes('mosque') || l.includes('church')) return '🕌';
        return '📍';
    }

    function getTemplates() {
        return templates;
    }

    return {
        init,
        startListening,
        stopListening,
        saveTemplate,
        deleteTemplate,
        updateTemplate,
        createTripFromTemplate,
        showSavePrompt,
        getTemplates
    };
})();
