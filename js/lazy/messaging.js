// Loaded on demand by ensureMessaging() — keeps the Messaging SDK out of the main bundle.
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging';

export async function load(app) {
    if (!(await isSupported())) {
        console.warn('Firebase Messaging not supported in this browser.');
        return null;
    }
    const messaging = getMessaging(app);
    return {
        getToken: (options) => getToken(messaging, options),
        onMessage: (handler) => onMessage(messaging, handler)
    };
}
