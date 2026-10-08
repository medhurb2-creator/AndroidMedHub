// frontend-user/scripts/viewer/ui-internal.js

/**
 * Universal Document Viewer — Internal UI
 * ============================================================================
 *
 * The bridge between the viewer's static HTML shell and the event-driven
 * core. Owns:
 *   • CSS injection (only the animation rules that must live with the JS)
 *   • DOM element lookup cache (delegates to utils.getViewerElements)
 *   • Every click / change / input / keydown listener inside the viewer chrome
 *   • Auto-hide header/footer state machine
 *   • Fullscreen toggle (delegates to native-bridge for platform awareness)
 *   • Zoom % / page counter / search count displays
 *   • DPR change detection (via platform.js reads)
 *   • Fit-to-width observer (re-fits on rotation / resize unless user zoomed)
 *   • Embedded-viewer mount / unmount
 *   • Document-content clearing (preserves the four static chrome nodes)
 *   • Subscribe-to-bus glue that keeps labels in sync with state
 *   • Tap-sequence detection: single → chrome, double → zoom (Android)
 *   • Sidebar (drawer) open / close with scrim + ARIA state + manager dispatch
 *   • Footer visibility per document kind (PDF-only)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * INVARIANTS (do not violate — see project spec):
 *
 *   1. #viewer-main is a fixed window. It paints the background colour and
 *      owns the native scroll box. This file never transforms it, never
 *      attaches gesture listeners directly to it, and never measures it for
 *      anything except viewport dimensions.
 *
 *   2. .page-container is the ONLY interactive element inside #viewer-main.
 *      Every slot inside it — a <canvas class="page"> or a <div class="cover">
 *      — is sized natural × displayScale by core.js. Resolution changes the
 *      bitmap inside a canvas; it never changes a slot's CSS size.
 *
 *   3. Every button, key, and control click emits a bus event
 *      (PAGE_JUMP_REQUESTED, SCALE_REQUESTED, ROTATE_REQUESTED, SWIPE, …).
 *      This file never touches the engine, caches, canvases, or workers.
 *
 *   4. Because #viewer-main has pointer-events: none in CSS, clicks on the
 *      background never reach the click listener attached here. Events from
 *      .page-container and its descendants bubble up to that listener; taps
 *      on empty space do nothing. The page is the only interactive surface.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Exports (20):
 *   injectViewerStyles, refreshElementCache, setupControls,
 *   setupAutoHideListeners, showHeaderFooter, hideHeaderFooter,
 *   resetAutoHideTimer, toggleFullscreen, updatePageNumberDisplay,
 *   updateNavButtons, updateZoomDisplay, updateSearchCountDisplay,
 *   updateSearchBarState, setupDPRListener, setupFitWidthObserver,
 *   mountChrome, unmountChrome, bindCoreEvents, teardownControls,
 *   clearViewerContent
 *
 * Boundary rules (architecture spec § 2.3):
 *   • Only file (besides viewer.js) permitted to query the DOM by element ID,
 *     inject styles, or attach click/change/input/keydown listeners.
 *   • Never attaches scroll / pointer / wheel / touch listeners (interaction).
 *   • Only writes `viewMode` and `dpr` to ViewerState.
 *   • Does NOT import `router`. The preview-mode subscribe CTA is built in
 *     core.js and emits PREVIEW_SUBSCRIBE_REQUESTED on the bus; viewer.js
 *     owns the router.navigateTo call.
 *
 * Import exceptions (documented):
 *   • `../ui.js`        — app-level toasts. Only showToast is used here.
 *   • `./platform.js`   — platform predicates + DPR reads (leaf module).
 *   • `./native-bridge.js` — fullscreen (platform-aware).
 *
 * CSS ownership:
 *   The bulk of viewer styling — the page container, the .page and .cover
 *   slots, viewer-main overflow and the .x-scroll toggle, sidebar, scrim,
 *   safe-area insets, dark-mode variables, tap targets — lives in the page
 *   stylesheet (`resource-browser.css`). Only the header/footer slide
 *   animations are injected here, because they are the visual half of the
 *   auto-hide state machine that this file owns.
 *
 * Footer visibility:
 *   #viewer-footer holds the page counter, page-jump input, prev/next
 *   buttons, and the zoom control cluster. It is declared
 *   `style="display: none"` in viewer.html and must be explicitly shown for
 *   PDFs. The DOCUMENT_LOADED subscriber here is the single authoritative
 *   decision point.
 *
 *     PDF              → display: flex  (footer visible)
 *     image / text     → display: none  (footer hidden)
 *     office / other   → display: none  (footer hidden)
 *     blocked preview  → display: none  (no pages to navigate)
 *
 * Preview-mode CTA:
 *   core.js's _buildPreviewCTA() appends a card after the last preview page
 *   containing a "Subscribe to Continue" button. The button emits
 *   PREVIEW_SUBSCRIBE_REQUESTED on the bus. That event is handled by
 *   viewer.js, which calls router.navigateTo to route to the subscription
 *   page.
 *
 *   This file clamps the page counter, page input, and nav buttons to the
 *   effective limit so the UI matches what the render pipeline will display.
 *
 * Document clearing (clearViewerContent):
 *   Removes every DOM node the viewer created for the previous document
 *   while preserving the four static chrome nodes declared in viewer.html:
 *   #viewer-loading, #viewer-progress, #viewer-content, #viewer-text-layer.
 *
 *   What is removed: the .page-container, every <canvas class="page"> and
 *   every <div class="cover"> inside it, the preview CTA, the error
 *   container, and any other non-static direct child of #viewer-main.
 *
 * Tap-sequence behaviour (Android convention):
 *   • Single tap  → toggle header/footer visibility.
 *   • Double tap  → toggle zoom (fit-width ↔ 2×), viewport-centered.
 *   • No triple tap — conflicts with long-press text selection.
 *
 * Keyboard shortcuts:
 *   The entire keydown handler is gated behind `isWeb()`. Android has no
 *   physical keyboard, so registering handlers for Ctrl+F, +, -, 0, arrows,
 *   F3, F11 would be dead code and would clash with the hardware back button.
 *
 * Sidebar (drawer) integration:
 *   The drawer (#viewer-outline-drawer) hosts three panels selected by
 *   `data-panel`:
 *     • "outline" → document outline (rendered by managers.OutlineManager)
 *     • "search"  → search input + results (rendered by managers.SearchManager)
 *     • "more"    → document info + actions (rendered by managers.MorePanel)
 *
 *   `_openSidebar()` sets `data-panel` and adds `.open`, then calls
 *   `core.getManagers().dispatchPanel(panel)` to trigger the right manager
 *   to render its content.
 *
 * Fit-to-width observer:
 *   `setupFitWidthObserver()` watches #viewer-main for width changes and
 *   re-applies fit-to-width when the user has NOT manually zoomed. This
 *   makes phone rotation and browser window resize re-fit the page to the
 *   new width — matching Chrome and Edge PDF viewer behaviour.
 *
 *   User override is tracked from the `source` field of SCALE_APPLIED:
 *     • 'fit' or 'reset'       → no override (user wants fit)
 *     • 'double-tap'           → override (user zoomed in)
 *     • 'button', 'keyboard',
 *       'pinch', 'wheel'       → override
 *
 * @module viewer/ui-internal
 */

'use strict';

import { CONFIG, Events } from './core.js';
import { getViewerElements, escapeHtml } from './utils.js';
import {
  isWeb,
  devicePixelRatio,
  getDPRClamped,
} from './platform.js';
import {
  enterFullscreen,
  exitFullscreen,
  isFullscreen,
} from './native-bridge.js';
import { showToast } from '../ui.js';

// ============================================================================
// MODULE-PRIVATE STATE
// ============================================================================

/** Cached element map. @private @type {any} */
let _els = null;

/** Teardown registry: every function that undoes a listener or subscription. @private @type {Array<() => void>} */
const _listeners = [];

/** Idempotence flags. @private */
let _controlsBound = false;
let _autoHideBound = false;
let _dprBound = false;
let _eventsBound = false;
let _fitWidthBound = false;

// ── Auto-hide state machine ────────────────────────────────────────────────
/** @private @type {ReturnType<typeof setTimeout>|null} */ let _autoHideTimer = null;
/** @private */ let _isHeaderVisible = true;
/** @private */ let _isOverControls = false;

// ── DPR tracking ───────────────────────────────────────────────────────────
/** @private */ let _lastDPR = 1;

// ── Toast throttle ─────────────────────────────────────────────────────────
/** @private */ let _memoryToastAt = 0;
/** @private */ let _offlineToastAt = 0;

// ── Tap-sequence state (single / double) ───────────────────────────────────
/** @private @type {ReturnType<typeof setTimeout>|null} */ let _pendingTapTimer = null;
/** @private */ let _pendingTapX = 0;
/** @private */ let _pendingTapY = 0;

// ── Magnify toggle state (double tap) ──────────────────────────────────────
/** @private */ let _isMagnified = false;
/** @private */ let _preMagnifyScale = 1;

// ── Cached UI mirrors ──────────────────────────────────────────────────────
/** @private */ let _currentViewMode = 'scroll';
/** @private */ let _currentPage = 1;
/** @private */ let _currentTotalPages = 1;
/** @private */ let _currentScale = 1;
/** @private */ let _currentEffectiveLimit = 1;

// ── Search mirrors ─────────────────────────────────────────────────────────
/** @private */ let _searchMatchCount = 0;
/** @private */ let _searchCurrentIndex = -1;

// ── Fit-to-width override tracking ─────────────────────────────────────────
/**
 * True when the user has manually chosen a zoom level. While true, the
 * fit-width observer does NOT re-fit on width changes — respecting the
 * user's explicit choice. Cleared when the user clicks the "fit" button
 * (source === 'fit') or resets zoom (source === 'reset').
 * @private
 */
let _userZoomOverride = false;

/** @private @type {ResizeObserver|null} */ let _fitObserver = null;
/** @private */ let _fitObserverWidth = 0;

// ============================================================================
// 1. PRIVATE HELPERS
// ============================================================================

/** @private @param {() => void} fn */
function _register(fn) {
  if (typeof fn === 'function') _listeners.push(fn);
}

/** @private */
function _addListener(target, type, handler, options) {
  if (!target || typeof target.addEventListener !== 'function') return;
  try {
    target.addEventListener(type, handler, options);
    _register(() => {
      try { target.removeEventListener(type, handler, options); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

/** @private */
function _emit(core, event, payload) {
  try { core.getBus().emit(event, payload); } catch { /* ignore */ }
}

/** @private @returns {any} */
function _getEls() {
  if (!_els) refreshElementCache();
  return _els;
}

// ============================================================================
// 2. CSS INJECTION
// ============================================================================

/**
 * Inject the viewer's animation-only CSS into `<head>` exactly once.
 *
 * The rest of the viewer's styling lives in the page stylesheet
 * (`resource-browser.css`): the page container, the .page and .cover slots,
 * viewer-main overflow and the .x-scroll toggle, sidebar, scrim, safe-area
 * insets, dark-mode variables, tap targets.
 *
 * Only the header/footer slide animations are injected here, because they
 * are the visual half of the auto-hide state machine owned by this file.
 *
 * @returns {void}
 */
export function injectViewerStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('viewer-inline-styles')) return;

  const style = document.createElement('style');
  style.id = 'viewer-inline-styles';
  style.textContent = `
    /* Auto-hide chrome: slide-in / slide-out animation. */
    .viewer-header {
      transition: transform 0.3s ease, opacity 0.3s ease;
      transform: translateY(0);
      opacity: 1;
    }
    .viewer-header.hidden {
      transform: translateY(-100%);
      opacity: 0;
      pointer-events: none;
    }
    .viewer-footer {
      transition: transform 0.3s ease, opacity 0.3s ease;
      transform: translateY(0);
      opacity: 1;
    }
    .viewer-footer.hidden {
      transform: translateY(100%);
      opacity: 0;
      pointer-events: none;
    }

    @media (prefers-reduced-motion: reduce) {
      .viewer-header,
      .viewer-footer {
        transition: none;
      }
    }
  `;
  document.head.appendChild(style);
}

// ============================================================================
// 3. ELEMENT CACHE
// ============================================================================

/**
 * Re-query the element map and cache it. Called by core before each document
 * load and by tests.
 *
 * @returns {any}
 */
export function refreshElementCache() {
  _els = getViewerElements();
  return _els;
}

// ============================================================================
// 4. AUTO-HIDE STATE MACHINE
// ============================================================================

/**
 * Show the header and footer, start the auto-hide countdown.
 * @returns {void}
 */
export function showHeaderFooter() {
  if (typeof document === 'undefined') return;
  const header = document.querySelector('.viewer-header');
  const footer = document.getElementById('viewer-footer');
  if (header) header.classList.remove('hidden');
  if (footer) footer.classList.remove('hidden');
  _isHeaderVisible = true;
  resetAutoHideTimer();
}

/**
 * Hide the header and footer, cancel the countdown.
 * @returns {void}
 */
export function hideHeaderFooter() {
  if (typeof document === 'undefined') return;
  const header = document.querySelector('.viewer-header');
  const footer = document.getElementById('viewer-footer');
  if (header) header.classList.add('hidden');
  if (footer) footer.classList.add('hidden');
  _isHeaderVisible = false;
  if (_autoHideTimer) {
    clearTimeout(_autoHideTimer);
    _autoHideTimer = null;
  }
}

/**
 * Restart the auto-hide countdown. No-op when the user is over the controls
 * or the header is already hidden.
 * @returns {void}
 */
export function resetAutoHideTimer() {
  if (_autoHideTimer) {
    clearTimeout(_autoHideTimer);
    _autoHideTimer = null;
  }
  if (_isOverControls) return;
  if (!_isHeaderVisible) return;
  _autoHideTimer = setTimeout(() => {
    _autoHideTimer = null;
    if (!_isOverControls) hideHeaderFooter();
  }, CONFIG.AUTO_HIDE_DELAY_MS);
}

/**
 * Wire the mouse and focus keep-alive listeners on header and footer.
 * Idempotent.
 *
 * @param {import('./core.js').ViewerCore} _core
 * @returns {void}
 */
export function setupAutoHideListeners(_core) {
  if (_autoHideBound) return;
  if (typeof document === 'undefined') return;

  const header = document.querySelector('.viewer-header');
  const footer = document.getElementById('viewer-footer');
  if (!header && !footer) return;

  const onEnter = () => {
    _isOverControls = true;
    if (_autoHideTimer) {
      clearTimeout(_autoHideTimer);
      _autoHideTimer = null;
    }
  };

  const onLeave = () => {
    _isOverControls = false;
    if (_isHeaderVisible) resetAutoHideTimer();
  };

  const onFocusOut = (el) => (e) => {
    if (!el.contains(e.relatedTarget)) onLeave();
  };

  for (const el of [header, footer]) {
    if (!el) continue;
    _addListener(el, 'mouseenter', onEnter);
    _addListener(el, 'mouseleave', onLeave);
    _addListener(el, 'focusin', onEnter);
    _addListener(el, 'focusout', onFocusOut(el));
  }

  _autoHideBound = true;
}

/** @private */
function _resetAutoHide() {
  _isOverControls = false;
  if (_autoHideTimer) {
    clearTimeout(_autoHideTimer);
    _autoHideTimer = null;
  }
  _isHeaderVisible = true;
}

// ============================================================================
// 5. FULLSCREEN
// ============================================================================

/**
 * Toggle fullscreen on the viewer container.
 *
 * On Android this enters/exits immersive mode (status bar hidden) via the
 * native bridge. On web it uses the Fullscreen API. Both paths are
 * synchronous with respect to user activation — the async work happens after
 * the click has already been consumed.
 *
 * @returns {void}
 */
export function toggleFullscreen() {
  if (isFullscreen()) {
    exitFullscreen().catch(() => { /* ignore */ });
  } else {
    enterFullscreen().catch(() => { /* ignore */ });
  }
  Promise.resolve().then(_syncFullscreenLabel);
}

/** @private */
function _syncFullscreenLabel() {
  const els = _getEls();
  if (!els || !els.fullscreenBtn) return;
  const isFs = isFullscreen();
  els.fullscreenBtn.setAttribute('aria-pressed', isFs ? 'true' : 'false');
  els.fullscreenBtn.title = isFs ? 'Exit fullscreen' : 'Enter fullscreen';
}

// ============================================================================
// 6. DISPLAY UPDATERS
// ============================================================================

/**
 * Refresh the page counter from cached state. Kept public for external
 * callers (core) that want to force a refresh.
 *
 * @returns {void}
 */
export function updatePageNumberDisplay() {
  _applyPageNumbers(_currentPage, _currentTotalPages);
}

/** @private */
function _applyPageNumbers(current, total) {
  const els = _getEls();
  if (!els) return;

  const totalClamped = Math.max(1, total || 1);
  const effective = _currentEffectiveLimit > 0
    ? Math.min(Math.max(1, _currentEffectiveLimit), totalClamped)
    : totalClamped;
  const c = Math.max(1, Math.min(current, totalClamped));

  if (els.pageNum) els.pageNum.textContent = String(c);

  if (els.pageInput) {
    els.pageInput.value = String(c);
    els.pageInput.min = '1';
    els.pageInput.max = String(effective);
  }

  if (els.pageCount) els.pageCount.textContent = String(totalClamped);

  _applyNavButtons(c, effective);
}

/** @private */
function _applyNavButtons(current, effective) {
  const els = _getEls();
  if (!els) return;

  if (_currentViewMode === 'scroll') {
    if (els.prevBtn) els.prevBtn.disabled = true;
    if (els.nextBtn) els.nextBtn.disabled = true;
  } else {
    if (els.prevBtn) els.prevBtn.disabled = current <= 1;
    if (els.nextBtn) els.nextBtn.disabled = current >= effective;
  }
}

/**
 * Public updater kept for external callers that want to refresh nav buttons.
 * @returns {void}
 */
export function updateNavButtons() {
  _applyNavButtons(_currentPage, _currentEffectiveLimit || _currentTotalPages);
}

/**
 * Update the zoom-percentage display.
 * @returns {void}
 */
export function updateZoomDisplay() {
  const els = _getEls();
  if (!els || !els.zoomLevel) return;
  els.zoomLevel.textContent = Math.round(_currentScale * 100) + '%';
}

/**
 * Update the search count display (`M/N` or empty) and enable/disable the
 * prev/next match buttons.
 * @returns {void}
 */
export function updateSearchCountDisplay() {
  const els = _getEls();
  if (!els) return;
  const total = _searchMatchCount;
  const idx = _searchCurrentIndex;
  if (els.searchCount) {
    if (total > 0 && idx >= 0) {
      els.searchCount.textContent = `${idx + 1}/${total}`;
    } else {
      els.searchCount.textContent = '';
    }
  }
  const disabled = total === 0;
  if (els.searchPrev) els.searchPrev.disabled = disabled;
  if (els.searchNext) els.searchNext.disabled = disabled;
}

/**
 * Open or close the inline search bar in the header. In sidebar mode, this
 * only manages the inline bar's visibility — the drawer's search panel is
 * managed separately.
 *
 * @param {boolean} [open]
 * @returns {void}
 */
export function updateSearchBarState(open) {
  const els = _getEls();
  if (!els || !els.searchBar) return;
  const shouldOpen = typeof open === 'boolean'
    ? open
    : !els.searchBar.classList.contains('active');

  if (shouldOpen) {
    els.searchBar.classList.add('active');
    if (els.searchInput && typeof els.searchInput.focus === 'function') {
      try { els.searchInput.focus(); } catch { /* ignore */ }
    }
  } else {
    els.searchBar.classList.remove('active');
    if (els.searchInput && typeof els.searchInput.blur === 'function') {
      try { els.searchInput.blur(); } catch { /* ignore */ }
    }
  }
  if (els.searchBtn) {
    els.searchBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }
}

/** @private @returns {boolean} */
function _isSearchOpen() {
  const els = _getEls();
  return !!(els && els.searchBar && els.searchBar.classList.contains('active'));
}

// ============================================================================
// 7. SIDEBAR (DRAWER) HELPERS
// ============================================================================

/** @private @returns {boolean} */
function _hasSidebar() {
  try {
    return !!document.getElementById('viewer-outline-drawer')
      && !!document.getElementById('viewer-drawer-scrim');
  } catch {
    return false;
  }
}

/**
 * Open the sidebar with the given panel content.
 *
 * Sets `data-panel`, adds `.open` on both the drawer and its scrim, updates
 * ARIA state on every toggle button, hides the inline search bar (the drawer
 * owns search when it is open), and dispatches to the managers so the panel
 * content renders.
 *
 * Idempotent — opening an already-open drawer simply switches the panel.
 *
 * @private
 * @param {import('./core.js').ViewerCore} core
 * @param {'outline'|'search'|'more'} panel
 * @returns {void}
 */
function _openSidebar(core, panel) {
  const els = _getEls();
  if (!els || !els.outlineDrawer) return;
  const drawer = els.outlineDrawer;
  const scrim = document.getElementById('viewer-drawer-scrim');

  const safePanel = (panel === 'search' || panel === 'more') ? panel : 'outline';

  drawer.dataset.panel = safePanel;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  if (scrim) scrim.classList.add('open');

  _setToggleExpanded('viewer-outline-btn', safePanel === 'outline');
  _setToggleExpanded('viewer-search-btn', safePanel === 'search');
  _setToggleExpanded('viewer-more-btn', safePanel === 'more');

  if (safePanel === 'search' && els.searchBar) {
    els.searchBar.classList.remove('active');
  }

  try {
    const managers = (typeof core.getManagers === 'function') ? core.getManagers() : null;
    if (managers && typeof managers.dispatchPanel === 'function') {
      managers.dispatchPanel(safePanel);
    }
  } catch { /* ignore */ }
}

/**
 * Close the sidebar (and its scrim) and reset every toggle's ARIA state.
 * Idempotent — safe to call when the drawer is already closed.
 *
 * @private
 * @returns {void}
 */
function _closeSidebar() {
  const els = _getEls();
  if (els && els.outlineDrawer) {
    els.outlineDrawer.classList.remove('open');
    els.outlineDrawer.setAttribute('aria-hidden', 'true');
  }
  const scrim = document.getElementById('viewer-drawer-scrim');
  if (scrim) scrim.classList.remove('open');
  _setToggleExpanded('viewer-outline-btn', false);
  _setToggleExpanded('viewer-search-btn', false);
  _setToggleExpanded('viewer-more-btn', false);
}

/** @private */
function _setToggleExpanded(id, expanded) {
  try {
    const el = document.getElementById(id);
    if (el) el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  } catch { /* ignore */ }
}

/** @private @returns {boolean} */
function _isSidebarOpen() {
  try {
    const drawer = document.getElementById('viewer-outline-drawer');
    return !!(drawer && drawer.classList.contains('open'));
  } catch {
    return false;
  }
}

// ============================================================================
// 8. DPR LISTENER
// ============================================================================

/**
 * Wire the resize listener that detects DPR changes. Idempotent.
 * @param {import('./core.js').ViewerCore} core
 * @returns {void}
 */
export function setupDPRListener(core) {
  if (_dprBound) return;
  if (typeof window === 'undefined') return;

  _lastDPR = devicePixelRatio();

  const handler = () => {
    const current = devicePixelRatio();
    if (current === _lastDPR) return;
    _lastDPR = current;
    try {
      const state = core.getState();
      state.set('dpr', getDPRClamped(CONFIG.MAX_DPR));
    } catch { /* ignore */ }
    try {
      const zoom = core.getZoom();
      if (zoom && typeof zoom.applyDprChange === 'function') {
        zoom.applyDprChange(current);
      }
    } catch { /* ignore */ }
  };

  _addListener(window, 'resize', handler);
  _dprBound = true;
}

// ============================================================================
// 9. FIT-TO-WIDTH OBSERVER
// ============================================================================

/**
 * Watch #viewer-main for width changes and re-apply fit-to-width when the
 * user has NOT manually overridden the zoom.
 *
 * Chrome / Edge behaviour: a phone rotation or a browser window resize while
 * fit-to-width is active keeps the page fitting the new width. As soon as
 * the user pinches, buttons, or uses the keyboard to change the zoom, the
 * observer goes quiet — respecting the user's explicit choice.
 *
 * Uses a ResizeObserver on #viewer-main. The observer fires on the initial
 * observation; we rAF-coalesce so a window drag does not thrash.
 *
 * Idempotent — safe to call more than once; only the first call binds.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {void}
 */
export function setupFitWidthObserver(core) {
  if (_fitWidthBound) return;
  if (typeof window === 'undefined') return;
  if (typeof ResizeObserver !== 'function') return;

  const els = _getEls();
  if (!els || !els.main) return;

  _fitObserverWidth = els.main.clientWidth;

  let pending = false;

  try {
    _fitObserver = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        try {
          const main = els.main;
          if (!main) return;
          const w = main.clientWidth;
          if (!(w > 0) || w === _fitObserverWidth) return;
          _fitObserverWidth = w;

          // User has chosen a scale manually — respect it.
          if (_userZoomOverride) return;

          // Re-apply fit-to-width via the core's private helper. It
          // computes the new scale, sets state, and calls
          // zoom.syncScale() so the next render uses the new scale.
          if (core && typeof core._applyFitToWidth === 'function') {
            Promise.resolve(core._applyFitToWidth()).catch(() => { /* ignore */ });
          }
        } catch { /* ignore */ }
      });
    });

    _fitObserver.observe(els.main);

    _register(() => {
      try { if (_fitObserver) _fitObserver.disconnect(); } catch { /* ignore */ }
      _fitObserver = null;
      _fitWidthBound = false;
    });

    _fitWidthBound = true;
  } catch { /* ignore */ }
}

/**
 * Track whether the user has explicitly chosen a scale. Called from the
 * SCALE_APPLIED subscriber. Sources that indicate "user did not override"
 * clear the flag; everything else sets it.
 *
 * @private
 * @param {string} source
 */
function _noteZoomSource(source) {
  if (source === 'fit') { _userZoomOverride = false; return; }
  if (source === 'reset') { _userZoomOverride = false; return; }
  // button, keyboard, pinch, wheel, double-tap all mean the user chose.
  _userZoomOverride = true;
}

// ============================================================================
// 10. CONTROL WIRING
// ============================================================================

/**
 * Wire every UI control listener. Idempotent.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {void}
 */
export function setupControls(core) {
  if (_controlsBound) return;
  const els = _getEls();
  if (!els || !els.container) return;

  // ── Menu (hamburger → dropdown) ────────────────────────────────────────
  const menuBtn = document.getElementById('viewer-menu-btn');
  const menuPanel = document.getElementById('viewer-menu');
  if (menuBtn && menuPanel) {
    const closeMenu = () => {
      if (menuPanel.hidden) return;
      menuPanel.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    };

    const openMenu = () => {
      menuPanel.hidden = false;
      menuBtn.setAttribute('aria-expanded', 'true');

      // Close on outside click, Escape, or after any item is picked.
      const onOutside = (e) => {
        if (menuPanel.contains(e.target)) return;
        if (menuBtn.contains(e.target)) return;
        closeMenu();
        cleanup();
      };
      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        closeMenu();
        cleanup();
      };
      const cleanup = () => {
        document.removeEventListener('click', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
      };

      // Defer attachment so the same click that opened the menu doesn't
      // immediately close it via the outside-click handler.
      setTimeout(() => {
        document.addEventListener('click', onOutside, true);
        document.addEventListener('keydown', onKey, true);
      }, 0);
    };

    _addListener(menuBtn, 'click', (e) => {
      e.stopPropagation();
      if (menuPanel.hidden) openMenu();
      else closeMenu();
    });

    // Any item click closes the menu after the item's own handler runs.
    _addListener(menuPanel, 'click', (e) => {
      const item = e.target.closest('.viewer-menu-item');
      if (!item) return;
      setTimeout(closeMenu, 0);
    });
  }

  const hasSidebar = _hasSidebar();

  // ── View-mode toggle ────────────────────────────────────────────────────
  if (els.toggleViewBtn) {
    const labelSync = () => {
      try {
        const state = core.getState();
        const mode = state.get('viewMode') || 'scroll';
        const label = document.getElementById('viewer-toggle-view-label');
        if (label) {
          label.textContent = mode === 'scroll' ? 'Page view' : 'Scroll view';
        }
        // Fallback for older DOM where the toggle was a top-level button.
        if (!label && els.toggleViewBtn) {
          els.toggleViewBtn.textContent = mode === 'scroll' ? '📄 Page View' : '📜 Scroll View';
        }
      } catch { /* ignore */ }
    };
    labelSync();

    _addListener(els.toggleViewBtn, 'click', () => {
      let mode = 'scroll';
      try {
        const state = core.getState();
        mode = state.get('viewMode') || 'scroll';
      } catch { /* ignore */ }
      const next = mode === 'scroll' ? 'page' : 'scroll';
      try { core.getState().set('viewMode', next); } catch { /* ignore */ }
      labelSync();
      _emit(core, Events.LAYOUT_CHANGED, { mode: next });
    });
  }

  // ── Prev / next page ────────────────────────────────────────────────────
  if (els.prevBtn) {
    _addListener(els.prevBtn, 'click', () => {
      let cur = 1;
      try { cur = core.getState().get('currentPage') || 1; } catch { /* ignore */ }
      if (cur <= 1) return;
      _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: cur - 1, reason: 'prev-button' });
    });
  }
  if (els.nextBtn) {
    _addListener(els.nextBtn, 'click', () => {
      let cur = 1;
      let total = 1;
      try {
        const s = core.getState();
        cur = s.get('currentPage') || 1;
        total = s.get('numPages') || 1;
      } catch { /* ignore */ }
      const limit = _currentEffectiveLimit > 0
        ? Math.min(_currentEffectiveLimit, total)
        : total;
      if (cur >= limit) return;
      _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: cur + 1, reason: 'next-button' });
    });
  }

  // ── Page input ──────────────────────────────────────────────────────────
  if (els.pageInput) {
    const jump = () => {
      const raw = parseInt(els.pageInput.value, 10);
      if (!Number.isFinite(raw)) return;
      let total = 1;
      try { total = core.getState().get('numPages') || 1; } catch { /* ignore */ }
      const limit = _currentEffectiveLimit > 0
        ? Math.min(_currentEffectiveLimit, total)
        : total;
      const target = Math.max(1, Math.min(raw, limit));
      els.pageInput.value = String(target);
      let cur = 1;
      try { cur = core.getState().get('currentPage') || 1; } catch { /* ignore */ }
      if (target === cur) return;
      _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: target, reason: 'input' });
    };
    _addListener(els.pageInput, 'change', jump);
    _addListener(els.pageInput, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jump();
      }
    });
  }

  // ── Zoom controls ───────────────────────────────────────────────────────
  if (els.zoomIn) {
    _addListener(els.zoomIn, 'click', () => {
      let scale = 1;
      try { scale = core.getState().get('scale') || 1; } catch { /* ignore */ }
      const next = Math.min(scale + CONFIG.ZOOM_STEP, CONFIG.MAX_ZOOM);
      _emit(core, Events.SCALE_REQUESTED, { scale: next, source: 'button' });
    });
  }
  if (els.zoomOut) {
    _addListener(els.zoomOut, 'click', () => {
      let scale = 1;
      try { scale = core.getState().get('scale') || 1; } catch { /* ignore */ }
      const next = Math.max(scale - CONFIG.ZOOM_STEP, CONFIG.MIN_ZOOM);
      _emit(core, Events.SCALE_REQUESTED, { scale: next, source: 'button' });
    });
  }
  if (els.zoomFit) {
    _addListener(els.zoomFit, 'click', () => {
      try {
        const zoom = core.getZoom();
        if (zoom && typeof zoom.requestFit === 'function') zoom.requestFit();
      } catch { /* ignore */ }
    });
  }
  if (els.zoomReset) {
    _addListener(els.zoomReset, 'click', () => {
      _emit(core, Events.SCALE_REQUESTED, { scale: 1.0, source: 'reset' });
    });
  }

  // ── Rotation (optional button; not in the current HTML) ────────────────
  {
    const rotateBtn = document.getElementById('viewer-rotate-btn');
    if (rotateBtn) {
      _addListener(rotateBtn, 'click', () => {
        _emit(core, Events.ROTATE_REQUESTED, { delta: 90 });
      });
    }
  }

  // ── Fullscreen ──────────────────────────────────────────────────────────
  if (els.fullscreenBtn) {
    _addListener(els.fullscreenBtn, 'click', () => {
      try { toggleFullscreen(); } catch { /* ignore */ }
    });
  }
  if (isWeb()) {
    _addListener(document, 'fullscreenchange', _syncFullscreenLabel);
  }

  // ── Outline button ─────────────────────────────────────────────────────
  if (els.outlineBtn) {
    _addListener(els.outlineBtn, 'click', () => {
      if (hasSidebar) {
        if (_isSidebarOpen() && els.outlineDrawer && els.outlineDrawer.dataset.panel === 'outline') {
          _closeSidebar();
        } else {
          _openSidebar(core, 'outline');
        }
      } else {
        // Legacy fallback when the sidebar shell is not present.
        try { core.getOutline().toggle(); } catch { /* ignore */ }
      }
    });
  }

  // ── Search button ──────────────────────────────────────────────────────
  if (els.searchBtn) {
    _addListener(els.searchBtn, 'click', () => {
      if (hasSidebar) {
        if (_isSidebarOpen() && els.outlineDrawer && els.outlineDrawer.dataset.panel === 'search') {
          _closeSidebar();
        } else {
          _openSidebar(core, 'search');
        }
      } else {
        // Legacy inline mode.
        updateSearchBarState();
        if (!_isSearchOpen()) {
          try { core.getSearch().clear(); } catch { /* ignore */ }
        }
      }
    });
  }

  // ── "More" button (optional; only if HTML provides it) ─────────────────
  {
    const moreBtn = document.getElementById('viewer-more-btn');
    if (moreBtn && hasSidebar) {
      _addListener(moreBtn, 'click', () => {
        if (_isSidebarOpen() && els.outlineDrawer && els.outlineDrawer.dataset.panel === 'more') {
          _closeSidebar();
        } else {
          _openSidebar(core, 'more');
        }
      });
    }
  }

  // ── Inline search bar controls (legacy path + sidebar header fallback) ─
  if (els.searchClose) {
    _addListener(els.searchClose, 'click', () => {
      updateSearchBarState(false);
      try { core.getSearch().clear(); } catch { /* ignore */ }
      if (hasSidebar && _isSidebarOpen()) _closeSidebar();
    });
  }
  if (els.searchInput) {
    const runSearch = () => {
      const q = els.searchInput.value || '';
      const cs = !!(els.searchCaseSensitive && els.searchCaseSensitive.checked);
      const ww = !!(els.searchWholeWord && els.searchWholeWord.checked);
      try {
        const search = core.getSearch();
        if (search && search.searchDebounced) {
          search.searchDebounced(q, { caseSensitive: cs, wholeWord: ww });
        }
      } catch { /* ignore */ }
    };
    _addListener(els.searchInput, 'input', runSearch);
    _addListener(els.searchInput, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        try {
          const search = core.getSearch();
          if (e.shiftKey) search.previous();
          else search.next();
        } catch { /* ignore */ }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        updateSearchBarState(false);
        try { core.getSearch().clear(); } catch { /* ignore */ }
        if (hasSidebar && _isSidebarOpen()) _closeSidebar();
      }
    });
  }
  if (els.searchPrev) {
    _addListener(els.searchPrev, 'click', () => {
      try { core.getSearch().previous(); } catch { /* ignore */ }
    });
  }
  if (els.searchNext) {
    _addListener(els.searchNext, 'click', () => {
      try { core.getSearch().next(); } catch { /* ignore */ }
    });
  }
  [els.searchCaseSensitive, els.searchWholeWord].forEach((el) => {
    if (!el) return;
    _addListener(el, 'change', () => {
      const q = els.searchInput ? els.searchInput.value || '' : '';
      if (!q) return;
      const cs = !!(els.searchCaseSensitive && els.searchCaseSensitive.checked);
      const ww = !!(els.searchWholeWord && els.searchWholeWord.checked);
      try {
        const search = core.getSearch();
        if (search && search.search) {
          search.search(q, { caseSensitive: cs, wholeWord: ww }).catch(() => { /* ignore */ });
        }
      } catch { /* ignore */ }
    });
  });

  // ── Scrim: click closes the sidebar ────────────────────────────────────
  if (hasSidebar) {
    const scrim = document.getElementById('viewer-drawer-scrim');
    if (scrim) {
      _addListener(scrim, 'click', () => {
        _closeSidebar();
        if (_isSearchOpen()) updateSearchBarState(false);
      });
    }
  } else {
    // Legacy fallback: click outside the drawer closes it.
    _addListener(document, 'click', (e) => {
      if (!els.outlineDrawer) return;
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('.outline-drawer')) return;
      if (e.target.closest('#viewer-outline-btn')) return;
      els.outlineDrawer.classList.remove('open');
    });
  }

  // ── Open local file ─────────────────────────────────────────────────────
  if (els.openLocalBtn && els.fileInput) {
    _addListener(els.openLocalBtn, 'click', () => {
      try { els.fileInput.click(); } catch { /* ignore */ }
    });
    _addListener(els.fileInput, 'change', () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      if (file) _emit(core, Events.LOCAL_FILE_OPEN_REQUESTED, { file });
      try { els.fileInput.value = ''; } catch { /* ignore */ }
    });
  }

  // ── Drag & drop (web only — no drag on Android) ────────────────────────
  if (isWeb()) {
    const dropHandler = (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const file = e.dataTransfer.files[0];
      if (file) _emit(core, Events.LOCAL_FILE_OPEN_REQUESTED, { file });
    };
    const dragOverHandler = (e) => {
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch { /* ignore */ }
    };
    _addListener(document, 'drop', dropHandler);
    _addListener(document, 'dragover', dragOverHandler);
  }

  // ── Back button ─────────────────────────────────────────────────────────
  if (els.backBtn) {
    _addListener(els.backBtn, 'click', () => {
      _emit(core, Events.NAV_BACK_REQUESTED, {});
    });
  }

  // ── Keyboard shortcuts (web only) ──────────────────────────────────────
  if (isWeb()) {
    _addListener(document, 'keydown', (e) => {
      const target = e.target;
      const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
      const isSearchInput = target && els.searchInput && target === els.searchInput;
      const mod = e.ctrlKey || e.metaKey;

      // ── Ctrl/Cmd + F → open search ────────────────────────────────────
      if (mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        if (hasSidebar) _openSidebar(core, 'search');
        else updateSearchBarState(true);
        return;
      }

      // ── F11 → fullscreen ──────────────────────────────────────────────
      if (e.key === 'F11') {
        e.preventDefault();
        toggleFullscreen();
        return;
      }

      // ── F3 → next search match ────────────────────────────────────────
      if (e.key === 'F3' && !e.shiftKey) {
        if (_isSearchOpen() || (hasSidebar && _isSidebarOpen())) {
          e.preventDefault();
          try { core.getSearch().next(); } catch { /* ignore */ }
        }
        return;
      }

      // ── Shift + F3 → previous search match ────────────────────────────
      if (e.key === 'F3' && e.shiftKey) {
        if (_isSearchOpen() || (hasSidebar && _isSidebarOpen())) {
          e.preventDefault();
          try { core.getSearch().previous(); } catch { /* ignore */ }
        }
        return;
      }

      // ── Escape → close search / sidebar ───────────────────────────────
      if (e.key === 'Escape') {
        if (_isSearchOpen()) {
          e.preventDefault();
          updateSearchBarState(false);
          try { core.getSearch().clear(); } catch { /* ignore */ }
          if (_isSidebarOpen()) _closeSidebar();
          return;
        }
        if (_isSidebarOpen()) {
          e.preventDefault();
          _closeSidebar();
          return;
        }
      }

      // Do not steal keystrokes from text inputs unless they're the search
      // input (which has its own handler for Enter / Escape).
      if (inInput && !isSearchInput) return;

      // ── Arrow keys (page mode only) ───────────────────────────────────
      switch (e.key) {
        case 'ArrowLeft':
          if (_currentViewMode === 'page') {
            e.preventDefault();
            if (_currentPage > 1) {
              _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: _currentPage - 1, reason: 'keyboard' });
            }
          }
          break;
        case 'ArrowRight': {
          if (_currentViewMode === 'page') {
            e.preventDefault();
            const limit = _currentEffectiveLimit > 0
              ? Math.min(_currentEffectiveLimit, _currentTotalPages)
              : _currentTotalPages;
            if (_currentPage < limit) {
              _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: _currentPage + 1, reason: 'keyboard' });
            }
          }
          break;
        }

        // ── Home / End → first / last page ────────────────────────────────
        case 'Home':
          e.preventDefault();
          _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: 1, reason: 'keyboard' });
          break;
        case 'End': {
          e.preventDefault();
          const limit = _currentEffectiveLimit > 0
            ? Math.min(_currentEffectiveLimit, _currentTotalPages)
            : _currentTotalPages;
          _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: limit, reason: 'keyboard' });
          break;
        }

        // ── PageUp / PageDown → prev / next page ──────────────────────────
        case 'PageUp':
          e.preventDefault();
          if (_currentPage > 1) {
            _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: _currentPage - 1, reason: 'keyboard' });
          }
          break;
        case 'PageDown': {
          e.preventDefault();
          const limit = _currentEffectiveLimit > 0
            ? Math.min(_currentEffectiveLimit, _currentTotalPages)
            : _currentTotalPages;
          if (_currentPage < limit) {
            _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: _currentPage + 1, reason: 'keyboard' });
          }
          break;
        }

        // ── Zoom: + / = / - / 0 ───────────────────────────────────────────
        case '+':
        case '=':
          if (!isSearchInput) {
            e.preventDefault();
            _emit(core, Events.SCALE_REQUESTED, {
              scale: Math.min(_currentScale + CONFIG.ZOOM_STEP, CONFIG.MAX_ZOOM),
              source: 'keyboard',
            });
          }
          break;
        case '-':
          if (!isSearchInput) {
            e.preventDefault();
            _emit(core, Events.SCALE_REQUESTED, {
              scale: Math.max(_currentScale - CONFIG.ZOOM_STEP, CONFIG.MIN_ZOOM),
              source: 'keyboard',
            });
          }
          break;
        case '0':
          if (!isSearchInput) {
            e.preventDefault();
            _emit(core, Events.SCALE_REQUESTED, { scale: 1.0, source: 'keyboard' });
          }
          break;

        default:
          break;
      }
    });
  }

  // ── Tap sequence (single → chrome, double → zoom) ──────────────────────
  //
  // Attached to #viewer-main, but that element has pointer-events: none in
  // CSS. Only events bubbling up from .page-container (and its descendants)
  // ever reach this listener. Taps on the background do nothing.
  if (els.main) {
    _addListener(els.main, 'click', (e) => {
      const target = e.target;
      if (target && typeof target.closest === 'function') {
        if (target.closest('button, a, input, select, textarea, .outline-drawer, .viewer-preview-cta, #viewer-drawer-scrim')) return;
      }

      const x = e.clientX;
      const y = e.clientY;

      if (_pendingTapTimer !== null) {
        clearTimeout(_pendingTapTimer);
        _pendingTapTimer = null;
        _emit(core, Events.DOUBLE_TAP, { x, y });
        return;
      }

      _pendingTapX = x;
      _pendingTapY = y;
      _pendingTapTimer = setTimeout(() => {
        _pendingTapTimer = null;
        _emit(core, Events.SINGLE_TAP, { x: _pendingTapX, y: _pendingTapY });
      }, CONFIG.DOUBLE_SETTLE_MS);
    });
  }

  _controlsBound = true;
}

// ============================================================================
// 11. BUS SUBSCRIPTIONS
// ============================================================================

/**
 * Subscribe to the bus events that drive UI updates. Idempotent.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {void}
 */
export function bindCoreEvents(core) {
  if (_eventsBound) return;
  const bus = core.getBus();

  const subscribe = (event, handler) => {
    try { _register(bus.on(event, handler)); } catch { /* ignore */ }
  };

  const effectiveLimit = () => {
    try {
      if (core && typeof core.getEffectivePageLimit === 'function') {
        const limit = core.getEffectivePageLimit();
        if (typeof limit === 'number' && limit > 0) return limit;
      }
      return core.getState().get('numPages') || 1;
    } catch {
      return 1;
    }
  };

  // ── Loading / loaded / error ─────────────────────────────────────────────
  subscribe(Events.DOCUMENT_LOADING, () => {
    const els = _getEls();
    if (!els) return;
    if (els.loading) els.loading.style.display = 'block';
    if (els.progress) els.progress.style.display = 'none';
    if (els.main) {
      const err = els.main.querySelector('.error-container');
      if (err) err.remove();
    }
  });

  subscribe(Events.DOCUMENT_LOADED, () => {
    const els = _getEls();
    if (!els) return;
    if (els.loading) els.loading.style.display = 'none';
    if (els.progress) els.progress.style.display = 'none';

    let current = 1;
    let total = 1;
    let documentKind = null;
    let blocked = false;
    try {
      const s = core.getState();
      current = s.get('currentPage') || 1;
      total = s.get('numPages') || 1;
      documentKind = s.get('documentKind');
      blocked = s.get('previewBlocked') === true;
      _currentPage = current;
      _currentTotalPages = total;
      _currentViewMode = s.get('viewMode') || 'scroll';
      _currentScale = s.get('scale') || 1;
    } catch { /* ignore */ }

    _currentEffectiveLimit = effectiveLimit();

    // Footer is shown only for PDFs that have at least one visible page.
    if (els.footer) {
      els.footer.style.display =
        (documentKind === 'pdf' && !blocked) ? 'flex' : 'none';
    }

    _applyPageNumbers(current, total);
    updateZoomDisplay();
    showHeaderFooter();

    // A fresh document starts without a user zoom override — fit-to-width
    // has just been applied by core._loadPdf, so the observer should be
    // free to re-fit on subsequent width changes.
    _userZoomOverride = false;

    // Refresh the fit-width observer's baseline width now that the DOM
    // has changed.
    try {
      if (_fitObserver && els.main) {
        _fitObserverWidth = els.main.clientWidth;
      }
    } catch { /* ignore */ }
  });

  subscribe(Events.DOCUMENT_ERROR, (payload) => {
    const els = _getEls();
    if (!els) return;
    if (els.loading) els.loading.style.display = 'none';
    if (els.progress) els.progress.style.display = 'none';
    if (!els.main) return;
    const rawMessage = payload && payload.message ? payload.message : 'Failed to load document';
    const safe = escapeHtml(String(rawMessage));

    // Preserve the four static chrome nodes; append the error container.
    const keep = new Set();
    if (els.loading) keep.add(els.loading);
    if (els.progress) keep.add(els.progress);
    if (els.content) keep.add(els.content);
    if (els.textLayerContainer) keep.add(els.textLayerContainer);
    for (const child of Array.from(els.main.children)) {
      if (!keep.has(child)) {
        try { child.remove(); } catch { /* ignore */ }
      }
    }

    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-container';
    errorDiv.setAttribute('role', 'alert');
    errorDiv.innerHTML = `<p>Failed to load document: ${safe}</p>
      <button class="btn-secondary" data-viewer-action="back">Go Back</button>`;
    els.main.appendChild(errorDiv);

    const backBtn = errorDiv.querySelector('[data-viewer-action="back"]');
    if (backBtn) {
      _addListener(backBtn, 'click', () => {
        _emit(core, Events.NAV_BACK_REQUESTED, {});
      });
    }
  });

  subscribe(Events.DOCUMENT_DESTROYED, () => {
    resetUIState();
  });

  // ── Layout ───────────────────────────────────────────────────────────────
  subscribe(Events.LAYOUT_CHANGED, (payload) => {
    if (payload && payload.mode) _currentViewMode = payload.mode;
    updateNavButtons();
    showHeaderFooter();
  });

  // ── Page visibility ─────────────────────────────────────────────────────
  subscribe(Events.PAGE_VISIBLE, (payload) => {
    if (!payload || typeof payload.pageNum !== 'number') return;
    _currentPage = payload.pageNum;
    try {
      _currentTotalPages = core.getState().get('numPages') || _currentTotalPages;
    } catch { /* ignore */ }
    _currentEffectiveLimit = effectiveLimit();
    _applyPageNumbers(_currentPage, _currentTotalPages);
  });

  // ── Scale applied ────────────────────────────────────────────────────────
  subscribe(Events.SCALE_APPLIED, (payload) => {
    if (payload && typeof payload.scale === 'number') _currentScale = payload.scale;
    if (payload && typeof payload.source === 'string') {
      _noteZoomSource(payload.source);
    }
    if (!payload || payload.source !== 'double-tap') {
      _isMagnified = false;
    }
    updateZoomDisplay();
  });

  // ── Rotation applied ────────────────────────────────────────────────────
  subscribe(Events.ROTATION_APPLIED, () => {
    updateNavButtons();
  });

  // ── Search ───────────────────────────────────────────────────────────────
  subscribe(Events.SEARCH_STARTED, () => {
    _searchMatchCount = 0;
    _searchCurrentIndex = -1;
    updateSearchCountDisplay();
    const els = _getEls();
    if (els && els.searchCount) els.searchCount.textContent = '…';
  });

  subscribe(Events.SEARCH_PROGRESS, (payload) => {
    if (!_isSearchOpen()) return;
    const els = _getEls();
    if (!els || !els.searchCount) return;
    if (payload && typeof payload.scanned === 'number' && typeof payload.total === 'number') {
      els.searchCount.textContent = `${payload.scanned}/${payload.total}`;
    }
  });

  subscribe(Events.SEARCH_COMPLETED, (payload) => {
    if (payload && Array.isArray(payload.matches)) {
      _searchMatchCount = payload.matches.length;
      _searchCurrentIndex = typeof payload.currentIndex === 'number' ? payload.currentIndex : -1;
    } else {
      _searchMatchCount = 0;
      _searchCurrentIndex = -1;
    }
    updateSearchCountDisplay();
  });

  subscribe(Events.SEARCH_MATCH_FOCUSED, (payload) => {
    if (payload && typeof payload.index === 'number') {
      _searchCurrentIndex = payload.index;
    }
    updateSearchCountDisplay();
  });

  subscribe(Events.SEARCH_CLEARED, () => {
    _searchMatchCount = 0;
    _searchCurrentIndex = -1;
    updateSearchCountDisplay();
  });

  // ── Outline ──────────────────────────────────────────────────────────────
  subscribe(Events.OUTLINE_READY, (payload) => {
    const els = _getEls();
    if (!els || !els.outlineBtn) return;
    const count = payload && typeof payload.count === 'number' ? payload.count : 0;
    els.outlineBtn.disabled = count === 0;
  });

  // ── Interaction activity → reset auto-hide ───────────────────────────────
  subscribe(Events.INTERACTION_ACTIVITY, () => {
    resetAutoHideTimer();
  });

  // ── Single tap → toggle chrome ──────────────────────────────────────────
  subscribe(Events.SINGLE_TAP, () => {
    if (_isHeaderVisible) hideHeaderFooter();
    else showHeaderFooter();
  });

  // ── Double tap → toggle zoom ────────────────────────────────────────────
  subscribe(Events.DOUBLE_TAP, () => {
    if (_isMagnified) {
      _emit(core, Events.SCALE_REQUESTED, {
        scale: _preMagnifyScale,
        source: 'double-tap',
      });
      _isMagnified = false;
    } else {
      _preMagnifyScale = _currentScale;
      const target = Math.min(_currentScale * CONFIG.MAGNIFY_FACTOR, CONFIG.MAX_ZOOM);
      _emit(core, Events.SCALE_REQUESTED, {
        scale: target,
        source: 'double-tap',
      });
      _isMagnified = true;
    }
  });

  // ── Memory pressure → throttled toast ────────────────────────────────────
  subscribe(Events.MEMORY_PRESSURE, (payload) => {
    if (!payload || payload.level !== 'critical') return;
    const now = Date.now();
    if (now - _memoryToastAt < 30000) return;
    _memoryToastAt = now;
    try { showToast('Low memory — some pages may reload as you scroll', 'warning'); } catch { /* ignore */ }
  });

  // ── Network offline → throttled toast ───────────────────────────────────
  subscribe(Events.NETWORK_OFFLINE, () => {
    const now = Date.now();
    if (now - _offlineToastAt < 30000) return;
    _offlineToastAt = now;
    try { showToast('You are offline', 'warning'); } catch { /* ignore */ }
  });

  // ── Worker error → dev-only toast ────────────────────────────────────────
  subscribe(Events.WORKER_ERROR, () => {
    if (!CONFIG.DEBUG_WORKERS) return;
    try { showToast('Worker error (dev only)', 'warning'); } catch { /* ignore */ }
  });

  // ── State: view-mode change ──────────────────────────────────────────────
  try {
    _register(core.getState().subscribe('viewMode', (payload) => {
      _currentViewMode = payload && payload.next ? payload.next : 'scroll';
      updateNavButtons();
      const els = _getEls();
      if (els && els.toggleViewBtn) {
        els.toggleViewBtn.textContent = _currentViewMode === 'scroll' ? '📄 Page View' : '📜 Scroll View';
      }
    }));
  } catch { /* ignore */ }

  // ── State: current-page mirror ───────────────────────────────────────────
  try {
    _register(core.getState().subscribe('currentPage', (payload) => {
      if (payload && typeof payload.next === 'number') {
        _currentPage = payload.next;
        updateNavButtons();
      }
    }));
  } catch { /* ignore */ }

  // ── State: scale mirror ──────────────────────────────────────────────────
  try {
    _register(core.getState().subscribe('scale', (payload) => {
      if (payload && typeof payload.next === 'number') {
        _currentScale = payload.next;
        updateZoomDisplay();
      }
    }));
  } catch { /* ignore */ }

  _eventsBound = true;
}

// ============================================================================
// 12. EMBEDDED MOUNT / UNMOUNT
// ============================================================================

/**
 * Present the viewer as a fixed-position overlay, hiding the app's main
 * container. Idempotent.
 *
 * @param {import('./core.js').ViewerCore} _core
 * @returns {void}
 */
export function mountChrome(_core) {
  if (typeof document === 'undefined') return;
  const els = _getEls();
  if (els && els.container) {
    const c = els.container;
    c.style.display = 'block';
    c.style.position = 'fixed';
    c.style.top = '0';
    c.style.left = '0';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.zIndex = '2000';
    c.style.background = 'var(--bg-primary)';
  }
  const app = document.getElementById('app');
  if (app) app.style.display = 'none';
}

/**
 * Hide the viewer container and restore the app. Does not clear viewer
 * content — that is `ViewerCore.destroy`'s job. Idempotent.
 *
 * @param {import('./core.js').ViewerCore} _core
 * @returns {void}
 */
export function unmountChrome(_core) {
  if (typeof document === 'undefined') return;
  const els = _getEls();
  if (els && els.container) {
    els.container.style.display = 'none';
  }
  const app = document.getElementById('app');
  if (app) app.style.display = 'block';
}

// ============================================================================
// 13. STATE RESET & TEARDOWN
// ============================================================================

/**
 * Reset UI state without removing listeners. Called on DOCUMENT_DESTROYED.
 * The listeners persist so that the next document load works.
 *
 * @returns {void}
 */
export function resetUIState() {
  const els = _getEls();
  if (els) {
    if (els.loading) els.loading.style.display = 'none';
    if (els.progress) {
      els.progress.value = 0;
      els.progress.style.display = 'none';
    }
    if (els.searchInput) els.searchInput.value = '';
    if (els.searchBar) els.searchBar.classList.remove('active');
    if (els.outlineDrawer) {
      els.outlineDrawer.classList.remove('open');
      els.outlineDrawer.setAttribute('aria-hidden', 'true');
    }
    if (els.footer) els.footer.style.display = 'none';
  }

  try {
    const scrim = document.getElementById('viewer-drawer-scrim');
    if (scrim) scrim.classList.remove('open');
  } catch { /* ignore */ }

  _setToggleExpanded('viewer-outline-btn', false);
  _setToggleExpanded('viewer-search-btn', false);
  _setToggleExpanded('viewer-more-btn', false);

  if (_pendingTapTimer) {
    clearTimeout(_pendingTapTimer);
    _pendingTapTimer = null;
  }
  _pendingTapX = 0;
  _pendingTapY = 0;

  _isMagnified = false;
  _preMagnifyScale = 1;

  _currentEffectiveLimit = 1;

  _currentPage = 1;
  _currentTotalPages = 1;
  _currentScale = 1;
  _currentViewMode = 'scroll';
  _searchMatchCount = 0;
  _searchCurrentIndex = -1;
  _userZoomOverride = false;
  _resetAutoHide();
  updateSearchCountDisplay();
  updateZoomDisplay();
  _applyPageNumbers(1, 1);
  showHeaderFooter();
}

/**
 * Remove every listener and subscription registered by ui-internal.
 * Idempotent. Called on full viewer shutdown (not on document switch).
 *
 * @returns {void}
 */
export function teardownControls() {
  for (const fn of _listeners.splice(0)) {
    try { fn(); } catch { /* ignore */ }
  }
  _controlsBound = false;
  _autoHideBound = false;
  _dprBound = false;
  _eventsBound = false;
  _fitWidthBound = false;

  try { if (_fitObserver) _fitObserver.disconnect(); } catch { /* ignore */ }
  _fitObserver = null;
  _fitObserverWidth = 0;

  if (_pendingTapTimer) {
    clearTimeout(_pendingTapTimer);
    _pendingTapTimer = null;
  }
  _pendingTapX = 0;
  _pendingTapY = 0;

  if (_autoHideTimer) {
    clearTimeout(_autoHideTimer);
    _autoHideTimer = null;
  }

  _isMagnified = false;
  _preMagnifyScale = 1;
  _currentEffectiveLimit = 1;
  _currentPage = 1;
  _currentTotalPages = 1;
  _currentScale = 1;
  _currentViewMode = 'scroll';
  _searchMatchCount = 0;
  _searchCurrentIndex = -1;
  _userZoomOverride = false;
  _els = null;
}

// ============================================================================
// 14. DOCUMENT CLEARING
// ============================================================================

/**
 * Remove every DOM node the viewer created during a document load, while
 * preserving the four static chrome nodes declared in viewer.html.
 *
 * WHAT SURVIVES:
 *   • #viewer-loading       — the loading spinner
 *   • #viewer-progress      — the progress bar
 *   • #viewer-content       — reserved container
 *   • #viewer-text-layer    — reserved container
 *
 * WHAT IS REMOVED:
 *   • The .page-container and every <canvas class="page"> and
 *     <div class="cover"> inside it
 *   • Every .search-layer, .error-container, .viewer-preview-cta
 *   • Any <pre> from a text-document load
 *   • Every other direct child of #viewer-main not on the survive list
 *
 * ALSO:
 *   • Empties #viewer-outline-drawer and removes its .open class.
 *   • Closes the scrim.
 *   • Clears #viewer-title textContent.
 *   • Exits fullscreen if the viewer was the fullscreen element.
 *
 * Idempotent. Safe to call before init, after destroy, or on a document
 * that was never loaded.
 *
 * @returns {void}
 */
export function clearViewerContent() {
  if (typeof document === 'undefined') return;

  try {
    const els = _getEls();
    if (!els) return;

    if (els.main) {
      const main = els.main;

      const keep = new Set();
      if (els.loading) keep.add(els.loading);
      if (els.progress) keep.add(els.progress);
      if (els.content) keep.add(els.content);
      if (els.textLayerContainer) keep.add(els.textLayerContainer);

      const toRemove = [];
      for (const child of Array.from(main.children)) {
        if (!keep.has(child)) toRemove.push(child);
      }
      for (const node of toRemove) {
        try { node.remove(); } catch { /* ignore */ }
      }

      if (els.loading) els.loading.style.display = 'none';
      if (els.progress) {
        els.progress.value = 0;
        els.progress.style.display = 'none';
      }

      // The .x-scroll class may be present from a previous document.
      main.classList.remove('x-scroll');
    }

    if (els.outlineDrawer) {
      els.outlineDrawer.innerHTML = '';
      els.outlineDrawer.classList.remove('open');
      els.outlineDrawer.setAttribute('aria-hidden', 'true');
    }

    const scrim = document.getElementById('viewer-drawer-scrim');
    if (scrim) scrim.classList.remove('open');

    _setToggleExpanded('viewer-outline-btn', false);
    _setToggleExpanded('viewer-search-btn', false);
    _setToggleExpanded('viewer-more-btn', false);

    if (els.title) {
      els.title.textContent = '';
    }

    if (els.footer) {
      els.footer.style.display = 'none';
    }

    try {
      if (isFullscreen()) exitFullscreen().catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}