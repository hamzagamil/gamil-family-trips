/* eslint-disable max-len */
/**
 * TripSync Cloud Functions
 *
 * 1. sendTripReminders (scheduled, every 1 min):
 *    a. NEW TRIP BROADCASTS — notifiedNew == false → push ALL users
 *    b. DEPARTURE REMINDERS — trips departing in 28–32 min → push participants
 *
 * 2. sendDriverNotification (callable HTTPS):
 *    Client calls this after a driver joins/is replaced.
 *    Sends FCM pushes to old driver (if replaced) and all riders.
 *
 * 3. deleteAccount (callable HTTPS):
 *    In-app account deletion (App Store 5.1.1(v) / Google Play requirement).
 */

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const db = getFirestore();
const messaging = getMessaging();

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** Format a UTC Date as YYYY-MM-DD */
function toDateStr(date) {
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    const d = String(date.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/**
 * Convert a Cairo wall-clock time (date + HH:MM) to a UTC Date.
 * Uses Intl to resolve the actual offset on that date, so DST is handled
 * automatically (Cairo is UTC+2 in winter, UTC+3 during DST).
 */
function cairoWallTimeToUTC(dateStr, hours, minutes) {
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    // Treat the wall time as if it were UTC to get a candidate instant.
    const candidate = new Date(`${dateStr}T${hh}:${mm}:00Z`);
    // Format that instant into Cairo wall time to discover the offset.
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", {
            timeZone: "Africa/Cairo",
            year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            hour12: false,
        }).formatToParts(candidate).map((p) => [p.type, p.value])
    );
    const cairoAsUTC = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour) % 24,
        Number(parts.minute),
        Number(parts.second)
    );
    const offsetMs = cairoAsUTC - candidate.getTime();
    return new Date(candidate.getTime() - offsetMs);
}

/** Format HH:MM (24h) as h:MM AM/PM */
function formatDisplayTime(timeStr) {
    const [h, m] = (timeStr || "00:00").split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const displayHour = h % 12 || 12;
    return `${displayHour}:${String(m).padStart(2, "0")} ${ampm}`;
}

// ─────────────────────────────────────────────
// Main scheduled function
// ─────────────────────────────────────────────

exports.sendTripReminders = onSchedule(
    {
        schedule: "every 1 minutes",
        timeZone: "Africa/Cairo",
        memory: "256MiB",
    },
    async () => {
        const now = new Date();

        // Run both jobs in parallel
        await Promise.allSettled([
            broadcastNewTrips(),
            sendDepartureReminders(now),
        ]);
    }
);

// ─────────────────────────────────────────────
// Job 1: Broadcast new trips to all users
// ─────────────────────────────────────────────

/**
 * Finds all trips with notifiedNew === false, sends an FCM push to
 * every user on the platform, then flips the flag to avoid resending.
 */
async function broadcastNewTrips() {
    const snapshot = await db
        .collection("trips")
        .where("notifiedNew", "==", false)
        .where("deleted", "==", false)
        .get();

    if (snapshot.empty) return;

    console.log(`[broadcastNewTrips] Found ${snapshot.docs.length} new trip(s) to announce.`);

    // ── STEP 1: Immediately mark all trips as notified BEFORE sending any
    //    pushes.  This prevents the next scheduled invocation (which fires
    //    every 1 min) from picking up the same trips and sending duplicates.
    const flagBatch = db.batch();
    for (const tripDoc of snapshot.docs) {
        flagBatch.update(tripDoc.ref, { notifiedNew: true });
    }
    await flagBatch.commit();
    console.log(`[broadcastNewTrips] Marked ${snapshot.docs.length} trip(s) as notifiedNew (pre-send).`);

    // ── STEP 2: Fetch all users once — reuse across all new trips
    const usersSnapshot = await db.collection("users").get();
    if (usersSnapshot.empty) {
        console.log("[broadcastNewTrips] No users found — skipping.");
        return;
    }

    // ── STEP 3: Send notifications
    for (const tripDoc of snapshot.docs) {
        const trip = tripDoc.data();
        const tripId = tripDoc.id;
        const creatorUid = trip.createdBy || null;
        const creatorName = trip.creatorName || "Someone";
        const destination = trip.destination || "unknown destination";
        const displayTime = formatDisplayTime(trip.time);
        const dateLabel = trip.date || "";

        const notification = {
            title: "🚗 New Trip Available!",
            body: `${creatorName} created a trip to ${destination} on ${dateLabel} at ${displayTime}. Tap to join!`,
        };

        console.log(`[broadcastNewTrips] Announcing trip ${tripId} → ${destination}`);

        // Notify every driver (skip the creator)
        const notifyPromises = [];
        for (const userDoc of usersSnapshot.docs) {
            const uid = userDoc.id;
            const userData = userDoc.data();

            // Only send new-trip alerts to drivers
            if (userData.role !== 'driver') continue;

            // Skip the creator — they don't need to be notified about their own trip
            if (uid === creatorUid) continue;

            // Write an in-app notification
            const notifRef = db
                .collection("users")
                .doc(uid)
                .collection("notifications")
                .doc();

            notifyPromises.push(
                notifRef.set({
                    message: notification.body,
                    tripId,
                    type: "new_trip",
                    timestamp: Timestamp.now(),
                    read: false,
                })
            );

            // Send FCM push to all registered device tokens
            const tokens = userData.fcmTokens || [];
            if (tokens.length > 0) {
                notifyPromises.push(
                    sendPushToUserTokens(uid, tokens, notification, {
                        tripId,
                        type: "new_trip",
                        tag: `new-trip-${tripId}`,
                    })
                );
            }
        }

        await Promise.allSettled(notifyPromises);
    }

    console.log(`[broadcastNewTrips] Done.`);
}

// ─────────────────────────────────────────────
// Job 2: Send 30-minute departure reminders
// ─────────────────────────────────────────────

/**
 * Checks trips departing in the 28–32 minute window and sends
 * reminder pushes to all participants (assignees + driver + creator).
 */
async function sendDepartureReminders(now) {
    const windowMinutes = { min: 28, max: 32 };

    const todayStr = toDateStr(now);
    const tomorrowDate = new Date(now);
    tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
    const tomorrowStr = toDateStr(tomorrowDate);

    for (const dateStr of [todayStr, tomorrowStr]) {
        await processTripsForDate(dateStr, now, windowMinutes);
    }
}

/**
 * Query active trips for a given date and send reminders for those
 * departing within the notification window.
 */
async function processTripsForDate(dateStr, now, windowMinutes) {
    const snapshot = await db
        .collection("trips")
        .where("date", "==", dateStr)
        .where("deleted", "==", false)
        .get();

    if (snapshot.empty) return;

    const batch = db.batch();
    const notificationPromises = [];

    for (const tripDoc of snapshot.docs) {
        const trip = tripDoc.data();

        if (trip.notified30min === true) continue;

        const [hours, minutes] = (trip.time || "00:00").split(":").map(Number);
        // Trip times are Cairo wall-clock; resolve to UTC with DST awareness.
        const tripDateTime = cairoWallTimeToUTC(dateStr, hours, minutes);

        const diffMs = tripDateTime.getTime() - now.getTime();
        const diffMinutes = diffMs / (1000 * 60);

        if (diffMinutes >= windowMinutes.min && diffMinutes <= windowMinutes.max) {
            console.log(`[reminders] Sending 30min reminder for trip ${tripDoc.id} → ${trip.destination} at ${trip.time}`);

            batch.update(tripDoc.ref, { notified30min: true });

            const assigneeUids = (trip.assignees || []).map((a) => a.uid);
            const driverUid = trip.driver ? trip.driver.uid : null;
            const targetUids = new Set([...assigneeUids, trip.createdBy]);
            if (driverUid) targetUids.add(driverUid);

            for (const uid of targetUids) {
                notificationPromises.push(
                    sendReminderToUser(uid, trip, tripDoc.id)
                );
            }
        }
    }

    await batch.commit();
    await Promise.allSettled(notificationPromises);
}

/**
 * Look up a user's FCM tokens and send the 30-min departure reminder.
 */
async function sendReminderToUser(uid, trip, tripId) {
    try {
        const userDoc = await db.collection("users").doc(uid).get();
        if (!userDoc.exists) return;

        const tokens = userDoc.data().fcmTokens || [];
        if (tokens.length === 0) return;

        const displayTime = formatDisplayTime(trip.time);
        const notification = {
            title: "🚗 Trip Reminder — 30 Minutes!",
            body: `Your trip to ${trip.destination} departs at ${displayTime}. Get ready!`,
        };

        // In-app notification
        await db.collection("users").doc(uid).collection("notifications").add({
            message: notification.body,
            tripId,
            type: "reminder",
            timestamp: Timestamp.now(),
            read: false,
        });

        await sendPushToUserTokens(uid, tokens, notification, {
            tripId,
            type: "reminder",
            tag: `reminder-${tripId}`,
        });
    } catch (err) {
        console.error(`[reminders] Error sending to user ${uid}:`, err);
    }
}

// ─────────────────────────────────────────────
// Shared FCM send helper
// ─────────────────────────────────────────────

/**
 * Sends an FCM push notification to all of a user's device tokens.
 * Automatically prunes stale/invalid tokens from Firestore.
 *
 * @param {string} uid
 * @param {string[]} tokens
 * @param {{ title: string, body: string }} notification
 * @param {{ tripId: string, type: string, tag: string }} data
 */
async function sendPushToUserTokens(uid, tokens, notification, data) {
    const invalidTokens = [];
    let successCount = 0;

    console.log(`[FCM] Sending to user ${uid} — ${tokens.length} token(s), type=${data.type}`);

    await Promise.all(
        tokens.map(async (token) => {
            try {
                await messaging.send({
                    token,
                    android: {
                        priority: "high",
                        notification: {
                            title: notification.title,
                            body: notification.body,
                            channelId: ["new_trip"].includes(data.type)
                                ? "new_trips"
                                : ["driver_assigned", "driver_replaced"].includes(data.type)
                                    ? "driver_updates"
                                    : "trip_reminders",
                            sound: "default",
                            priority: "high",
                            defaultVibrateTimings: true,
                        },
                    },
                    apns: {
                        payload: {
                            aps: {
                                alert: { title: notification.title, body: notification.body },
                                sound: "default",
                                badge: 1,
                            },
                        },
                    },
                    webpush: {
                        headers: {
                            // High urgency: delivered promptly even when the phone is idle (Doze)
                            Urgency: "high",
                            // A departure reminder is useless after departure; other messages keep 1 day
                            TTL: data.type === "reminder" ? "1800" : "86400",
                        },
                        // Displayed by our service worker (public/firebase-messaging-sw.js),
                        // which reads title, body and tag from here.
                        notification: {
                            title: notification.title,
                            body: notification.body,
                            icon: "/icon-192.png",
                            badge: "/icon-192.png",
                            tag: data.tag || `notif-${Date.now()}`,
                        },
                        fcmOptions: {
                            link: "https://daily-trip-planner.web.app",
                        },
                    },
                    data: {
                        title: notification.title || "",
                        body: notification.body || "",
                        tripId: data.tripId || "",
                        type: data.type || "general",
                        tag: data.tag || "",
                    },
                });
                successCount++;
            } catch (err) {
                if (
                    err.code === "messaging/registration-token-not-registered" ||
                    err.code === "messaging/invalid-registration-token"
                ) {
                    invalidTokens.push(token);
                    console.warn(`[FCM] Stale token for user ${uid}: ${token.substring(0, 20)}...`);
                } else {
                    console.error(`[FCM] Error sending to token for user ${uid}:`, err.code, err.message);
                }
            }
        })
    );

    console.log(`[FCM] Results for user ${uid}: ${successCount} sent, ${invalidTokens.length} stale, ${tokens.length - successCount - invalidTokens.length} errored`);

    // Prune stale tokens
    if (invalidTokens.length > 0) {
        const validTokens = tokens.filter((t) => !invalidTokens.includes(t));
        await db.collection("users").doc(uid).update({ fcmTokens: validTokens });
        console.log(`[FCM] Removed ${invalidTokens.length} stale token(s) for user ${uid}. ${validTokens.length} remaining.`);
    }
}

// ─────────────────────────────────────────────
// Callable: Send driver-related push notifications
// ─────────────────────────────────────────────

/**
 * Called by the client after a driver joins or is replaced.
 * Expects request.data:
 *   { tripId, type ("driver_assigned"|"driver_replaced"),
 *     oldDriverUid, newDriverName, destination, date, time,
 *     riderUids: string[] }
 */
exports.sendDriverNotification = onCall(
    { region: "us-central1" },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Must be signed in.");
        }

        const {
            tripId,
            type,
            oldDriverUid,
            newDriverName,
            destination,
            date,
            time,
            riderUids = [],
        } = request.data;

        const displayTime = formatDisplayTime(time);
        const notifyPromises = [];

        // ── Notify displaced driver ──────────────────────────────────────
        if (type === "driver_replaced" && oldDriverUid) {
            const msg = `${newDriverName} replaced you as driver for the trip to ${destination} on ${date} at ${displayTime}.`;
            console.log(`[sendDriverNotification] Notifying displaced driver ${oldDriverUid}`);
            notifyPromises.push(
                sendPushToUser(oldDriverUid, {
                    title: "⚠️ You Were Replaced as Driver",
                    body: msg,
                }, { tripId, type: "driver_replaced", tag: `driver-replaced-${tripId}` })
            );
            notifyPromises.push(
                db.collection("users").doc(oldDriverUid).collection("notifications").add({
                    message: msg,
                    tripId,
                    type: "driver_replaced",
                    timestamp: Timestamp.now(),
                    read: false,
                })
            );
        }

        // ── Notify riders that a driver was assigned/changed ─────────────
        if (riderUids.length > 0) {
            const isReplacement = type === "driver_replaced";
            const riderTitle = isReplacement ? "🔄 Driver Changed!" : "🚗 Driver Assigned!";
            const riderMsg = isReplacement
                ? `${newDriverName} is now the new driver for your trip to ${destination} on ${date} at ${displayTime}.`
                : `${newDriverName} is now the driver for your trip to ${destination} on ${date} at ${displayTime}.`;

            for (const uid of riderUids) {
                // Skip the old driver — they get their own separate notification
                if (uid === oldDriverUid) continue;

                console.log(`[sendDriverNotification] Notifying rider/creator ${uid}`);
                notifyPromises.push(
                    sendPushToUser(uid, {
                        title: riderTitle,
                        body: riderMsg,
                    }, { tripId, type: "driver_assigned", tag: `driver-assigned-${tripId}` })
                );
                notifyPromises.push(
                    db.collection("users").doc(uid).collection("notifications").add({
                        message: riderMsg,
                        tripId,
                        type: "driver_assigned",
                        timestamp: Timestamp.now(),
                        read: false,
                    })
                );
            }
        }

        await Promise.allSettled(notifyPromises);
        return { success: true };
    }
);

/**
 * Fetches a user's FCM tokens and sends them a push.
 */
async function sendPushToUser(uid, notification, data) {
    try {
        const userDoc = await db.collection("users").doc(uid).get();
        if (!userDoc.exists) {
            console.warn(`[FCM] sendPushToUser: user ${uid} does not exist in Firestore.`);
            return;
        }
        const tokens = userDoc.data().fcmTokens || [];
        if (tokens.length === 0) {
            console.warn(`[FCM] sendPushToUser: user ${uid} has 0 FCM tokens — cannot send push.`);
            return;
        }
        await sendPushToUserTokens(uid, tokens, notification, data);
    } catch (err) {
        console.error(`[FCM] sendPushToUser error for ${uid}:`, err.message);
    }
}

// ─────────────────────────────────────────────
// Callable: Delete the caller's account and personal data
// ─────────────────────────────────────────────

/**
 * - trips the user created → soft-deleted (deleted: true, as the app's own
 *   "Delete trip" does) and stripped of the creator's name and photo
 * - the user is removed from every trip's assignees / driver slot
 * - users/{uid} and its subcollections (notifications, frequentTrips,
 *   FCM tokens) are deleted
 * - the Firebase Auth account is deleted
 */
exports.deleteAccount = onCall(
    { region: "us-central1", timeoutSeconds: 300 },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Must be signed in.");
        }
        const uid = request.auth.uid;
        console.log(`[deleteAccount] Deleting account ${uid}`);

        const writer = db.bulkWriter();

        // assignees is an array of objects, so it can't be queried by uid —
        // scan trips, reading only the fields we need.
        const trips = await db.collection("trips")
            .select("createdBy", "assignees", "driver", "deleted")
            .get();

        let created = 0;
        let joined = 0;
        trips.forEach((snap) => {
            const t = snap.data();
            const update = {};

            if (t.createdBy === uid) {
                created++;
                update.creatorName = "Deleted user";
                update.creatorPhoto = FieldValue.delete();
                if (!t.deleted) {
                    update.deleted = true;
                    update.deletedAt = Timestamp.now();
                }
            }

            const assignees = Array.isArray(t.assignees) ? t.assignees : [];
            if (assignees.some((a) => a && a.uid === uid)) {
                update.assignees = assignees.filter((a) => !a || a.uid !== uid);
            }
            if (t.driver && t.driver.uid === uid) {
                update.driver = FieldValue.delete();
            }

            if (update.assignees || update.driver) joined++;
            if (Object.keys(update).length > 0) writer.update(snap.ref, update);
        });

        await writer.close();
        await db.recursiveDelete(db.collection("users").doc(uid));

        try {
            await getAuth().deleteUser(uid);
        } catch (err) {
            if (err.code !== "auth/user-not-found") throw err;
        }

        console.log(`[deleteAccount] Done for ${uid}: ${created} created trip(s) removed, ${joined} trip membership(s) removed`);
        return { ok: true };
    }
);
