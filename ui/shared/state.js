/**
 * Nariya — Simple Reactive State Bus
 * Lightweight event emitter for cross-component communication.
 */

const listeners = {};

/**
 * Subscribe to a state event.
 * @param {string} event - Event name
 * @param {Function} callback - Handler function
 * @returns {Function} Unsubscribe function
 */
export function subscribeState(event, callback) {
    if (!listeners[event]) listeners[event] = [];
    listeners[event].push(callback);
    return () => {
        listeners[event] = listeners[event].filter(cb => cb !== callback);
    };
}

/**
 * Emit a state event to all subscribers.
 * @param {string} event - Event name
 * @param {*} data - Payload
 */
export function emitState(event, data) {
    if (!listeners[event]) return;
    for (const cb of listeners[event]) {
        try {
            cb(data);
        } catch (e) {
            console.warn(`[Nariya State] Error in listener for "${event}":`, e);
        }
    }
}
