// scripts/resource-browser.js

/**
 * Resource Browser Module
 * - Displays resources with public thumbnails (no caching).
 * - When user downloads a file, the thumbnail is also downloaded and cached offline.
 * - Downloaded thumbnails are shown from cache; undownloaded ones use the public URL.
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

// Thumbnail cache – maps resourceId -> object URL (only for downloaded items)
const thumbnailCache = new Map();

// ==================== FAVORITES HELPERS ====================
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

// ==================== RENDER FUNCTIONS ====================
function applyFiltersAndRender() {
    const grid = document.getElementById('resource-grid');
    if (!grid) {
        console.error('[ResourceBrowser] resource-grid not found!');
        return;
    }
    const filtered = filterDocuments(allDocuments, currentFilter, document.getElementById('search-input').value);
    if (filtered.length === 0) {
        grid.innerHTML = '<div class="no-data">No resources match your criteria.</div>';
        return;
    }
    grid.innerHTML = filtered.map(doc => createResourceCard(doc)).join('');
    attachCardEventListeners();
}

function getThumbnailSrc(doc) {
    if (thumbnailCache.has(doc._id)) {
        return thumbnailCache.get(doc._id);
    }
    if (doc.thumbnailUrl) {
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
        mainBtnHtml = `<button class="main-btn btn-open" data-id="${doc._id}" data-title="${doc.title}" data-type="${doc.fileType}">Open</button>`;
    } else {
        mainBtnHtml = `<button class="main-btn btn-download" data-id="${doc._id}">⬇ Download</button>`;
    }

    const favBadgeHtml = isFav ? '<div class="favorite-badge">⭐</div>' : '';

    const thumbSrc = getThumbnailSrc(doc);
    const thumbnailHtml = thumbSrc
        ? `<img src="${thumbSrc}" alt="Thumbnail" loading="lazy">`
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
        btn.addEventListener('click', async (e) => {
            const id = btn.dataset.id;
            const doc = docMap.get(id);

            // ===== OPEN =====
            if (btn.classList.contains('btn-open')) {
                // ✅ Check subscription only for premium resources
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
            // ✅ Check subscription only for premium resources
            if (doc && doc.isPremium) {
                const hasActive = await subscription.hasActiveSubscription();
                if (!hasActive) {
                    ui.showToast('Subscription required to download this premium resource', 'warning');
                    router.navigateTo('subscription');
                    return;
                }
            }
            // For free resources, proceed without subscription check
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
            // Remove file blob and thumbnail blob
            await db.deleteFileBlob(id);
            await db.deleteThumbnailBlob(id);
            const manifest = content.getDownloadManifest();
            delete manifest[id];
            content.setDownloadManifest(manifest);
            thumbnailCache.delete(id);
            const doc = docMap.get(id);
            if (doc) {
                const card = btn.closest('.resource-card');
                card.outerHTML = createResourceCard(doc);
                attachCardEventListeners();
            }
            ui.showToast('File deleted', 'success');
        });
    });

    document.addEventListener('click', () => {
        document.querySelectorAll('.menu-dropdown.open').forEach(m => m.classList.remove('open'));
    });
}

// ==================== THUMBNAIL CACHING ====================
async function cacheThumbnail(resourceId, thumbnailUrl) {
    if (!thumbnailUrl) {
        console.warn(`[Thumbnail] No thumbnail URL for ${resourceId}`);
        return false;
    }

    if (thumbnailCache.has(resourceId)) {
        return true;
    }

    const existing = await db.getThumbnailBlob(resourceId);
    if (existing) {
        const url = URL.createObjectURL(existing);
        thumbnailCache.set(resourceId, url);
        return true;
    }

    try {
        const response = await fetch(thumbnailUrl);
        if (!response.ok) {
            throw new Error(`Thumbnail request failed: HTTP ${response.status}`);
        }
        const blob = await response.blob();
        if (!blob.size) {
            throw new Error('Thumbnail response was empty');
        }

        await db.saveThumbnailBlob(resourceId, blob);
        const url = URL.createObjectURL(blob);
        thumbnailCache.set(resourceId, url);

        console.log(`[Thumbnail] Cached successfully: ${resourceId} (${blob.size} bytes)`);
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
                const url = URL.createObjectURL(blob);
                thumbnailCache.set(id, url);
            } catch (err) {
                console.warn(`[Thumbnail] Failed to restore ${id}:`, err);
            }
        })
    );
}

// ==================== DOWNLOAD LOGIC ====================
async function startDownload(resourceId) {
    if (activeDownloads.has(resourceId)) return;

    const card = document.querySelector(`.resource-card[data-id="${resourceId}"]`);
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
            } else {
                if (percentEl) percentEl.textContent = (loaded / 1024).toFixed(1) + ' KB';
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

        if (doc) {
            card.outerHTML = createResourceCard(doc);
            attachCardEventListeners();
        }

        ui.showToast(
            thumbnailDownloaded
                ? 'Download complete'
                : 'File downloaded, but thumbnail could not be cached',
            thumbnailDownloaded ? 'success' : 'warning'
        );

    } catch (error) {
        if (error.name === 'AbortError') {
            // handled
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

    try {
        console.log(`[ResourceBrowser] Fetching resources: subject=${currentSubject}, category=${currentCategory}, cursor=${currentCursor}`);
        const result = await content.fetchResources(
            currentSubject,
            currentCategory,
            currentCursor,
            {}
        );
        console.log('[ResourceBrowser] fetchResources result:', result);

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
        isLoading = false;

        await hydrateThumbnailCache(allDocuments);

        applyFiltersAndRender();
    } catch (error) {
        console.error('[ResourceBrowser] Error loading resources:', error);
        ui.showToast('Failed to load resources: ' + error.message, 'error');
        isLoading = false;
        const grid = document.getElementById('resource-grid');
        if (grid) {
            grid.innerHTML = `<div class="error-message">Error loading resources: ${error.message}</div>`;
        }
    }
}

// ==================== VIEWER COORDINATION ====================
export function showViewer(docId, title, fileType) {
    viewer.showEmbeddedViewer(docId, title, fileType);
}

export function closeViewer() {
    viewer.closeEmbeddedViewer();
}

// ==================== INITIALIZATION ====================
export async function initResourceBrowser(subject, type, forceRefresh = false) {
    console.log(`[ResourceBrowser] initResourceBrowser called: subject=${subject}, type=${type}, forceRefresh=${forceRefresh}`);

    const pageTitle = document.getElementById('page-title');
    const searchInput = document.getElementById('search-input');
    const filterBtn = document.getElementById('filter-btn');
    const filterDropdown = document.getElementById('filter-dropdown');
    const loadMoreBtn = document.getElementById('load-more-btn');
    const loadMoreSpinner = document.getElementById('load-more-spinner');

    if (!pageTitle) {
        console.error('[ResourceBrowser] page-title element not found!');
        return;
    }

    currentSubject = subject;
    currentCategory = CATEGORY_MAP[type] || type;
    console.log(`[ResourceBrowser] currentSubject=${currentSubject}, currentCategory=${currentCategory}`);

    const typeName = TYPE_NAMES[type] || 'Resources';
    pageTitle.textContent = `${typeName} – ${subject}`;
    console.log(`[ResourceBrowser] Title set to: ${pageTitle.textContent}`);

    await loadResources(true);

    // ---- Event listeners ----
    const newSearchInput = document.getElementById('search-input');
    if (newSearchInput) {
        newSearchInput.removeEventListener('input', searchHandler);
        newSearchInput.addEventListener('input', debounce(() => applyFiltersAndRender(), 300));
    }

    const newFilterBtn = document.getElementById('filter-btn');
    if (newFilterBtn) {
        newFilterBtn.removeEventListener('click', filterToggleHandler);
        newFilterBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const dropdown = document.getElementById('filter-dropdown');
            if (dropdown) dropdown.classList.toggle('open');
        });
    }

    const dropdown = document.getElementById('filter-dropdown');
    if (dropdown) {
        dropdown.querySelectorAll('button').forEach(btn => {
            btn.removeEventListener('click', filterSelectHandler);
            btn.addEventListener('click', () => {
                currentFilter = btn.dataset.filter;
                dropdown.querySelectorAll('button').forEach(b => b.classList.remove('active-filter'));
                btn.classList.add('active-filter');
                dropdown.classList.remove('open');
                applyFiltersAndRender();
            });
        });
    }

    const newLoadMoreBtn = document.getElementById('load-more-btn');
    if (newLoadMoreBtn) {
        newLoadMoreBtn.removeEventListener('click', loadMoreHandler);
        newLoadMoreBtn.addEventListener('click', () => loadResources(false));
    }

    document.removeEventListener('click', closeDropdownHandler);
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.filter-wrapper')) {
            const dropdown = document.getElementById('filter-dropdown');
            if (dropdown) dropdown.classList.remove('open');
        }
    });

    function searchHandler(e) { applyFiltersAndRender(); }
    function filterToggleHandler(e) { /* handled inline */ }
    function filterSelectHandler(e) { /* handled inline */ }
    function loadMoreHandler(e) { loadResources(false); }
    function closeDropdownHandler(e) { /* handled inline */ }
}

function debounce(fn, delay) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}