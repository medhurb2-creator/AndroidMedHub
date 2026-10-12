// scripts/db/content-store.js

/**
 * Content store — item-level file CRUD.
 * ============================================================================
 *
 * Manages FILES on disk. Nothing in this module touches IndexedDB, reads
 * the user record, or knows what a "textbook" is. It receives a
 * (namespace, collection, id) triple, writes or reads the corresponding
 * folder, and returns results. Metadata is db.js's responsibility.
 *
 * That separation is deliberate:
 *
 *   • It keeps the dependency graph acyclic:
 *       db.js → content-store.js → app-storage.js + layout.js
 *
 *   • It lets db.js remain the single point of metadata truth for the
 *     47 files that already call db.saveFileBlob / db.getFileBlob /
 *     db.saveThumbnailBlob / db.savePublicAsset. Those callers do not
 *     change. Internally, db.js routes their blobs here.
 *
 * ─── STORAGE ROOTS ──────────────────────────────────────────────────────────
 *
 * Three roots can exist: 'internal', 'external' (emulated), and
 * 'sdcard' (removable). The user picks which one NEW writes go to; the
 * native layer's resolveRead() searches all three, so switching the
 * preference never strands an existing file.
 *
 * This module is deliberately root-agnostic. Every function operates on
 * a RELATIVE path. Which root a file currently lives in is an
 * implementation detail of app-storage.js and the native bridge — it
 * only surfaces when the caller asks (itemRootOf, migrateContentToRoot)
 * or when a size is computed across all roots.
 *
 * The one place root-awareness leaks: writes always land in the
 * current write root (getStorageRootType()). If the user has selected
 * 'sdcard' and ejects the card mid-write, subsequent chunks of the same
 * file silently land in the fallback root ('internal'). Callers writing
 * large files across a card-removal window should check
 * storage.getStorageRootType() between chunks and abort on change.
 *
 * ─── WHAT AN "ITEM" IS ──────────────────────────────────────────────────────
 *
 * An item is a folder on disk. It can hold any number of files. The
 * caller decides which filenames go inside:
 *
 *   saveItemFiles({
 *     namespace:  'resources',
 *     collection: 'textbooks',
 *     id:         'robins-pathology',
 *     files: {
 *       'document.pdf':  pdfBlob,
 *       'cover.jpg':     coverBlob,
 *       'meta.json':     metaBlob,
 *     },
 *   });
 *
 * Results on disk:
 *
 *   content/resources/textbooks/robins-pathology/
 *   ├── document.pdf
 *   ├── cover.jpg
 *   └── meta.json
 *
 * The (namespace, collection, id) triple is the DB key. It is also the
 * on-disk path. There is no separate mapping table.
 *
 * ─── WHY FOLDER-PER-ITEM ────────────────────────────────────────────────────
 *
 *   • Multi-file items are natural (model + textures + thumbnail).
 *   • Delete is one folder removal — atomic.
 *   • Adding a file to an existing item is another put() in the folder.
 *   • Filename collisions are impossible — the item ID namespaces them.
 *
 * ─── LARGE FILES ────────────────────────────────────────────────────────────
 *
 * writeBlobAt() splits a blob into 512 KB slices, base64-encodes each,
 * and appends through the native bridge. Peak JS heap during a write is
 * under ~2 MB regardless of the file's total size. A 500 MB PDF writes
 * without ever materialising the whole thing in memory.
 *
 * ─── FAILURE BEHAVIOUR ──────────────────────────────────────────────────────
 *
 * If any file in saveItemFiles() fails, the entire item folder is
 * deleted before returning. Partial items never appear on disk. Callers
 * see { ok: false } and can retry or surface the error.
 *
 * If the item already existed — possibly on a different root than the
 * current write root — the old copy is removed (via resolveRead, which
 * finds it wherever it is) before the new one is written. The new copy
 * always lands in the current write root.
 */

import * as storage from './app-storage.js';
import * as layout  from './layout.js';

// 512 KB of raw bytes per writeBase64 call. Base64-encodes to ~700 KB
// per call — a balance between fewer bridge round-trips and smaller
// transient allocations in both Java and JS.
const WRITE_CHUNK_BYTES = 512 * 1024;

// ============================================================================
// Internal: blob ↔ base64, chunked write, whole read
// ============================================================================

function blobSliceToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const comma = result.indexOf(',');
            resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.onerror = () => reject(reader.error || new Error('FileReader error'));
        reader.readAsDataURL(blob);
    });
}

function base64ToBlob(base64, mimeType) {
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mimeType || 'application/octet-stream' });
    } catch {
        return null;
    }
}

/**
 * Write a blob to disk at the given relative path.
 *
 * Splits into WRITE_CHUNK_BYTES slices. First slice replaces the file
 * (append=false); subsequent slices append. Never holds more than one
 * chunk in memory at a time.
 *
 * Writes to the current write root. If the preferred root becomes
 * unavailable mid-write, later chunks land in the fallback root and the
 * file is split across two volumes — see the module docstring. The
 * caller is responsible for aborting a large write if the root changes.
 *
 * @returns {Promise<boolean>}
 */
async function writeBlobAt(relativePath, blob) {
    if (!blob) return false;

    const total = blob.size;

    if (total === 0) {
        // Zero-byte file — create it so exists() returns true.
        return storage.writeBase64(relativePath, '', false);
    }

    let offset = 0;
    let first = true;

    while (offset < total) {
        const end = Math.min(offset + WRITE_CHUNK_BYTES, total);
        const slice = blob.slice(offset, end);

        let base64;
        try {
            base64 = await blobSliceToBase64(slice);
        } catch {
            return false;
        }

        const ok = storage.writeBase64(relativePath, base64, !first);
        if (!ok) return false;

        first = false;
        offset = end;
    }

    return true;
}

/**
 * Read a whole file back as a Blob. Safe up to ~30 MB — above that the
 * base64 string and its decoded copy both live in memory at once.
 *
 * Searches all three roots via the native layer.
 */
async function readBlobAt(relativePath, mimeType) {
    const base64 = storage.readBase64(relativePath);
    if (!base64) return null;
    return base64ToBlob(base64, mimeType);
}

/**
 * Sum the size of a path across every available root.
 *
 * A file or folder normally lives in exactly one root; summing across
 * roots is safe because moveFile() removes the source after verifying
 * the destination. During a partial migration a whole namespace can be
 * split across two roots, which is exactly the case this helper is
 * meant to handle correctly.
 *
 * Returns -1 if the path exists in no available root.
 */
function sizeAcrossRoots(relPath) {
    const roots = storage.getAvailableRoots();
    let total = 0;
    let any = false;
    for (const r of roots) {
        if (!r.available) continue;
        const size = storage.getDirectorySizeInRoot(r.type, relPath);
        if (size >= 0) {
            total += size;
            any = true;
        }
    }
    return any ? total : -1;
}

// ============================================================================
// Item operations
// ============================================================================

/**
 * Save or replace the files for an item.
 *
 * @param {Object} opts
 *   {
 *     namespace:  string,   // must be registered
 *     collection: string,
 *     id:         string,
 *     files:      { [filename: string]: Blob },
 *   }
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   itemPath?: string,
 *   files?: Array<{ name: string, size: number, mimeType: string }>,
 *   totalSize?: number,
 *   error?: string,
 * }>}
 */
export async function saveItemFiles(opts) {
    const { namespace, collection, id, files } = opts || {};

    if (!namespace || !collection || !id) {
        return { ok: false, error: 'namespace, collection, and id are required' };
    }
    if (!layout.isNamespaceRegistered(namespace)) {
        return { ok: false, error: `namespace "${namespace}" is not registered` };
    }
    if (!files || typeof files !== 'object' || Object.keys(files).length === 0) {
        return { ok: false, error: 'files must be a non-empty object' };
    }
    if (!storage.isNativeStorageAvailable()) {
        return { ok: false, error: 'native storage unavailable' };
    }

    const itemDir = layout.itemPath(namespace, collection, id);

    // If the item already exists — possibly on a different root than the
    // current write root — remove it first so we start clean. This makes
    // saveItemFiles idempotent: replacing an item never leaves orphaned
    // old files behind, and it never leaves a split between roots.
    if (storage.exists(itemDir)) {
        storage.deleteDirectory(itemDir);
    }

    if (!storage.createDirectory(itemDir)) {
        return { ok: false, error: 'could not create item directory' };
    }

    const writtenFiles = [];
    let totalSize = 0;

    for (const [filename, blob] of Object.entries(files)) {
        if (!blob) continue;

        const filePath = `${itemDir}/${filename}`;
        const ok = await writeBlobAt(filePath, blob);

        if (!ok) {
            // Roll back: delete the whole item folder.
            storage.deleteDirectory(itemDir);
            return { ok: false, error: `write failed for ${filename}` };
        }

        writtenFiles.push({
            name:     filename,
            size:     blob.size,
            mimeType: blob.type || 'application/octet-stream',
        });
        totalSize += blob.size;
    }

    if (writtenFiles.length === 0) {
        storage.deleteDirectory(itemDir);
        return { ok: false, error: 'no valid blobs in files' };
    }

    return { ok: true, itemPath: itemDir, files: writtenFiles, totalSize };
}

/**
 * True if the item folder exists and holds at least one file.
 * Searches all three roots.
 */
export function itemExists(namespace, collection, id) {
    const dir = layout.itemPath(namespace, collection, id);
    if (!storage.exists(dir) || !storage.isDirectory(dir)) return false;
    const entries = storage.listDirectory(dir);
    return entries.some(e => !e.isDirectory);
}

/**
 * Which root currently holds this item, or null if it is not on disk.
 *
 * Returns 'internal' | 'external' | 'sdcard' | null.
 *
 * An item lives in exactly one root. During a migration in progress,
 * that root is wherever the last successful relocateToRoot() put it.
 *
 * @returns {'internal'|'external'|'sdcard'|null}
 */
export function itemRootOf(namespace, collection, id) {
    const dir = layout.itemPath(namespace, collection, id);
    const roots = storage.getAvailableRoots();
    for (const r of roots) {
        if (!r.available) continue;
        if (storage.fileInRoot(dir, r.type)) return r.type;
    }
    return null;
}

/**
 * List the files inside an item folder (top level only, not recursive).
 *
 * Uses the write root for enumeration. In the common case the item
 * lives in the write root. If the item lives elsewhere (typically after
 * a preference change without migration), the write-root scan misses it
 * and this returns []. Callers that need a root-independent listing
 * should use listItemFilesInRoot with itemRootOf().
 *
 * @returns {Array<{ name: string, size: number, lastModified: number }>}
 */
export function listItemFiles(namespace, collection, id) {
    const dir = layout.itemPath(namespace, collection, id);
    if (!storage.exists(dir) || !storage.isDirectory(dir)) return [];
    return storage.listDirectory(dir)
        .filter(e => !e.isDirectory)
        .map(e => ({
            name:         e.name,
            size:         e.size || 0,
            lastModified: e.lastModified || 0,
        }));
}

/**
 * Read a single file from an item.
 *
 * Searches all three roots via the native layer.
 *
 * @returns {Promise<Blob|null>}
 */
export async function loadItemFile(namespace, collection, id, filename, mimeType) {
    const path = layout.itemFilePath(namespace, collection, id, filename);
    return readBlobAt(path, mimeType);
}

/**
 * Delete an item's folder and everything inside it.
 *
 * The native deleteDirectory() resolves via resolveRead, so this finds
 * and removes the item in whichever root currently holds it.
 */
export function deleteItemFiles(namespace, collection, id) {
    const dir = layout.itemPath(namespace, collection, id);
    if (!storage.exists(dir)) return true;
    return storage.deleteDirectory(dir);
}

/**
 * Delete an entire collection. Searches all three roots.
 */
export function deleteCollectionFiles(namespace, collection) {
    const dir = layout.collectionPath(namespace, collection);
    if (!storage.exists(dir)) return true;
    return storage.deleteDirectory(dir);
}

/**
 * Delete an entire namespace. Searches all three roots.
 */
export function deleteNamespaceFiles(namespace) {
    const dir = layout.namespacePath(namespace);
    if (!storage.exists(dir)) return true;
    return storage.deleteDirectory(dir);
}

// ============================================================================
// Sizes
//
// All three size functions sum across every available root. A partial
// migration can leave an item, collection, or namespace split between
// two roots; the sum is the honest answer.
// ============================================================================

/**
 * Total bytes on disk for this item, across all roots.
 * Returns -1 if the item is not on disk in any root.
 */
export function getItemSize(namespace, collection, id) {
    return sizeAcrossRoots(layout.itemPath(namespace, collection, id));
}

/**
 * Total bytes on disk for this collection, across all roots.
 * Returns -1 if the collection is not on disk in any root.
 */
export function getCollectionSize(namespace, collection) {
    return sizeAcrossRoots(layout.collectionPath(namespace, collection));
}

/**
 * Total bytes on disk for this namespace, across all roots.
 * Returns -1 if the namespace is not on disk in any root.
 */
export function getNamespaceSize(namespace) {
    return sizeAcrossRoots(layout.namespacePath(namespace));
}

// ============================================================================
// Path helpers (for FileProvider use by higher layers)
// ============================================================================

/**
 * Absolute path of a file inside an item, or null if it doesn't exist.
 *
 * Used to hand a file to FileProvider without exposing paths to
 * callers. Resolves the item to its actual root first — the file may
 * not be in the write root (e.g. user selected internal but the item
 * was downloaded to the SD card).
 *
 * Do not persist the returned path. It embeds the current mount point
 * of a removable volume and will become stale when the card is
 * ejected, reinserted, or mounted under a different device node.
 */
export function absoluteItemFilePath(namespace, collection, id, filename) {
    const rel = layout.itemFilePath(namespace, collection, id, filename);
    if (!storage.exists(rel)) return null;

    const roots = storage.getAvailableRoots();
    for (const r of roots) {
        if (!r.available) continue;
        if (storage.fileInRoot(rel, r.type)) {
            return `${r.path}/${rel}`;
        }
    }
    return null;
}

// ============================================================================
// Low-level blob passthrough
//
// For db.js's non-item storage needs: thumbnails keyed by resource ID,
// cached public assets, manifests. These are single files at known
// relative paths — no folder-per-item wrapping needed.
// ============================================================================

/**
 * Write a blob at an explicit relative path.
 * Lands in the current write root.
 */
export async function saveBlobAt(relativePath, blob) {
    return writeBlobAt(relativePath, blob);
}

/**
 * Read a blob from an explicit relative path.
 * Searches all three roots.
 */
export async function loadBlobAt(relativePath, mimeType) {
    return readBlobAt(relativePath, mimeType);
}

/**
 * Delete a file at an explicit relative path.
 * Searches all three roots.
 */
export function deleteBlobAt(relativePath) {
    return storage.deleteFile(relativePath);
}

/**
 * True if a file exists at the given path in any available root.
 */
export function blobExistsAt(relativePath) {
    return storage.exists(relativePath) && storage.isFile(relativePath);
}

/**
 * Size of a file at an explicit relative path. -1 if missing.
 * Searches all three roots.
 */
export function getBlobSizeAt(relativePath) {
    return storage.getSize(relativePath);
}

// ============================================================================
// Migration
// ============================================================================

/**
 * Move all content from every non-target root to the target root.
 *
 * Idempotent: files already in the target are skipped via fileInRoot().
 * A migration interrupted by a crash, a process kill, or an ejected SD
 * card can simply be run again — it re-scans, skips completed work, and
 * retries whatever is left. No resume marker is needed.
 *
 * Safety:
 *   • The preference is NOT changed here. The caller should call
 *     storage.setPreferredRoot(target) only after this returns ok.
 *   • The source is deleted only after the destination copy has been
 *     verified by size in the native moveFile() helper. A verification
 *     failure leaves the source intact and the file is reported in
 *     `failed`.
 *   • Nothing under 'system/' or 'cache/' is touched. Cache is
 *     regenerable and should be cleared separately if space is
 *     needed; system is tiny and belongs in whichever root is
 *     currently active.
 *
 * Cost: one native listFilesInRoot() call per source root, then three
 * native calls per file (fileInRoot, relocateToRoot, and — for the
 * size returned to the caller — getSize). For a library of N files
 * this is roughly 3N native calls. On a slow SD card expect real
 * wall-clock time; the yields between files keep the UI responsive.
 *
 * @param {'internal'|'external'|'sdcard'} targetRootType
 * @param {Object} [options]
 * @param {(progress: {
 *   phase: 'scan'|'migrate'|'skip'|'fail'|'complete',
 *   rel?: string,
 *   sourceRoot?: string,
 *   targetRoot: string,
 *   bytes?: number,
 *   index?: number,
 *   total?: number,
 *   migrated?: number,
 *   skipped?: number,
 *   failed?: number,
 * }) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @param {string} [options.subpath='content']
 *   Subtree to migrate. Defaults to 'content'. Pass a narrower path
 *   (e.g. 'content/resources') to migrate a subset.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   targetRoot: string,
 *   migrated: string[],
 *   skipped: string[],
 *   failed: Array<{ rel: string, sourceRoot: string }>,
 *   totalBytes: number,
 *   aborted: boolean,
 *   error?: string,
 * }>}
 */
export async function migrateContentToRoot(targetRootType, options = {}) {
    const {
        onProgress = null,
        signal = null,
        subpath = 'content',
    } = options || {};

    const result = {
        ok: false,
        targetRoot: targetRootType,
        migrated: [],
        skipped: [],
        failed: [],
        totalBytes: 0,
        aborted: false,
    };

    if (!storage.isNativeStorageAvailable()) {
        result.error = 'native storage unavailable';
        return result;
    }
    if (!['internal', 'external', 'sdcard'].includes(targetRootType)) {
        result.error = `unknown target root "${targetRootType}"`;
        return result;
    }

    const roots = storage.getAvailableRoots();
    const target = roots.find(r => r.type === targetRootType);
    if (!target || !target.available) {
        result.error = `target root "${targetRootType}" is not available`;
        return result;
    }

    const sourceRoots = roots
        .filter(r => r.available && r.type !== targetRootType)
        .map(r => r.type);

    if (sourceRoots.length === 0) {
        // Nothing else to migrate from. Not an error — the target is
        // already the only available root.
        result.ok = true;
        if (onProgress) {
            onProgress({ phase: 'complete', targetRoot: targetRootType,
                         migrated: 0, skipped: 0, failed: 0 });
        }
        return result;
    }

    // Scan phase: enumerate every file under `subpath` in each source.
    // Re-enumerate fresh — do not trust a cached list, since a previous
    // run may have moved some files already.
    const work = []; // { rel, sourceRoot }
    for (const sourceRoot of sourceRoots) {
        if (onProgress) onProgress({ phase: 'scan', sourceRoot, targetRoot: targetRootType });
        const files = storage.listFilesInRoot(sourceRoot, subpath);
        for (const rel of files) {
            work.push({ rel, sourceRoot });
        }
    }

    const total = work.length;
    let index = 0;

    for (const { rel, sourceRoot } of work) {
        if (signal && signal.aborted) {
            result.aborted = true;
            break;
        }

        index++;

        // Skip files already in the target. This is the idempotency
        // that makes the whole function resumable.
        if (storage.fileInRoot(rel, targetRootType)) {
            result.skipped.push(rel);
            if (onProgress) {
                onProgress({
                    phase: 'skip', rel, sourceRoot, targetRoot: targetRootType,
                    index, total,
                    migrated: result.migrated.length,
                    skipped: result.skipped.length,
                    failed: result.failed.length,
                });
            }
            await new Promise(r => setTimeout(r, 0));
            continue;
        }

        const bytesBefore = storage.getSize(rel);

        const ok = storage.relocateToRoot(rel, targetRootType);

        if (ok) {
            result.migrated.push(rel);
            if (bytesBefore > 0) result.totalBytes += bytesBefore;
            if (onProgress) {
                onProgress({
                    phase: 'migrate', rel, sourceRoot, targetRoot: targetRootType,
                    bytes: bytesBefore > 0 ? bytesBefore : undefined,
                    index, total,
                    migrated: result.migrated.length,
                    skipped: result.skipped.length,
                    failed: result.failed.length,
                });
            }
        } else {
            result.failed.push({ rel, sourceRoot });
            if (onProgress) {
                onProgress({
                    phase: 'fail', rel, sourceRoot, targetRoot: targetRootType,
                    index, total,
                    migrated: result.migrated.length,
                    skipped: result.skipped.length,
                    failed: result.failed.length,
                });
            }
        }

        // Yield so the UI can repaint and so an AbortSignal checked at
        // the top of the loop actually gets a chance to fire.
        await new Promise(r => setTimeout(r, 0));
    }

    result.ok = result.failed.length === 0 && !result.aborted;

    if (onProgress) {
        onProgress({
            phase: 'complete',
            targetRoot: targetRootType,
            index, total,
            migrated: result.migrated.length,
            skipped: result.skipped.length,
            failed: result.failed.length,
        });
    }

    return result;
}

// ============================================================================
// Stats
// ============================================================================

/**
 * Disk usage summary.
 *
 * Returns both a per-namespace breakdown of the WRITE root (matching
 * the previous shape) and a per-root breakdown that sums content
 * across all available roots. The per-root view is what callers should
 * use once files can live in more than one place — for example while a
 * migration is in progress, or after a preference change without
 * migration.
 *
 * `totalBytes` and `namespaces` continue to describe the write root
 * only, for backwards compatibility with existing callers.
 *
 * @returns {{
 *   rootType: string,          // the actual write root
 *   preferredRoot: string,     // the user's stored preference
 *   totalBytes: number,        // write root only
 *   namespaces: Array<{ name: string, bytes: number }>,  // write root only
 *   cache: { bytes: number },  // write root only
 *   perRoot: Array<{
 *     type: 'internal'|'external'|'sdcard',
 *     removable: boolean,
 *     isCurrent: boolean,
 *     freeBytes: number,
 *     contentBytes: number,    // sums all namespaces in this root
 *   }>,
 * }}
 */
export function getStorageStats() {
    const rootType      = storage.getStorageRootType();
    const preferredRoot = storage.getPreferredRoot();

    const namespaces = layout.getRegisteredNamespaces().map(ns => ({
        name:  ns.name,
        bytes: Math.max(0, storage.getDirectorySize(layout.namespacePath(ns.name))),
    }));

    const cacheBytes = Math.max(0, storage.getDirectorySize('cache'));
    const totalBytes = namespaces.reduce((s, n) => s + n.bytes, 0) + cacheBytes;

    const roots = storage.getAvailableRoots();
    const perRoot = roots.map(r => ({
        type:         r.type,
        removable:    !!r.removable,
        isCurrent:    !!r.isCurrent,
        freeBytes:    r.freeBytes || 0,
        contentBytes: r.available
            ? Math.max(0, storage.getDirectorySizeInRoot(r.type, 'content'))
            : 0,
    }));

    return {
        rootType,
        preferredRoot,
        totalBytes,
        namespaces,
        cache: { bytes: cacheBytes },
        perRoot,
    };
}

// ============================================================================
// Cache
// ============================================================================

/**
 * Wipe the entire cache directory. Safe at any time — thumbnails and
 * manifests are regenerable.
 */
export function clearCache() {
    return storage.deleteDirectory('cache');
}

/**
 * Recreate the cache subtree after a clear. Call if a caller wipes the
 * cache and then needs to write a fresh thumbnail.
 */
export function ensureCacheDirectories() {
    storage.createDirectory('cache');
    storage.createDirectory('cache/thumbnails');
    storage.createDirectory('cache/manifests');
    storage.createDirectory('cache/tmp');
}