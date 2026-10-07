// frontend-user/scripts/viewer.js

/**
 * Universal Document Viewer — Entry Point
 * ============================================================================
 *
 * Public façade of the viewer subsystem. This is the file the rest of the
 * application imports. It is the ONLY file permitted to import the app-level
 * modules (`content.js`, `subscription.js`, `ui.js`, `router.js`), the ONLY
 * file that touches `window.showViewer` / `window.closeViewer` / `window.history`
 * on behalf of the viewer, and the ONLY file that constructs the singleton
 * ViewerCore.
 *
 * Public exports:
 *   • loadDocumentInPage(docId)                             → Promise<void>
 *   • openDocument(docId, title?, fileType?, opts?)         → Promise<void>
 *   • showEmbeddedViewer(docId, title?, fileType?, opts?)   → void
 *   • closeEmbeddedViewer()                                 → void
 *   • openDocumentModal(docId)                              → Promise<void>  (legacy alias)
 *   • openPendingFile()                                     → boolean       (host-page hook)
 *
 * `opts` carries hint flags for the load. Currently only one flag is used:
 *   • previewMode: boolean — cap rendered pages to 10% and append a
 *     subscribe CTA after the last preview page. Set by resource-browser.js
 *     for premium catalogue resources opened without an active subscription.
 *     Never set by external-file paths (file picker, Android intent).
 *
 * External file handling:
 *   Three entry points hand files to this module — Android intents, the file
 *   picker, and drag-drop. In every case the file is external: it did not
 *   come from the catalogue and is never subject to auth or the subscription
 *   preview policy. The user chose it; it just opens.
 *
 *   When a file arrives and the viewer DOM is not yet mounted (cold start,
 *   or the app is on a non-viewer page), the payload is stashed and the app
 *   navigates to `resource-browser` — the page that hosts the viewer chrome.
 *   That page's init() calls `openPendingFile()`, which drains the stash and
 *   runs the file through the standard loadDocument pipeline.
 *
 *   Both file-open paths (`_loadLocalFileIntoViewer`, `_openNativeFilePayload`)
 *   call `mountChrome()` themselves before handing the blob to the core. The
 *   catalogue path (`showEmbeddedViewer`) has always done this; the file-open
 *   paths previously assumed the caller would, which is wrong for the
 *   stash-drain flow — the resource-browser page's `_enterFileOpenMode()`
 *   hides #app but does not mount the viewer chrome. The viewer chrome is
 *   the viewer subsystem's responsibility.
 *
 * Document clearing:
 *   Every entry point that starts a new document calls `clearViewerContent()`
 *   from `ui-internal.js`. That removes any DOM the previous document left
 *   behind — page containers, canvas wrappers, canvases, images, iframes,
 *   search-layer overlays, error containers, and the preview-mode CTA — while
 *   preserving the four static chrome nodes declared in the host page
 *   (#viewer-loading, #viewer-progress, #viewer-content, #viewer-text-layer).
 *
 * Design constraints:
 *   • Zero import-time side effects EXCEPT one: `_wireNativeFileOpen()` runs
 *     at module load so the Capacitor plugin listener is registered before
 *     the launch intent is dispatched. Silent no-op everywhere except Android.
 *   • Errors are rendered into the viewer chrome, never thrown to callers.
 *   • Every error message is escaped via utils.escapeHtml.
 *   • No reference to pdfjsLib, Worker, localStorage, or rAF.
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
 * True when the viewer chrome is mounted and reachable. The chrome lives
 * inside `resource-browser.html` — no other page has the 32 element IDs
 * that `refreshElementCache()` looks up.
 *
 * @private
 * @returns {boolean}
 */
function _isViewerHostPage() {
  try {
    const root = document.getElementById('app-root');
    if (!root) return false;
    const section = root.querySelector('section[data-page]');
    return !!(section && section.dataset.page === 'resource-browser');
  } catch {
    return false;
  }
}

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
 * Mount the viewer chrome and clear any residue from a previous document.
 * Idempotent. Safe to call before the core is initialised — mountChrome
 * ignores its argument and only touches the DOM.
 *
 * Used by every file-open path that bypasses `showEmbeddedViewer`.
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
 * The fallback chain for the viewer's back button.
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
// 4. EXTERNAL FILE — LOCAL FILE OBJECT (file input, drag-drop)
// ============================================================================

/**
 * Open a `File` object in the viewer.
 *
 * External files are never subject to the catalogue preview policy. The user
 * chose the file; there is no catalogue resource to upsell. No auth is
 * required and none is checked here.
 *
 * If the viewer host page is not mounted, the File is stashed in
 * `_pendingLocalFile` and the app navigates to the host page. That page's
 * init() calls `openPendingFile()`, which drains the stash.
 *
 * @private
 * @param {File} file
 * @returns {Promise<void>}
 */
async function _handleLocalFileOpen(file) {
  if (!file) return;

  await _waitForDom();

  const els = refreshElementCache();
  if (!els || !els.main || !_isViewerHostPage()) {
    _pendingLocalFile = file;
    try { router.navigateTo('resource-browser'); } catch { /* ignore */ }
    return;
  }

  await _loadLocalFileIntoViewer(file);
}

/**
 * Perform the actual load of a user-selected File into the viewer.
 *
 * Called from two places:
 *   • Directly, when the file input fires on the resource-browser page.
 *   • From `openPendingFile()`, after the resource-browser page's init()
 *     drains the stash written by `_handleLocalFileOpen`.
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
// 5. PUBLIC API — loadDocumentInPage
// ============================================================================

/**
 * Load a document identified by `docId` into the current page's viewer
 * chrome. Intended for `viewer.html`, where the 32 viewer element IDs exist.
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
// 6. PUBLIC API — openDocument
// ============================================================================

/**
 * Open a document from another page. Delegates to `window.showViewer` if
 * the host app defines it; otherwise navigates to the viewer host page.
 *
 * This is the internal-document path. Auth is enforced by the target page's
 * own logic, not here.
 *
 * @param {string} docId
 * @param {string} [title='Document']
 * @param {string|null} [fileType=null]
 * @param {{ previewMode?: boolean }|null} [opts=null]
 * @returns {Promise<void>}
 */
export async function openDocument(docId, title = 'Document', fileType = null, opts = null) {
  try { injectViewerStyles(); } catch { /* ignore */ }

  try {
    if (typeof window !== 'undefined' && typeof window.showViewer === 'function') {
      window.showViewer(docId, title, fileType, opts);
      return;
    }
  } catch { /* ignore */ }

  try {
    router.navigateTo('resource-browser');
  } catch { /* ignore */ }
}

// ============================================================================
// 7. PUBLIC API — showEmbeddedViewer
// ============================================================================

/**
 * Open the viewer as a fixed-position overlay.
 *
 * This is the catalogue path. It is called by resource-browser.js when a
 * catalogue resource is opened, and it mounts the chrome itself.
 *
 * @param {string} docId
 * @param {string} [title='Document']
 * @param {string|null} [fileType=null]
 * @param {{ previewMode?: boolean }|null} [opts=null]
 * @returns {void}
 */
export function showEmbeddedViewer(docId, title = 'Document', fileType = null, opts = null) {
  const els = refreshElementCache();
  injectViewerStyles();

  _currentDocId = docId;
  _isLocalFile = false;

  if (!els || !els.main) return;

  try { mountChrome(_core); } catch { /* ignore */ }

  clearViewerContent();

  if (els.loading) els.loading.style.display = 'block';
  if (els.progress) els.progress.style.display = 'none';
  if (els.title) els.title.textContent = title || 'Document';

  _loadDocumentIntoEmbedded(docId, fileType, opts).catch(() => { /* handled internally */ });
}

/**
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
    if (els && els.main) {
      const message = err && err.message ? err.message : 'Failed to load document';
      const safe = escapeHtml(String(message));
      els.main.innerHTML = `<div class="error-container" role="alert"><p>${safe}</p></div>`;
    }
  } finally {
    if (els && els.loading) els.loading.style.display = 'none';
    if (els && els.progress) els.progress.style.display = 'none';
  }
}

// ============================================================================
// 8. PUBLIC API — closeEmbeddedViewer
// ============================================================================

/**
 * Close the embedded viewer overlay and release the current document. Idempotent.
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
}

// ============================================================================
// 9. PUBLIC API — openDocumentModal (legacy alias)
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
// 12. NATIVE FILE-OPEN (Capacitor Android)
// ============================================================================
//
// Two paths converge here:
//
//   Cold start — the OS launched the app to open a file. The plugin stashed
//     the URI. `getPendingFile()` fetches it after module load.
//
//   Warm start — the app is already running. The plugin fires `fileOpen`,
//     which we handle inline.
//
// In either case, if the viewer chrome is not mounted, the payload is
// stashed in `sessionStorage.pendingFileOpen` and the app navigates to
// `resource-browser`. That page's init() calls `openPendingFile()`, which
// reads the stash and calls `_openNativeFilePayload` again — this time with
// the viewer mounted.
//
// Preview mode is deliberately NOT applied: the file is external.

const PENDING_FILE_KEY = 'pendingFileOpen';

/**
 * Load a native-provided file payload into the viewer.
 *
 * If the viewer chrome isn't mounted, stash the payload and route to the
 * host page. Otherwise mount the chrome, fetch the file, and load.
 *
 * @private
 * @param {{ path: string, name: string, mimeType: string|null, size?: number }} payload
 * @returns {Promise<void>}
 */
async function _openNativeFilePayload(payload) {
  if (!payload || !payload.path) return;

  await _waitForDom();

  const els = refreshElementCache();

  // Viewer chrome isn't mounted, or we're on the wrong page — stash and route.
  if (!els || !els.main || !_isViewerHostPage()) {
    try {
      sessionStorage.setItem(PENDING_FILE_KEY, JSON.stringify(payload));
    } catch { /* ignore quota errors */ }
    try { router.navigateTo('resource-browser'); } catch { /* ignore */ }
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
    const capacitor = typeof window !== 'undefined' ? window.Capacitor : null;
    const fetchUrl = capacitor && typeof capacitor.convertFileSrc === 'function'
      ? capacitor.convertFileSrc(payload.path)
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

/**
 * Wire the Capacitor FileOpen plugin. Runs once at module load.
 *
 * @private
 */
function _wireNativeFileOpen() {
  if (typeof window === 'undefined') return;

  const capacitor = window.Capacitor;
  if (!capacitor || !capacitor.Plugins) return;

  const plugin = capacitor.Plugins.FileOpen;
  if (!plugin) return;

  // Warm start — the OS handed us a file while the app was running.
  try {
    if (typeof plugin.addListener === 'function') {
      plugin.addListener('fileOpen', (payload) => {
        _openNativeFilePayload(payload).catch(() => { /* handled internally */ });
      });
    }
  } catch { /* ignore */ }

  // Cold start — the OS launched the app with a file.
  try {
    if (typeof plugin.getPendingFile === 'function') {
      plugin.getPendingFile()
        .then((payload) => {
          if (payload && payload.path) {
            return _openNativeFilePayload(payload);
          }
          return undefined;
        })
        .catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
}

// ============================================================================
// 13. PUBLIC API — openPendingFile
// ============================================================================

/**
 * Drain a pending external file and open it in the viewer.
 *
 * Called by the viewer host page (`resource-browser.js`) from its `init()`,
 * once the viewer chrome is mounted. Reads both sources of pending files:
 *
 *   1. `sessionStorage.pendingFileOpen` — native file payloads (path-based).
 *      Set by `_openNativeFilePayload` when the chrome wasn't yet mounted.
 *
 *   2. `_pendingLocalFile` — a `File` object from the file picker or
 *      drag-drop. File objects cannot be serialized, so they live in a
 *      module variable until drained.
 *
 * The sessionStorage entry is cleared on read (idempotent). The File
 * reference is nulled on read. Returns `true` if a file was found and the
 * load was initiated, `false` if there was nothing pending.
 *
 * @returns {boolean}
 */
export function openPendingFile() {
  // ── Source 1: native payload ────────────────────────────────────────
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

  // ── Source 2: local File object ─────────────────────────────────────
  if (_pendingLocalFile) {
    const file = _pendingLocalFile;
    _pendingLocalFile = null;
    _loadLocalFileIntoViewer(file).catch(() => { /* handled internally */ });
    return true;
  }

  return false;
}

// ── Self-registration ───────────────────────────────────────────────────────
//
// This is the ONLY intentional side effect at module load.
//
// `_wireNativeFileOpen()` must run before the browser (or WebView) dispatches
// the launch event. It is a silent no-op on every non-Android platform.

_wireNativeFileOpen();