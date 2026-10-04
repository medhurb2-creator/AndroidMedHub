// frontend-user/scripts/viewer.js

/**
 * Universal Document Viewer — Entry Point
 * ============================================================================
 *
 * Public façade of the viewer subsystem. This is the file the rest of the
 * application imports. It is the ONLY file permitted to import the app-level
 * modules (`content.js`, `subscription.js`, `ui.js`, `router.js`), the ONLY
 * file that touches `window.showViewer` / `window.closeViewer` /
 * `window.history` on behalf of the viewer, and the ONLY file that constructs
 * the singleton ViewerCore.
 *
 * Public exports (preserved byte-for-byte from the previous monolith):
 *   • loadDocumentInPage(docId)                             → Promise<void>
 *   • openDocument(docId, title?, fileType?, opts?)         → Promise<void>
 *   • showEmbeddedViewer(docId, title?, fileType?, opts?)   → void
 *   • closeEmbeddedViewer()                                 → void
 *   • openDocumentModal(docId)                              → Promise<void>  (legacy alias)
 *
 * `opts` carries hint flags for the load. Currently only one flag is used:
 *   • previewMode: boolean — cap rendered pages to 10% and append a
 *     subscribe CTA after the last preview page. Set by resource-browser.js
 *     for premium catalogue resources opened without an active subscription.
 *     Never set by external-file paths (file picker, Android intent).
 *
 * Document clearing:
 *   Every entry point that starts a new document begins by calling
 *   `clearViewerContent()` from `ui-internal.js`. That removes any DOM the
 *   previous document left behind — page containers, canvas wrappers,
 *   canvases, images, iframes, search-layer overlays, error containers, and
 *   the preview-mode CTA — while preserving the four static chrome nodes
 *   declared in viewer.html (#viewer-loading, #viewer-progress,
 *   #viewer-content, #viewer-text-layer).
 *
 *   The core also calls this function on every `destroy()`, so both paths
 *   (explicit close, document switch) converge on the same clear.
 *
 * Plus a documented debug namespace:
 *   • __debug.state() / .flags() / .report()        — QA / dev-tools only
 *
 * Design constraints (architecture spec § 5–§ 8):
 *   • Zero import-time side effects EXCEPT one: `_wireNativeFileOpen()` is
 *     invoked at module load to register the Capacitor plugin listener
 *     before the launch intent is dispatched. The call is a silent no-op in
 *     browsers and on iOS, and touches nothing visible on Android unless the
 *     OS actually hands the app a file.
 *   • Errors are rendered into the viewer chrome, never thrown to callers.
 *   • Every error message is escaped via utils.escapeHtml.
 *   • No reference to pdfjsLib, Worker, localStorage, or rAF.
 *
 * Cross-platform behaviour:
 *   • Browser: entry points are `loadDocumentInPage`, `openDocument`,
 *     `showEmbeddedViewer`. Native file-open is inert.
 *   • Capacitor Android: additionally responds to ACTION_VIEW intents that
 *     match the AndroidManifest's `<intent-filter>` entries, via the
 *     `FileOpen` Capacitor plugin. The plugin copies the incoming
 *     `content://` stream into the app cache and returns an absolute path,
 *     which this file fetches via `Capacitor.convertFileSrc` and routes
 *     through the same `core.loadDocument` pipeline every other entry uses.
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
// MODULE-PRIVATE STATE (five variables, no more)
// ============================================================================

/** Singleton core instance. Constructed on first entry-point call. @private */
/** @type {import('./viewer/core.js').ViewerCore|null} */
let _core = null;

/** The docId currently being displayed, if any. @private */
/** @type {string|null} */
let _currentDocId = null;

/** True when the current document came from a local file. @private */
let _isLocalFile = false;

/** App-level bus subscription unsubscribe functions. @private */
/** @type {Array<() => void>} */
let _appSubscriptions = [];

/**
 * Singleton promise for the init sequence. Prevents concurrent entry calls
 * from double-constructing the core.
 * @private
 * @type {Promise<import('./viewer/core.js').ViewerCore>|null}
 */
let _coreInitPromise = null;

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

  // Attach a no-op catch to prevent unhandled rejection warnings when the
  // caller does not observe the returned promise (e.g. showEmbeddedViewer's
  // fire-and-forget path). The initialisation failure is observed by the
  // calling entry-point's own try/catch.
  _coreInitPromise.catch(() => { /* swallow */ });

  return _coreInitPromise;
}

/**
 * Register the app-level bus subscriptions. These are the ONLY events
 * whose handling requires app-level knowledge (router, window.closeViewer,
 * window.history).
 *
 * Registered exactly once, at first `_ensureCore()`. They are viewer-lifetime
 * subscriptions and must NOT be torn down on document switch or on
 * `closeEmbeddedViewer` — the core instance is reused across opens, and
 * `_ensureCore` returns the memoised promise on subsequent calls without
 * re-wiring.
 *
 * @private
 * @param {import('./viewer/core.js').ViewerCore} core
 */
function _wireAppSubscriptions(core) {
  const bus = core.getBus();

  // Back navigation intent.
  _appSubscriptions.push(bus.on(Events.NAV_BACK_REQUESTED, () => {
    _handleBack();
  }));

  // Local-file open intent.
  _appSubscriptions.push(bus.on(Events.LOCAL_FILE_OPEN_REQUESTED, (payload) => {
    if (!payload || !payload.file) return;
    _handleLocalFileOpen(payload.file).catch(() => { /* handled internally */ });
  }));

  // Preview-mode subscribe CTA. Emitted by the call-to-action card that
  // core._buildPreviewCTA inserts after the last preview page. Routes the
  // user to the subscription page so they can unlock the full document.
  //
  // This is the ONLY app-level consumer of PREVIEW_SUBSCRIBE_REQUESTED. The
  // CTA's subscribe button does not perform the redirect itself — it emits
  // the event; this subscriber owns the router call. That keeps ui-internal
  // free of a router dependency and keeps the redirect logic in the file
  // that is already permitted to import app-level modules.
  _appSubscriptions.push(bus.on(Events.PREVIEW_SUBSCRIBE_REQUESTED, () => {
    try { router.navigateTo('subscription.html'); } catch { /* ignore */ }
  }));
}

/**
 * Optionally expose `window.__viewer` for dev tools. Gated by
 * CONFIG.DEBUG_VIEWER so it is inert in production.
 *
 * @private
 * @param {import('./viewer/core.js').ViewerCore} _core
 */
function _maybeInstallDebugShortcut(_core) {
  if (!CONFIG.DEBUG_VIEWER) return;
  try {
    if (typeof window !== 'undefined') {
      window.__viewer = __debug;
    }
  } catch { /* ignore */ }
}

// ============================================================================
// 2. BACK-NAVIGATION CHAIN
// ============================================================================

/**
 * The fallback chain for the viewer's back button. Order preserved from the
 * previous monolithic viewer.
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
    router.navigateTo('subjects.html');
  } catch { /* ignore */ }
}

// ============================================================================
// 3. LOCAL FILE OPEN
// ============================================================================

/**
 * Open a `File` object (from a file input or drag-drop) in the viewer.
 *
 * Deliberately does NOT pass previewMode: external files opened by the user
 * are never subject to the catalogue preview policy. The user chose the file
 * themselves; there is no catalogue resource to upsell.
 *
 * @private
 * @param {File} file
 * @returns {Promise<void>}
 */
async function _handleLocalFileOpen(file) {
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
    await core.loadDocument(file, fileType, file.name || 'Document');
  } catch (err) {
    const message = err && err.message ? err.message : 'Failed to open file';
    try { ui.showToast('Failed to open file: ' + message, 'error'); } catch { /* ignore */ }
  }
}

// ============================================================================
// 4. PUBLIC API — loadDocumentInPage
// ============================================================================

/**
 * Load a document identified by `docId` into the current page's viewer
 * chrome. Intended for `viewer.html`, where the 32 viewer element IDs exist.
 *
 * Flow: clear DOM → refresh element cache → inject styles → subscription
 * check → blob fetch (download if needed) → core.loadDocument. Never rejects
 * — failures are rendered into the viewer chrome.
 *
 * Keeps the hard subscription gate for cloud/premium documents routed through
 * the top-level viewer page. Preview mode is NOT applied here — it is scoped
 * to the embedded-viewer path used by the resource browser.
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

  // Clear any residue from a previous document, then show loading state.
  // clearViewerContent() preserves #viewer-loading and #viewer-progress, so
  // the following two lines operate on live nodes.
  clearViewerContent();

  if (els.loading) els.loading.style.display = 'block';
  if (els.progress) els.progress.style.display = 'none';

  try {
    // ── Subscription gate ────────────────────────────────────────────────
    const hasActive = await subscription.hasActiveSubscription();
    if (!hasActive) {
      try { ui.showToast('Subscription required', 'warning'); } catch { /* ignore */ }
      try { router.navigateTo('subscription.html'); } catch { /* ignore */ }
      return;
    }

    // ── Blob retrieval ───────────────────────────────────────────────────
    let blob = await content.getLocalFile(docId);

    if (!blob) {
      try { ui.showLoading('Fetching document...'); } catch { /* ignore */ }
      const success = await content.downloadResource(docId);
      try { ui.hideLoading(); } catch { /* ignore */ }
      if (!success) throw new Error('Download failed');
      blob = await content.getLocalFile(docId);
      if (!blob) throw new Error('File not found after download');
    }

    // ── Core load ────────────────────────────────────────────────────────
    // previewMode is explicitly false: this path is gated on subscription
    // and must always render the full document when reached.
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
// 5. PUBLIC API — openDocument
// ============================================================================

/**
 * Open a document from another page. Delegates to `window.showViewer` if the
 * host app defines it; otherwise navigates to `viewer.html`.
 *
 * The `opts` argument carries hint flags (currently only `previewMode`) and
 * is forwarded verbatim to `window.showViewer`. It is ignored on the
 * router-navigation fallback because that path does not currently support
 * preview mode via URL parameters.
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
    router.navigateTo('viewer.html?docId=' + encodeURIComponent(docId));
  } catch { /* ignore */ }
}

// ============================================================================
// 6. PUBLIC API — showEmbeddedViewer
// ============================================================================

/**
 * Open the viewer as a fixed-position overlay, hiding the host app's `#app`.
 * Synchronous — the load proceeds in the background; errors surface in the
 * viewer chrome.
 *
 * `opts` carries hint flags (currently only `previewMode`) and is forwarded
 * to `_loadDocumentIntoEmbedded` → `core.loadDocument`.
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

  // Mount the embedded chrome (fixed positioning, hide #app).
  try { mountChrome(_core); } catch { /* ignore */ }

  // Clear residue from a previous document BEFORE showing the loading
  // indicator. clearViewerContent() preserves #viewer-loading and
  // #viewer-progress, so the following two lines operate on live nodes.
  clearViewerContent();

  if (els.loading) els.loading.style.display = 'block';
  if (els.progress) els.progress.style.display = 'none';
  if (els.title) els.title.textContent = title || 'Document';

  // Fire-and-forget the async load.
  _loadDocumentIntoEmbedded(docId, fileType, opts).catch(() => { /* handled internally */ });
}

/**
 * Private async helper for the embedded viewer load flow.
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
// 7. PUBLIC API — closeEmbeddedViewer
// ============================================================================

/**
 * Close the embedded viewer overlay, restore the host app's `#app`, and
 * release the core's document state. Idempotent.
 *
 * The app-level bus subscriptions registered by `_ensureCore` are
 * viewer-lifetime and are deliberately NOT torn down here. `_ensureCore`
 * memoises its init promise; a subsequent `showEmbeddedViewer` would not
 * re-wire them, and the back button, local-file handling, and preview CTA
 * would go dead. They die naturally with the JS context when the page unloads.
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

  // Defense in depth: if core.destroy() failed partway through — or if the
  // core was never initialised — ensure the DOM is cleaned anyway. The
  // function is idempotent, so a redundant call is harmless.
  try { clearViewerContent(); } catch { /* ignore */ }

  _currentDocId = null;
  _isLocalFile = false;
}

// ============================================================================
// 8. PUBLIC API — openDocumentModal (legacy alias)
// ============================================================================

/**
 * Legacy alias preserved for backwards compatibility.
 *
 * @param {string} docId
 * @returns {Promise<void>}
 */
export async function openDocumentModal(docId) {
  return openDocument(docId);
}

// ============================================================================
// 9. ERROR RENDERING (private)
// ============================================================================

/**
 * Render an error container into the viewer's main area. Escapes the message
 * and wires the back button to the NAV_BACK_REQUESTED intent (or the router
 * fallback when the core is not yet available).
 *
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
    // Prefer the bus intent when the core is available; otherwise run the
    // same fallback chain directly.
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
// 10. DEBUG NAMESPACE
// ============================================================================

/**
 * QA / dev-tools only. Every method is null-safe before init.
 *
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
    } catch {
      return null;
    }
  },

  flags() {
    try {
      if (!_core) return null;
      const s = _core.getState();
      return s ? s.get('flags') || null : null;
    } catch {
      return null;
    }
  },

  report() {
    const base = {
      docId: _currentDocId,
      isLocalFile: _isLocalFile,
      coreInited: _core !== null,
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
        ? scheduler.getStats()
        : null;
    } catch { /* ignore */ }
    try {
      const memory = _core.getMemory();
      base.memory = memory && typeof memory.report === 'function'
        ? memory.report()
        : null;
    } catch { /* ignore */ }
    try {
      const workers = _core.getWorkers();
      base.workers = workers && typeof workers.stats === 'function'
        ? workers.stats()
        : null;
    } catch { /* ignore */ }
    try {
      const cache = _core.getCache();
      base.cache = cache && typeof cache.report === 'function'
        ? cache.report()
        : null;
    } catch { /* ignore */ }
    return base;
  },
};

// ============================================================================
// 11. NATIVE FILE-OPEN INTEGRATION (Capacitor Android)
// ============================================================================
//
// When the OS hands a file to the installed APK (via an ACTION_VIEW intent
// matched by the AndroidManifest's <intent-filter> entries), the FileOpenPlugin
// copies the incoming content:// stream into the app cache directory and
// delivers an absolute path through the Capacitor bridge. This section
// converts that path into a Blob and loads it through the same
// core.loadDocument pipeline every other entry point uses.
//
// Cold start: the app was launched by the intent, before the WebView loaded.
//   The plugin stashed the URI. We fetch it once via `getPendingFile()`.
//
// Warm start: the app is already running and receives a new file. The plugin
//   fires a `fileOpen` event which we handle inline.
//
// Preview mode is deliberately NOT applied here: external files arriving via
// the Android intent are the user's own files, not catalogue resources, and
// are outside the scope of the subscription preview policy. The whole block
// is inert on non-Android platforms.

/**
 * Load a native-provided file payload (path + name + mimeType) into the
 * viewer. Mirrors `_handleLocalFileOpen` but the input is a path on the
 * device's filesystem, not a user-selected File.
 *
 * @private
 * @param {{ path: string, name: string, mimeType: string|null, size: number }} payload
 * @returns {Promise<void>}
 */
async function _openNativeFilePayload(payload) {
  if (!payload || !payload.path) return;

  // Wait for the DOM if the app was launched cold and the WebView is still
  // parsing. The 32 viewer element IDs must exist before we can cache them.
  if (document.readyState === 'loading') {
    await new Promise((resolve) => {
      document.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
  }

  const els = refreshElementCache();
  if (!els || !els.main) return;

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
    // Capacitor converts a native filesystem path into a URL the WebView can
    // fetch directly, with no base64 round-trip and no additional plugin.
    const capacitor = typeof window !== 'undefined' ? window.Capacitor : null;
    const fetchUrl = capacitor && typeof capacitor.convertFileSrc === 'function'
      ? capacitor.convertFileSrc(payload.path)
      : payload.path;

    const response = await fetch(fetchUrl);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const blob = await response.blob();

    // Preserve the original MIME type if the platform provided one; the
    // viewer's own MIME detection will handle the rest.
    const typedBlob = payload.mimeType && blob.type !== payload.mimeType
      ? blob.slice(0, blob.size, payload.mimeType)
      : blob;

    const core = await _ensureCore();
    await core.loadDocument(typedBlob, fileType, payload.name || 'Document');
  } catch (err) {
    const message = err && err.message ? err.message : 'Failed to open file';
    try { ui.showToast('Failed to open file: ' + message, 'error'); } catch { /* ignore */ }
  }
}

/**
 * Wire the Capacitor FileOpen plugin. Runs once at module load.
 *
 * Silent no-op when the platform has no FileOpen plugin registered (browser
 * build, iOS build without the plugin, etc.). A defensive null check on
 * `window.Capacitor` and `.Plugins` covers the browser case cleanly.
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

  // Cold start — the OS launched the app with a file. Fetch the stashed URI.
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

// ── Self-registration ───────────────────────────────────────────────────────
//
// This is the ONLY intentional side effect at module load in this file.
//
// `_wireNativeFileOpen()` must run before the browser (or WebView) dispatches
// the launch event, which can happen immediately after the module loads. It
// is a silent no-op on every non-Android platform.

_wireNativeFileOpen();