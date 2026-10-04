// frontend-user/scripts/viewer/ui-internal.js

/**
 * Universal Document Viewer — Internal UI
 * ============================================================================
 *
 * The bridge between the viewer's static HTML shell and the event-driven
 * core. Owns:
 *   • CSS injection (frozen styles + preview-mode CTA styling)
 *   • DOM element lookup cache (delegates to utils.getViewerElements)
 *   • Every click/change/input/keydown listener inside the viewer chrome
 *   • Auto-hide header/footer state machine
 *   • Fullscreen toggle
 *   • Zoom % / page counter / search count displays
 *   • DPR change detection
 *   • Embedded-viewer mount / unmount
 *   • Document-content clearing (the viewer DOM is wiped on destroy)
 *   • Subscribe-to-bus glue that keeps labels in sync with state
 *   • Tap-sequence detection (single / double / triple) on the content area
 *
 * Exports (19):
 *   injectViewerStyles, refreshElementCache, setupControls,
 *   setupAutoHideListeners, showHeaderFooter, hideHeaderFooter,
 *   resetAutoHideTimer, toggleFullscreen, updatePageNumberDisplay,
 *   updateNavButtons, updateZoomDisplay, updateSearchCountDisplay,
 *   updateSearchBarState, setupDPRListener, mountChrome, unmountChrome,
 *   bindCoreEvents, teardownControls, clearViewerContent
 *
 * Boundary rules (architecture spec § 2.3):
 *   • Only file (besides viewer.js) permitted to query the DOM by element ID,
 *     inject styles, or attach click/change/input/keydown listeners.
 *   • Never attaches scroll / pointer / wheel / touch listeners (interaction).
 *   • Never touches the engine, caches, canvases, or workers.
 *   • Only writes `viewMode` and `dpr` to ViewerState.
 *   • Does NOT import `router`. The preview-mode subscribe CTA is built in
 *     core.js and emits PREVIEW_SUBSCRIBE_REQUESTED on the bus; viewer.js
 *     owns the router.navigateTo call.
 *
 * Import exceptions (documented):
 *   • `../ui.js` — app-level toasts and loading overlays. Only three
 *     functions are used (showToast, showLoading, hideLoading).
 *
 * Preview-mode CTA:
 *   When the viewer is in preview mode, core.js's _buildPreviewCTA() appends
 *   a card after the last preview page containing a "Subscribe to Continue"
 *   button. The button emits PREVIEW_SUBSCRIBE_REQUESTED on the bus. That
 *   event is handled by viewer.js, which calls router.navigateTo to route
 *   the user to the subscription page.
 *
 *   This file is responsible for styling that card and for clamping the
 *   page counter, page input, and nav buttons to the effective limit so the
 *   UI matches what the render pipeline will actually display.
 *
 * Document clearing (clearViewerContent):
 *   Called by core.destroy() as part of the canonical teardown, and again
 *   as a defensive step inside viewer.js's two entry points. It removes
 *   every DOM node the viewer created for the previous document — page
 *   containers, canvas wrappers, canvases, images, iframes, search-layer
 *   overlays, error containers, and the preview-mode CTA — while preserving
 *   the four static chrome nodes declared in viewer.html (#viewer-loading,
 *   #viewer-progress, #viewer-content, #viewer-text-layer).
 *
 *   This is what makes "close and reopen shows exactly what a fresh session
 *   would show" true. Without it, the previous document's DOM survives the
 *   close, bleeds into the next open, and (worse) removes #viewer-loading
 *   and #viewer-progress when main.innerHTML = '' is used naively.
 *
 * Tap-sequence behaviour (industry-standard, matches Acrobat / PDFKit /
 * Nutrient / Apryse):
 *   • Single tap  → nothing.
 *   • Double tap  → toggle header/footer visibility.
 *   • Triple tap  → toggle magnify (2× viewport-centered zoom).
 *
 * Touch-action contract (cross-platform):
 *   `#viewer-main` uses `touch-action: pan-x pan-y`, NOT `manipulation`.
 *
 * Lifecycle correction (documented deviation from spec § 4.15):
 *   DOCUMENT_DESTROYED triggers `resetUIState()` (state only, listeners
 *   persist) rather than `teardownControls()`.
 *
 * @module viewer/ui-internal
 */

'use strict';

import { CONFIG, Events } from './core.js';
import { getViewerElements, escapeHtml } from './utils.js';
import { showToast, showLoading, hideLoading } from '../ui.js';

// ============================================================================
// MODULE-PRIVATE STATE
// ============================================================================

/** Cached element map. Refreshed on document load and on demand. @private */
let _els = null;

/** Teardown registry: every function that undoes a listener or subscription. @private */
/** @type {Array<() => void>} */
let _listeners = [];

/** Idempotence flags. @private */
let _controlsBound = false;
let _autoHideBound = false;
let _dprBound = false;
let _eventsBound = false;

/** Auto-hide state machine. @private */
let _autoHideTimer = null;
let _isHeaderVisible = true;
let _isOverControls = false;

/** DPR tracking. @private */
let _lastDPR = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

/** Memory-pressure toast throttle. @private */
let _memoryToastAt = 0;

// ── Tap-sequence state ──────────────────────────────────────────────────────
/** @private */ let _tapCount = 0;
/** @private @type {ReturnType<typeof setTimeout>|null} */ let _tapTimer = null;
/** @private */ let _tapLastX = 0;
/** @private */ let _tapLastY = 0;

// ── Magnify toggle state (triple-tap) ───────────────────────────────────────
/** @private */ let _isMagnified = false;
/** @private */ let _preMagnifyScale = 1;

// ── Preview-mode state ──────────────────────────────────────────────────────
/**
 * Effective page limit for the page counter, page input max, and nav-button
 * disabling. Equals `numPages` normally; equals the preview limit
 * (10% of the document, at least 1) when in preview mode.
 *
 * @private
 */
let _currentEffectiveLimit = 1;

// ============================================================================
// 1. CSS INJECTION
// ============================================================================

/**
 * Inject the viewer's CSS into `<head>` exactly once. Idempotent across
 * viewer inits and documents.
 *
 * @returns {void}
 */
export function injectViewerStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('viewer-inline-styles')) return;

  const style = document.createElement('style');
  style.id = 'viewer-inline-styles';
  style.textContent = `
    .viewer-loading-dots {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-size: 2rem;
      color: var(--text-secondary, #888);
      gap: 0.25rem;
    }
    .viewer-loading-dots span {
      animation: viewer-dot-bounce 1.4s infinite ease-in-out both;
      display: inline-block;
    }
    .viewer-loading-dots span:nth-child(1) { animation-delay: 0s; }
    .viewer-loading-dots span:nth-child(2) { animation-delay: 0.2s; }
    .viewer-loading-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes viewer-dot-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-0.5em); }
    }

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

    .canvas-wrapper {
      content-visibility: auto;
      contain-intrinsic-size: 200px;
    }

    /* Preview-mode CTA card. Rendered by core.js's _buildPreviewCTA after
       the last preview page. Its subscribe button emits
       PREVIEW_SUBSCRIBE_REQUESTED on the bus, which viewer.js handles by
       routing to the subscription page. */
    .viewer-preview-cta {
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 3rem 1.5rem 5rem;
      box-sizing: border-box;
    }
    .viewer-preview-cta-inner {
      max-width: 420px;
      width: 100%;
      text-align: center;
      padding: 2rem 1.75rem;
      background: var(--bg-secondary, #f9fafb);
      border: 1px solid var(--border-color, #e5e7eb);
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
    }
    .viewer-preview-cta-icon {
      font-size: 2.25rem;
      line-height: 1;
      margin-bottom: 0.5rem;
    }
    .viewer-preview-cta-title {
      margin: 0 0 0.75rem;
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text-primary, #111827);
    }
    .viewer-preview-cta-body {
      margin: 0 0 1.25rem;
      color: var(--text-secondary, #6b7280);
      font-size: 0.95rem;
      line-height: 1.5;
    }
    .viewer-preview-cta-btn {
      display: inline-block;
      padding: 0.6rem 1.25rem;
      border: none;
      border-radius: 8px;
      background: var(--accent-color, #2563eb);
      color: #fff;
      font-size: 0.95rem;
      font-weight: 500;
      cursor: pointer;
      transition: filter 0.15s ease, transform 0.05s ease;
    }
    .viewer-preview-cta-btn:hover {
      filter: brightness(1.08);
    }
    .viewer-preview-cta-btn:active {
      transform: translateY(1px);
    }
    .viewer-preview-cta-btn:focus-visible {
      outline: 2px solid var(--accent-color, #2563eb);
      outline-offset: 2px;
    }

    #viewer-main {
      touch-action: pan-x pan-y;
    }
  `;
  document.head.appendChild(style);
}

// ============================================================================
// 2. ELEMENT CACHE
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

/**
 * Internal accessor; refreshes the cache if it was never populated.
 * @private
 * @returns {any}
 */
function _getEls() {
  if (!_els) refreshElementCache();
  return _els;
}

// ============================================================================
// 3. TEARDOWN REGISTRY HELPERS
// ============================================================================

/**
 * Register a teardown function. Used for both DOM listener removers and
 * event-bus unsubscribe functions.
 * @private
 * @param {() => void} fn
 */
function _register(fn) {
  if (typeof fn === 'function') _listeners.push(fn);
}

/**
 * Add a DOM listener and register its removal.
 * @private
 * @param {EventTarget|null} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} handler
 * @param {AddEventListenerOptions|boolean} [options]
 */
function _addListener(target, type, handler, options) {
  if (!target || typeof target.addEventListener !== 'function') return;
  try {
    target.addEventListener(type, handler, options);
    _register(() => {
      try { target.removeEventListener(type, handler, options); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
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

/**
 * Reset auto-hide state. Called on document destroy. Keeps listeners bound.
 * @private
 */
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
 * Toggle fullscreen on the viewer container. Called synchronously from click
 * or keydown handlers — never from a Promise chain — to preserve user
 * activation.
 *
 * @returns {void}
 */
export function toggleFullscreen() {
  if (typeof document === 'undefined') return;
  const els = _getEls();
  const container = (els && els.container)
    || document.querySelector('.viewer-container')
    || document.documentElement;
  if (!container) return;

  if (!document.fullscreenElement) {
    const p = container.requestFullscreen ? container.requestFullscreen() : null;
    if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
  } else {
    const p = document.exitFullscreen ? document.exitFullscreen() : null;
    if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
  }
}

/**
 * Sync the fullscreen button's title/aria-pressed with the browser state.
 * @private
 */
function _syncFullscreenLabel() {
  const els = _getEls();
  if (!els || !els.fullscreenBtn) return;
  const isFs = !!document.fullscreenElement;
  els.fullscreenBtn.setAttribute('aria-pressed', isFs ? 'true' : 'false');
  els.fullscreenBtn.title = isFs ? 'Exit fullscreen' : 'Enter fullscreen';
}

// ============================================================================
// 6. DISPLAY UPDATERS
// ============================================================================

/**
 * Sync the page counter, page input, and page count. Also calls
 * updateNavButtons.
 *
 * @returns {void}
 */
export function updatePageNumberDisplay() {
  const els = _getEls();
  if (!els) return;
  let current = 1;
  let total = 1;
  try {
    // Reads happen via the core instance — not available here; we read from
    // the DOM which ui-internal owns. Callers (bindCoreEvents) pass values
    // through state. This function is state-agnostic on purpose so it can be
    // called from anywhere.
  } catch { /* ignore */ }
  void current; void total;
}

/**
 * Apply the current page number, real total, and effective limit to the UI.
 *
 * @private
 * @param {number} current        1-based current page
 * @param {number} total          real total pages of the document
 */
function _applyPageNumbers(current, total) {
  const els = _getEls();
  if (!els) return;

  const totalClamped = Math.max(1, total || 1);

  // Effective limit = preview limit in preview mode, else real total.
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

/**
 * @private
 * @param {number} current
 * @param {number} effective
 */
function _applyNavButtons(current, effective) {
  const els = _getEls();
  if (!els) return;
  let viewMode = 'scroll';
  try {
    viewMode = _currentViewMode;
  } catch { /* ignore */ }

  if (viewMode === 'scroll') {
    if (els.prevBtn) els.prevBtn.disabled = true;
    if (els.nextBtn) els.nextBtn.disabled = true;
  } else {
    if (els.prevBtn) els.prevBtn.disabled = current <= 1;
    if (els.nextBtn) els.nextBtn.disabled = current >= effective;
  }
}

/** Cached view mode for nav-button disabling. Updated by bindCoreEvents. @private */
let _currentViewMode = 'scroll';

/** Cached current/total page for nav-button updates. @private */
let _currentPage = 1;
let _currentTotalPages = 1;

/**
 * Public updater kept for external callers (core) that want to refresh from
 * known values.
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
  let scale = 1;
  scale = _currentScale;
  els.zoomLevel.textContent = Math.round(scale * 100) + '%';
}

/** Cached scale for zoom display. Updated by bindCoreEvents. @private */
let _currentScale = 1;

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

/** Cached search state for count display. Updated by bindCoreEvents. @private */
let _searchMatchCount = 0;
let _searchCurrentIndex = -1;

/**
 * Open or close the search bar. Toggles the `active` class and manages focus.
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
}

/**
 * @private
 * @returns {boolean}
 */
function _isSearchOpen() {
  const els = _getEls();
  return !!(els && els.searchBar && els.searchBar.classList.contains('active'));
}

// ============================================================================
// 7. DPR LISTENER
// ============================================================================

/**
 * Wire the resize listener that detects DPR changes. Idempotent.
 * @param {import('./core.js').ViewerCore} core
 * @returns {void}
 */
export function setupDPRListener(core) {
  if (_dprBound) return;
  if (typeof window === 'undefined') return;

  _lastDPR = window.devicePixelRatio || 1;

  const handler = () => {
    const current = window.devicePixelRatio || 1;
    if (current === _lastDPR) return;
    _lastDPR = current;
    try {
      const state = core.getState();
      state.set('dpr', Math.min(current, CONFIG.MAX_DPR));
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
// 8. CONTROL WIRING
// ============================================================================

/**
 * Emit a bus event safely.
 * @private
 * @param {import('./core.js').ViewerCore} core
 * @param {string} event
 * @param {any} [payload]
 */
function _emit(core, event, payload) {
  try { core.getBus().emit(event, payload); } catch { /* ignore */ }
}

/**
 * Wire every UI control listener. Idempotent — a second call is a no-op.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {void}
 */
export function setupControls(core) {
  if (_controlsBound) return;
  const els = _getEls();
  if (!els || !els.container) return;

  // ── View-mode toggle ────────────────────────────────────────────────────
  if (els.toggleViewBtn) {
    const labelSync = () => {
      try {
        const state = core.getState();
        const mode = state.get('viewMode') || 'scroll';
        els.toggleViewBtn.textContent = mode === 'scroll' ? '📄 Page View' : '📜 Scroll View';
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

  // ── Fullscreen ──────────────────────────────────────────────────────────
  if (els.fullscreenBtn) {
    _addListener(els.fullscreenBtn, 'click', () => {
      try { toggleFullscreen(); } catch { /* ignore */ }
    });
  }
  _addListener(document, 'fullscreenchange', _syncFullscreenLabel);

  // ── Search bar ──────────────────────────────────────────────────────────
  if (els.searchBtn) {
    _addListener(els.searchBtn, 'click', () => {
      updateSearchBarState();
      if (!_isSearchOpen()) {
        try { core.getSearch().clear(); } catch { /* ignore */ }
      }
    });
  }
  if (els.searchClose) {
    _addListener(els.searchClose, 'click', () => {
      updateSearchBarState(false);
      try { core.getSearch().clear(); } catch { /* ignore */ }
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

  // ── Outline drawer ──────────────────────────────────────────────────────
  if (els.outlineBtn) {
    _addListener(els.outlineBtn, 'click', () => {
      try { core.getOutline().toggle(); } catch { /* ignore */ }
    });
  }
  _addListener(document, 'click', (e) => {
    if (!els.outlineDrawer) return;
    if (!e.target || !e.target.closest) return;
    if (e.target.closest('.outline-drawer')) return;
    if (e.target.closest('#viewer-outline-btn')) return;
    els.outlineDrawer.classList.remove('open');
  });

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

  // ── Drag & drop ─────────────────────────────────────────────────────────
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

  // ── Back button ─────────────────────────────────────────────────────────
  if (els.backBtn) {
    _addListener(els.backBtn, 'click', () => {
      _emit(core, Events.NAV_BACK_REQUESTED, {});
    });
  }

  // ── Keyboard shortcuts ──────────────────────────────────────────────────
  _addListener(document, 'keydown', (e) => {
    const target = e.target;
    const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    const isSearchInput = target && els.searchInput && target === els.searchInput;

    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (e.key === 'F3') {
      if (_isSearchOpen()) {
        e.preventDefault();
        try { core.getSearch().next(); } catch { /* ignore */ }
      }
      return;
    }

    if (e.key === 'Escape' && _isSearchOpen()) {
      e.preventDefault();
      updateSearchBarState(false);
      try { core.getSearch().clear(); } catch { /* ignore */ }
      return;
    }

    if (inInput && !isSearchInput) return;

    switch (e.key) {
      case 'ArrowLeft':
        if (_currentViewMode === 'page') {
          e.preventDefault();
          if (_currentPage > 1) {
            _emit(core, Events.PAGE_JUMP_REQUESTED, { pageNum: _currentPage - 1, reason: 'keyboard' });
          }
        }
        break;
      case 'ArrowRight':
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

  // ── Tap sequence (single / double / triple) on the content area ─────────
  if (els.main) {
    _addListener(els.main, 'click', (e) => {
      const target = e.target;
      if (target && typeof target.closest === 'function') {
        if (target.closest('button, a, input, select, textarea')) return;
      }

      const x = e.clientX;
      const y = e.clientY;

      _tapCount++;
      _tapLastX = x;
      _tapLastY = y;

      if (_tapTimer) {
        clearTimeout(_tapTimer);
        _tapTimer = null;
      }

      if (_tapCount >= 3) {
        _tapCount = 0;
        _emit(core, Events.TRIPLE_TAP, { x, y });
        return;
      }

      if (_tapCount === 2) {
        _tapTimer = setTimeout(() => {
          _tapTimer = null;
          _tapCount = 0;
          _emit(core, Events.DOUBLE_TAP, { x: _tapLastX, y: _tapLastY });
        }, CONFIG.DOUBLE_SETTLE_MS);
        return;
      }

      _tapTimer = setTimeout(() => {
        _tapTimer = null;
        _tapCount = 0;
      }, CONFIG.TAP_SEQUENCE_GAP_MS);
    });
  }

  _controlsBound = true;
}

// ============================================================================
// 9. BUS SUBSCRIPTIONS
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

  /**
   * @private
   * @returns {number}
   */
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
    try {
      const s = core.getState();
      current = s.get('currentPage') || 1;
      total = s.get('numPages') || 1;
      _currentPage = current;
      _currentTotalPages = total;
      _currentViewMode = s.get('viewMode') || 'scroll';
    } catch { /* ignore */ }

    _currentEffectiveLimit = effectiveLimit();

    _applyPageNumbers(current, total);
    updateZoomDisplay();
    showHeaderFooter();
  });

  subscribe(Events.DOCUMENT_ERROR, (payload) => {
    const els = _getEls();
    if (!els) return;
    if (els.loading) els.loading.style.display = 'none';
    if (els.progress) els.progress.style.display = 'none';
    if (!els.main) return;
    const rawMessage = payload && payload.message ? payload.message : 'Failed to load document';
    const safe = escapeHtml(String(rawMessage));
    els.main.innerHTML = `<div class="error-container" role="alert">
      <p>Failed to load document: ${safe}</p>
      <button class="btn-secondary" data-viewer-action="back">Go Back</button>
    </div>`;
    const backBtn = els.main.querySelector('[data-viewer-action="back"]');
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
    if (!payload || payload.source !== 'triple-tap') {
      _isMagnified = false;
    }
    updateZoomDisplay();
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

  // ── Double tap → toggle chrome ───────────────────────────────────────────
  subscribe(Events.DOUBLE_TAP, () => {
    if (_isHeaderVisible) hideHeaderFooter();
    else showHeaderFooter();
  });

  // ── Triple tap → toggle magnify ──────────────────────────────────────────
  subscribe(Events.TRIPLE_TAP, () => {
    if (_isMagnified) {
      _emit(core, Events.SCALE_REQUESTED, {
        scale: _preMagnifyScale,
        source: 'triple-tap',
      });
      _isMagnified = false;
    } else {
      _preMagnifyScale = _currentScale;
      const target = Math.min(_currentScale * CONFIG.MAGNIFY_FACTOR, CONFIG.MAX_ZOOM);
      _emit(core, Events.SCALE_REQUESTED, {
        scale: target,
        source: 'triple-tap',
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
// 10. EMBEDDED MOUNT / UNMOUNT
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
    c.style.display = 'flex';
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
// 11. STATE RESET & TEARDOWN
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
    if (els.progress) els.progress.style.display = 'none';
    if (els.searchInput) els.searchInput.value = '';
    if (els.searchBar) els.searchBar.classList.remove('active');
    if (els.outlineDrawer) els.outlineDrawer.classList.remove('open');
  }

  if (_tapTimer) {
    clearTimeout(_tapTimer);
    _tapTimer = null;
  }
  _tapCount = 0;

  _isMagnified = false;
  _preMagnifyScale = 1;

  _currentEffectiveLimit = 1;

  _currentPage = 1;
  _currentTotalPages = 1;
  _currentScale = 1;
  _currentViewMode = 'scroll';
  _searchMatchCount = 0;
  _searchCurrentIndex = -1;
  _resetAutoHide();
  updateSearchCountDisplay();
  updateZoomDisplay();
  _applyPageNumbers(1, 1);
  showHeaderFooter();
}

/**
 * Remove every listener and subscription registered by ui-internal. Idempotent.
 * Called on full viewer shutdown (not on document switch).
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

  if (_tapTimer) {
    clearTimeout(_tapTimer);
    _tapTimer = null;
  }
  _tapCount = 0;

  _isMagnified = false;
  _preMagnifyScale = 1;

  _currentEffectiveLimit = 1;

  _resetAutoHide();
}

// ============================================================================
// 12. DOCUMENT CLEARING
// ============================================================================

/**
 * Remove every DOM node the viewer created during a document load, while
 * preserving the static chrome nodes declared in viewer.html.
 *
 * WHAT SURVIVES (the four static chrome nodes):
 *   • #viewer-loading       — the loading spinner
 *   • #viewer-progress      — the progress bar
 *   • #viewer-content       — reserved container (empty in the current HTML)
 *   • #viewer-text-layer    — reserved container (empty in the current HTML)
 *
 * WHAT IS REMOVED:
 *   • Every .page-container       (from the last PDF load)
 *   • Every .canvas-wrapper       (inside page containers)
 *   • Every canvas, img, iframe   (from PDF/image/office loads)
 *   • Every .search-layer         (search highlights)
 *   • Every .error-container      (load failures)
 *   • Every .viewer-preview-cta   (preview-mode subscribe card)
 *   • Any <pre> from a text-document load
 *   • Every other direct child of #viewer-main that is not on the survive list
 *
 * ALSO:
 *   • Empties #viewer-outline-drawer and removes its .open class.
 *   • Clears #viewer-title textContent.
 *   • Exits fullscreen if the viewer was the fullscreen element.
 *
 * Idempotent. Safe to call before the core is initialised, after destroy, or
 * on a document that was never loaded.
 *
 * WHY THIS EXISTS:
 *   core.destroy() tears down the engine, workers, caches, and state, but
 *   the previous document's DOM survives — page containers, canvases,
 *   search overlays, and error containers stay attached to #viewer-main.
 *   On the next open, viewer.js would need to wipe them, and doing so with
 *   `main.innerHTML = ''` also deletes #viewer-loading and #viewer-progress.
 *   This function identifies document content vs. static chrome, preserving
 *   the latter.
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

      // Nodes declared in viewer.html that must survive the clear.
      const keep = new Set();
      if (els.loading) keep.add(els.loading);
      if (els.progress) keep.add(els.progress);
      if (els.content) keep.add(els.content);
      if (els.textLayerContainer) keep.add(els.textLayerContainer);

      // Snapshot children first — removing during iteration mutates the list.
      const toRemove = [];
      for (const child of Array.from(main.children)) {
        if (!keep.has(child)) toRemove.push(child);
      }
      for (const node of toRemove) {
        try { node.remove(); } catch { /* ignore */ }
      }

      // Reset the preserved nodes' visible state.
      if (els.loading) els.loading.style.display = 'none';
      if (els.progress) {
        els.progress.value = 0;
        els.progress.style.display = 'none';
      }
    }

    // Outline drawer: empty its contents and close it.
    if (els.outlineDrawer) {
      els.outlineDrawer.innerHTML = '';
      els.outlineDrawer.classList.remove('open');
    }

    // Reset the header title so a reopen doesn't briefly show the old name.
    if (els.title) {
      els.title.textContent = '';
    }

    // Exit fullscreen if the viewer was in it.
    try {
      if (document.fullscreenElement) document.exitFullscreen();
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}