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
 * ─── BINARY READ PATHS ──────────────────────────────────────────────────────
 *
 * Two ways to get bytes out of a file:
 *
 *   Small files (< ~30 MB)  →  readBase64(path)
 *     Single call, whole file as one Base64 string. Cost is 4× the file
 *     size at peak in the WebView renderer. Simple, but a hard ceiling
 *     sits around 30 MB on most Android devices before the renderer OOMs.
 *
 *   Large files (up to ~200 MB)  →  readBlob(path, mimeType)
 *     Async. Loops over the file in fixed-size chunks via
 *     readBase64Range(), assembling a Blob. Bounds the JS working set
 *     to one chunk at a time; the accumulating Blob spills to disk in
 *     Chromium's blob storage for anything past a few MB. This is the
 *     entry point viewer.js uses for every stored PDF and image.
 *
 * Above ~200 MB the WebView bridge cannot deliver the bytes into JS at
 * all — the renderer exhausts itself during Blob accumulation. Files
 * that large must be served through a local HTTP range endpoint
 * (PdfRangeServer) so the consumer (PDF.js) can stream from it instead
 * of receiving the whole payload. That is a separate native component.
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
 * Read a whole file as Base64.
 *
 * Safe up to ~30 MB. For larger files use readBlob() — this method
 * materializes the entire file into a Java byte[], then a Base64
 * string, then a JS string, then the caller's decoded buffer. Peak
 * cost is 4× the file size.
 */
export function readBase64(path) {
    const n = native();
    if (!n) return '';
    try { return n.readBase64(path) || ''; } catch { return ''; }
}

/**
 * Size of a file in bytes. -1 if the path does not resolve to a file.
 *
 * Pairs with readBase64Range() to drive chunked reads. Most callers
 * should use readBlob() instead of calling this directly.
 */
export function fileSize(path) {
    const n = native();
    if (!n) return -1;
    try { return n.fileSize(path); } catch { return -1; }
}

/**
 * Read a byte range from a file as Base64. "" on failure.
 *
 * Low-level primitive. Prefer readBlob() for whole-file reads — this
 * exists so readBlob can loop over a file without holding more than
 * one chunk in memory at a time.
 *
 * @param {string} path    relative path resolved by the bridge
 * @param {number} offset  byte offset from start of file
 * @param {number} length  number of bytes to read
 * @returns {string}       Base64-encoded bytes, or "" on failure
 */
export function readBase64Range(path, offset, length) {
    const n = native();
    if (!n) return '';
    try { return n.readBase64Range(path, offset, length) || ''; } catch { return ''; }
}

// ============================================================================
// Chunked read (large files)
// ============================================================================

/**
 * Fixed chunk size for chunked reads: 4 MB.
 *
 * Balances three pressures:
 *   • Fewer round trips across the bridge (each bridge call has JNI
 *     and JSON serialization overhead)
 *   • Bounded per-call memory: 4 MB Java byte[] → ~5.3 MB Base64 string
 *     → ~5.3 MB JS string → 4 MB Uint8Array
 *   • Number of `await` yields between chunks (a 200 MB file is 50
 *     chunks; larger chunks mean fewer yields but longer per-chunk
 *     blocking)
 *
 * 4 MB is a middle ground. Smaller values reduce peak heap per call
 * but increase round trips; larger values do the opposite.
 */
const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Read a stored file as a Blob, streaming through the native bridge in
 * fixed-size chunks.
 *
 * This is the entry point every viewer and image renderer should use.
 * It replaces the old readBase64 → atob → Uint8Array → Blob pipeline
 * with one that bounds peak memory regardless of file size.
 *
 * WHY CHUNKED:
 *   The single-call readBase64() loads the whole file into four
 *   simultaneous representations — Java byte[], Java Base64 string, JS
 *   Base64 string, JS Uint8Array — before the caller can even start
 *   building the Blob. Past ~30 MB that exhausts the WebView renderer
 *   heap and the app is OOM-killed by the Android Low Memory Killer.
 *
 *   Chunked reads keep the Java-side allocation at CHUNK_BYTES and the
 *   JS-side working set at one Base64 string + one Uint8Array at a
 *   time. The accumulating `parts[]` array holds decoded chunk bytes
 *   until Blob construction — but Chromium's blob storage spills to
 *   disk for anything past a few MB, so the JS heap does not need to
 *   hold the whole file once new Blob(parts) is called.
 *
 * PEAK MEMORY:
 *   During the loop: 4 MB Uint8Array being built + growing parts[]
 *   array. For a 200 MB file the parts[] array holds 200 MB of decoded
 *   chunks until the final Blob construction; the renderer's overall
 *   headroom determines whether that succeeds. Chromium's blob
 *   spill-to-disk happens during construction, not during accumulation,
 *   so a 200 MB file is at the practical ceiling of this method.
 *
 *   Files past that ceiling need a range-served HTTP URL so the
 *   consumer (PDF.js) can stream and never materialize the whole file.
 *   That is a separate native component (PdfRangeServer) and a
 *   different API than this one.
 *
 * @param {string} path       relative path resolved by the bridge
 * @param {string} mimeType   MIME type for the resulting Blob
 * @returns {Promise<Blob|null>}  null if the file does not exist or the
 *                                bridge is unavailable
 * @throws {Error}            if a chunk read fails mid-stream
 */
export async function readBlob(path, mimeType) {
    const total = fileSize(path);
    if (!(total > 0)) return null;

    const parts = [];

    for (let offset = 0; offset < total; offset += CHUNK_BYTES) {
        const len = Math.min(CHUNK_BYTES, total - offset);
        const b64 = readBase64Range(path, offset, len);

        if (!b64) {
            throw new Error(
                `Chunked read failed at offset ${offset} of ${total} (path: ${path})`,
            );
        }

        // Decode this chunk's Base64 to bytes.
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) {
            bytes[i] = bin.charCodeAt(i);
        }
        parts.push(bytes);

        // Yield to the event loop between chunks so the main thread can
        // paint progress, process input, and stay responsive. Without
        // this, a 200 MB read (50 chunks) blocks the UI for ~250 ms.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return new Blob(parts, { type: mimeType || 'application/octet-stream' });
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