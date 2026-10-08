// scripts/db/layout.js

/**
 * Content layout registry.
 * ============================================================================
 *
 * Everything about where files live is derived from this module. There
 * is no switch(contentType) anywhere in the app — the namespace and
 * collection strings carry the type, and the path is computed by
 * concatenation.
 *
 * To add a new content type in the future, either:
 *   • Register a new namespace, or
 *   • Reuse an existing namespace with a new collection name
 *
 * Neither requires editing the path-computation logic below.
 *
 * ─── ON-DISK SHAPE ──────────────────────────────────────────────────────────
 *
 *   [root]/
 *   ├── content/
 *   │   ├── {namespace}/
 *   │   │   └── {collection}/
 *   │   │       └── {itemId}/
 *   │   │           ├── document.pdf
 *   │   │           ├── cover.jpg
 *   │   │           ├── textures/...
 *   │   │           └── meta.json
 *   │   └── ...
 *   ├── cache/
 *   │   ├── thumbnails/
 *   │   ├── manifests/
 *   │   └── tmp/
 *   └── system/
 *       └── layout.json
 *
 * The DB stores only relative paths and namespace/collection/item
 * triples. Absolute roots are resolved per call by the native bridge.
 */

import * as storage from './app-storage.js';

const LAYOUT_VERSION = 1;
const LAYOUT_FILE    = 'system/layout.json';

/** @type {Map<string, { name: string, description: string }>} */
const _namespaces = new Map();

// ============================================================================
// Slugs
// ============================================================================

/**
 * Filesystem-safe slug. Lowercase, hyphens, no accents.
 *   "Robbins & Cotran" → "robbins-cotran"
 *   "2024 KNH Anatomy" → "2024-knh-anatomy"
 */
export function slug(input) {
    return String(input || 'unknown')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64) || 'unknown';
}

// ============================================================================
// Namespace registry
// ============================================================================

/**
 * Register a namespace. Idempotent. Name must match
 * [a-z0-9][a-z0-9-]{0,62}.
 *
 * @param {string} name
 * @param {{ description?: string }} [spec]
 * @returns {boolean} true if registered (or already was)
 */
export function registerNamespace(name, spec = {}) {
    if (!name || typeof name !== 'string') return false;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) return false;
    _namespaces.set(name, {
        name,
        description: spec.description || '',
    });
    return true;
}

export function isNamespaceRegistered(name) {
    return _namespaces.has(name);
}

export function getRegisteredNamespaces() {
    return [..._namespaces.values()];
}

// ============================================================================
// Path computation
// ============================================================================

export function namespacePath(namespace) {
    return `content/${slug(namespace)}`;
}

export function collectionPath(namespace, collection) {
    return `${namespacePath(namespace)}/${slug(collection)}`;
}

export function itemPath(namespace, collection, itemId) {
    return `${collectionPath(namespace, collection)}/${slug(itemId)}`;
}

export function itemFilePath(namespace, collection, itemId, filename) {
    return `${itemPath(namespace, collection, itemId)}/${filename}`;
}

export function itemMetaPath(namespace, collection, itemId) {
    return `${itemPath(namespace, collection, itemId)}/meta.json`;
}

// ============================================================================
// Cache paths
// ============================================================================

export function thumbnailPath(key, ext = 'jpg') {
    return `cache/thumbnails/${slug(key)}.${ext}`;
}

export function manifestPath(name) {
    return `cache/manifests/${slug(name)}.json`;
}

export function tmpPath(uuid) {
    return `cache/tmp/${slug(uuid)}.part`;
}

// ============================================================================
// Layout descriptor — version + registry, persisted to disk
// ============================================================================

/**
 * Write the current layout version + registered namespaces to
 * system/layout.json. Called once at boot. Future migrations can
 * compare the persisted version against LAYOUT_VERSION to detect drift.
 */
export function persistLayoutDescriptor() {
    if (!storage.isNativeStorageAvailable()) return false;
    storage.createDirectory('system');

    const descriptor = {
        version: LAYOUT_VERSION,
        created: Date.now(),
        namespaces: getRegisteredNamespaces().map(ns => ({
            name: ns.name,
            description: ns.description,
        })),
    };
    return storage.writeText(LAYOUT_FILE, JSON.stringify(descriptor, null, 2));
}

/**
 * Read the persisted descriptor. Returns null if missing or malformed.
 */
export function readLayoutDescriptor() {
    const raw = storage.readText(LAYOUT_FILE);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.version !== 'number') return null;
        return parsed;
    } catch { return null; }
}

export function getLayoutVersion() {
    return LAYOUT_VERSION;
}

// ============================================================================
// Boot scaffold
// ============================================================================

/**
 * Create the base directory tree. Idempotent.
 * Returns true if the native storage layer is available.
 */
export function scaffoldDirectories() {
    if (!storage.isNativeStorageAvailable()) return false;

    const dirs = [
        'content',
        'cache',
        'cache/thumbnails',
        'cache/manifests',
        'cache/tmp',
        'system',
    ];
    for (const d of dirs) storage.createDirectory(d);

    // Namespace roots, so exists() checks are predictable from boot.
    for (const ns of _namespaces.values()) {
        storage.createDirectory(namespacePath(ns.name));
    }
    return true;
}