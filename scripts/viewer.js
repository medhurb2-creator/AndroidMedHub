// frontend-user/scripts/viewer.js

/**
 * Universal Document Viewer - Entry Point
 * ============================================================================
 *
 * Public facade of the viewer subsystem. Shared by two pages:
 *
 *   * pages/viewer.html            - dedicated page for external files.
 *                                    No auth. Drains a pending file on init.
 *
 *   * pages/resource-browser.html  - catalogue page. Opens catalogue
 *                                    resources in an embedded overlay.
 *                                    Auth required by the page, not here.
 *
 * This module is page-agnostic. It never checks which page it's mounted on.
 * If the viewer chrome (the #viewer element with its 32 IDs) exists, a file
 * can be loaded into it.
 *
 * Public exports:
 *   * loadDocumentInPage(docId)                             -> Promise<void>
 *   * openDocument(docId, title?, fileType?, opts?)         -> Promise<void>
 *   * showEmbeddedViewer(docId, title?, fileType?, opts?)   -> Promise<void>
 *   * closeEmbeddedViewer()                                 -> void
 *   * openDocumentModal(docId)                              -> Promise<void>  (legacy alias)
 *   * openPendingFile()                                     -> boolean       (host-page hook)
 *
 * `opts` carries hint flags for the load. Currently only one flag is used:
 *   * previewMode: boolean - cap rendered pages to 10% and append a
 *     subscribe CTA after the last preview page. Set by resource-browser.js
 *     for premium catalogue resources opened without an active subscription.
 *     Never set by external-file paths (file picker, Android intent).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ASYNC FAILURE PROPAGATION
 *
 *   The whole open-document chain is awaitable:
 *
 *     resource-browser.js Open handler
 *       → viewer.openDocument(id, title, type, { previewMode })
 *       → window.showViewer(...)  (set to resource-browser.js::showViewer)
 *       → viewer.showEmbeddedViewer(...)
 *       → _loadDocumentIntoEmbedded(...)
 *
 *   Every hop returns a Promise that resolves when the load completes and
 *   rejects when it fails. The Open handler's try/catch is the endpoint:
 *   it restores the button's "Open" state and surfaces a toast.
 *
 *   showEmbeddedViewer is written as a plain function (not async) that
 *   returns the Promise from _loadDocumentIntoEmbedded and attaches a
 *   silent `.catch(() => {})` to the returned promise. This silences the
 *   browser's "unhandled rejection" warning for legacy callers that fire
 *   and forget, while still rejecting for callers that await. Awaiting the
 *   same Promise sees the rejection; the two paths do not interfere.
 *
 *   Errors that originate inside `core.loadDocument` are a special case:
 *   core catches them, emits DOCUMENT_ERROR, and ui-internal renders the
 *   standard error container into the viewer chrome. The chain does NOT
 *   see those — loadDocument resolves normally after firing the event.
 *   The chain only sees errors that happen BEFORE core takes over: missing
 *   IndexedDB blob, failed download, core initialization failure. Those
 *   are the cases where the button would otherwise stay stuck at
 *   "Opening…" forever with no visible feedback.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * External file handling:
 *   Two entry points hand external files to this module:
 *
 *     1. Native payloads (Android intents). The FileOpen plugin delivers
 *        a path-based payload to app.js, which stashes it in
 *        sessionStorage.pendingFileOpen and routes to pages/viewer.html.
 *        That page's init() calls openPendingFile(), which drains the
 *        stash and hands the payload to _openNativeFilePayload().
 *
 *     2. Local File objects (file picker, drag-drop). These arrive via
 *        the LOCAL_FILE_OPEN_REQUESTED bus event on whatever page the
 *        user is on. If the viewer chrome is already mounted (viewer page
 *        or resource-browser overlay), the file loads directly. Otherwise
 *        it's stashed in _pendingLocalFile (File objects cannot be
 *        serialized) and the app routes to pages/viewer.html, whose init
 *        drains the stash.
 *
 *   External files NEVER require auth. The user chose the file; it just
 *   opens. Internal catalogue resources still route through
 *   resource-browser.html's embedded viewer overlay - they never reach
 *   the external-file paths.
 *
 * Document clearing:
 *   Every entry point that starts a new document calls clearViewerContent()
 *   from ui-internal.js. That removes any DOM the previous document left
 *   behind - page containers, canvas wrappers, canvases, images, iframes,
 *   search-layer overlays, error containers, and the preview-mode CTA -
 *   while preserving the four static chrome nodes declared in the host page
 *   (#viewer-loading, #viewer-progress, #viewer-content, #viewer-text-layer).
 *
 * Design constraints:
 *   * Zero import-time side effects. All wiring happens on demand.
 *   * Errors are rendered into the viewer chrome, never thrown to
 *     non-awaiting callers. Awaiting callers receive the rejection.
 *   * Every error message is escaped via utils.escapeHtml.
 *   * No reference to pdfjsLib, Worker, localStorage, or rAF.
 *
 * @module viewer
 */

'use strict';

// ============================================================================
// APP-LEVEL IMPORTS (only file permitted to import these)
// ============================================================================

import * as content from './content.js';
import * as subscription from './subscription.js';
import * as ui from './ui.js';
import * as router from './router.js';

// ============================================================================
// VIEWER SUBSYSTEM IMPORTS
// ============================================================================

import { createCore, Events, CONFIG } from './viewer/core.js';
import {
  injectViewerStyles,
  refreshElementCache,
  mountChrome,
  unmountChrome,
  clearViewerContent,
} from './viewer/ui-internal.js';
import { escapeHtml } from './viewer/utils.js';

// ============================================================================
// MODULE-PRIVATE STATE
// ============================================================================

/** Singleton core instance. @private @type {import('./viewer/core.js').ViewerCore|null} */
let _core = null;

/** The docId currently being displayed, if any. @private @type {string|null} */
let _currentDocId = null;

/** True when the current document came from a local file. @private */
let _isLocalFile = false;

/** App-level bus subscription unsubscribe functions. @private @type {Array<() => void>} */
let _appSubscriptions = [];

/**
 * Singleton promise for the init sequence. Prevents concurrent entry calls
 * from double-constructing the core.
 * @private
 * @type {Promise<import('./viewer/core.js').ViewerCore>|null}
 */
let _coreInitPromise = null;

/**
 * A File object awaiting a viewer host page. Set when a user-selected File
 * (file input, drag-drop) arrives before the viewer chrome is mounted. File
 * objects cannot be serialized to sessionStorage, so they live here until
 * `openPendingFile()` drains them.
 *
 * @private
 * @type {File|null}
 */
let _pendingLocalFile = null;

/**
 * sessionStorage key used to stash a native FileOpen payload between the
 * page that received it and the viewer page that will load it. The same
 * key is written by app.js when a cold-start or warm-start file intent
 * arrives before the viewer page has mounted.
 *
 * @private
 * @constant {string}
 */
const PENDING_FILE_KEY = 'pendingFileOpen';

// ============================================================================
// 1. CORE LIFECYCLE
// ============================================================================

/**
 * Return the singleton core, constructing and initialising it on first call.
 * Concurrent calls share a single init promise.
 *
 * @private
 * @returns {Promise<import('./viewer/core.js').ViewerCore>}
 */
function _ensureCore() {
  if (_coreInitPromise) return _coreInitPromise;

  _coreInitPromise = (async () => {
    const core = createCore();
    _core = core;
    await core.init();
    _wireAppSubscriptions(core);
    _maybeInstallDebugShortcut(core);
    return core;
  })();

  _coreInitPromise.catch(() => { /* swallow */ });

  return _coreInitPromise;
}

/**
 * Register the app-level bus subscriptions. Registered exactly once, at
 * first `_ensureCore()`. These are viewer-lifetime subscriptions and are
 * deliberately NOT torn down on document switch.
 *
 * @private
 * @param {import('./viewer/core.js').ViewerCore} core
 */
function _wireAppSubscriptions(core) {
  const bus = core.getBus();

  _appSubscriptions.push(bus.on(Events.NAV_BACK_REQUESTED, () => {
    _handleBack();
  }));

  _appSubscriptions.push(bus.on(Events.LOCAL_FILE_OPEN_REQUESTED, (payload) => {
    if (!payload || !payload.file) return;
    _handleLocalFileOpen(payload.file).catch(() => { /* handled internally */ });
  }));

  _appSubscriptions.push(bus.on(Events.PREVIEW_SUBSCRIBE_REQUESTED, () => {
    try { router.navigateTo('subscription'); } catch { /* ignore */ }
  }));
}

/**
 * @private
 * @param {import('./viewer/core.js').ViewerCore} _core
 */
function _maybeInstallDebugShortcut(_core) {
  if (!CONFIG.DEBUG_VIEWER) return;
  try {
    if (typeof window !== 'undefined') {
      window.__viewer = {
        ...__debug,
        openPendingFile,
      };
    }
  } catch { /* ignore */ }
}

// ============================================================================
// 2. ENVIRONMENT CHECKS
// ============================================================================

/**
 * True when the DOM is fully parsed and safe to query.
 * @private
 * @returns {boolean}
 */
function _domReady() {
  return typeof document !== 'undefined' && document.readyState !== 'loading';
}

/**
 * Resolve once the DOM is ready. No-op when already ready.
 * @private
 * @returns {Promise<void>}
 */
function _waitForDom() {
  if (_domReady()) return Promise.resolve();
  return new Promise((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

/**
 * True when the viewer chrome is mounted and reachable.
 *
 * The chrome lives inside the host page - either pages/viewer.html or the
 * embedded overlay inside pages/resource-browser.html. Both have the same
 * #viewer element with the same 32 IDs. If `refreshElementCache()` returns
 * a main element, the chrome is present and a file can be loaded.
 *
 * @private
 * @returns {boolean}
 */
function _chromeMounted() {
  try {
    const els = refreshElementCache();
    return !!(els && els.main);
  } catch {
    return false;
  }
}

/**
 * Mount the viewer chrome and clear any residue from a previous document.
 * Idempotent. Safe to call before the core is initialised - mountChrome
 * ignores its argument and only touches the DOM.
 *
 * @private
 * @param {import('./viewer/core.js').ViewerCore|null} core
 */
function _prepareChromeForFileOpen(core) {
  try { mountChrome(core); } catch { /* ignore */ }
  try { clearViewerContent(); } catch { /* ignore */ }
}

// ============================================================================
// 3. BACK-NAVIGATION CHAIN
// ============================================================================

/**
 * The fallback chain for the viewer's back button. Called from the core's
 * NAV_BACK_REQUESTED event and from the error container's back button.
 *
 * On the viewer page, the page's own back button wires directly to
 * `router.navigateTo('subjects' | 'welcome')` and never emits NAV_BACK.
 * On the resource-browser page, the overlay's back button calls
 * `window.closeViewer()` directly. This chain is the fallback when
 * neither of those applies - e.g. errors during load.
 *
 * @private
 */
function _handleBack() {
  // 1. Host-app-provided hook.
  try {
    if (typeof window !== 'undefined' && typeof window.closeViewer === 'function') {
      window.closeViewer();
      return;
    }
  } catch { /* ignore */ }

  // 2. Browser history, if any.
  try {
    if (typeof window !== 'undefined' && window.history && window.history.length > 1) {
      window.history.back();
      return;
    }
  } catch { /* ignore */ }

  // 3. Fallback route.
  try {
    router.navigateTo('subjects');
  } catch { /* ignore */ }
}

// ============================================================================
// 4. EXTERNAL FILE - LOCAL FILE OBJECT (file input, drag-drop)
// ============================================================================

/**
 * Open a `File` object in the viewer.
 *
 * External files are never subject to the catalogue preview policy. The
 * user chose the file; there is no catalogue resource to upsell. No auth
 * is required and none is checked here.
 *
 * If the viewer chrome is already mounted (viewer page, or the catalogue
 * page with the overlay active), the file loads in place. Otherwise the
 * File object is stashed in `_pendingLocalFile` - File objects cannot be
 * serialized to sessionStorage - and the app routes to `viewer`. That
 * page's init() calls `openPendingFile()`, which drains the stash.
 *
 * @private
 * @param {File} file
 * @returns {Promise<void>}
 */
async function _handleLocalFileOpen(file) {
  if (!file) return;

  await _waitForDom();

  // Chrome not mounted → stash the File and route to the viewer page.
  if (!_chromeMounted()) {
    _pendingLocalFile = file;
    try { router.navigateTo('viewer'); } catch { /* ignore */ }
    return;
  }

  // Chrome mounted → load directly.
  await _loadLocalFileIntoViewer(file);
}

/**
 * Perform the actual load of a user-selected File into the viewer.
 *
 * Called from two places:
 *   * Directly, when the file input fires on a page with chrome mounted.
 *   * From `openPendingFile()`, after the viewer page's init() drains the
 *     stash written by `_handleLocalFileOpen`.
 *
 * Mounts the viewer chrome before loading. The catalogue path calls
 * `mountChrome` from `showEmbeddedViewer`; the file-open path must do the
 * same because it does not go through that entry point.
 *
 * @private
 * @param {File} file
 * @returns {Promise<void>}
 */
async function _loadLocalFileIntoViewer(file) {
  _currentDocId = null;
  _isLocalFile = true;

  let fileType = '';
  try {
    if (file.name && typeof file.name === 'string') {
      const parts = file.name.split('.');
      if (parts.length > 1) fileType = parts.pop();
    }
  } catch { /* ignore */ }

  try {
    const core = await _ensureCore();
    _prepareChromeForFileOpen(core);
    await core.loadDocument(file, fileType, file.name || 'Document');
  } catch (err) {
    const message = err && err.message ? err.message : 'Failed to open file';
    try { ui.showToast('Failed to open file: ' + message, 'error'); } catch { /* ignore */ }
  }
}

// ============================================================================
// 5. PUBLIC API - loadDocumentInPage
// ============================================================================

/**
 * Load a document identified by `docId` into the current page's viewer
 * chrome. Intended for pages that have the 32 viewer element IDs mounted.
 *
 * This is the internal-document path: it keeps the hard subscription gate.
 * Preview mode is NOT applied here.
 *
 * @param {string} docId
 * @returns {Promise<void>}
 */
export async function loadDocumentInPage(docId) {
  refreshElementCache();
  injectViewerStyles();

  _currentDocId = docId;
  _isLocalFile = false;

  const els = refreshElementCache();
  if (!els || !els.main) return;

  clearViewerContent();

  if (els.loading) els.loading.style.display = 'block';
  if (els.progress) els.progress.style.display = 'none';

  try {
    const hasActive = await subscription.hasActiveSubscription();
    if (!hasActive) {
      try { ui.showToast('Subscription required', 'warning'); } catch { /* ignore */ }
      try { router.navigateTo('subscription'); } catch { /* ignore */ }
      return;
    }

    let blob = await content.getLocalFile(docId);

    if (!blob) {
      try { ui.showLoading('Fetching document...'); } catch { /* ignore */ }
      const success = await content.downloadResource(docId);
      try { ui.hideLoading(); } catch { /* ignore */ }
      if (!success) throw new Error('Download failed');
      blob = await content.getLocalFile(docId);
      if (!blob) throw new Error('File not found after download');
    }

    const core = await _ensureCore();
    await core.loadDocument(blob, null, 'Document', { previewMode: false });
  } catch (err) {
    _renderErrorContainer(err);
  } finally {
    if (els.loading) els.loading.style.display = 'none';
    if (els.progress) els.progress.style.display = 'none';
  }
}

// ============================================================================
// 6. PUBLIC API - openDocument
// ============================================================================

/**
 * Open a document from another page. Delegates to `window.showViewer` if
 * the host app defines it; otherwise navigates to the catalogue page.
 *
 * This is the internal-document path. Auth is enforced by the target page's
 * own logic, not here.
 *
 * The delegate call is awaited. When the host app's `window.showViewer`
 * returns a Promise (as the resource-browser's does), any async failure
 * inside the viewer propagates back here and out to the caller. This is
 * what lets the resource-browser Open button's try/catch see "file not
 * found", "download failed", and viewer initialization errors.
 *
 * @param {string} docId
 * @param {string} [title='Document']
 * @param {string|null} [fileType=null]
 * @param {{ previewMode?: boolean }|null} [opts=null]
 * @returns {Promise<void>}
 */
export async function openDocument(docId, title = 'Document', fileType = null, opts = null) {
  try { injectViewerStyles(); } catch { /* ignore */ }

  if (typeof window !== 'undefined' && typeof window.showViewer === 'function') {
    // Await the delegate so async failures surface to the caller.
    // A sync delegate that returns undefined resolves immediately —
    // which is correct behaviour for legacy hosts that don't return
    // a Promise.
    await window.showViewer(docId, title, fileType, opts);
    return;
  }

  try {
    router.navigateTo('resource-browser');
  } catch { /* ignore */ }
}

// ============================================================================
// 7. PUBLIC API - showEmbeddedViewer
// ============================================================================

/**
 * Open the viewer as a fixed-position overlay.
 *
 * This is the catalogue path. Called by resource-browser.js when a
 * catalogue resource is opened. Mounts the chrome itself.
 *
 * Returns a Promise that resolves when the load completes and rejects when
 * it fails. Written as a plain (non-async) function so the returned Promise
 * is exactly the one from `_loadDocumentIntoEmbedded` — but with a silent
 * `.catch` attached, so callers that fire-and-forget do not trigger the
 * browser's unhandled-rejection warning. Awaiting the same Promise still
 * sees the rejection; the two paths do not interfere.
 *
 * @param {string} docId
 * @param {string} [title='Document']
 * @param {string|null} [fileType=null]
 * @param {{ previewMode?: boolean }|null} [opts=null]
 * @returns {Promise<void>}
 */
export function showEmbeddedViewer(docId, title = 'Document', fileType = null, opts = null) {
  const els = refreshElementCache();
  injectViewerStyles();

  _currentDocId = docId;
  _isLocalFile = false;

  if (!els || !els.main) {
    return Promise.resolve();
  }

  try { mountChrome(_core); } catch { /* ignore */ }

  clearViewerContent();

  if (els.loading) els.loading.style.display = 'block';
  if (els.progress) els.progress.style.display = 'none';
  if (els.title) els.title.textContent = title || 'Document';

  const loadPromise = _loadDocumentIntoEmbedded(docId, fileType, opts);

  // Silence unhandled-rejection warnings for callers that ignore the
  // returned Promise. The rejection is still delivered to anyone who
  // awaits loadPromise.
  loadPromise.catch(() => { /* silence for fire-and-forget callers */ });

  return loadPromise;
}

/**
 * Load a catalogue document into the mounted embedded viewer.
 *
 * Errors that occur before core takes over (missing IndexedDB blob, failed
 * download, core init failure) are rendered into the viewer chrome AND
 * re-thrown so the caller can react. Once core.loadDocument is reached,
 * errors are core's responsibility — core catches them, emits
 * DOCUMENT_ERROR, and ui-internal renders the standard error container.
 * core.loadDocument does not reject for PDF-load errors; it resolves
 * normally after firing the event.
 *
 * @private
 * @param {string} docId
 * @param {string|null} fileType
 * @param {{ previewMode?: boolean }|null} [opts=null]
 * @returns {Promise<void>}
 */
async function _loadDocumentIntoEmbedded(docId, fileType, opts = null) {
  const els = refreshElementCache();

  try {
    let blob = await content.getLocalFile(docId);
    if (!blob) {
      try { ui.showLoading('Downloading document...'); } catch { /* ignore */ }
      const success = await content.downloadResource(docId);
      try { ui.hideLoading(); } catch { /* ignore */ }
      if (!success) throw new Error('Download failed');
      blob = await content.getLocalFile(docId);
      if (!blob) throw new Error('File not found after download');
    }

    const core = await _ensureCore();
    await core.loadDocument(blob, fileType, 'Document', opts);
  } catch (err) {
    // Render the error into the viewer chrome so the failure is visible
    // even if the caller ignores the rejection.
    if (els && els.main) {
      const message = err && err.message ? err.message : 'Failed to load document';
      const safe = escapeHtml(String(message));
      els.main.innerHTML =
        `<div class="error-container" role="alert"><p>${safe}</p></div>`;
    }
    // Re-throw so awaiting callers (the Open button handler) can restore
    // their state and surface their own feedback.
    throw err;
  } finally {
    if (els && els.loading) els.loading.style.display = 'none';
    if (els && els.progress) els.progress.style.display = 'none';
  }
}

// ============================================================================
// 8. PUBLIC API - closeEmbeddedViewer
// ============================================================================

/**
 * Close the embedded viewer overlay and release the current document.
 * Idempotent.
 *
 * @returns {void}
 */
export function closeEmbeddedViewer() {
  try {
    if (_core && typeof _core.destroy === 'function') {
      _core.destroy();
    }
  } catch { /* ignore */ }

  try { unmountChrome(_core); } catch { /* ignore */ }

  try { clearViewerContent(); } catch { /* ignore */ }

  _currentDocId = null;
  _isLocalFile = false;
  _pendingLocalFile = null;
}

// ============================================================================
// 9. PUBLIC API - openDocumentModal (legacy alias)
// ============================================================================

/**
 * @param {string} docId
 * @returns {Promise<void>}
 */
export async function openDocumentModal(docId) {
  return openDocument(docId);
}

// ============================================================================
// 10. ERROR RENDERING
// ============================================================================

/**
 * @private
 * @param {unknown} err
 */
function _renderErrorContainer(err) {
  const els = refreshElementCache();
  if (!els || !els.main) return;

  const message = err && typeof err === 'object' && 'message' in err
    ? String(/** @type {{ message: unknown }} */ (err).message)
    : 'Unknown error';
  const safe = escapeHtml(message);

  els.main.innerHTML = `<div class="error-container" role="alert">
    <p>Failed to load document: ${safe}</p>
    <button class="btn-secondary" data-viewer-action="back">Go Back</button>
  </div>`;

  const backBtn = els.main.querySelector('[data-viewer-action="back"]');
  if (!backBtn) return;

  backBtn.addEventListener('click', () => {
    try {
      if (_core) {
        _core.getBus().emit(Events.NAV_BACK_REQUESTED, {});
        return;
      }
    } catch { /* ignore */ }
    _handleBack();
  });
}

// ============================================================================
// 11. DEBUG NAMESPACE
// ============================================================================

/**
 * QA / dev-tools only.
 * @type {{
 *   state: () => object|null,
 *   flags: () => object|null,
 *   report: () => object,
 * }}
 */
export const __debug = {
  state() {
    try {
      if (!_core) return null;
      const s = _core.getState();
      return s && typeof s.snapshot === 'function' ? s.snapshot() : null;
    } catch { return null; }
  },

  flags() {
    try {
      if (!_core) return null;
      const s = _core.getState();
      return s ? s.get('flags') || null : null;
    } catch { return null; }
  },

  report() {
    const base = {
      docId: _currentDocId,
      isLocalFile: _isLocalFile,
      coreInited: _core !== null,
      pendingLocalFile: !!_pendingLocalFile,
      chromeMounted: _chromeMounted(),
      state: null,
      flags: null,
      scheduler: null,
      memory: null,
      workers: null,
      cache: null,
    };
    if (!_core) return base;
    try {
      const s = _core.getState();
      base.state = s && typeof s.snapshot === 'function' ? s.snapshot() : null;
      base.flags = s ? s.get('flags') || null : null;
    } catch { /* ignore */ }
    try {
      const scheduler = _core.getScheduler();
      base.scheduler = scheduler && typeof scheduler.getStats === 'function'
        ? scheduler.getStats() : null;
    } catch { /* ignore */ }
    try {
      const memory = _core.getMemory();
      base.memory = memory && typeof memory.report === 'function'
        ? memory.report() : null;
    } catch { /* ignore */ }
    try {
      const workers = _core.getWorkers();
      base.workers = workers && typeof workers.stats === 'function'
        ? workers.stats() : null;
    } catch { /* ignore */ }
    try {
      const cache = _core.getCache();
      base.cache = cache && typeof cache.report === 'function'
        ? cache.report() : null;
    } catch { /* ignore */ }
    return base;
  },
};

// ============================================================================
// 12. NATIVE FILE PAYLOAD LOADER
// ============================================================================
//
// Native payloads (path-based) are the Android intent path. They are
// delivered to app.js via the FileOpen Java plugin, stashed in
// sessionStorage.pendingFileOpen, and drained here by the viewer page's
// init() -> openPendingFile().
//
// By the time _openNativeFilePayload runs, the caller has already verified
// that the chrome is mounted (that's what openPendingFile's caller checks).
// No stash-and-route logic lives here - if the chrome is somehow missing,
// log and bail rather than attempt a redirect that could loop.

/**
 * Load a native-provided file payload into the viewer.
 *
 * @private
 * @param {{ path: string, name?: string, mimeType?: string|null, size?: number }} payload
 * @returns {Promise<void>}
 */
async function _openNativeFilePayload(payload) {
  if (!payload || !payload.path) return;

  await _waitForDom();

  // The chrome should already be mounted by the page that called us. If
  // it's not, something upstream is broken - bail rather than redirect.
  if (!_chromeMounted()) {
    console.warn('[Viewer] Native file payload arrived but viewer chrome is not mounted.');
    return;
  }

  _currentDocId = null;
  _isLocalFile = true;

  let fileType = '';
  try {
    if (payload.name && typeof payload.name === 'string') {
      const parts = payload.name.split('.');
      if (parts.length > 1) fileType = parts.pop();
    }
  } catch { /* ignore */ }

  try {
    const bridge = typeof window !== 'undefined' ? window.Capacitor : null;
    const fetchUrl = bridge && typeof bridge.convertFileSrc === 'function'
      ? bridge.convertFileSrc(payload.path)
      : payload.path;

    const response = await fetch(fetchUrl);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();

    const typedBlob = payload.mimeType && blob.type !== payload.mimeType
      ? blob.slice(0, blob.size, payload.mimeType)
      : blob;

    const core = await _ensureCore();
    _prepareChromeForFileOpen(core);
    await core.loadDocument(typedBlob, fileType, payload.name || 'Document');
  } catch (err) {
    const message = err && err.message ? err.message : 'Failed to open file';
    try { ui.showToast('Failed to open file: ' + message, 'error'); } catch { /* ignore */ }
  }
}

// ============================================================================
// 13. PUBLIC API - openPendingFile
// ============================================================================

/**
 * Drain a pending external file and open it in the viewer.
 *
 * Called by pages/viewer.js from its init(), once the viewer chrome is
 * mounted. Reads two sources of pending files:
 *
 *   1. sessionStorage.pendingFileOpen - native payloads stashed by app.js
 *      when a cold-start or warm-start file intent arrived before the
 *      viewer page mounted.
 *
 *   2. _pendingLocalFile - a File object from the file picker or drag-drop
 *      that arrived while the viewer chrome wasn't mounted. File objects
 *      cannot be serialized, so they live in a module variable.
 *
 * The sessionStorage entry is cleared on read (idempotent). The File
 * reference is nulled on read. Returns true if a file was found and its
 * load was initiated, false if nothing was pending.
 *
 * @returns {boolean}
 */
export function openPendingFile() {
  // -- Source 1: native payload ------------------------------------------
  try {
    const raw = sessionStorage.getItem(PENDING_FILE_KEY);
    if (raw) {
      sessionStorage.removeItem(PENDING_FILE_KEY);
      const payload = JSON.parse(raw);
      if (payload && payload.path) {
        _openNativeFilePayload(payload).catch(() => { /* handled internally */ });
        return true;
      }
    }
  } catch { /* ignore parse errors */ }

  // -- Source 2: local File object ---------------------------------------
  if (_pendingLocalFile) {
    const file = _pendingLocalFile;
    _pendingLocalFile = null;
    _loadLocalFileIntoViewer(file).catch(() => { /* handled internally */ });
    return true;
  }

  return false;
}