/**
 * Nariya — Rule file mirror
 * Keeps a copy of the rules in `nariya_rules.json` in the place the user
 * picked under Settings → Storage Provider:
 *   - native: a folder on disk (File System Access API; the directory handle
 *     is kept in IndexedDB so the service worker can write to it)
 *   - gdrive: a file in the user's Google Drive (drive.file scope)
 * The file holds the same JSON as "Export rules", so it can be imported
 * anywhere. Writes are debounced; the last result is kept for the UI.
 */

export const RULES_FILE_NAME = 'nariya_rules.json';
const STATUS_KEY = 'nariya_mirror_status';
const DB_NAME = 'nariya';
const DB_STORE = 'handles';
const HANDLE_KEY = 'rulesDirectory';
const DEBOUNCE_MS = 800;
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

// ─── Directory handle persistence (IndexedDB) ───────────────────

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idb(mode, fn) {
    const db = await openDb();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, mode);
            const req = fn(tx.objectStore(DB_STORE));
            tx.oncomplete = () => resolve(req.result);
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

export function saveDirectoryHandle(handle) {
    return idb('readwrite', store => store.put(handle, HANDLE_KEY));
}

export function getDirectoryHandle() {
    return idb('readonly', store => store.get(HANDLE_KEY));
}

/**
 * Read rules already in the folder's nariya_rules.json (or null)
 * @param {FileSystemDirectoryHandle} dir
 */
export async function readRulesFromDirectory(dir) {
    try {
        const fileHandle = await dir.getFileHandle(RULES_FILE_NAME);
        const text = await (await fileHandle.getFile()).text();
        const data = JSON.parse(text);
        return Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

// ─── Writers ─────────────────────────────────────────────────────

async function writeNative(json) {
    const dir = await getDirectoryHandle();
    if (!dir) throw new Error('No folder selected');
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        const err = new Error('Folder access needs to be granted again');
        err.needsPermission = true;
        throw err;
    }
    const fileHandle = await dir.getFileHandle(RULES_FILE_NAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(json);
    await writable.close();
}

function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, (token) => {
            if (chrome.runtime.lastError || !token) {
                return reject(new Error(chrome.runtime.lastError?.message || 'Not signed in to Google Drive'));
            }
            resolve(typeof token === 'string' ? token : token.token);
        });
    });
}

/**
 * Upload the rules JSON into the Drive file (retries once with a fresh token)
 * @param {string} json
 * @param {string} fileId
 * @param {{ fetchImpl?: Function, getToken?: Function, dropToken?: Function }} deps
 */
export async function writeDrive(json, fileId, deps = {}) {
    const fetchImpl = deps.fetchImpl || fetch;
    const getToken = deps.getToken || (() => getAuthToken(false));
    const dropToken = deps.dropToken || ((token) => new Promise(r => chrome.identity.removeCachedAuthToken({ token }, r)));
    if (!fileId) throw new Error('Google Drive is not connected');

    for (let attempt = 0; attempt < 2; attempt++) {
        const token = await getToken();
        const res = await fetchImpl(`${DRIVE_UPLOAD}/${encodeURIComponent(fileId)}?uploadType=media`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: json
        });
        if (res.ok) return;
        if (res.status === 401 && attempt === 0) {
            await dropToken(token);
            continue;
        }
        throw new Error(`Google Drive returned HTTP ${res.status}`);
    }
}

/**
 * Read the rules currently stored in the Drive file (or null)
 */
export async function readDriveRules(fileId, token, fetchImpl = fetch) {
    const res = await fetchImpl(`${DRIVE_FILES}/${encodeURIComponent(fileId)}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    try {
        const data = JSON.parse(await res.text());
        return Array.isArray(data) ? data : null;
    } catch {
        return null;
    }
}

// ─── Mirror ──────────────────────────────────────────────────────

let pending = null;
let timer = null;

export async function getMirrorStatus() {
    const result = await chrome.storage.local.get(STATUS_KEY);
    return result[STATUS_KEY] || null;
}

/**
 * Write the rules to the configured file now
 * @param {Array} rules
 * @param {Object} settings
 * @returns {Promise<Object|null>} status, or null when no mirror is configured
 */
export async function mirrorNow(rules, settings) {
    const engine = settings.enableCloudSync ? 'browser' : (settings.storageEngine || 'browser');
    if (engine !== 'native' && engine !== 'gdrive') return null;

    const json = JSON.stringify(rules, null, 2);
    let status;
    try {
        if (engine === 'native') await writeNative(json);
        else await writeDrive(json, settings.gdriveFileId);
        status = { engine, ok: true, at: Date.now(), count: rules.length };
    } catch (e) {
        status = { engine, ok: false, at: Date.now(), error: e.message, needsPermission: !!e.needsPermission };
        console.warn(`[Nariya] Could not write ${RULES_FILE_NAME} (${engine}):`, e.message);
    }
    await chrome.storage.local.set({ [STATUS_KEY]: status });
    return status;
}

/**
 * Debounced mirror after a rule change
 */
export function mirrorRules(rules, settings) {
    pending = { rules, settings };
    clearTimeout(timer);
    timer = setTimeout(() => {
        const { rules: r, settings: s } = pending;
        pending = null;
        mirrorNow(r, s);
    }, DEBOUNCE_MS);
}
