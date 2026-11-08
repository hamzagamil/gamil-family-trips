// Loaded on demand by ensureFunctions() — keeps the Functions SDK out of the main bundle.
import { getFunctions, httpsCallable } from 'firebase/functions';

export function load(app) {
    const functions = getFunctions(app);
    return {
        httpsCallable: (name) => httpsCallable(functions, name)
    };
}
