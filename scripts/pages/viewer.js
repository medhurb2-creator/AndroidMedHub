// scripts/pages/viewer.js

/**
 * Viewer Page — external file host.
 * ============================================================================
 *
 * The dedicated page for external files: Android intents (ACTION_VIEW),
 * file picker selections, drag-drop, share sheet handoffs.
 *
 * There is no auth here. There is no catalogue. When this page loads, an
 * external file is about to be displayed — the payload was stashed by
 * app.js or by viewer.js and this page's only job is to drain it.
 *
 * The full viewer subsystem lives in `../viewer.js`, which is shared with
 * resource-browser.html's embedded viewer. This module is a thin shell
 * that wires page-level concerns: drain the pending file, wire the back
 * button, tear down cleanly on navigation away.
 *
 * Internal catalogue resources are NOT opened here. They route through
 * resource-browser.html's embedded viewer overlay. See resource-browser.js.
 *
 * Lifecycle:
 *   init(context)   — called by page-manager after the page's HTML has been
 *                     injected into #app-root. Drains the pending file
 *                     (native payload in sessionStorage, or a local File
 *                     object held by viewer.js). If nothing is pending,
 *                     bounces to a sensible landing page.
 *
 *   destroy()       — called by page-manager before loading the next page.
 *                     Releases the viewer core's document state so a
 *                     subsequent file-open starts clean.
 *
 * @module pages/viewer
 */

import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as viewer from '../viewer.js';

/**
 * Read the current auth state without throwing. Used only to pick the
 * landing page when this page is reached without a pending file — never
 * to gate access to the file itself.
 *
 * @private
 * @returns {boolean}
 */
function _isAuthed() {
  try {
    return auth.checkAuth() === true;
  } catch {
    return false;
  }
}

/**
 * Where to go when this page was reached without a file.
 *
 * @private
 * @returns {string}
 */
function _defaultRoute() {
  return _isAuthed() ? 'subjects' : 'welcome';
}

/**
 * Page initializer. Called by page-manager after the HTML is injected.
 *
 * @param {{
 *   root: HTMLElement,
 *   page: string,
 *   path: string,
 *   query: URLSearchParams,
 *   params: Record<string, string>,
 *   hash: string,
 *   signal: AbortSignal,
 * }} context
 * @returns {Promise<void>}
 */
export async function init(context) {
  ui.applyTheme();

  // ── Drain the pending file ──────────────────────────────────────────
  //
  // viewer.openPendingFile() reads both pending sources:
  //
  //   1. sessionStorage.pendingFileOpen — a payload from the FileOpen
  //      plugin (Android intents), stashed by app.js or viewer.js.
  //
  //   2. A local File object — from a file-picker or drag-drop that
  //      arrived while the viewer chrome wasn't mounted. Held in a
  //      module variable in viewer.js.
  //
  // It returns true if a file was found and its load was initiated, and
  // false if nothing was pending. When it returns true, the load is
  // already in flight by the time this function continues — the file
  // fetch, chrome mount, and core.loadDocument call all happen inside
  // the module and surface through the DOM as they progress.
  let consumed = false;
  try {
    consumed = viewer.openPendingFile() === true;
  } catch (err) {
    console.error('[Viewer] openPendingFile failed:', err);
  }

  // ── No file? This page has nothing to display. ──────────────────────
  //
  // Reaching the viewer page without a pending payload means either:
  //   • a stale URL (bookmark, manual address-bar entry)
  //   • a race where the payload was consumed elsewhere
  //   • a bug in app.js's route resolution
  //
  // Any of these: bounce to the app's default landing page. Do NOT
  // display an empty viewer — a blank chrome with no document looks
  // like the app is broken.
  if (!consumed) {
    console.warn('[Viewer] No pending file — bouncing to default route');
    try { router.navigateTo(_defaultRoute()); } catch { /* ignore */ }
    return;
  }

  // ── Wire the back button ────────────────────────────────────────────
  //
  // On this page there is no catalogue to return to — the user came from
  // outside the app. Back navigates to the default landing page.
  // page-manager will destroy this page (calling destroy() below) as part
  // of the navigation, which closes the viewer core and clears the DOM.
  //
  // The button element is re-queried here rather than cached, because
  // page-manager replaces the page's DOM on every navigation. There is
  // no accumulation risk: this init() runs once per page load.
  const backBtn = document.getElementById('viewer-back-btn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      try { router.navigateTo(_defaultRoute()); } catch { /* ignore */ }
    });
  }

  // ── Wire the local-file input on this page ──────────────────────────
  //
  // The header includes an "Open local file" button and a hidden file
  // input. On the viewer page, opening a new file replaces the current
  // one. LOCAL_FILE_OPEN_REQUESTED is emitted by ui-internal.js when the
  // user picks a file; viewer.js handles it via its own subscription and
  // loads the new file into the already-mounted chrome. Nothing to wire
  // here — the listener is registered by the viewer module.
}

/**
 * Page teardown. Called by page-manager before the next page loads.
 *
 * Closes the viewer core and clears the viewer DOM so the next file-open
 * starts from a clean slate. Idempotent.
 *
 * @returns {void}
 */
export function destroy() {
  try {
    viewer.closeEmbeddedViewer();
  } catch (err) {
    console.warn('[Viewer] destroy failed:', err);
  }
}