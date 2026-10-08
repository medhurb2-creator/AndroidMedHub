// scripts/pages/resource-browser.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as subscription from '../subscription.js';
import * as resourceBrowser from '../resource-browser.js';
import * as viewer from '../viewer.js';

let $;

/**
 * Bound handler for the `native:file-arrived` event. Stored at module scope
 * so `destroy()` can remove exactly this reference. Re-creating it in each
 * init() would leak listeners across navigations.
 *
 * @type {(() => void) | null}
 */
let _fileArrivedHandler = null;

/**
 * Bound handler for the `native:share-arrived` event. Fired by app.js when
 * the Android WebView receives a new deep link while this page is already
 * the current page. Without this listener, a warm-start share would never
 * be consumed.
 *
 * @type {(() => void) | null}
 */
let _shareArrivedHandler = null;

/**
 * Bound handler for browser back/forward onto a share URL. The app uses
 * query-string routing (`?subject=X&type=Y`), not hash routing, so a
 * history traversal onto a share link fires `popstate` — not `hashchange`.
 *
 * @type {(() => void) | null}
 */
let _popStateHandler = null;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ────────────────────────────────────────────────────────────────────
  // Warm-start listeners.
  //
  // Two independent arrival channels, both of which can deliver a payload
  // while this page is already the current page — in which case `init()`
  // does not re-run and the payload would otherwise be lost:
  //
  //   • `native:file-arrived` — FileOpen plugin delivered a file
  //   • `native:share-arrived` — deep link / new intent delivered a share
  //
  // The `popstate` listener covers the web-side case: the user taps the
  // browser back button and lands on a share URL from earlier in the
  // session. The URL changes without a page reload, so a navigation
  // listener is required to notice it.
  //
  // All listeners are registered first, before the initial pending-file
  // and share checks below, so a payload that arrives during the async
  // work that follows is not lost.
  // ────────────────────────────────────────────────────────────────────

  // ── File arrival ───────────────────────────────────────────────────
  _fileArrivedHandler = () => {
    try {
      const consumed = viewer.openPendingFile() === true;
      if (consumed) {
        _enterFileOpenMode();
      }
    } catch (err) {
      console.warn('[ResourceBrowser] Warm-start file arrival failed:', err);
    }
  };
  document.addEventListener('native:file-arrived', _fileArrivedHandler);

  // ── Share arrival (native) ─────────────────────────────────────────
  _shareArrivedHandler = () => {
    _handleShareIfPresent().catch((err) =>
      console.warn('[ResourceBrowser] Warm-start share arrival failed:', err)
    );
  };
  document.addEventListener('native:share-arrived', _shareArrivedHandler);

  // ── Share arrival (browser back/forward) ───────────────────────────
  _popStateHandler = () => {
    _handleShareIfPresent().catch((err) =>
      console.warn('[ResourceBrowser] Popstate share check failed:', err)
    );
  };
  window.addEventListener('popstate', _popStateHandler);

  // ────────────────────────────────────────────────────────────────────
  // Detect file-open mode.
  //
  // The page hosts two very different flows:
  //
  //   1. External-file open — the OS handed us a file (Android intent),
  //      or the user picked one through the file picker / drag-drop.
  //      app.js or viewer.js stashed the payload and routed here.
  //      External files are NEVER subject to auth or the subscription
  //      preview policy. The user chose the file; it just opens.
  //
  //   2. Catalogue browse — the user tapped a subject or a deep link
  //      resolved to a catalogue route. This path requires auth and the
  //      subscription manager must be initialized before the resource
  //      browser starts.
  //
  // viewer.openPendingFile() drains both kinds of pending payloads:
  //   • sessionStorage.pendingFileOpen (native path-based payload)
  //   • the module-level File object in viewer.js (file-picker / drag-drop)
  //
  // It returns true if a file was found and its load was initiated, false
  // if nothing was pending. The call itself is side-effect free when
  // nothing is pending — no core init, no DOM changes.
  // ────────────────────────────────────────────────────────────────────

  let consumedFile = false;
  try {
    consumedFile = viewer.openPendingFile() === true;
  } catch (err) {
    console.warn('[ResourceBrowser] openPendingFile check failed:', err);
  }

  if (consumedFile) {
    _enterFileOpenMode();
    return;
  }

  // ────────────────────────────────────────────────────────────────────
  // Catalogue browse mode. Auth is required here.
  // ────────────────────────────────────────────────────────────────────

  if (!auth.checkAuth()) {
    router.navigateTo('login');
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const subject = params.get('subject');
  const type = params.get('type');

  if (!subject || !type) {
    ui.showToast('Invalid resource request', 'error');
    router.navigateTo('subjects');
    return;
  }

  // ---------------------------------------------------------------------------
  // Initialize the subscription manager BEFORE the resource browser.
  //
  // The Open handler in resource-browser.js calls
  // subscription.hasActiveSubscription() to decide whether a premium
  // catalogue resource should open in preview mode (unsubscribed) or in full
  // (subscribed). hasActiveSubscription() reads from the subscription
  // manager's in-memory state, IndexedDB, and localStorage.
  //
  // Without an explicit init, the manager's in-memory state is empty on a
  // fresh session, and the fallback chain can return stale local data. On
  // page load we want the freshest truth from the backend (when online and
  // authenticated), which is exactly what initSubscription() obtains.
  //
  // This is idempotent — the subscription manager handles repeated calls —
  // and cannot fail the page: any network error falls back to cached state.
  // ---------------------------------------------------------------------------
  try {
    await subscription.initSubscription();
  } catch (err) {
    // Never block the resource browser on a subscription hiccup. The Open
    // handler will still work with whatever cached state is available.
    console.warn('[ResourceBrowser] subscription init failed; continuing with cached state', err);
  }

  // Attach event listeners
  const backBtn = $('#backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }
  const themeBtn = $('#themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', ui.toggleTheme);
  }

  // Expose globals for viewer.js
  window.docMap = resourceBrowser.docMap;
  window.showViewer = resourceBrowser.showViewer;
  window.closeViewer = resourceBrowser.closeViewer;

  // ⚡ Force refresh: pass true to skip cache and call backend.
  //
  // If the URL also carries a share payload (`?share=1&id=…`), the
  // resource browser itself consumes it during this call — it resolves
  // the id (from the loaded page or the backend), injects it into the
  // grid, opens the viewer, and strips the share params. No extra
  // handling is needed here for the cold-start case.
  await resourceBrowser.initResourceBrowser(subject, type, true);

  console.log('[ResourceBrowser] Initialized (forced fresh load)');
}

/**
 * If the current URL is a share link, resolve and open the shared document.
 *
 * Called from the `native:share-arrived` warm-start listener and from the
 * `popstate` listener (browser back/forward onto a share URL).
 *
 * On the INITIAL page load this is NOT needed — `init()` above already
 * calls `initResourceBrowser()`, which itself reads the share params off
 * the URL and consumes them. This helper exists only for arrivals that
 * happen AFTER the page is already initialized: the URL changes without
 * a reload, so `init()` does not run again.
 *
 * Auth is required for the catalogue path, matching the cold-start flow.
 *
 * @private
 * @returns {Promise<boolean>} true if a share was detected and handled
 */
async function _handleShareIfPresent() {
  const params = new URLSearchParams(window.location.search);

  // Not a share link → nothing to do.
  if (params.get('share') !== '1') return false;

  const id = params.get('id');
  const subject = params.get('subject');
  const type = params.get('type');

  if (!id || !subject || !type) {
    // Malformed share link — do not hijack navigation.
    console.warn('[ResourceBrowser] Share params incomplete:', {
      id: !!id,
      subject: !!subject,
      type: !!type,
    });
    return false;
  }

  // Same auth gate as the cold-start catalogue path.
  if (!auth.checkAuth()) {
    router.navigateTo('login');
    return true;
  }

  console.log('[ResourceBrowser] Warm-start share detected', { subject, type, id });

  // Re-init the browser against the shared subject/type. This is
  // idempotent from the caller's perspective: it re-fetches page 1 for
  // the path (or serves it from cache) and then internally calls
  // `_consumeSharedDoc`, which resolves the id via the backend if it
  // isn't already on screen, opens the viewer, and strips the share
  // params from the URL.
  //
  // Subscription state is refreshed by `initResourceBrowser` itself, so
  // no separate init is needed here.
  try {
    await resourceBrowser.initResourceBrowser(subject, type, true);
  } catch (err) {
    console.error('[ResourceBrowser] Share re-init failed:', err);
    ui.showToast('Could not open shared document', 'error');
  }
  return true;
}

/**
 * File-open mode.
 *
 * The page exists purely as a host for the viewer chrome. The catalogue UI
 * is hidden; the viewer takes over. No auth check, no resource-browser init,
 * no subscription consultation.
 *
 * The actual file load has already been initiated by
 * `viewer.openPendingFile()` before we get here — the payload was consumed,
 * the fetch is in flight, and the viewer will render as soon as the blob
 * resolves. This function's only job is to make the page look right for the
 * file-open context.
 *
 * @private
 */
function _enterFileOpenMode() {
  console.log('[ResourceBrowser] File-open mode — external file, no auth');

  // Hide the catalogue chrome. The viewer sits on top of it (or replaces
  // it entirely, depending on whether #app was already occupying the
  // screen). Either way, hiding #app ensures the file-open view is not
  // showing leftover catalogue header / grid / footer.
  const appEl = document.getElementById('app');
  if (appEl) appEl.style.display = 'none';

  // The viewer's back button, when clicked, should exit the viewer and
  // restore the catalogue chrome so a subsequent navigation to
  // resource-browser shows the normal UI. Without this, back would close
  // the viewer but leave #app hidden.
  const backBtn = document.getElementById('viewer-back-btn');
  if (backBtn) {
    // Clone-and-replace clears any previously attached listeners without
    // needing a reference to them. resource-browser.js's init may run
    // multiple times across a session; without this, listeners would
    // accumulate on the same button element.
    const fresh = backBtn.cloneNode(true);
    if (backBtn.parentNode) {
      backBtn.parentNode.replaceChild(fresh, backBtn);
    }
    fresh.addEventListener('click', () => {
      try { viewer.closeEmbeddedViewer(); } catch { /* ignore */ }
      if (appEl) appEl.style.display = '';
      try { router.navigateTo('subjects'); } catch { /* ignore */ }
    });
  }
}

export function destroy() {
  // Remove the file warm-start listener. Without this, a second init() on
  // the same page session would stack a second handler and a warm-start
  // file would trigger openPendingFile() twice.
  if (_fileArrivedHandler) {
    try {
      document.removeEventListener('native:file-arrived', _fileArrivedHandler);
    } catch { /* ignore */ }
    _fileArrivedHandler = null;
  }

  // Remove the share warm-start listener. Same reasoning: without this a
  // second init() would stack handlers and a single deep link would
  // re-init the resource browser twice.
  if (_shareArrivedHandler) {
    try {
      document.removeEventListener('native:share-arrived', _shareArrivedHandler);
    } catch { /* ignore */ }
    _shareArrivedHandler = null;
  }

  // Remove the popstate listener. Without this, back/forward would fire
  // handlers on pages that no longer exist in the DOM.
  if (_popStateHandler) {
    try {
      window.removeEventListener('popstate', _popStateHandler);
    } catch { /* ignore */ }
    _popStateHandler = null;
  }

  // The viewer module owns its own lifecycle. Nothing else to tear down here.
  //
  // #app's display was set to 'none' if we entered file-open mode; the
  // next navigation to any page that uses #app will restore it via the
  // page-manager's `appRoot.innerHTML = pageMeta.html` injection, which
  // re-creates the #app element fresh.
}