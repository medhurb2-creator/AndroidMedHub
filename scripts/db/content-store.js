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
 */
async function readBlobAt(relativePath, mimeType) {
    const base64 = storage.readBase64(relativePath);
    if (!base64) return null;
    return base64ToBlob(base64, mimeType);
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

    // If the item already exists, remove it first so we start clean.
    // This makes saveItemFiles idempotent — replacing an item never
    // leaves orphaned old files behind.
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
 */
export function itemExists(namespace, collection, id) {
    const dir = layout.itemPath(namespace, collection, id);
    if (!storage.exists(dir) || !storage.isDirectory(dir)) return false;
    const entries = storage.listDirectory(dir);
    return entries.some(e => !e.isDirectory);
}

/**
 * List the files inside an item folder (top level only, not recursive).
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
 * @returns {Promise<Blob|null>}
 */
export async function loadItemFile(namespace, collection, id, filename, mimeType) {
    const path = layout.itemFilePath(namespace, collection, id, filename);
    return readBlobAt(path, mimeType);
}

/**
 * Delete an item's folder and everything inside it.
 */
export function deleteItemFiles(namespace, collection, id) {
    const dir = layout.itemPath(namespace, collection, id);
    if (!storage.exists(dir)) return true;
    return storage.deleteDirectory(dir);
}

/**
 * Delete an entire collection.
 */
export function deleteCollectionFiles(namespace, collection) {
    const dir = layout.collectionPath(namespace, collection);
    if (!storage.exists(dir)) return true;
    return storage.deleteDirectory(dir);
}

/**
 * Delete an entire namespace.
 */
export function deleteNamespaceFiles(namespace) {
    const dir = layout.namespacePath(namespace);
    if (!storage.exists(dir)) return true;
    return storage.deleteDirectory(dir);
}

// ============================================================================
// Sizes
// ============================================================================

export function getItemSize(namespace, collection, id) {
    const dir = layout.itemPath(namespace, collection, id);
    return storage.getDirectorySize(dir);
}

export function getCollectionSize(namespace, collection) {
    const dir = layout.collectionPath(namespace, collection);
    return storage.getDirectorySize(dir);
}

export function getNamespaceSize(namespace) {
    const dir = layout.namespacePath(namespace);
    return storage.getDirectorySize(dir);
}

// ============================================================================
// Path helpers (for FileProvider use by higher layers)
// ============================================================================

/**
 * Absolute path of a file inside an item, or null if it doesn't exist.
 * Used to hand a file to FileProvider without exposing paths to callers.
 */
export function absoluteItemFilePath(namespace, collection, id, filename) {
    const rel = layout.itemFilePath(namespace, collection, id, filename);
    if (!storage.exists(rel)) return null;
    const root = storage.getStorageRoot();
    return root ? `${root}/${rel}` : null;
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
 */
export async function saveBlobAt(relativePath, blob) {
    return writeBlobAt(relativePath, blob);
}

/**
 * Read a blob from an explicit relative path.
 */
export async function loadBlobAt(relativePath, mimeType) {
    return readBlobAt(relativePath, mimeType);
}

/**
 * Delete a file at an explicit relative path.
 */
export function deleteBlobAt(relativePath) {
    return storage.deleteFile(relativePath);
}

/**
 * True if a file exists at the given path.
 */
export function blobExistsAt(relativePath) {
    return storage.exists(relativePath) && storage.isFile(relativePath);
}

/**
 * Size of a file at an explicit relative path. -1 if missing.
 */
export function getBlobSizeAt(relativePath) {
    return storage.getSize(relativePath);
}

// ============================================================================
// Stats
// ============================================================================

/**
 * Disk usage summary. Does NOT include item counts — those come from
 * the DB. This function is purely about bytes on disk.
 *
 * @returns {{
 *   rootType: string,
 *   totalBytes: number,
 *   namespaces: Array<{ name: string, bytes: number }>,
 *   cache: { bytes: number },
 * }}
 */
export function getStorageStats() {
    const rootType = storage.getStorageRootType();

    const namespaces = layout.getRegisteredNamespaces().map(ns => ({
        name:  ns.name,
        bytes: Math.max(0, storage.getDirectorySize(layout.namespacePath(ns.name))),
    }));

    const cacheBytes = Math.max(0, storage.getDirectorySize('cache'));
    const totalBytes = namespaces.reduce((s, n) => s + n.bytes, 0) + cacheBytes;

    return {
        rootType,
        totalBytes,
        namespaces,
        cache: { bytes: cacheBytes },
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