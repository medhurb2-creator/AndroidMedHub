// scripts/resource-browser.js

/**
 * Resource Browser Module
 *
 * Offline guarantees:
 *   - Downloaded FILES live in IndexedDB (db.saveFileBlob) → openable offline.
 *   - Downloaded THUMBNAILS live in IndexedDB (db.saveThumbnailBlob) → visible offline.
 *   - Downloaded METADATA lives in localStorage (DOWNLOADED_META_KEY) → cards render offline.
 *   - Undownloaded catalogue items are NEVER persisted. Offline you see only what you saved.
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

function saveDownloadedMeta(doc) {
    if (!doc) return;
    const map = getDownloadedMeta();
    map[doc._id] = {
        _id: doc._id,
        title: doc.title,
        author: doc.author || '',
        year: doc.year || '',
        category: doc.category,
        fileType: doc.fileType,
        fileSize: doc.fileSize,
        isPremium: doc.isPremium || false,
        updatedAt: doc.updatedAt || Date.now()
        // thumbnailUrl omitted on purpose – offline we always use the cached blob
    };
    setDownloadedMeta(map);
}

function removeDownloadedMeta(id) {
    const map = getDownloadedMeta();
    delete map[id];
    setDownloadedMeta(map);
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
    const isPremium = doc.isPremium || false;

    let mainBtnHtml = '';
    if (isDownloaded) {
        // Open uses the cached blob → works offline
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

            // ===== OPEN (uses cached blob – works offline) =====
            if (btn.classList.contains('btn-open')) {
                if (doc && doc.isPremium) {
                    const hasActive = await subscription.hasActiveSubscription();
                    if (!hasActive) {
                        ui.showToast('Subscription required to open this premium resource', 'warning');
                        router.navigateTo('subscription');
                        return;
                    }
                }
                const title = btn.dataset.title || 'Document';
                const fileType = btn.dataset.type || 'pdf';
                viewer.openDocument(id, title, fileType);
                return;
            }

            // ===== DOWNLOAD =====
            if (!navigator.onLine) {
                ui.showToast('Cannot download while offline', 'warning');
                return;
            }
            if (doc && doc.isPremium) {
                const hasActive = await subscription.hasActiveSubscription();
                if (!hasActive) {
                    ui.showToast('Subscription required to download this premium resource', 'warning');
                    router.navigateTo('subscription');
                    return;
                }
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

            // Wipe file blob, thumbnail blob, manifest entry, meta entry, and object URL
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
                // If we're offline, the deleted item no longer exists in the
                // offline list. Rebuild the list from the remaining downloads.
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

/**
 * Restore object URLs for any thumbnails that live in IndexedDB.
 * Must complete BEFORE render so offline cards show their cached thumbnails.
 */
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
    if (activeDownloads.has(resourceId)) return;

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

        // --- File blob ---
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

        // --- Thumbnail blob (offline access) ---
        let thumbnailDownloaded = false;
        if (thumbnailUrl) {
            thumbnailDownloaded = await cacheThumbnail(resourceId, thumbnailUrl);
        }

        // --- Manifest ---
        const manifest = content.getDownloadManifest();
        manifest[resourceId] = {
            downloadedAt: Date.now(),
            size: blob.size,
            mime: response.headers.get('content-type') || 'application/octet-stream',
            thumbnailDownloaded
        };
        content.setDownloadManifest(manifest);

        // --- Persisted metadata (offline card rendering) ---
        saveDownloadedMeta(doc);

        if (doc) {
            card.outerHTML = createResourceCard(doc);
            attachCardEventListeners();
        }

        ui.showToast(
            thumbnailDownloaded
                ? 'Download complete – available offline'
                : 'File downloaded – thumbnail could not be cached',
            thumbnailDownloaded ? 'success' : 'warning'
        );

    } catch (error) {
        if (error.name === 'AbortError') {
            // handled by cancel handler
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
 * Every entry must have BOTH persisted metadata AND a manifest entry
 * (i.e. a real blob in IndexedDB) — otherwise it can't be opened offline
 * and doesn't belong here.
 *
 * IMPORTANT: this does NOT touch currentFilter. Because allDocuments is
 * already restricted to downloaded items, whatever filter the user has
 * selected ('all', 'favorites', 'downloaded', 'recent') continues to
 * work correctly without hijacking the UI state.
 */
function loadOfflineResources() {
    const meta = getDownloadedMeta();
    const manifest = content.getDownloadManifest();

    const docs = Object.values(meta).filter(d => manifest && manifest[d._id]);

    allDocuments = docs;
    docMap.clear();
    allDocuments.forEach(d => docMap.set(d._id, d));

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

    // ---------- Try network first (do NOT trust navigator.onLine alone) ----------
    if (navigator.onLine) {
        try {
            console.log(`[ResourceBrowser] Fetching: subject=${currentSubject}, category=${currentCategory}, cursor=${currentCursor}`);
            const result = await content.fetchResources(
                currentSubject,
                currentCategory,
                currentCursor,
                {}
            );

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
        } catch (error) {
            console.warn('[ResourceBrowser] Network fetch failed, falling back to offline set:', error);
        }
    }

    // ---------- Offline fallback (only if network didn't succeed) ----------
    if (!networkSucceeded) {
        loadOfflineResources();
    }

    isLoading = false;

    // Hydrate thumbnails from IndexedDB BEFORE rendering so downloaded files
    // show their cached thumbnail even without connectivity.
    await hydrateThumbnailCache(allDocuments);
    applyFiltersAndRender();
}

// ==================== VIEWER ====================
export function showViewer(docId, title, fileType) {
    viewer.showEmbeddedViewer(docId, title, fileType);
}

export function closeViewer() {
    viewer.closeEmbeddedViewer();
}

// ==================== CONNECTIVITY LISTENERS ====================
// Attached exactly once across the page lifetime, regardless of how many
// times initResourceBrowser() runs.
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

    await loadResources(true);

    // ---- Search ----
    const newSearchInput = document.getElementById('search-input');
    if (newSearchInput) {
        // Replace node value handlers safely by removing then adding
        newSearchInput.oninput = null;
        newSearchInput.addEventListener('input', debounce(() => applyFiltersAndRender(), 300));
    }

    // ---- Filter dropdown ----
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

    // ---- Load more ----
    const newLoadMoreBtn = document.getElementById('load-more-btn');
    if (newLoadMoreBtn) {
        newLoadMoreBtn.onclick = () => {
            if (!navigator.onLine) return; // no more pages offline
            loadResources(false);
        };
    }

    // ---- Global outside-click handler (idempotent) ----
    document.removeEventListener('click', handleGlobalClick);
    document.addEventListener('click', handleGlobalClick);

    // ---- Connectivity auto-refresh (attach once) ----
    attachConnectivityListeners();
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}