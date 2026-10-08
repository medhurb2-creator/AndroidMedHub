// scripts/db/app-storage.js

/**
 * Low-level wrapper for window.MedVixStorage.
 *
 * Every method delegates to the native bridge registered in
 * MainActivity.onCreate(). The bridge is synchronous — each call
 * returns a primitive, not a promise. This file mirrors that shape:
 * functions return immediately with the native value, or a documented
 * sentinel on failure.
 *
 * Higher-level modules (content-store.js) wrap these into async
 * operations where the caller benefits from a promise-shaped API.
 *
 * If the native bridge is unavailable (web build, bootstrap failure),
 * every read returns the sentinel (-1, false, "", "[]") and every
 * write returns false. Nothing throws.
 */

function native() {
    return (typeof window !== 'undefined' && window.MedVixStorage) || null;
}

// ============================================================================
// Availability
// ============================================================================

export function isNativeStorageAvailable() {
    const n = native();
    if (!n) return false;
    try { return !!n.isAvailable(); } catch { return false; }
}

// ============================================================================
// Root
// ============================================================================

/**
 * Absolute path of the current write root.
 * Returns null if the bridge is unavailable or no root resolves.
 */
export function getStorageRoot() {
    const n = native();
    if (!n) return null;
    try { return n.getRoot() || null; } catch { return null; }
}

/**
 * "internal" | "external" | "unavailable"
 */
export function getStorageRootType() {
    const n = native();
    if (!n) return 'unavailable';
    try { return n.getRootType() || 'unavailable'; } catch { return 'unavailable'; }
}

/**
 * The user's preferred root for new writes.
 * "internal" | "external"
 */
export function getPreferredRoot() {
    const n = native();
    if (!n) return 'internal';
    try { return n.getPreferredRoot() || 'internal'; } catch { return 'internal'; }
}

/**
 * Set the preferred root. Takes effect immediately for new writes.
 * Existing files are not moved — use relocateToOtherRoot() per file.
 *
 * @returns {boolean} true on success
 */
export function setPreferredRoot(type) {
    const n = native();
    if (!n) return false;
    try { return !!n.setPreferredRoot(type); } catch { return false; }
}

/**
 * Both roots with metadata.
 *
 * @returns {Array<{
 *   type: 'internal'|'external',
 *   path: string,
 *   available: boolean,
 *   freeBytes: number,
 *   isCurrent: boolean,
 * }>}
 */
export function getAvailableRoots() {
    const n = native();
    if (!n) return [];
    try {
        const raw = n.getAvailableRoots();
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

// ============================================================================
// Directories
// ============================================================================

export function createDirectory(path) {
    const n = native();
    if (!n) return false;
    try { return !!n.createDirectory(path); } catch { return false; }
}

export function exists(path) {
    const n = native();
    if (!n) return false;
    try { return !!n.exists(path); } catch { return false; }
}

export function isDirectory(path) {
    const n = native();
    if (!n) return false;
    try { return !!n.isDirectory(path); } catch { return false; }
}

export function isFile(path) {
    const n = native();
    if (!n) return false;
    try { return !!n.isFile(path); } catch { return false; }
}

/**
 * Immediate children of a directory.
 *
 * @returns {Array<{ name: string, isDirectory: boolean, size: number, lastModified: number }>}
 */
export function listDirectory(path) {
    const n = native();
    if (!n) return [];
    try {
        const raw = n.listDirectory(path);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

/**
 * Recursively list every file under `subpath` in the given root.
 * Used for root migration.
 *
 * @param {'internal'|'external'} rootType
 * @param {string} subpath
 * @returns {string[]}  relative paths, forward-slash separated
 */
export function listFilesInRoot(rootType, subpath) {
    const n = native();
    if (!n) return [];
    try {
        const raw = n.listFilesInRoot(rootType, subpath);
        return raw ? JSON.parse(raw) : [];
    } catch { return []; }
}

/**
 * Recursive size of a directory in the current write root.
 * Returns -1 if the path does not exist.
 */
export function getDirectorySize(path) {
    const n = native();
    if (!n) return -1;
    try { return n.getDirectorySize(path); } catch { return -1; }
}

/**
 * Recursive size of a directory in a specific root.
 */
export function getDirectorySizeInRoot(rootType, subpath) {
    const n = native();
    if (!n) return -1;
    try { return n.getDirectorySizeInRoot(rootType, subpath); } catch { return -1; }
}

// ============================================================================
// File inspection
// ============================================================================

export function getSize(path) {
    const n = native();
    if (!n) return -1;
    try { return n.size(path); } catch { return -1; }
}

export function getLastModified(path) {
    const n = native();
    if (!n) return -1;
    try { return n.lastModified(path); } catch { return -1; }
}

// ============================================================================
// Delete
// ============================================================================

export function deleteFile(path) {
    const n = native();
    if (!n) return false;
    try { return !!n.deleteFile(path); } catch { return false; }
}

export function deleteDirectory(path) {
    const n = native();
    if (!n) return false;
    try { return !!n.deleteDirectory(path); } catch { return false; }
}

// ============================================================================
// Move
// ============================================================================

/**
 * Rename or move within the write root. Refuses to overwrite.
 */
export function move(fromPath, toPath) {
    const n = native();
    if (!n) return false;
    try { return !!n.move(fromPath, toPath); } catch { return false; }
}

/**
 * Move a path from whichever root currently holds it to the other.
 * The file's relative path is preserved.
 *
 * Used during root migration. Reads still work in either state, so a
 * partially-completed migration is not a data-loss event.
 */
export function relocateToOtherRoot(relativePath) {
    const n = native();
    if (!n) return false;
    try { return !!n.relocateToOtherRoot(relativePath); } catch { return false; }
}

// ============================================================================
// Binary write / read
// ============================================================================

/**
 * Write Base64 data to a file.
 *
 * append=false → create or truncate
 * append=true  → append (or create if missing)
 *
 * Callers writing large files loop: first chunk with append=false,
 * every subsequent chunk with append=true.
 */
export function writeBase64(path, base64, append = false) {
    const n = native();
    if (!n) return false;
    try { return !!n.writeBase64(path, base64, append); } catch { return false; }
}

/**
 * Read a whole file as Base64. Safe up to ~30 MB.
 */
export function readBase64(path) {
    const n = native();
    if (!n) return '';
    try { return n.readBase64(path) || ''; } catch { return ''; }
}

// ============================================================================
// Text write / read
// ============================================================================

export function writeText(path, text) {
    const n = native();
    if (!n) return false;
    try { return !!n.writeText(path, text); } catch { return false; }
}

export function readText(path) {
    const n = native();
    if (!n) return '';
    try { return n.readText(path) || ''; } catch { return ''; }
}