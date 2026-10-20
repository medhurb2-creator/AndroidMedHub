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
 * Bound handler for browser back/forward. The app uses query-string
 * routing (`?subject=X&type=Y`), not hash routing, so a history traversal
 * fires `popstate` — not `hashchange`.
 *
 * This handler covers two independent back/forward cases:
 *
 *   • Share URL — the user taps back and lands on a share link from
 *     earlier in the session (`?share=1&id=…`).
 *   • Topic change — the user taps back/forward between the topic-grid
 *     view (`?subject=X&type=Y`) and a topic-scoped resource view
 *     (`?subject=X&type=Y&topic=Z`).
 *
 * Share takes priority: a share URL also carries `subject`/`type`, so
 * if we checked topic first we would treat a share landing as a plain
 * topic change and skip the share injection logic.
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
  // The `popstate` listener covers two web-side cases:
  //   • the user taps browser back and lands on a share URL from earlier
  //     in the session;
  //   • the user taps browser back/forward between a topic-scoped view
  //     (?topic=X) and the topic-grid view (no ?topic).
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

  // ── Back/forward — share OR topic change ───────────────────────────
  //
  // Share has priority: a share URL also carries `subject`/`type`, so it
  // must be consumed by _handleShareIfPresent() before we consider
  // whether a topic changed. Only if the popstate was NOT a share do we
  // fall through to the topic-change check.
  //
  // _handleTopicIfChanged is a no-op when the URL's `topic` already
  // matches the module's internal state, so back-to-back popstate events
  // cannot cause double fetches.
  _popStateHandler = () => {
    _handleShareIfPresent()
      .then((handledShare) => {
        if (handledShare) return;
        _handleTopicIfChanged();
      })
      .catch((err) =>
        console.warn('[ResourceBrowser] Popstate handler failed:', err)
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
  // Kick off the subscription refresh — but do NOT wait for it.
  //
  // The Open handler in resource-browser.js calls
  // subscription.hasActiveSubscription() to decide whether a premium
  // catalogue resource should open in preview mode (unsubscribed) or in
  // full (subscribed). hasActiveSubscription() reads from the subscription
  // manager's in-memory state, IndexedDB, and localStorage.
  //
  // Historically this call was awaited, on the theory that the very first
  // paint needed fresh truth. In practice the only thing the fresh truth
  // changes on the first paint is the 🔒 Premium badge — a cosmetic hint.
  // The Open and Download handlers each re-check entitlement themselves
  // at the moment of use and remain the sole authority. So we let this
  // promise settle in the background instead of holding the render on it.
  //
  // If the network is slow or the backend is cold, the previous behaviour
  // was a blank grid for one to three seconds before anything appeared.
  // Now the topic grid (or resource fetch) starts immediately with the
  // last-known entitlement and updates the badge if the check later
  // reports a different value.
  //
  // initSubscription() is idempotent and already falls back to cached
  // state on network failure, so a rejection here is informational only.
  // ---------------------------------------------------------------------------
  subscription.initSubscription().catch((err) => {
    console.warn('[ResourceBrowser] subscription init failed; continuing with cached state', err);
  });

  // ── Back button ────────────────────────────────────────────────────
  //
  // Topic-aware. The page hosts two levels of the resource hierarchy:
  //
  //   1. Topic grid      — the list of topics for a subject+category
  //   2. Scoped view     — the resources inside ONE topic
  //
  // When the user is viewing a topic's resources and taps Back, they
  // expect to return to the topic grid (up one level), not to exit the
  // page entirely (up two levels). When they're on the topic grid, or
  // when the subject+category has no topics at all, Back exits to
  // subjects as before.
  //
  // isTopicActive() is false in the "no topics exist" case even if the
  // user is looking at resources, so this branch naturally falls through
  // to the old behaviour for topic-less categories.
  const backBtn = $('#backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (resourceBrowser.isTopicActive()) {
        resourceBrowser.backToTopics();
      } else {
        router.navigateTo('subjects');
      }
    });
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
  // The module reads the URL itself to decide what to render:
  //
  //   • `?share=1&id=…`  → resolve the shared document, inject it as a
  //                        card, highlight it, strip the share params.
  //                        Topic is NOT shown.
  //   • `?topic=Z`       → load topic Z's resources directly.
  //   • neither, and the subject+category has topics in topics.json
  //                      → render the topic-selection grid.
  //   • neither, and there are no topics
  //                      → load the full category as before.
  //
  // All of this branching lives inside initResourceBrowser; the page
  // file only needs to call it once with the subject and type.
  //
  // initResourceBrowser itself no longer awaits the subscription refresh
  // (see above) — it starts the topics.json read and the branch dispatch
  // straight away. First paint therefore happens as soon as the topic
  // list is available (fast path) or as soon as the resource fetch
  // returns (slow path), without waiting on entitlement.
  await resourceBrowser.initResourceBrowser(subject, type, true);

  console.log('[ResourceBrowser] Initialized (forced fresh load)');
}

/**
 * If the current URL is a share link, resolve and inject the shared
 * document into the grid as a normal card.
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
 * Behaviour is identical to the cold-start path:
 *   • The shared document is resolved via the backend (public query).
 *   • It is injected into the grid as a normal card.
 *   • The filter is reset to "all" and any active search is cleared so
 *     the card is guaranteed visible.
 *   • The card is scrolled into view and briefly highlighted.
 *   • A toast names the document.
 *   • The share params are stripped from the URL.
 *   • NO viewer is opened. NO download is started.
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
  // isn't already on screen, injects it as a card, highlights it, and
  // strips the share params from the URL.
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
 * If the URL's `topic` param differs from the browser module's currently
 * active topic, ask the module to re-sync.
 *
 * This is what makes browser back/forward work between the two views:
 *
 *   ?subject=anatomy&type=notes                  → topic grid
 *   ?subject=anatomy&type=notes&topic=lower-limb → scoped view
 *
 * Traversing history between those URLs fires `popstate` without a page
 * reload, so `init()` does not re-run. Without this handler, the grid
 * and the scoped view would go out of sync with the address bar.
 *
 * `syncTopicFromUrl(topic)` is idempotent — it is a no-op when the
 * requested topic already matches the module's internal state — so a
 * burst of popstate events cannot cause double fetches.
 *
 * @private
 */
function _handleTopicIfChanged() {
  try {
    const params = new URLSearchParams(window.location.search);
    const urlTopic = params.get('topic') || null;   // null = no topic in URL

    // Ask the module what it currently thinks the active topic is. If
    // the URL agrees, this popstate was not a topic navigation and there
    // is nothing to do.
    const currentTopic = resourceBrowser.getCurrentTopic();
    if (currentTopic === urlTopic) return;

    // Re-sync. The module decides whether to show the topic grid
    // (urlTopic === null) or load the requested topic's resources.
    // It is responsible for updating its internal state, the URL, and
    // the grid.
    resourceBrowser.syncTopicFromUrl(urlTopic);
  } catch (err) {
    console.warn('[ResourceBrowser] Topic change handler failed:', err);
  }
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
  // re-creates the #element fresh.
}