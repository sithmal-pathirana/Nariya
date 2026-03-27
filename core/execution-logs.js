/**
 * Nariya — Execution Logs
 * In-memory storage of matched DNR rules and intercepted requests
 * to display in the extension's execution status view.
 */

const MAX_LOGS = 1000;
let executionLogs = [];

/**
 * Add an execution log entry
 * @param {Object} entry 
 */
export function addLog(entry) {
    executionLogs.unshift({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        timestamp: Date.now(),
        ...entry
    });

    if (executionLogs.length > MAX_LOGS) {
        executionLogs = executionLogs.slice(0, MAX_LOGS);
    }
}

/**
 * Retrieve execution logs
 * @returns {Array} List of latest logs
 */
export function getLogs() {
    return executionLogs;
}

/**
 * Clear execution logs
 */
export function clearLogs() {
    executionLogs = [];
}
