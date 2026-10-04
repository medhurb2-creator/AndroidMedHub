// scripts/resource-browser.js

/**
 * Resource Browser Module
 *
 * Offline guarantees:
 *   - Downloaded FILES live in IndexedDB (db.saveFileBlob) → openable offline.
 *   - Downloaded THUMBNAILS live in IndexedDB (db.saveThumbnailBlob) → visible offline.
 *   - Downloaded METADATA lives in localStorage (DOWNLOADED_META_KEY) → cards render offline.
 *   - Undownloaded catalogue items are NEVER persisted. Offline you see only what you saved.
 *
 * Metadata contract:
 *   `saveDownloadedMeta` persists the FULL public document shape returned by
 *   the catalogue queries — including `isPremium`, `subject`, `description`,
 *   `tags`, `r2ThumbnailKey`, counters, and timestamps. This is what makes
 *   the offline Open handler able to apply the same premium policy as the
 *   online one: it reads `doc.isPremium` from the persisted record without
 *   ever contacting the backend.
 *
 * Preview-mode policy:
 *   A downloaded PREMIUM resource opened by a user with NO active subscription
 *   is displayed in preview mode: the viewer caps rendered pages to
 *   CONFIG.PREVIEW_PAGE_FRACTION (10% by default) and appends a subscribe
 *   call-to-action after the last preview page.
 *
 * Diagnostic logging:
 *   Set localStorage['debugPremium'] = '1' to enable detailed field-level
 *   logging at every point where `isPremium` is received, mapped, persisted,
 *   or read. Logs are grouped and colour-coded for fast scanning.
 */

import * as content from './content.js';
import * as subscription from './subscription.js';
import * as viewer from './viewer.js';
import * as db from './db.js';
import * as ui from './ui.js';
import * as router from './router.js';
import { convexHttpClient } from './convex-client.js';
import { getToken, logout } from './auth.js';

// ==================== CONSTANTS ====================
const CATEGORY_MAP = {
    'study': 'notes',
    'pastpaper': 'pastpapers',
    'textbook': 'textbooks',
    'visual': 'visual'
};
const TYPE_NAMES = {
    study: 'Study Resources',
    pastpaper: 'Past Papers',
    textbook: 'Textbooks',
    visual: 'Visual Concepts'
};
const FAVORITES_KEY = 'favorite_resources';
// Persisted metadata for DOWNLOADED files only
const DOWNLOADED_META_KEY = 'downloaded_resource_meta';

// ==================== DIAGNOSTIC LOGGER ====================
// Zero-cost when disabled. Toggle with:
//   localStorage.setItem('debugPremium', '1')   → on
//   localStorage.removeItem('debugPremium')     → off
// Then reload the page.
//
// Every log is tagged `[premium:...]` so you can filter the console with
// the string "premium". Colours are applied via console.log %c formatting
// so the important lines stand out in a busy console.

const DBG_KEY = 'debugPremium';

function _dbg() {
    try { return localStorage.getItem(DBG_KEY) === '1'; } catch { return false; }
}

const LOG_STYLE = {
    reset: 'color:inherit',
    info: 'color:#2563eb;font-weight:bold',
    ok: 'color:#059669;font-weight:bold',
    warn: 'color:#d97706;font-weight:bold',
    fail: 'color:#dc2626;font-weight:bold',
    dim: 'color:#6b7280',
};

/**
 * Log a tagged group of diagnostic data.
 * @param {string} tag
 * @param {any} payload
 * @param {'info'|'ok'|'warn'|'fail'} [level]
 */
function _log(tag, payload, level = 'info') {
    if (!_dbg()) return;
    const style = LOG_STYLE[level] || LOG_STYLE.info;
    try {
        console.groupCollapsed(`%c[premium:${tag}]`, style);
        console.log(payload);
        console.groupEnd();
    } catch { /* ignore */ }
}

/**
 * Log a one-line summary (no group). Useful for scanning.
 */
function _logLine(tag, message, level = 'info') {
    if (!_dbg()) return;
    const style = LOG_STYLE[level] || LOG_STYLE.info;
    try {
        console.log(`%c[premium:${tag}]`, style, message);
    } catch { /* ignore */ }
}

/**
 * Summarise a document record into a compact shape for logging.
 * Shows the exact value and type of isPremium, plus the full key list so
 * missing fields are obvious.
 */
function _summariseDoc(d) {
    return {
        _id: d._id,
        title: d.title,
        isPremium: d.isPremium,
        typeofIsPremium: typeof d.isPremium,
        isStrictTrue: d.isPremium === true,
        keys: Object.keys(d),
    };
}

// ==================== STATE ====================
let currentSubject = null;
let currentCategory = null;
let currentCursor = null;
let isLoading = false;
let hasMore = true;
let currentFilter = 'all';
let searchTerm = '';
let allDocuments = [];
const activeDownloads = new Map();
export const docMap = new Map();

// resourceId -> object URL (thumbnail blobs we've hydrated or downloaded)
const thumbnailCache = new Map();

// ==================== PERSISTED DOWNLOADED METADATA ====================
function getDownloadedMeta() {
    try {
        return JSON.parse(localStorage.getItem(DOWNLOADED_META_KEY) || '{}');
    } catch {
        return {};
    }
}

function setDownloadedMeta(map) {
    localStorage.setItem(DOWNLOADED_META_KEY, JSON.stringify(map));
}

/**
 * Persist the full public shape of a downloaded document.
 *
 * Called once per successful download, after both the file blob and the
 * thumbnail blob have been written to IndexedDB. The persisted record is
 * the sole source of truth for offline rendering, filtering, and — critically
 * — the Open handler's premium check.
 *
 * Fields are grouped by concern so it is easy to see what belongs where:
 *
 *   Identity        _id, title, subject, category
 *   Attribution     author, year
 *   Entitlement     isPremium         ← drives preview-mode decision offline
 *   Content         fileType, fileSize, description, tags
 *   Media           r2ThumbnailKey    (raw key; URL is derived online)
 *   Counters        downloadCount, viewCount, version
 *   Timestamps      uploadedAt, updatedAt
 *
 * `isPremium` is coerced with `=== true` so the value is always a strict
 * boolean.
 *
 * @param {object} doc  the full document record from docMap
 */
function saveDownloadedMeta(doc) {
    if (!doc) {
        _logLine('save-meta', 'skipped — no doc', 'warn');
        return;
    }

    const incomingIsPremium = doc.isPremium;
    const storedIsPremium = incomingIsPremium === true;

    const map = getDownloadedMeta();

    map[doc._id] = {
        // ── Identity ────────────────────────────────────────────────
        _id: doc._id,
        title: doc.title,
        subject: doc.subject,
        category: doc.category,

        // ── Attribution ─────────────────────────────────────────────
        author: doc.author ?? '',
        year: doc.year ?? '',

        // ── Entitlement (drives offline preview-mode decision) ──────
        isPremium: storedIsPremium,

        // ── Content metadata ────────────────────────────────────────
        fileType: doc.fileType,
        fileSize: doc.fileSize,
        description: doc.description ?? '',
        tags: Array.isArray(doc.tags) ? doc.tags : [],

        // ── Media ───────────────────────────────────────────────────
        r2ThumbnailKey: doc.r2ThumbnailKey ?? null,

        // ── Counters and versioning (informational) ─────────────────
        downloadCount: doc.downloadCount ?? 0,
        viewCount: doc.viewCount ?? 0,
        version: doc.version ?? 1,

        // ── Timestamps ──────────────────────────────────────────────
        uploadedAt: doc.uploadedAt ?? null,
        updatedAt: doc.updatedAt ?? Date.now(),
    };

    setDownloadedMeta(map);

    _log('save-meta', {
        id: doc._id,
        title: doc.title,
        incomingIsPremium,
        incomingTypeofIsPremium: typeof incomingIsPremium,
        storedIsPremium,
        storedRecord: map[doc._id],
    }, storedIsPremium ? 'ok' : 'info');
}

function removeDownloadedMeta(id) {
    const map = getDownloadedMeta();
    delete map[id];
    setDownloadedMeta(map);
    _logLine('remove-meta', `removed ${id}`, 'info');
}

// ==================== FAVORITES ====================
function getFavorites() {
    return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
}
function setFavorites(list) {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}
function isFavorite(id) {
    return getFavorites().includes(id);
}

// ==================== FILTER & SEARCH ====================
function filterDocuments(docs, filterType, searchTerm) {
    let filtered = docs;
    if (searchTerm.trim()) {
        const term = searchTerm.trim().toLowerCase();
        filtered = filtered.filter(d => d.title.toLowerCase().includes(term));
    }
    switch (filterType) {
        case 'favorites':
            filtered = filtered.filter(d => isFavorite(d._id));
            break;
        case 'downloaded':
            filtered = filtered.filter(d => content.isDownloaded(d._id));
            break;
        case 'recent':
            filtered = filtered.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            break;
        default:
            break;
    }
    return filtered;
}

// ==================== RENDER ====================
function applyFiltersAndRender() {
    const grid = document.getElementById('resource-grid');
    if (!grid) {
        console.error('[ResourceBrowser] resource-grid not found!');
        return;
    }
    const searchEl = document.getElementById('search-input');
    const term = searchEl ? searchEl.value : '';
    const filtered = filterDocuments(allDocuments, currentFilter, term);

    if (_dbg()) {
        _log('render', {
            currentFilter,
            searchTerm: term,
            totalInAllDocuments: allDocuments.length,
            afterFilter: filtered.length,
            premiumInAll: allDocuments.filter(d => d.isPremium === true).length,
            premiumInFiltered: filtered.filter(d => d.isPremium === true).length,
            docs: filtered.map(_summariseDoc),
        });
    }

    if (filtered.length === 0) {
        grid.innerHTML = '<div class="no-data">No resources match your criteria.</div>';
        return;
    }
    grid.innerHTML = filtered.map(doc => createResourceCard(doc)).join('');
    attachCardEventListeners();
}

/**
 * Thumbnail resolution order:
 *   1. Cached blob object URL (works offline) – always preferred
 *   2. Public remote URL (only if online)
 *   3. null → placeholder
 */
function getThumbnailSrc(doc) {
    if (thumbnailCache.has(doc._id)) {
        return thumbnailCache.get(doc._id);
    }
    if (navigator.onLine && doc.thumbnailUrl) {
        return doc.thumbnailUrl;
    }
    return null;
}

function createResourceCard(doc) {
    const isDownloaded = content.isDownloaded(doc._id);
    const isFav = isFavorite(doc._id);
    const sizeStr = doc.fileSize ? content.formatFileSize(doc.fileSize) : '';
    const isPremium = doc.isPremium === true;

    let mainBtnHtml = '';
    if (isDownloaded) {
        mainBtnHtml = `<button class="main-btn btn-open" data-id="${doc._id}" data-title="${doc.title}" data-type="${doc.fileType}">Open</button>`;
    } else {
        mainBtnHtml = `<button class="main-btn btn-download" data-id="${doc._id}">⬇ Download</button>`;
    }

    const favBadgeHtml = isFav ? '<div class="favorite-badge">⭐</div>' : '';

    const thumbSrc = getThumbnailSrc(doc);
    const thumbnailHtml = thumbSrc
        ? `<img src="${thumbSrc}" alt="Thumbnail" loading="lazy"
               onerror="this.onerror=null;this.outerHTML='<div class=&quot;thumbnail-placeholder&quot;>📄</div>'">`
        : '<div class="thumbnail-placeholder">📄</div>';

    return `
        <div class="resource-card" data-id="${doc._id}">
            ${favBadgeHtml}
            <div class="card-thumbnail">
                ${thumbnailHtml}
            </div>
            <div class="card-info">
                <div>
                    <h3>${doc.title}</h3>
                    <div class="meta">${doc.author || ''} ${doc.year ? `· ${doc.year}` : ''}</div>
                    <span class="type-badge">${doc.category}</span>
                </div>
                <div class="card-stats">
                    <span>${sizeStr}</span>
                    ${isPremium ? '<span class="premium-badge">🔒 Premium</span>' : ''}
                    ${isDownloaded ? '<span class="downloaded-badge">✅ Downloaded</span>' : ''}
                </div>
                <div class="card-actions">
                    ${mainBtnHtml}
                    <div class="menu-wrapper">
                        <button class="menu-btn" data-id="${doc._id}">⋮</button>
                        <div class="menu-dropdown" data-id="${doc._id}">
                            <button class="favorite-btn ${isFav ? 'active' : ''}" data-id="${doc._id}">
                                ${isFav ? '⭐ Remove favorite' : '☆ Add favorite'}
                            </button>
                            <button class="delete-btn" data-id="${doc._id}">🗑️ Delete</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// ==================== EVENT LISTENERS ====================
function attachCardEventListeners() {
    document.querySelectorAll('.btn-download, .btn-open').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const doc = docMap.get(id);
            const isOpen = btn.classList.contains('btn-open');

            // ── DEBUG: entry point — what did the click give us? ──────────
            if (_dbg()) {
                _logLine(
                    'click',
                    `${isOpen ? 'OPEN' : 'DOWNLOAD'} id=${id} ` +
                    `docFound=${!!doc} ` +
                    `isPremium=${doc ? doc.isPremium : '(no doc)'} ` +
                    `typeof=${doc ? typeof doc.isPremium : '(no doc)'} ` +
                    `docMapSize=${docMap.size}`,
                    'info'
                );
            }

            // ===== OPEN (uses cached blob – works offline) =====
            if (isOpen) {
                let previewMode = false;
                let hasActive = false;

                // Fetch subscription state so we can log it regardless of
                // whether the premium branch fires.
                if (doc && doc.isPremium === true) {
                    hasActive = await subscription.hasActiveSubscription();
                    if (!hasActive) {
                        previewMode = true;
                    }
                }

                // ── DEBUG: full decision trace ────────────────────────────
                if (_dbg()) {
                    const reason = !doc
                        ? 'doc not in docMap'
                        : doc.isPremium !== true
                            ? `isPremium is ${typeof doc.isPremium} (${String(doc.isPremium)}), not strict true`
                            : hasActive
                                ? 'user has active subscription'
                                : 'unsubscribed + premium → PREVIEW MODE';

                    _log('open-decision', {
                        id,
                        doc: doc ? _summariseDoc(doc) : null,
                        docMapSize: docMap.size,
                        hasActiveSubscription: hasActive,
                        willEnterPreviewMode: previewMode,
                        reason,
                    }, previewMode ? 'warn' : 'ok');
                }

                if (previewMode) {
                    ui.showToast(
                        'Previewing the first 10% — subscribe to unlock all pages',
                        'info'
                    );
                }

                const title = btn.dataset.title || 'Document';
                const fileType = btn.dataset.type || 'pdf';

                if (_dbg()) {
                    _logLine(
                        'open-final',
                        `id=${id} previewMode=${previewMode} title="${title}" type=${fileType}`,
                        previewMode ? 'warn' : 'ok'
                    );
                }

                viewer.openDocument(id, title, fileType, { previewMode });
                return;
            }

            // ===== DOWNLOAD =====
            if (!navigator.onLine) {
                _logLine('download-blocked', 'offline', 'warn');
                ui.showToast('Cannot download while offline', 'warning');
                return;
            }

            if (doc && doc.isPremium === true) {
                const hasActive = await subscription.hasActiveSubscription();
                if (!hasActive) {
                    _logLine(
                        'download-blocked',
                        `id=${id} premium + unsubscribed → redirect to subscription`,
                        'fail'
                    );
                    ui.showToast('Subscription required to download this premium resource', 'warning');
                    router.navigateTo('subscription');
                    return;
                }
                _logLine(
                    'download-allowed',
                    `id=${id} premium + subscribed → proceeding`,
                    'ok'
                );
            } else {
                _logLine(
                    'download-allowed',
                    `id=${id} free resource → proceeding`,
                    'ok'
                );
            }

            startDownload(id);
        });
    });

    document.querySelectorAll('.menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = btn.closest('.card-actions').querySelector('.menu-dropdown');
            document.querySelectorAll('.menu-dropdown.open').forEach(m => {
                if (m !== menu) m.classList.remove('open');
            });
            menu.classList.toggle('open');
        });
    });

    document.querySelectorAll('.favorite-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const favs = getFavorites();
            const idx = favs.indexOf(id);
            if (idx > -1) {
                favs.splice(idx, 1);
                btn.classList.remove('active');
                btn.textContent = '☆ Add favorite';
            } else {
                favs.push(id);
                btn.classList.add('active');
                btn.textContent = '⭐ Remove favorite';
            }
            setFavorites(favs);
            const card = btn.closest('.resource-card');
            const doc = docMap.get(id);
            if (doc) {
                card.outerHTML = createResourceCard(doc);
                attachCardEventListeners();
            }
        });
    });

    document.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (!confirm('Delete this downloaded file?')) return;

            await db.deleteFileBlob(id);
            await db.deleteThumbnailBlob(id);

            const manifest = content.getDownloadManifest();
            delete manifest[id];
            content.setDownloadManifest(manifest);

            const cachedUrl = thumbnailCache.get(id);
            if (cachedUrl) URL.revokeObjectURL(cachedUrl);
            thumbnailCache.delete(id);

            removeDownloadedMeta(id);

            const doc = docMap.get(id);
            if (doc) {
                if (!navigator.onLine) {
                    loadOfflineResources();
                    applyFiltersAndRender();
                } else {
                    const card = btn.closest('.resource-card');
                    card.outerHTML = createResourceCard(doc);
                    attachCardEventListeners();
                }
            }
            ui.showToast('File deleted', 'success');
        });
    });
}

// Global outside-click handler – registered once per page lifetime
function handleGlobalClick(e) {
    if (!e.target.closest('.menu-wrapper')) {
        document.querySelectorAll('.menu-dropdown.open').forEach(m => m.classList.remove('open'));
    }
    if (!e.target.closest('.filter-wrapper')) {
        const dropdown = document.getElementById('filter-dropdown');
        if (dropdown) dropdown.classList.remove('open');
    }
}

// ==================== THUMBNAIL CACHING ====================
async function cacheThumbnail(resourceId, thumbnailUrl) {
    if (!thumbnailUrl) {
        console.warn(`[Thumbnail] No thumbnail URL for ${resourceId}`);
        return false;
    }

    if (thumbnailCache.has(resourceId)) return true;

    const existing = await db.getThumbnailBlob(resourceId);
    if (existing) {
        thumbnailCache.set(resourceId, URL.createObjectURL(existing));
        return true;
    }

    try {
        const response = await fetch(thumbnailUrl);
        if (!response.ok) throw new Error(`Thumbnail request failed: HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size) throw new Error('Thumbnail response was empty');

        await db.saveThumbnailBlob(resourceId, blob);
        thumbnailCache.set(resourceId, URL.createObjectURL(blob));
        console.log(`[Thumbnail] Cached: ${resourceId} (${blob.size} bytes)`);
        return true;
    } catch (err) {
        console.error(`[Thumbnail] Failed for ${resourceId}:`, err);
        return false;
    }
}

async function hydrateThumbnailCache(docs) {
    await Promise.all(
        docs.map(async (doc) => {
            const id = doc._id;
            if (thumbnailCache.has(id)) return;
            try {
                const blob = await db.getThumbnailBlob(id);
                if (!blob) return;
                thumbnailCache.set(id, URL.createObjectURL(blob));
            } catch (err) {
                console.warn(`[Thumbnail] Hydrate failed for ${id}:`, err);
            }
        })
    );
}

// ==================== DOWNLOAD ====================
async function startDownload(resourceId) {
    if (activeDownloads.has(resourceId)) {
        _logLine('download-skip', `already downloading ${resourceId}`, 'warn');
        return;
    }

    const card = document.querySelector(`.resource-card[data-id="${resourceId}"]`);
    if (!card) return;
    const actions = card.querySelector('.card-actions');
    const doc = docMap.get(resourceId);

    const mainBtn = actions.querySelector('.main-btn');
    mainBtn.innerHTML = `
        <div class="download-progress">
            <span class="spinner-small"></span>
            <span class="percent">0%</span>
        </div>
    `;
    mainBtn.disabled = true;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'main-btn btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.dataset.id = resourceId;
    actions.insertBefore(cancelBtn, actions.querySelector('.menu-wrapper'));

    const abortController = new AbortController();
    activeDownloads.set(resourceId, abortController);

    cancelBtn.addEventListener('click', () => {
        abortController.abort();
        activeDownloads.delete(resourceId);
        if (doc) {
            card.outerHTML = createResourceCard(doc);
            attachCardEventListeners();
        }
        ui.showToast('Download cancelled', 'info');
    });

    try {
        const token = getToken();
        if (!token) {
            ui.showToast('Please log in again.', 'warning');
            router.navigateTo('login');
            return;
        }

        _logLine('download-start', `id=${resourceId} isPremium=${doc ? doc.isPremium : '(no doc)'}`, 'info');

        const result = await convexHttpClient.action('resources/actions:getDownloadUrl', {
            token,
            resourceId
        });
        if (!result.success) {
            if (result.message && (result.message.includes('token') || result.message.includes('JWT'))) {
                ui.showToast('Session expired. Please log in again.', 'warning');
                await logout();
                router.navigateTo('login');
                return;
            }
            throw new Error(result.message);
        }

        const { downloadUrl, thumbnailUrl } = result.data;

        const response = await fetch(downloadUrl, { signal: abortController.signal });
        if (!response.ok) throw new Error('Download failed');

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        const percentEl = mainBtn.querySelector('.percent');

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (total) {
                const pct = Math.round((loaded / total) * 100);
                if (percentEl) percentEl.textContent = pct + '%';
            } else if (percentEl) {
                percentEl.textContent = (loaded / 1024).toFixed(1) + ' KB';
            }
        }

        const blob = new Blob(chunks);
        await db.saveFileBlob(resourceId, blob);

        let thumbnailDownloaded = false;
        if (thumbnailUrl) {
            thumbnailDownloaded = await cacheThumbnail(resourceId, thumbnailUrl);
        }

        const manifest = content.getDownloadManifest();
        manifest[resourceId] = {
            downloadedAt: Date.now(),
            size: blob.size,
            mime: response.headers.get('content-type') || 'application/octet-stream',
            thumbnailDownloaded
        };
        content.setDownloadManifest(manifest);

        // Persisted metadata — this is where isPremium is written.
        saveDownloadedMeta(doc);

        if (doc) {
            card.outerHTML = createResourceCard(doc);
            attachCardEventListeners();
        }

        _logLine(
            'download-complete',
            `id=${resourceId} size=${blob.size} thumbnail=${thumbnailDownloaded} ` +
            `premiumWritten=${doc ? doc.isPremium === true : false}`,
            'ok'
        );

        ui.showToast(
            thumbnailDownloaded
                ? 'Download complete – available offline'
                : 'File downloaded – thumbnail could not be cached',
            thumbnailDownloaded ? 'success' : 'warning'
        );

    } catch (error) {
        if (error.name === 'AbortError') {
            _logLine('download-abort', `id=${resourceId}`, 'warn');
        } else {
            console.error('Download error:', error);
            ui.showToast('Download failed: ' + error.message, 'error');
            if (doc) {
                card.outerHTML = createResourceCard(doc);
                attachCardEventListeners();
            }
        }
    } finally {
        activeDownloads.delete(resourceId);
    }
}

// ==================== OFFLINE LOADING ====================
/**
 * Build the resource list purely from what has actually been downloaded.
 */
function loadOfflineResources() {
    const meta = getDownloadedMeta();
    const manifest = content.getDownloadManifest();

    const docs = Object.values(meta).filter(d => manifest && manifest[d._id]);

    if (_dbg()) {
        const allRecords = Object.values(meta);
        _log('offline-load', {
            totalPersistedRecords: allRecords.length,
            withManifestEntry: docs.length,
            records: allRecords.map(r => ({
                _id: r._id,
                title: r.title,
                isPremium: r.isPremium,
                typeofIsPremium: typeof r.isPremium,
                isStrictTrue: r.isPremium === true,
                hasManifest: !!(manifest && manifest[r._id]),
                keys: Object.keys(r),
            })),
        });
    }

    allDocuments = docs;
    docMap.clear();
    allDocuments.forEach(d => docMap.set(d._id, d));

    if (_dbg()) {
        _logLine(
            'offline-loaded',
            `docMap now has ${docMap.size} entries, ` +
            `${allDocuments.filter(d => d.isPremium === true).length} premium`,
            'info'
        );
    }

    currentCursor = null;
    hasMore = false;

    const loadMoreBtn = document.getElementById('load-more-btn');
    const loadMoreSpinner = document.getElementById('load-more-spinner');
    if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    if (loadMoreSpinner) loadMoreSpinner.style.display = 'none';
}

// ==================== LOAD RESOURCES ====================
async function loadResources(reset = true) {
    if (isLoading) return;
    isLoading = true;

    if (reset) {
        currentCursor = null;
        hasMore = true;
        allDocuments = [];
        const loadMoreBtn = document.getElementById('load-more-btn');
        const loadMoreSpinner = document.getElementById('load-more-spinner');
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
        if (loadMoreSpinner) loadMoreSpinner.style.display = 'none';
    } else {
        const loadMoreSpinner = document.getElementById('load-more-spinner');
        const loadMoreBtn = document.getElementById('load-more-btn');
        if (loadMoreSpinner) loadMoreSpinner.style.display = 'block';
        if (loadMoreBtn) loadMoreBtn.style.display = 'none';
    }

    let networkSucceeded = false;

    if (navigator.onLine) {
        try {
            console.log(`[ResourceBrowser] Fetching: subject=${currentSubject}, category=${currentCategory}, cursor=${currentCursor}`);

            const result = await content.fetchResources(
                currentSubject,
                currentCategory,
                currentCursor,
                {}
            );

            // ── DEBUG: what the backend actually returned ──────────────
            if (_dbg()) {
                const docs = result && Array.isArray(result.documents) ? result.documents : [];
                const premiumCount = docs.filter(d => d.isPremium === true).length;

                _log('backend-response', {
                    source: 'network',
                    subject: currentSubject,
                    category: currentCategory,
                    reset,
                    cursor: currentCursor,
                    hasMore: result && result.hasMore,
                    nextCursor: result && result.cursor,
                    receivedCount: docs.length,
                    premiumCount,
                    documents: docs.map(_summariseDoc),
                }, premiumCount > 0 ? 'ok' : 'warn');

                _logLine(
                    'backend-summary',
                    `received ${docs.length} docs, ${premiumCount} with isPremium === true`,
                    premiumCount > 0 ? 'ok' : 'fail'
                );
            }

            if (reset) {
                allDocuments = result.documents;
            } else {
                allDocuments = allDocuments.concat(result.documents);
            }
            allDocuments.forEach(d => docMap.set(d._id, d));

            currentCursor = result.cursor;
            hasMore = result.hasMore;

            const loadMoreBtn = document.getElementById('load-more-btn');
            if (loadMoreBtn) loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
            const loadMoreSpinner = document.getElementById('load-more-spinner');
            if (loadMoreSpinner) loadMoreSpinner.style.display = 'none';

            networkSucceeded = true;

            // ── DEBUG: docMap state after mapping ──────────────────────
            if (_dbg()) {
                _log('docMap-after-map', {
                    source: 'network',
                    totalInAllDocuments: allDocuments.length,
                    totalInDocMap: docMap.size,
                    premiumInDocMap: Array.from(docMap.values()).filter(d => d.isPremium === true).length,
                    documents: allDocuments.map(_summariseDoc),
                });
            }

        } catch (error) {
            console.warn('[ResourceBrowser] Network fetch failed, falling back to offline set:', error);
            _logLine('network-failed', String(error && error.message || error), 'fail');
        }
    } else {
        _logLine('network-skip', 'navigator.onLine === false', 'warn');
    }

    if (!networkSucceeded) {
        loadOfflineResources();
    }

    isLoading = false;

    await hydrateThumbnailCache(allDocuments);
    applyFiltersAndRender();
}

// ==================== VIEWER ====================
/**
 * Open a resource in the embedded viewer.
 *
 * @param {string} docId
 * @param {string} title
 * @param {string} fileType
 * @param {{ previewMode?: boolean }|null} [opts]
 */
export function showViewer(docId, title, fileType, opts = null) {
    if (_dbg()) {
        _logLine(
            'showViewer',
            `id=${docId} title="${title}" type=${fileType} ` +
            `previewMode=${opts && opts.previewMode === true}`,
            opts && opts.previewMode === true ? 'warn' : 'ok'
        );
    }
    viewer.showEmbeddedViewer(docId, title, fileType, opts);
}

export function closeViewer() {
    viewer.closeEmbeddedViewer();
}

// ==================== CONNECTIVITY LISTENERS ====================
let connectivityListenersAttached = false;
function attachConnectivityListeners() {
    if (connectivityListenersAttached) return;
    connectivityListenersAttached = true;

    window.addEventListener('online', () => {
        ui.showToast('Back online', 'success');
        loadResources(true);
    });
    window.addEventListener('offline', () => {
        ui.showToast('Offline – showing downloaded resources only', 'info');
        loadResources(true);
    });
}

// ==================== INIT ====================
export async function initResourceBrowser(subject, type, forceRefresh = false) {
    console.log(`[ResourceBrowser] init: subject=${subject}, type=${type}, forceRefresh=${forceRefresh}`);

    const pageTitle = document.getElementById('page-title');
    if (!pageTitle) {
        console.error('[ResourceBrowser] page-title element not found!');
        return;
    }

    currentSubject = subject;
    currentCategory = CATEGORY_MAP[type] || type;

    const typeName = TYPE_NAMES[type] || 'Resources';
    pageTitle.textContent = `${typeName} – ${subject}`;

    if (_dbg()) {
        _logLine('init', `subject=${subject} category=${currentCategory} debug=ON`, 'info');
    }

    await loadResources(true);

    const newSearchInput = document.getElementById('search-input');
    if (newSearchInput) {
        newSearchInput.oninput = null;
        newSearchInput.addEventListener('input', debounce(() => applyFiltersAndRender(), 300));
    }

    const newFilterBtn = document.getElementById('filter-btn');
    if (newFilterBtn) {
        newFilterBtn.onclick = (e) => {
            e.stopPropagation();
            const dropdown = document.getElementById('filter-dropdown');
            if (dropdown) dropdown.classList.toggle('open');
        };
    }

    const dropdown = document.getElementById('filter-dropdown');
    if (dropdown) {
        dropdown.querySelectorAll('button').forEach(btn => {
            btn.onclick = () => {
                currentFilter = btn.dataset.filter;
                dropdown.querySelectorAll('button').forEach(b => b.classList.remove('active-filter'));
                btn.classList.add('active-filter');
                dropdown.classList.remove('open');
                applyFiltersAndRender();
            };
        });
    }

    const newLoadMoreBtn = document.getElementById('load-more-btn');
    if (newLoadMoreBtn) {
        newLoadMoreBtn.onclick = () => {
            if (!navigator.onLine) return;
            loadResources(false);
        };
    }

    document.removeEventListener('click', handleGlobalClick);
    document.addEventListener('click', handleGlobalClick);

    attachConnectivityListeners();
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}