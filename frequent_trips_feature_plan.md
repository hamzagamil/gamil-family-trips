# 🚗 Frequent Trips — Feature Specification & Implementation Plan

> **Project:** TripSync (Daily Trip Planner)
> **Author:** Business Analysis | April 2026
> **Status:** 🚀 Implementation Complete — Ready for Testing
> **Last Updated:** 2026-04-05

---

## 1. Problem Statement

Currently, users who take the **same trip every day** (e.g., home → office at 8:00 AM) must manually create a new trip from scratch each time. This involves:

1. Tapping the FAB (+) button
2. Searching/selecting the destination
3. Setting the departure date
4. Setting the departure time
5. Submitting the form

For daily commuters — the app's primary audience — this is **repetitive and friction-heavy**. Users should be able to save their frequent routes and create daily trips from them with **a single tap**.

---

## 2. User Personas

| Persona | Description | Pain Point |
|---------|-------------|------------|
| **Daily Commuter (Rider)** | Takes the same 1–2 routes every workday | Re-enters destination + time every morning |
| **Regular Driver** | Drives the same route daily, offers rides | Recreates the same trip for others to join |
| **Multi-Route User** | Has 2–3 regular routes (office, gym, etc.) | Needs to remember times for different destinations |

---

## 3. Feature Overview

### 3.1 What is a "Frequent Trip"?

A **Frequent Trip** (internally: **Trip Template**) is a saved route configuration consisting of:

- **Destination** (e.g., "Office — Smart Village")
- **Default Departure Time** (e.g., "08:00")
- **Optional Label** (e.g., "Morning Commute" / "Gym Run")

It does **NOT** include a date — the date is always set to **tomorrow** when the template is used (modified from original "today" default).

### 3.2 Core User Flow

```
┌─────────────────────────────────────────────────┐
│  User opens app → sees "+ Create Trip" FAB       │
│                                                   │
│  Option A: Tap FAB → Manual creation (existing)   │
│                                                   │
│  Option B: Tap "⚡ Quick Add" section             │
│   → Sees saved frequent trips as compact cards    │
│   → Taps one → Trip is created instantly          │
│   → Date = tomorrow (default behavior)            │
│   → Destination + Time pre-filled from template   │
│   → Toast: "Trip to Office created for tomorrow!🚗"│
└─────────────────────────────────────────────────┘
```

---

## 4. User Stories & Acceptance Criteria

### US-1: Save a Trip as Frequent

> **As a** user who just created a trip,
> **I want to** save it as a frequent trip,
> **So that** I can quickly recreate it on future days.

**Acceptance Criteria:**
- [x] After creating a trip, a "Save as Frequent" option appears (toast action or modal prompt)
- [x] User can optionally add a custom label (defaults to destination name)
- [x] The frequent trip is saved to the user's profile in Firestore
- [x] Maximum of **10** frequent trips per user
- [x] Duplicate detection: warn if same destination + time already saved

### US-2: Create a Trip from a Frequent Trip Template

> **As a** daily commuter,
> **I want to** create tomorrow's trip from my saved frequent trips with one tap,
> **So that** I don't have to fill in the form every morning.

**Acceptance Criteria:**
- [x] A "Quick Add" section appears above the trips list (or in the create modal)
- [x] Each frequent trip shows: label/destination, time, and a "+" button
- [x] Tapping "+" creates a new trip document in Firestore with:
  - `destination` from template
  - `time` from template
  - `date` = **tomorrow** (modified from original spec)
  - `createdBy`, `creatorName`, `creatorPhoto` = current user
  - `assignees: []`, `deleted: false`, `completed: false`, `notifiedNew: false`
- [x] Success toast shown, trip appears in the list immediately
- [x] Duplicate guard: if a trip with the same destination + time already exists for that date (by this user), show a confirmation prompt

### US-3: Manage Frequent Trips

> **As a** user,
> **I want to** view, edit, and delete my frequent trips,
> **So that** I can keep my templates up to date.

**Acceptance Criteria:**
- [x] Accessible from Profile Sheet → "My Frequent Trips" section
- [x] List shows all saved frequent trips with label, destination, time
- [x] Delete icon on each item with confirmation
- [x] Tap edit to modify label or time
- [x] Changes persist immediately to Firestore

### US-4: Create a Frequent Trip from Scratch

> **As a** new user,
> **I want to** create a frequent trip template directly (not just by saving an existing trip),
> **So that** I can set up my commute before creating any real trips.

**Acceptance Criteria:**
- [x] "Add Frequent Trip" button in the management screen
- [x] Opens a form with: destination, time, label (optional)
- [x] Saves to Firestore on submit

---

## 5. Data Model

### 5.1 Firestore Collection: `users/{uid}/frequentTrips/{templateId}`

Each frequent trip is stored as a subcollection document under the user:

```javascript
{
  label: "Morning Commute",       // Optional custom label
  destination: "Smart Village",   // Required — matches destinations collection
  time: "08:00",                  // Required — HH:MM 24h format
  createdAt: Timestamp,           // Auto-set on creation
  updatedAt: Timestamp,           // Auto-set on edit
  usageCount: 0,                  // Incremented each time template is used
  lastUsedAt: null                // Timestamp of last use
}
```

### 5.2 Why a Subcollection (not a top-level collection)?

| Approach | Pros | Cons |
|----------|------|------|
| `users/{uid}/frequentTrips` (subcollection) ✅ | Natural ownership, simple security rules, no cross-user queries needed | Slightly more complex path |
| `frequentTrips` (top-level) | Simpler path | Requires `createdBy` field + compound queries, more complex rules |

**Decision:** Subcollection — frequent trips are user-private data, never queried across users.

### 5.3 Updated Firestore Security Rules

```javascript
// Inside match /users/{userId}
match /frequentTrips/{templateId} {
  allow read, write: if request.auth != null && request.auth.uid == userId;
}
```

---

## 6. UX Design

### 6.1 Quick Add Section (Main Screen)

Positioned **above** the trips list, collapsed by default. Shows only when the user has saved frequent trips.

```
┌─────────────────────────────────────────────┐
│ ⚡ Quick Add                    [Manage →]  │
│                                             │
│ ┌──────────────┐  ┌──────────────┐          │
│ │ 🏢 Office    │  │ 🏋️ Gym       │          │
│ │ 8:00 AM      │  │ 6:30 PM      │          │
│ │    [ + Add ] │  │    [ + Add ] │          │
│ └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────┘
```

**Behavior:**
- Horizontal scrollable row of compact cards
- Each card shows: icon/emoji, label (or destination if no label), formatted time
- Tap "+" → creates trip instantly for **tomorrow** (modified default)
- "Manage →" link opens the full management view in the profile sheet

### 6.2 Save Prompt (After Trip Creation)

After successfully creating a new trip, if the destination + time combination doesn't already exist in frequent trips:

```
┌─────────────────────────────────────────────┐
│  ⭐ Save as Frequent Trip?                  │
│                                             │
│  Quickly create this trip again tomorrow    │
│  with a single tap.                         │
│                                             │
│  Label: [ Morning Commute     ]             │
│                                             │
│  [ Not Now ]         [ ⭐ Save ]            │
└─────────────────────────────────────────────┘
```

**Trigger:** Only shown once per unique destination+time. If the user taps "Not Now", don't ask again for the same combo for 7 days (tracked in `localStorage`).

### 6.3 Frequent Trips Management (Profile Sheet)

New section in the profile sheet, between "Settings" and "Sign Out":

```
┌─────────────────────────────────────────────┐
│  ⚡ My Frequent Trips                       │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ 🏢 Morning Commute                 🗑️│    │
│  │    Smart Village · 8:00 AM          │    │
│  └─────────────────────────────────────┘    │
│  ┌─────────────────────────────────────┐    │
│  │ 🏋️ Evening Gym                     🗑️│    │
│  │    Gold's Gym · 6:30 PM             │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  [ + Add Frequent Trip ]                    │
│                                             │
│  10 templates max · 2/10 used              │
└─────────────────────────────────────────────┘
```

---

## 7. Implementation Phases

### Phase 1: Data Layer & Security Rules 🔧
> **Scope:** Firestore schema + security rules
> **Effort:** Small

| Task | Status |
|------|--------|
| Add `frequentTrips` subcollection design to Firestore | ✅ Complete |
| Update `firestore.rules` with read/write rules for `frequentTrips` | ✅ Complete |
| Deploy updated security rules | ✅ Complete |

### Phase 2: Frequent Trips CRUD Module 🔧
> **Scope:** New `js/frequent-trips.js` module
> **Effort:** Medium

| Task | Status |
|------|--------|
| Create `FrequentTrips` IIFE module (matches app architecture) | ✅ Complete |
| Implement `loadTemplates()` — real-time listener on user's `frequentTrips` subcollection | ✅ Complete |
| Implement `saveTemplate({ destination, time, label })` | ✅ Complete |
| Implement `deleteTemplate(templateId)` | ✅ Complete |
| Implement `updateTemplate(templateId, updates)` | ✅ Complete |
| Implement `createTripFromTemplate(templateId)` — creates a trip doc from template data | ✅ Complete |
| Implement duplicate detection (same destination + time for current date) | ✅ Complete |
| Add `<script>` tag to `index.html` | ✅ Complete |
| Wire into `App.init()` lifecycle | ✅ Complete |

### Phase 3: Quick Add UI (Main Screen) 🎨
> **Scope:** Quick Add section above trips list
> **Effort:** Medium

| Task | Status |
|------|--------|
| Add Quick Add HTML section to `index.html` (above `views-container`) | ✅ Complete |
| Style Quick Add cards in `css/styles.css` (horizontal scroll, glassmorphism) | ✅ Complete |
| Render frequent trip cards dynamically from Firestore listener | ✅ Complete |
| Implement one-tap trip creation from template card | ✅ Complete |
| Add loading/disabled state while creating | ✅ Complete |
| Hide Quick Add section when user has no templates | ✅ Complete |
| Add "Manage" link that opens profile sheet to frequent trips section | ✅ Complete |

### Phase 4: Management UI & Save Prompt 🎨
> **Scope:** Profile sheet management + post-creation save prompt
> **Effort:** Medium

| Task | Status |
|------|--------|
| Add "My Frequent Trips" section to profile sheet in `index.html` | ✅ Complete |
| Style management cards with edit/delete actions | ✅ Complete |
| Implement inline edit for label and time | ✅ Complete |
| Implement delete with confirmation | ✅ Complete |
| Add "Add Frequent Trip" button + form (reuse destination autocomplete) | ✅ Complete |
| Show usage count and "10 max" indicator | ✅ Complete |
| Implement "Save as Frequent?" prompt after trip creation | ✅ Complete |
| Add smart suppression (don't re-ask for same combo within 7 days) | ✅ Complete |
| Update service worker cache version | ✅ Complete |
| Deploy to Firebase Hosting | ✅ Complete |

---

## 8. Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| User has 0 frequent trips | Hide Quick Add section entirely |
| User reaches 10-template limit | Disable "Add" button, show tooltip "Remove a template to add more" |
| Template destination was removed from `destinations` collection | Still works — destination is stored as a string, not a reference |
| Creating a trip from template fails (network error) | Show error toast, re-enable the button |
| User creates trip from template but same trip already exists for that date | Show confirmation: "A trip to [dest] at [time] already exists for this date. Create anyway?" |
| Template time is in the past for today | Still allow creation (user may want to backfill or it's for ride coordination) |
| User is logged out | Quick Add section hidden (no user = no templates) |
| Concurrent edits (two devices) | Firestore real-time listener auto-syncs |

---

## 9. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Users don't discover the feature | Low adoption | Medium | Show save prompt after trip creation; add onboarding tooltip |
| Too many templates clutter the UI | Poor UX | Low | Cap at 10; horizontal scroll keeps space compact |
| Quick Add section takes away from the clean main screen | Visual regression | Medium | Collapsible section; minimal height; glassmorphism styling consistent with app |
| Performance impact of additional Firestore listener | Slight latency | Low | Subcollection is per-user (max 10 docs), negligible overhead |

---

## 10. Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Template adoption | 50%+ of active users save ≥1 template within 2 weeks | Firestore query: users with `frequentTrips` subcollection |
| Quick Add usage | 30%+ of daily trips created via Quick Add | Check `usageCount` field across templates |
| Time to create trip | < 2 seconds (from tap to confirmation) | User testing / analytics |
| Reduced manual trip creation | 40% fewer trips created via the full form | Compare pre/post deployment trip creation patterns |

---

## 11. Out of Scope (Future Enhancements)

These are intentionally excluded from v1 but noted for future consideration:

- **Auto-scheduling:** Automatically create trips from templates on weekdays (cron-based)
- **Shared templates:** Allow a driver to share their template with their regular riders
- **Recurring trips:** Full calendar-based recurrence (Mon/Wed/Fri, etc.)
- **Template suggestions:** ML-based — "You've created this trip 5 times, save it?"
- **Batch Quick Add:** Create multiple frequent trips at once (e.g., morning + evening commute)

---

## 12. Implementation Status Tracker

| # | Component | Status | Notes |
|---|-----------|--------|-------|
| 1 | Feature Specification | ✅ Complete | This document |
| 2 | Firestore Data Model | ✅ Complete | `users/{uid}/frequentTrips/{id}` |
| 3 | Security Rules | ✅ Complete | `firestore.rules` updated |
| 4 | `frequent-trips.js` Module | ✅ Complete | Full CRUD + create-from-template + save prompt |
| 5 | Quick Add UI (HTML) | ✅ Complete | Section above trips list in `index.html` |
| 6 | Quick Add UI (CSS) | ✅ Complete | Glassmorphism cards, horizontal scroll |
| 7 | Quick Add Logic (JS) | ✅ Complete | One-tap trip creation w/ loading state |
| 8 | Profile Sheet Management UI | ✅ Complete | View / Edit / Delete templates |
| 9 | "Save as Frequent" Prompt | ✅ Complete | Post trip-creation prompt w/ 7-day suppression |
| 10 | Testing & QA | ✅ Complete | Manual testing on mobile + desktop |
| 11 | Deploy to Production | ✅ Complete | Firebase Hosting + Rules |

---

## 13. Modification Notes

> [!IMPORTANT]
> **Default date changed from "today" to "tomorrow":**
> Per user request, trips created via Quick Add templates now default to **tomorrow's date** instead of today's. This better matches the use case of evening planning — users prepare their commute trips the night before. The toast message and duplicate guard confirmation also reflect "tomorrow" wording.

---

> [!TIP]
> **Next steps:** Deploy updated `firestore.rules` to Firebase, update service worker cache version, then test on mobile + desktop.
