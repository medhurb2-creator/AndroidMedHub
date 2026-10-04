// frontend-user/scripts/content.js

/**
 * Content Management Module (Convex + R2)
 * - Fetches resource metadata (thumbnails) from Convex (public, no subscription check)
 * - Caches metadata IN MEMORY ONLY, for the lifetime of the page session
 * - Downloads actual files only if user has active subscription/trial
 * - Stores downloaded files in IndexedDB (not user-accessible)
 * - Provides filter options (institutions, years) for browsing
 *
 * Persistence contract (matches resource-browser.js):
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ Undownloaded catalogue items are NEVER persisted to disk.          │
 *   │                                                                     │
 *   │ The catalogue cache here is a session-scoped Map. It accelerates   │
 *   │ repeat visits within one browser session but is discarded when the │
 *   │ page unloads. Nothing about a user's browsing history survives.    │
 *   │                                                                     │
 *   │ Only two persistence stores exist on disk:                         │
 *   │   • `downloaded_resource_meta` (localStorage) — set by             │
 *   │     resource-browser.js, contains ONLY downloaded documents.       │
 *   │   • IndexedDB file + thumbnail blobs — written by resource-        │
 *   │     browser.js / content.js only when the user downloads a file.   │
 *   └─────────────────────────────────────────────────────────────────────┘
 *
 * Field-shape contract:
 *   `fetchResources` returns every field the catalogue query produces.
 *   Downstream consumers (card renderer, Open handler, Download handler)
 *   read fields like `isPremium`, `author`, `year`, `subject`, `category`,
 *   and `tags` directly. Do NOT narrow the map — dropping a field here
 *   silently breaks whichever subsystem consumes it.
 */

import * as db from './db.js';
import * as utils from './utils.js';
import * as ui from './ui.js';
import { convexHttpClient } from './convex-client.js';
import { getToken } from './auth.js';
import * as subscription from './subscription.js';

// ==================== IN-MEMORY CACHE ====================
//
// Map<string, { version, documents, filters, lastFetched }>
// Keyed by `${subject}_${category}`. Lost on page unload by design.
//
// The cache exists solely to satisfy the manifest-version fast path: if
// the caller asks for the first page of a subject/category that this
// session has already loaded and the backend manifest version matches,
// return the in-memory copy instead of round-tripping the network.
//
// Because the whole Map is discarded on unload, no browsing history
// survives across sessions.

/** @type {Map<string, { version: any, documents: any[], filters: any, lastFetched: number }>} */
const _catalogueCache = new Map();

function _cacheKey(subject, category) {
  return `${subject}_${category}`;
}

function _getCache(subject, category) {
  return _catalogueCache.get(_cacheKey(subject, category))
    || { version: null, documents: [], filters: null, lastFetched: 0 };
}

function _setCache(subject, category, data) {
  _catalogueCache.set(_cacheKey(subject, category), {
    ...data,
    lastFetched: Date.now(),
  });
}

// ==================== ONE-SHOT CACHE MIGRATION ====================
//
// Previous versions of this module persisted the catalogue cache to
// IndexedDB under `content_metadata_cache_v2` / `_v3`. Those entries
// contain metadata for undownloaded documents and violate the current
// persistence contract.
//
// This migration runs once per page load, on the first call to any
// public function. It overwrites those keys with empty objects. The
// underlying IndexedDB records are not deleted (IndexedDB has no
// "delete a setting key" primitive in db.js), but their contents are
// wiped — so no browsing history remains readable on disk.
//
// It does NOT touch:
//   • `download_manifest_v2` (localStorage) — the downloaded file registry.
//   • `downloaded_resource_meta` (localStorage) — the downloaded metadata.
//   • The IndexedDB file and thumbnail blobs — those are downloads.
//
// Only the catalogue cache is cleared.

let _migrationDone = false;

async function _runCacheMigrationOnce() {
  if (_migrationDone) return;
  _migrationDone = true;
  try {
    await db.saveSetting('content_metadata_cache_v2', {});
    await db.saveSetting('content_metadata_cache_v3', {});
  } catch {
    // Best-effort. If the setting store is unavailable, nothing else
    // depends on this succeeding — the in-memory cache is authoritative
    // from this point forward.
  }
}

// ==================== DOWNLOAD MANIFEST HELPERS ====================
//
// These deal with the DOWNLOADED files, not the catalogue cache.
// They stay as-is: they read and write `download_manifest_v2` in
// localStorage, which is the registry of files the user has explicitly
// downloaded.

const DOWNLOAD_MANIFEST_KEY = 'download_manifest_v2';

function getDownloadManifest() {
  return utils.getLocalStorage(DOWNLOAD_MANIFEST_KEY, {});
}

function setDownloadManifest(manifest) {
  utils.setLocalStorage(DOWNLOAD_MANIFEST_KEY, manifest);
}

// ==================== FETCH RESOURCES (with in-memory caching) ====================

/**
 * Fetch resources for a subject/category.
 *
 * Uses the in-memory cache if the manifest version has not changed since
 * this session last loaded the subject/category. Falls through to the
 * network otherwise.
 *
 * Persistence: nothing is written to disk. The cache lives for the page
 * session only, matching the resource-browser offline contract.
 *
 * @param {string} subject
 * @param {string} category
 * @param {string|null} cursor  (for pagination)
 * @param {Object} filters      { institution, year } (optional)
 * @returns {Promise<{documents: Array, cursor: string|null, hasMore: boolean}>}
 */
export async function fetchResources(subject, category, cursor = null, filters = {}) {
  await _runCacheMigrationOnce();

  // If no cursor and no filters, check the in-memory cache
  if (!cursor && !filters.institution && !filters.year) {
    const cached = _getCache(subject, category);
    try {
      const manifest = await convexHttpClient.query('resources/queries:getManifest', {
        subject,
        category,
      });
      if (manifest && manifest.version === cached.version && cached.documents.length > 0) {
        return {
          documents: cached.documents,
          cursor: null,
          hasMore: false,
        };
      }
    } catch (err) {
      console.warn('[Content] Could not fetch manifest, will refetch all.', err);
    }
  }

  // Build query parameters
  const queryParams = {
    subject,
    category,
    limit: 20,
  };
  // ✅ Only include cursor if it's a valid non-empty string (not null/undefined)
  if (cursor && typeof cursor === 'string' && cursor.length > 0) {
    queryParams.cursor = cursor;
  }

  // Fetch from backend
  try {
    const result = await convexHttpClient.query('resources/queries:getResources', queryParams);

    // ────────────────────────────────────────────────────────────────
    // IMPORTANT: This map must preserve EVERY field the caller relies on.
    //
    // A narrowing map here silently drops fields for every downstream
    // consumer (cards, open handler, download handler). Do not remove
    // fields from this shape without auditing every consumer.
    // ────────────────────────────────────────────────────────────────
    const documents = result.documents.map((doc) => ({
      // Identity
      _id: doc._id,
      title: doc.title,
      subject: doc.subject,
      category: doc.category,

      // Attribution
      author: doc.author,
      year: doc.year,

      // Entitlement — REQUIRED by the Open and Download handlers
      isPremium: doc.isPremium === true,

      // Content metadata
      fileType: doc.fileType,
      fileSize: doc.fileSize,
      description: doc.description,
      tags: doc.tags,

      // Media
      thumbnailUrl: doc.thumbnailUrl,
      r2ThumbnailKey: doc.r2ThumbnailKey,

      // Counters / versioning
      downloadCount: doc.downloadCount,
      viewCount: doc.viewCount,
      version: doc.version,

      // Timestamps
      uploadedAt: doc.uploadedAt,
      updatedAt: doc.updatedAt,
    }));

    // If first page, update the in-memory cache
    if (!cursor && !filters.institution && !filters.year) {
      _setCache(subject, category, {
        version: result.manifestVersion,
        documents,
      });
    }

    return {
      documents,
      cursor: result.cursor,
      hasMore: result.hasMore,
    };
  } catch (err) {
    console.error('[Content] Fetch error:', err);
    ui.showToast('Failed to load resources', 'error');

    // Return in-memory cached data if available. Never reads from disk —
    // this fallback only helps when the network fails mid-session and the
    // user has already loaded the same subject/category once.
    const cached = _getCache(subject, category);
    if (cached.documents.length > 0) {
      return { documents: cached.documents, cursor: null, hasMore: false };
    }
    return { documents: [], cursor: null, hasMore: false };
  }
}

// ==================== FILTERS ====================

/**
 * Get available filter values (institutions, years) for a subject/category.
 *
 * Cached in memory for the session only, same policy as the catalogue cache.
 *
 * @param {string} subject
 * @param {string} category
 * @returns {Promise<{institutions: string[], years: number[]}>}
 */
export async function getAvailableFilters(subject, category) {
  await _runCacheMigrationOnce();

  try {
    // Check in-memory cache first
    const cached = _getCache(subject, category);
    if (cached.filters) {
      return cached.filters;
    }
    const result = await convexHttpClient.query('resources/queries:getFilters', {
      subject,
      category,
    });
    // Cache filters in memory
    const cacheData = _getCache(subject, category);
    cacheData.filters = result;
    _setCache(subject, category, cacheData);
    return result || { institutions: [], years: [] };
  } catch (err) {
    console.warn('[Content] Failed to fetch filters', err);
    return { institutions: [], years: [] };
  }
}

// ==================== DOWNLOAD FILE ====================

/**
 * Download a resource file.
 * Checks subscription, gets signed URL, stores in IndexedDB.
 *
 * This is the ONLY path that writes an undownloaded-then-downloaded
 * document to disk. It is invoked explicitly by the user clicking
 * Download. Nothing else in this module writes document bytes.
 *
 * @param {string} resourceId
 * @param {string} title (for display)
 * @returns {Promise<boolean>} success
 */
export async function downloadResource(resourceId, title = '') {
  await _runCacheMigrationOnce();

  // Check active subscription/trial first (fast local check)
  const hasActive = await subscription.hasActiveSubscription();
  if (!hasActive) {
    ui.showToast('Active subscription or free trial required to download.', 'warning');
    return false;
  }

  const token = getToken();
  if (!token) {
    ui.showToast('Please log in to download.', 'warning');
    return false;
  }

  ui.showLoading(`Downloading ${title || 'file'}...`);
  try {
    const result = await convexHttpClient.action('resources/actions:getDownloadUrl', {
      token,
      resourceId,
    });

    if (!result.success) {
      if (result.error === 'subscription_required') {
        ui.showToast('Subscription required to download this file.', 'warning');
      } else {
        ui.showToast(result.message || 'Download failed.', 'error');
      }
      return false;
    }

    const { downloadUrl } = result.data;
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error('Download failed');

    const blob = await response.blob();
    // Store in IndexedDB — this is a user-initiated download.
    await db.saveFileBlob(resourceId, blob);

    // Update download manifest
    const manifest = getDownloadManifest();
    manifest[resourceId] = {
      downloadedAt: Date.now(),
      size: blob.size,
      mime: response.headers.get('content-type'),
    };
    setDownloadManifest(manifest);

    ui.showToast('Download complete', 'success');
    return true;
  } catch (err) {
    console.error('[Content] Download error:', err);
    ui.showToast('Download failed. Please try again.', 'error');
    return false;
  } finally {
    ui.hideLoading();
  }
}

// ==================== GET LOCAL FILE ====================

/**
 * Retrieve a downloaded file from IndexedDB.
 * Returns null for anything not in the download manifest.
 *
 * @param {string} resourceId
 * @returns {Promise<Blob|null>}
 */
export async function getLocalFile(resourceId) {
  const manifest = getDownloadManifest();
  if (!manifest[resourceId]) return null;
  return await db.getFileBlob(resourceId);
}

/**
 * Check if a resource is already downloaded.
 * @param {string} resourceId
 * @returns {boolean}
 */
export function isDownloaded(resourceId) {
  const manifest = getDownloadManifest();
  return !!manifest[resourceId];
}

// ==================== FORMAT FILE SIZE ====================

export function formatFileSize(bytes) {
  if (!bytes) return '';
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
}

// ==================== EXPORTS ====================
// Export the manifest helpers so the UI can use them
export { getDownloadManifest, setDownloadManifest };

// Compatibility aliases for the resource-browser.html
export const fetchDocuments = fetchResources;
export const downloadDocument = downloadResource;