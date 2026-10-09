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
 * Path scoping (subject + category):
 *   Downloads and favorites are BOUND TO THE PATH THEY WERE CREATED IN.
 *   A resource downloaded while viewing Anatomy → notes is only ever
 *   surfaced under Anatomy → notes. It will not appear in Physiology →
 *   textbooks, nor under any other subject/category combination, neither
 *   in the "Downloaded" filter nor in the offline-only fallback view.
 *
 *   This is enforced in `getDownloadedDocuments()` and `getFavoriteDocuments()`
 *   by comparing each persisted record's `subject`/`category` against the
 *   currently-active `currentSubject`/`currentCategory`. The persisted
 *   record already carries both fields (written verbatim by
 *   `saveDownloadedMeta`), and `currentCategory` is the same normalized
 *   value that was written, so the comparison is apples-to-apples.
 *
 * Sorting:
 *   Documents are sorted alphabetically by title — case-insensitive, locale-
 *   aware, with natural numeric ordering so "Chapter 2" precedes "Chapter 10".
 *   This applies to every filter EXCEPT "recent", which sorts by updatedAt
 *   descending (newest first) with a title tie-breaker.
 *
 *   Sorting happens at render time in `sortDocuments()`, which is the single
 *   authoritative point of order. Filter sources (loaded docs, persisted
 *   downloads, persisted favorites) all funnel through it, so display order
 *   is consistent regardless of where the data came from.
 *
 * Filter sourcing:
 *   The "Downloaded" and "Favorites" filters do NOT filter the loaded list.
 *   They read directly from their persisted sources (localStorage), so a
 *   download or favorite from page 5 of the SAME subject/category is visible
 *   even when only page 1 is loaded. Cross-path leakage is prevented by the
 *   subject/category scoping described above.
 *
 * Pagination on revisit:
 *   The in-memory catalogue cache (in content.js) preserves cursor and
 *   hasMore, so revisiting a subject shows the first page WITH a working
 *   "Load more" button — not a silently truncated list.
 *
 * Offline race handling:
 *   When the browser goes offline mid-fetch, the in-flight response is
 *   discarded and the offline-only set is rendered. This is done by
 *   checking navigator.onLine after every await boundary.
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
 * Open-button feedback:
 *   When the user taps "Open", the button immediately enters an inline
 *   "Opening…" state — a small spinner and a short label, contained
 *   entirely within the button. This gives the tap immediate visual
 *   confirmation while the entitlement check, blob resolution, and viewer
 *   boot happen asynchronously. On failure the button is restored and a
 *   toast reports the error. On success the viewer takes over the screen
 *   and the button's state becomes irrelevant.
 *
 *   The inline state deliberately does NOT use the global overlay spinner,
 *   which would hide the whole grid and give no per-card context. Every
 *   card can be loading independently; the user always knows which one is
 *   working.
 *
 * Premium badge display policy:
 *   The 🔒 Premium badge is INFORMATIONAL ONLY. It is rendered on a card
 *   only when the resource is premium AND the user currently has no active
 *   subscription or free trial. Subscribers and trial users do not see it,
 *   since the badge would be misleading (they already have access).
 *
 *   This never affects functionality: the Open handler and the Download
 *   handler still call subscription.hasActiveSubscription() themselves and
 *   remain the sole authority on entitlement. The cached flag below is a
 *   presentation hint only.
 *
 * Share links (deep link, not a premium or download feature):
 *   A card's ⋮ menu exposes "🔗 Share". Sharing builds a compact URL from
 *   the document's identity so the recipient lands directly on it instead
 *   of browsing for it.
 *
 *   URL shape:
 *     https://app.medvix.co.ke/resource-browser?subject=<s>&type=<t>&share=1&id=<_id>
 *
 *   The origin is FIXED to the production domain — not whatever host the
 *   sharer happens to be browsing from. During local development the app
 *   runs at localhost:3001, but a link with that origin is useless to the
 *   recipient. See SHARE_ORIGIN below.
 *
 *   Landing flow (no auto-download, no auto-open, no premium decision here):
 *     1. initResourceBrowser() runs first — routing + page 1 fetch.
 *     2. Share params consumed:
 *          • If the id is already in docMap → use the real doc, no
 *            network call.
 *          • Miss → content.fetchResourceById(id), which queries
 *            `resources/queries:getResource` (public, no auth) and
 *            returns the canonical public shape.
 *          • Null → toast "Shared document not found", stop.
 *     3. The recipient sees the shared document rendered as a normal card
 *        in the grid, highlighted so they can identify it, and a toast
 *        naming it. The filter is reset to "all" and any active search
 *        term cleared so the card is guaranteed visible.
 *     4. Strip share params from the URL.
 *     5. Nothing else happens. The recipient decides whether to Download
 *        the resource (which stores the blob in IndexedDB, enabling
 *        offline access) or, once downloaded, to Open it in the viewer.
 *
 *   Why no auto-open:
 *     Opening a share link on an undownloaded resource would force the
 *     recipient to fetch the entire file just to look at page 1, without
 *     asking. That is a silent bandwidth cost on someone else's device.
 *     The card gives the recipient full metadata — title, author, file
 *     size, premium status, download state — so they can make the
 *     decision themselves. Every path from the card (Download, Open,
 *     favourite, share again) flows through the existing handlers that
 *     already implement entitlement, preview mode, and offline storage.
 *
 *   Native share (Android):
 *     Inside the Capacitor Android app the Web Share API is unreliable, so
 *     `shareResource` prefers the native `MedvixShare` plugin
 *     (com.medhurb.app.MedvixSharePlugin) when present. The plugin's
 *     `share({title, text, url, dialogTitle})` method opens the system
 *     chooser with the link as text/plain. On the web build it falls back
 *     to navigator.share, then to clipboard copy + toast.
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
const DOWNLOADED_META_KEY = 'downloaded_resource_meta';

// ==================== DIAGNOSTIC LOGGER ====================
// Zero-cost when disabled. Toggle with:
//   localStorage.setItem('debugPremium', '1')   → on
//   localStorage.removeItem('debugPremium')     → off
// Then reload the page.

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

function _log(tag, payload, level = 'info') {
    if (!_dbg()) return;
    const style = LOG_STYLE[level] || LOG_STYLE.info;
    try {
        console.groupCollapsed(`%c[premium:${tag}]`, style);
        console.log(payload);
        console.groupEnd();
    } catch { /* ignore */ }
}

function _logLine(tag, message, level = 'info') {
    if (!_dbg()) return;
    const style = LOG_STYLE[level] || LOG_STYLE.info;
    try {
        console.log(`%c[premium:${tag}]`, style, message);
    } catch { /* ignore */ }
}

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

// ==================== PATH KEY ====================
//
// Normalize the (subject, category) pair used to scope persisted downloads
// and favorites to the browsing path they were created in. With the current
// writers this is a no-op, but it protects against a future backend that
// ever normalizes casing or whitespace differently.
//
// @param {any} subject
// @param {any} category
// @returns {string}
function _pathKey(subject, category) {
    const s = String(subject == null ? '' : subject).trim().toLowerCase();
    const c = String(category == null ? '' : category).trim().toLowerCase();
    return `${s}::${c}`;
}

// ==================== STATE ====================
let currentSubject = null;
let currentCategory = null;
let currentCursor = null;
let isLoading = false;
let hasMore = true;
let currentFilter = 'all';
let allDocuments = [];
const activeDownloads = new Map();
export const docMap = new Map();

// resourceId -> object URL (thumbnail blobs we've hydrated or downloaded)
const thumbnailCache = new Map();

// ==================== SUBSCRIPTION STATE (DISPLAY ONLY) ====================
//
// The premium badge on a card is purely informational. We cache the user's
// entitlement here so the synchronous card renderer can decide whether to
// render the badge. This value NEVER gates functionality:
//   • the Open handler still calls subscription.hasActiveSubscription()
//     itself before choosing preview mode;
//   • the Download handler still calls it before allowing a premium fetch.
//
// Keeping a separate copy here means the two handlers remain the single
// authority on entitlement, and this is only a presentation hint.

let userHasActiveSubscription = false;

/**
 * Refresh the cached entitlement flag.
 * Swallows errors and keeps the previous value on failure, so a transient
 * offline blip never flips the badge on for a paying subscriber.
 *
 * @returns {Promise<boolean>} the (possibly stale on failure) flag
 */
async function refreshSubscriptionState() {
    try {
        userHasActiveSubscription =
            (await subscription.hasActiveSubscription()) === true;
    } catch {
        // Keep last known value.
    }
    if (_dbg()) {
        _logLine(
            'sub-state',
            `userHasActiveSubscription=${userHasActiveSubscription}`,
            userHasActiveSubscription ? 'ok' : 'warn'
        );
    }
    return userHasActiveSubscription;
}

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
        pathKey: _pathKey(doc.subject, doc.category),
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
    try {
        return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
    } catch {
        return [];
    }
}
function setFavorites(list) {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}
function isFavorite(id) {
    return getFavorites().includes(id);
}

// ==================== FILTER SOURCES ====================
//
// "Downloaded" and "Favorites" read directly from their persisted stores,
// NOT from the currently-loaded page. This makes both filters complete
// regardless of pagination WITHIN the current subject/category.
//
// Both helpers are SCOPED to the path (subject + category) currently being
// browsed. A download or favorite created in Anatomy → notes is invisible
// from any other path. The persisted record already carries subject and
// category (written verbatim by `saveDownloadedMeta`), and `currentCategory`
// is the same normalized value that was written, so the comparison is
// apples-to-apples.

function getDownloadedDocuments() {
    const meta = getDownloadedMeta();
    const manifest = content.getDownloadManifest() || {};

    const pathKey = _pathKey(currentSubject, currentCategory);

    return Object.values(meta).filter(d =>
        d &&
        manifest[d._id] &&
        _pathKey(d.subject, d.category) === pathKey
    );
}

function getFavoriteDocuments() {
    const favs = getFavorites();
    if (favs.length === 0) return [];
    const favSet = new Set(favs);

    const pathKey = _pathKey(currentSubject, currentCategory);

    /** @type {Map<string, object>} */
    const result = new Map();

    // Source 1: currently loaded catalogue docs. Already path-scoped by
    // construction (allDocuments is the current subject/category page set).
    allDocuments.forEach(d => {
        if (favSet.has(d._id)) result.set(d._id, d);
    });

    // Source 2: persisted downloaded metadata. Must be path-scoped here,
    // otherwise a favorite that is ALSO downloaded would leak across paths
    // (the store is global).
    const meta = getDownloadedMeta();
    const manifest = content.getDownloadManifest() || {};
    Object.values(meta).forEach(d => {
        if (!d || !favSet.has(d._id)) return;
        if (!manifest[d._id]) return;
        if (_pathKey(d.subject, d.category) !== pathKey) return;
        if (!result.has(d._id)) result.set(d._id, d);
    });

    return Array.from(result.values());
}

// ==================== FILTER ====================

/**
 * Apply filter and search to a document list. Does NOT sort — sorting is
 * applied separately by `sortDocuments()` so filter and order are
 * independent concerns.
 *
 * @param {Array<object>} docs
 * @param {string} filterType
 * @param {string} searchTerm
 * @returns {Array<object>}
 */
function filterDocuments(docs, filterType, searchTerm) {
    let filtered;

    switch (filterType) {
        case 'favorites':
            filtered = getFavoriteDocuments();
            break;
        case 'downloaded':
            filtered = getDownloadedDocuments();
            break;
        case 'recent':
            // Source is the loaded docs; sorting is applied later.
            filtered = docs.slice();
            break;
        case 'all':
        default:
            filtered = docs;
            break;
    }

    if (searchTerm && searchTerm.trim()) {
        const term = searchTerm.trim().toLowerCase();
        filtered = filtered.filter(d => (d.title || '').toLowerCase().includes(term));
    }

    return filtered;
}

// ==================== SORT ====================

/**
 * Sort documents for display.
 *
 * Default: alphabetical by title — case-insensitive, locale-aware, with
 * natural numeric ordering so "Chapter 2" precedes "Chapter 10". Documents
 * with empty titles sort last.
 *
 * The "recent" sort mode uses updatedAt (falling back to uploadedAt)
 * descending, with a title tie-breaker for stable ordering when timestamps
 * are equal.
 *
 * Returns a new array; does not mutate the input.
 *
 * @param {Array<object>} docs
 * @param {string} sortMode
 * @returns {Array<object>}
 */
function sortDocuments(docs, sortMode) {
    const copy = docs.slice();

    if (sortMode === 'recent') {
        return copy.sort((a, b) => {
            const ta = Number(a.updatedAt || a.uploadedAt || 0);
            const tb = Number(b.updatedAt || b.uploadedAt || 0);
            if (tb !== ta) return tb - ta;
            return _compareTitles(a.title, b.title);
        });
    }

    return copy.sort((a, b) => _compareTitles(a.title, b.title));
}

/**
 * Compare two titles for alphabetical ordering.
 * @private
 * @param {any} a
 * @param {any} b
 * @returns {number}
 */
function _compareTitles(a, b) {
    const ta = String(a == null ? '' : a).trim();
    const tb = String(b == null ? '' : b).trim();
    // Empty titles sort to the end, not the beginning.
    if (!ta && !tb) return 0;
    if (!ta) return 1;
    if (!tb) return -1;
    try {
        return ta.localeCompare(tb, undefined, { numeric: true, sensitivity: 'base' });
    } catch {
        // Fallback for engines without localeCompare options.
        const la = ta.toLowerCase();
        const lb = tb.toLowerCase();
        return la < lb ? -1 : la > lb ? 1 : 0;
    }
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

    // Filter, then sort. Order is applied uniformly to every filter source.
    const filtered = sortDocuments(
        filterDocuments(allDocuments, currentFilter, term),
        currentFilter,
    );

    if (_dbg()) {
        _log('render', {
            currentFilter,
            searchTerm: term,
            pathKey: _pathKey(currentSubject, currentCategory),
            totalInAllDocuments: allDocuments.length,
            afterFilter: filtered.length,
            premiumInFiltered: filtered.filter(d => d.isPremium === true).length,
            userHasActiveSubscription,
            firstFiveTitles: filtered.slice(0, 5).map(d => d.title),
        });
    }

    if (filtered.length === 0) {
        let emptyMsg;
        if (currentFilter === 'downloaded') {
            emptyMsg = 'No downloaded resources yet for this section.';
        } else if (currentFilter === 'favorites') {
            emptyMsg = 'No favorites yet for this section.';
        } else if (!navigator.onLine) {
            emptyMsg = 'You are offline and have no downloaded resources for this section.';
        } else {
            emptyMsg = 'No resources match your criteria.';
        }
        grid.innerHTML = `<div class="no-data">${emptyMsg}</div>`;
        return;
    }

    grid.innerHTML = filtered.map(doc => createResourceCard(doc)).join('');
    attachCardEventListeners();
}

/**
 * Thumbnail resolution order:
 *   1. Cached blob object URL (works offline) — always preferred
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

    // ── Display-only gate ───────────────────────────────────────────
    // The 🔒 Premium badge is shown ONLY when the resource is premium AND
    // the user currently lacks an active subscription / free trial.
    // This is cosmetic; it does not affect the Open or Download handlers,
    // which each re-check entitlement via subscription.hasActiveSubscription().
    const showPremiumBadge = isPremium && !userHasActiveSubscription;

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
                    ${showPremiumBadge ? '<span class="premium-badge">🔒 Premium</span>' : ''}
                    ${isDownloaded ? '<span class="downloaded-badge">✅ Downloaded</span>' : ''}
                </div>
                <div class="card-actions">
                    ${mainBtnHtml}
                    <div class="menu-wrapper">
                        <button class="menu-btn" data-id="${doc._id}">⋮</button>
                        <div class="menu-dropdown" data-id="${doc._id}">
                            <button class="share-btn" data-id="${doc._id}">🔗 Share</button>
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

// ==================== OPEN-BUTTON FEEDBACK ====================

/**
 * Put an Open button into a visible inline "Opening…" state.
 *
 * The spinner is the same 14px border spinner the download button uses,
 * scoped to the button rather than the whole screen. This is the point:
 * the user tapped a specific card, and the feedback should stay on that
 * card, not blank out the rest of the grid with a full-screen overlay.
 *
 * The original innerHTML is stashed on the element so _restoreButton can
 * put it back verbatim without reconstructing the "Open" markup.
 *
 * @param {HTMLButtonElement|null} btn
 */
function _setButtonOpening(btn) {
    if (!btn) return;
    if (!btn.dataset.originalHtml) {
        btn.dataset.originalHtml = btn.innerHTML;
    }
    btn.disabled = true;
    btn.classList.add('btn-loading');
    btn.innerHTML = `
        <div class="open-progress">
            <span class="spinner-small"></span>
            <span class="open-label">Opening…</span>
        </div>
    `;
}

/**
 * Restore an Open button to its original state.
 *
 * Called only on failure paths. On success the viewer takes over the
 * screen and the button's state no longer matters — leaving it in the
 * loading state is fine and avoids a visible flicker of "Open" →
 * "Opening…" → "Open" → screen change.
 *
 * @param {HTMLButtonElement|null} btn
 */
function _restoreButton(btn) {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('btn-loading');
    if (btn.dataset.originalHtml) {
        btn.innerHTML = btn.dataset.originalHtml;
        delete btn.dataset.originalHtml;
    }
}

// ==================== SHARE-HIGHLIGHT FEEDBACK ====================

/**
 * Scroll a card into view and pulse it briefly so the recipient of a share
 * link can see exactly which document the link points at. Purely cosmetic —
 * the card is fully interactive either way.
 *
 * Called only from the share-landing flow. Removes the highlight class
 * after a few seconds; the outline disappears and the card looks identical
 * to every other card in the grid.
 *
 * @param {string} id
 */
function _highlightSharedCard(id) {
    try {
        const card = document.querySelector(`.resource-card[data-id="${id}"]`);
        if (!card) return;

        card.classList.add('shared-highlight');

        try {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch {
            try { card.scrollIntoView(); } catch { /* ignore */ }
        }

        setTimeout(() => {
            try { card.classList.remove('shared-highlight'); } catch { /* ignore */ }
        }, 4000);
    } catch { /* ignore */ }
}

// ==================== SHARE ====================
//
// Share is a deep link, not a premium or download feature. Its only job:
// land the recipient on the exact document so they don't have to browse
// for it. Nothing is downloaded, nothing is stored, no premium decision is
// made here.
//
// URL shape:
//   https://app.medvix.co.ke/resource-browser?subject=<s>&type=<t>&share=1&id=<_id>
//
// Origin policy:
//   The share URL ALWAYS points at the production origin, regardless of
//   where the app is currently being served from. During local dev the app
//   runs at http://localhost:3001, but a link with that origin is useless
//   to the recipient. Change SHARE_ORIGIN only if the app moves.
//
// Landing flow:
//   1. initResourceBrowser() runs first — routing + page 1 fetch as normal.
//   2. Share params consumed:
//        • If the id is already in docMap (it landed on a loaded page),
//          use the real doc. No network call.
//        • Miss → content.fetchResourceById(id), which queries
//          `resources/queries:getResource` (public, no auth) and returns
//          the canonical public shape.
//        • Null → toast "Shared document not found", stop.
//   3. The shared card is injected into the grid (if not already present),
//      the filter is reset to "all", any active search is cleared, the
//      card is scrolled into view and briefly highlighted, and a toast
//      names it. NO viewer is opened. NO download is started.
//   4. Strip share params from the URL.
//
// Native share (Android):
//   Inside the Capacitor Android app, `shareResource` prefers the native
//   `MedvixShare` plugin (com.medhurb.app.MedvixSharePlugin). Its `share`
//   method takes {title, text, url, dialogTitle} and opens the system
//   chooser with the link as text/plain. On web builds it falls back to
//   navigator.share, then to clipboard copy + toast.

const SHARE_PARAM = 'share';
const SHARE_ORIGIN = 'https://app.medvix.co.ke';
const SHARE_PATH = '/resource-browser';
const SHARE_NATIVE_PLUGIN = 'MedvixShare';

/** Map a category (e.g. 'pastpapers') back to its route `type` ('pastpaper'). */
function _categoryToType(category) {
    for (const [type, cat] of Object.entries(CATEGORY_MAP)) {
        if (cat === category) return type;
    }
    return category;
}

function buildShareUrl(doc) {
    // Always build against the production origin + route, not whatever
    // host the sharer happens to be browsing from.
    const params = new URLSearchParams();
    params.set('subject', String(doc.subject ?? ''));
    params.set('type', String(_categoryToType(doc.category)));
    params.set(SHARE_PARAM, '1');
    params.set('id', String(doc._id));

    return `${SHARE_ORIGIN}${SHARE_PATH}?${params.toString()}`;
}

/** Parse the current URL. Returns `{id}` or null. */
function readSharedDocFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get(SHARE_PARAM) !== '1') return null;
        const id = params.get('id');
        if (!id) return null;
        return { id };
    } catch (err) {
        console.warn('[Share] Failed to parse share params:', err);
        return null;
    }
}

/** Strip share params from the URL after consumption. */
function clearSharedDocFromUrl() {
    try {
        const url = new URL(window.location.href);
        for (const key of [SHARE_PARAM, 'id']) {
            url.searchParams.delete(key);
        }
        const qs = url.searchParams.toString();
        const next = url.pathname + (qs ? '?' + qs : '') + url.hash;
        history.replaceState(null, '', next);
    } catch { /* ignore */ }
}

/**
 * Return the native MedvixShare plugin if we're running inside the
 * Capacitor Android app. Returns null on the web build.
 */
function _getNativeSharePlugin() {
    try {
        const cap = window.Capacitor;
        if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return null;
        const plugins = cap.Plugins || {};
        const plugin = plugins[SHARE_NATIVE_PLUGIN];
        if (plugin && typeof plugin.share === 'function') return plugin;
    } catch { /* ignore */ }
    return null;
}

async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through */ }

    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

/**
 * Share a card.
 *
 * Preference order:
 *   1. Native MedvixShare plugin (Android app) — reliable in the WebView.
 *   2. Web Share API (navigator.share) — modern mobile browsers.
 *   3. Clipboard copy + toast — desktop / older browsers.
 *
 * Only needs `_id`, `subject`, and `category`.
 *
 * @param {object} doc
 */
async function shareResource(doc) {
    if (!doc) {
        ui.showToast('Unable to share: document not found', 'warning');
        return;
    }

    const url = buildShareUrl(doc);
    const shareTitle = doc.title || 'Shared document';
    const shareText = `Check out this resource: ${doc.title || ''}`;

    if (_dbg()) {
        _logLine('share', `id=${doc._id} url=${url}`, 'info');
    }

    // ── 1. Native plugin ───────────────────────────────────────────
    const native = _getNativeSharePlugin();
    if (native) {
        try {
            await native.share({
                title: shareTitle,
                text: shareText,
                url,
                dialogTitle: 'Share document',
            });
            if (_dbg()) _logLine('share', 'native plugin invoked', 'ok');
            return;
        } catch (err) {
            if (_dbg()) _logLine('share', `native plugin failed: ${err && err.message}`, 'warn');
            // fall through
        }
    }

    // ── 2. Web Share API ───────────────────────────────────────────
    if (navigator.share) {
        try {
            await navigator.share({
                title: shareTitle,
                text: shareText,
                url,
            });
            return;
        } catch (err) {
            if (err && err.name === 'AbortError') return;
            // fall through
        }
    }

    // ── 3. Clipboard ───────────────────────────────────────────────
    const ok = await copyToClipboard(url);
    if (ok) {
        ui.showToast('Share link copied to clipboard', 'success');
    } else {
        try { window.prompt('Copy this link to share:', url); } catch { /* ignore */ }
    }
}

/**
 * Resolve a shared id to a real document, inject it into the grid so the
 * recipient sees it as a normal card, and stop there.
 *
 * NO viewer is opened. NO download is started. The recipient gets the
 * card with full metadata (title, author, size, premium badge, download
 * state) and decides what to do with it — Download, Open (once
 * downloaded), favourite, or nothing. Every one of those paths flows
 * through the existing card handlers, which already implement
 * entitlement checks, preview mode, and offline storage.
 *
 * Called from two places:
 *   • initResourceBrowser() on cold start, when the URL carries share
 *     params.
 *   • _handleShareIfPresent() in pages/resource-browser.js, which
 *     re-invokes initResourceBrowser() for warm-start arrivals (native
 *     share intent while the page is already up, or browser
 *     back/forward onto a share URL).
 *
 * @param {{id: string}} share
 */
async function _consumeSharedDoc(share) {
    let doc = docMap.get(share.id);

    if (!doc) {
        // Ask the backend for exactly this one document.
        // getResource takes only resourceId; subject/category were only
        // needed for routing (already done by initResourceBrowser).
        doc = await content.fetchResourceById(share.id);
    }

    clearSharedDocFromUrl();

    if (!doc) {
        ui.showToast('Shared document not found', 'error');
        return;
    }

    // Inject the doc into the grid so the recipient sees it as a real
    // card, with all its metadata, file size, and entitlements intact.
    docMap.set(doc._id, doc);
    if (!allDocuments.some(d => d._id === doc._id)) {
        allDocuments = [doc, ...allDocuments];
        await hydrateThumbnailCache([doc]);
    }

    // If the recipient is on a filter that would hide the shared card
    // (e.g. "Downloaded" but this doc isn't downloaded yet), reset to
    // "all" so the shared card is actually visible on landing. Also
    // clear any active search term — a stale query from the previous
    // session would silently hide the shared doc.
    if (currentFilter !== 'all') {
        currentFilter = 'all';
        const dropdown = document.getElementById('filter-dropdown');
        if (dropdown) {
            dropdown.querySelectorAll('button').forEach(b => {
                b.classList.toggle('active-filter', b.dataset.filter === 'all');
            });
        }
    }
    const searchEl = document.getElementById('search-input');
    if (searchEl && searchEl.value) {
        searchEl.value = '';
    }

    applyFiltersAndRender();

    // Make the shared card findable: scroll it into view and pulse it
    // briefly so the recipient can identify which document the link
    // points at.
    _highlightSharedCard(doc._id);

    if (_dbg()) {
        _logLine('share-land', `id=${doc._id} title="${doc.title}"`, 'info');
    }

    ui.showToast(`Shared: ${doc.title}`, 'info');

    // NO viewer.openDocument() call. The user decides what to do with the
    // card — Open, Download, share again, or nothing.
}

// ==================== EVENT LISTENERS ====================
function attachCardEventListeners() {
    document.querySelectorAll('.btn-download, .btn-open').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            const doc = docMap.get(id);
            const isOpen = btn.classList.contains('btn-open');

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

            // ===== OPEN =====
            if (isOpen) {
                // Immediate visual feedback: swap the button into an inline
                // loading state before any await. The entitlement check, the
                // metadata lookup inside the viewer, and the blob URL
                // creation all take time on first open — especially for a
                // large PDF that has to be read out of the native bridge in
                // chunks.
                _setButtonOpening(btn);

                let previewMode = false;
                let hasActive = false;

                             try {
                    if (doc && doc.isPremium === true) {
                        hasActive = await subscription.hasActiveSubscription();
                        if (!hasActive) {
                            previewMode = true;
                        }
                    }

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

                    await viewer.openDocument(id, title, fileType, { previewMode });
                } catch (err) {
                    if (_dbg()) {
                        _logLine(
                            'open-failed',
                            String(err && err.message || err),
                            'fail'
                        );
                    }
                    ui.showToast(
                        'Could not open: ' +
                            (err && err.message ? err.message : 'unknown error'),
                        'error'
                    );
                } finally {
                    // Restore the button whether the open succeeded or failed.
                    // On success the viewer is covering the screen so the
                    // reset is invisible; on failure it's what un-sticks the
                    // button.
                    _restoreButton(btn);
                }
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
                _logLine('download-allowed', `id=${id} premium + subscribed → proceeding`, 'ok');
            } else {
                _logLine('download-allowed', `id=${id} free resource → proceeding`, 'ok');
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

    // ── SHARE ──────────────────────────────────────────────────────
    document.querySelectorAll('.share-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const doc = docMap.get(id);
            const dropdown = btn.closest('.menu-dropdown');
            if (dropdown) dropdown.classList.remove('open');
            await shareResource(doc);
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

            // Full re-render keeps sort and filter coherent.
            if (currentFilter === 'favorites') {
                applyFiltersAndRender();
                return;
            }
            const card = btn.closest('.resource-card');
            const doc = docMap.get(id);
            if (card && doc) {
                card.outerHTML = createResourceCard(doc);
                attachCardEventListeners();
            } else {
                applyFiltersAndRender();
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

            // Full re-render — the deleted item may be a filter source.
            if (!navigator.onLine || currentFilter === 'downloaded') {
                loadOfflineResources();
            }
            applyFiltersAndRender();
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
    if (!thumbnailUrl) return false;
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
        return true;
    } catch (err) {
        console.warn(`[Thumbnail] Failed for ${resourceId}:`, err);
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
            } catch { /* ignore */ }
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

        // Persisted metadata — this is where isPremium AND the path
        // (subject/category) are written. Without these the record would
        // be unreachable from any future browsing path.
        saveDownloadedMeta(doc);

        // Full re-render: the card's sort position may change, and if the
        // user is filtered by "downloaded" or "all", a new card may appear.
        applyFiltersAndRender();

        _logLine(
            'download-complete',
            `id=${resourceId} path=${_pathKey(doc && doc.subject, doc && doc.category)} ` +
            `size=${blob.size} thumbnail=${thumbnailDownloaded} ` +
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
 * Build the resource list from what has actually been downloaded, SCOPED
 * TO THE CURRENT PATH (subject + category). A download made in Anatomy →
 * notes is invisible here while browsing Physiology → textbooks.
 *
 * Sorting and filtering are applied by `applyFiltersAndRender`.
 */
function loadOfflineResources() {
    const docs = getDownloadedDocuments();

    if (_dbg()) {
        _log('offline-load', {
            pathKey: _pathKey(currentSubject, currentCategory),
            downloadedCount: docs.length,
            titles: docs.map(d => d.title),
        });
    }

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

/**
 * Immediate offline-only render, bypassing the isLoading guard.
 * Called from the offline event handler so an in-flight fetch cannot
 * block the offline view from appearing.
 */
function renderOfflineNow() {
    isLoading = false;
    loadOfflineResources();
    applyFiltersAndRender();
}

// ==================== LOAD RESOURCES ====================
async function loadResources(reset = true) {
    if (isLoading) return;
    isLoading = true;

    if (reset) {
        currentCursor = null;
        hasMore = true;
        allDocuments = [];
        docMap.clear();
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
            const result = await content.fetchResources(
                currentSubject,
                currentCategory,
                currentCursor,
                {}
            );

            // The fetch may have spanned a connectivity change. If we are
            // offline now, discard the response and render the offline set
            // instead.
            if (!navigator.onLine) {
                isLoading = false;
                renderOfflineNow();
                return;
            }

            if (_dbg()) {
                const docs = result && Array.isArray(result.documents) ? result.documents : [];
                const premiumCount = docs.filter(d => d.isPremium === true).length;

                _log('backend-response', {
                    source: result && result.source,
                    subject: currentSubject,
                    category: currentCategory,
                    pathKey: _pathKey(currentSubject, currentCategory),
                    reset,
                    cursor: currentCursor,
                    hasMore: result && result.hasMore,
                    nextCursor: result && result.cursor,
                    receivedCount: docs.length,
                    premiumCount,
                    titles: docs.slice(0, 5).map(d => d.title),
                }, premiumCount > 0 ? 'ok' : 'warn');
            }

            if (reset) {
                allDocuments = result.documents;
            } else {
                allDocuments = allDocuments.concat(result.documents);
            }
            allDocuments.forEach(d => docMap.set(d._id, d));

            currentCursor = result.cursor;
            hasMore = result.hasMore === true;

            const loadMoreBtn = document.getElementById('load-more-btn');
            if (loadMoreBtn) loadMoreBtn.style.display = hasMore ? 'inline-block' : 'none';
            const loadMoreSpinner = document.getElementById('load-more-spinner');
            if (loadMoreSpinner) loadMoreSpinner.style.display = 'none';

            networkSucceeded = true;

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
        isLoading = false;
        // Refresh entitlement before re-rendering so the premium badge
        // reflects the latest subscription state (a plan may have been
        // purchased or expired while we were offline).
        refreshSubscriptionState().then(() => loadResources(true));
    });

    window.addEventListener('offline', () => {
        ui.showToast('Offline – showing downloaded resources only', 'info');
        // Immediate offline render — do NOT wait for any in-flight fetch.
        renderOfflineNow();
    });
}

// ==================== INIT ====================
export async function initResourceBrowser(subject, type, forceRefresh = false) {
    const pageTitle = document.getElementById('page-title');
    if (!pageTitle) {
        console.error('[ResourceBrowser] page-title element not found!');
        return;
    }

    currentSubject = subject;
    currentCategory = CATEGORY_MAP[type] || type;

    // Reset per-visit UI state so a filter from a previous subject does
    // not leak into this one.
    currentFilter = 'all';
    const searchEl = document.getElementById('search-input');
    if (searchEl) searchEl.value = '';

    const typeName = TYPE_NAMES[type] || 'Resources';
    pageTitle.textContent = `${typeName} – ${subject}`;

    const dropdown = document.getElementById('filter-dropdown');
    if (dropdown) {
        dropdown.querySelectorAll('button').forEach(b => {
            b.classList.toggle('active-filter', b.dataset.filter === 'all');
        });
    }

    if (_dbg()) {
        _logLine(
            'init',
            `subject=${subject} category=${currentCategory} ` +
            `pathKey=${_pathKey(currentSubject, currentCategory)} debug=ON`,
            'info'
        );
    }

    // Resolve entitlement before the first render so subscribers never see
    // a flash of the premium badge. Best-effort: on failure we keep the
    // previous value (default false on cold start).
    await refreshSubscriptionState();

    await loadResources(true);

    // ── Shared-doc landing ─────────────────────────────────────────
    // If the URL carries a share payload, resolve it to a real document
    // (backend by id if not already loaded), inject it as a card, and
    // highlight it so the recipient can see which one the link points
    // at. No viewer is opened, no download is started.
    //
    // The recipient decides what to do with the card via the normal
    // Open / Download / Share / Favourite handlers.
    const share = readSharedDocFromUrl();
    if (share) await _consumeSharedDoc(share);

    if (searchEl) {
        searchEl.oninput = null;
        searchEl.addEventListener('input', debounce(() => applyFiltersAndRender(), 300));
    }

    const filterBtn = document.getElementById('filter-btn');
    if (filterBtn) {
        filterBtn.onclick = (e) => {
            e.stopPropagation();
            const dd = document.getElementById('filter-dropdown');
            if (dd) dd.classList.toggle('open');
        };
    }

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

    const loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.onclick = () => {
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