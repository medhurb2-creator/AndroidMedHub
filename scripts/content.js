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
 * Cache shape:
 *   The in-memory cache stores `{version, documents, cursor, hasMore}`.
 *   Storing cursor/hasMore is REQUIRED for pagination correctness on
 *   revisit — without them, the cache-served first page lies about being
 *   the last page, and the "Load more" button never appears.
 *
 * Failure semantics:
 *   `fetchResources` re-throws network errors when it has no cache to
 *   fall back on. This lets the caller (resource-browser.js) detect the
 *   failure and switch to its offline-only view (`loadOfflineResources`).
 *   Silently returning an empty result set was the root cause of the
 *   "downloads don't show offline" bug.
 */

import * as db from './db.js';
import * as utils from './utils.js';
import * as ui from './ui.js';
import { convexHttpClient } from './convex-client.js';
import { getToken } from './auth.js';
import * as subscription from './subscription.js';

// ==================== IN-MEMORY CACHE ====================
//
// Map<string, {
//   version: any,
//   documents: any[],
//   cursor: string|null,
//   hasMore: boolean,
//   filters: any,
//   lastFetched: number,
// }>
//
// Keyed by `${subject}_${category}`. Lost on page unload by design.

/**
 * @type {Map<string, {
 *   version: any,
 *   documents: any[],
 *   cursor: string|null,
 *   hasMore: boolean,
 *   filters: any,
 *   lastFetched: number,
 * }>}
 */
const _catalogueCache = new Map();

function _cacheKey(subject, category) {
  return `${subject}_${category}`;
}

function _getCache(subject, category) {
  return _catalogueCache.get(_cacheKey(subject, category)) || {
    version: null,
    documents: [],
    cursor: null,
    hasMore: false,
    filters: null,
    lastFetched: 0,
  };
}

function _setCache(subject, category, data) {
  const prev = _getCache(subject, category);
  _catalogueCache.set(_cacheKey(subject, category), {
    // Preserve fields the caller didn't supply.
    version: data.version !== undefined ? data.version : prev.version,
    documents: data.documents !== undefined ? data.documents : prev.documents,
    cursor: data.cursor !== undefined ? data.cursor : prev.cursor,
    hasMore: data.hasMore !== undefined ? data.hasMore : prev.hasMore,
    filters: data.filters !== undefined ? data.filters : prev.filters,
    lastFetched: Date.now(),
  });
}

// ==================== ONE-SHOT CACHE MIGRATION ====================

let _migrationDone = false;

async function _runCacheMigrationOnce() {
  if (_migrationDone) return;
  _migrationDone = true;
  try {
    await db.saveSetting('content_metadata_cache_v2', {});
    await db.saveSetting('content_metadata_cache_v3', {});
  } catch {
    // Best-effort.
  }
}

// ==================== DOWNLOAD MANIFEST HELPERS ====================

const DOWNLOAD_MANIFEST_KEY = 'download_manifest_v2';

function getDownloadManifest() {
  return utils.getLocalStorage(DOWNLOAD_MANIFEST_KEY, {});
}

function setDownloadManifest(manifest) {
  utils.setLocalStorage(DOWNLOAD_MANIFEST_KEY, manifest);
}

// ==================== FETCH RESOURCES ====================

/**
 * Fetch resources for a subject/category.
 *
 * Behaviour:
 *   • If first page (no cursor, no filters) and cache version matches,
 *     return the cached page — including its cursor and hasMore, so
 *     pagination continues correctly.
 *   • Otherwise fetch from backend.
 *   • On network failure:
 *       - If cache has documents → return cache with source 'cache'.
 *       - If cache is empty → RE-THROW. This lets the caller switch to
 *         the offline-only view. Silently returning [] is what broke
 *         offline downloads.
 *
 * @param {string} subject
 * @param {string} category
 * @param {string|null} cursor
 * @param {Object} filters  { institution, year }
 * @returns {Promise<{documents: Array, cursor: string|null, hasMore: boolean, source: string}>}
 */
export async function fetchResources(subject, category, cursor = null, filters = {}) {
  await _runCacheMigrationOnce();

  const isFirstPage = !cursor && !filters.institution && !filters.year;

  // ── Cache fast-path ────────────────────────────────────────────────
  if (isFirstPage) {
    const cached = _getCache(subject, category);
    if (cached.documents.length > 0) {
      try {
        const manifest = await convexHttpClient.query('resources/queries:getManifest', {
          subject,
          category,
        });
        if (manifest && manifest.version === cached.version) {
          return {
            documents: cached.documents,
            cursor: cached.cursor || null,
            hasMore: cached.hasMore === true,
            source: 'cache',
          };
        }
      } catch {
        // Manifest check failed — fall through to full fetch. Do not
        // return the cache here, because we can't confirm it is current.
      }
    }
  }

  // ── Build query params ─────────────────────────────────────────────
  const queryParams = {
    subject,
    category,
    limit: 20,
  };
  if (cursor && typeof cursor === 'string' && cursor.length > 0) {
    queryParams.cursor = cursor;
  }

  // ── Network fetch ──────────────────────────────────────────────────
  try {
    const result = await convexHttpClient.query('resources/queries:getResources', queryParams);

    // ────────────────────────────────────────────────────────────────
    // IMPORTANT: This map must preserve EVERY field the caller relies on.
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

    // Write the cache on first-page fetches, including cursor and hasMore
    // so a subsequent cache hit continues pagination correctly.
    if (isFirstPage) {
      _setCache(subject, category, {
        version: result.manifestVersion,
        documents,
        cursor: result.cursor || null,
        hasMore: result.hasMore === true,
      });
    }

    return {
      documents,
      cursor: result.cursor || null,
      hasMore: result.hasMore === true,
      source: 'network',
    };
  } catch (err) {
    console.error('[Content] Fetch error:', err);

    // Fall back to in-memory cache if we have one.
    const cached = _getCache(subject, category);
    if (cached.documents.length > 0) {
      return {
        documents: cached.documents,
        cursor: cached.cursor || null,
        hasMore: cached.hasMore === true,
        source: 'cache-fallback',
      };
    }

    // No cache to serve from. Re-throw so the caller can switch to its
    // offline path. This is the fix for "downloads don't show offline".
    throw err;
  }
}

// ==================== FILTERS ====================

/**
 * Get available filter values (institutions, years) for a subject/category.
 *
 * @param {string} subject
 * @param {string} category
 * @returns {Promise<{institutions: string[], years: number[]}>}
 */
export async function getAvailableFilters(subject, category) {
  await _runCacheMigrationOnce();

  const cached = _getCache(subject, category);
  if (cached.filters) {
    return cached.filters;
  }

  try {
    const result = await convexHttpClient.query('resources/queries:getFilters', {
      subject,
      category,
    });
    _setCache(subject, category, { filters: result });
    return result || { institutions: [], years: [] };
  } catch (err) {
    console.warn('[Content] Failed to fetch filters', err);
    return { institutions: [], years: [] };
  }
}

// ==================== DOWNLOAD FILE ====================

/**
 * Download a resource file (standalone API; the resource browser has its
 * own download flow that also writes persisted metadata).
 *
 * @param {string} resourceId
 * @param {string} title
 * @returns {Promise<boolean>}
 */
export async function downloadResource(resourceId, title = '') {
  await _runCacheMigrationOnce();

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
    await db.saveFileBlob(resourceId, blob);

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

export { getDownloadManifest, setDownloadManifest };

export const fetchDocuments = fetchResources;
export const downloadDocument = downloadResource;
