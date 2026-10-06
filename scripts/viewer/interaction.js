// frontend-user/scripts/viewer/interaction.js

/**
 * Universal Document Viewer — Interaction Layer
 * ============================================================================
 *
 * Sensory and motor layer of the viewer. Owns every user-input listener that
 * produces motion (scroll, pointer, wheel, touch, gesture recognition) and
 * every motion-timing decision (velocity sampling, pause/resume thresholds,
 * gesture settle debounce, rAF-batched DOM writes).
 *
 * Exports (5):
 *   • ScrollManager   — velocity, visibility, prefetch, navigation
 *   • ZoomManager     — two-phase zoom (CSS transform → async re-raster)
 *   • PanManager      — rAF-batched pan writes
 *   • GestureManager  — pinch / swipe / modifier-wheel routing
 *   • createInteractionLayer(core) — factory
 *
 * Boundary rule (architecture spec § 2.3):
 *   • This is the ONLY file permitted to attach scroll / pointer / wheel /
 *     touch listeners. Motion keydown is handled by ui-internal (which emits
 *     events); this file reacts to those events.
 *   • Never touches the engine. Accesses subsystems exclusively via
 *     core.getScheduler(), core.getTileManager(), core.getRenderer(),
 *     core.getScroll(), core.getZoom(), core.getPan().
 *   • Never inserts canvases into the DOM (that is core's RENDER_COMPLETE
 *     subscriber). Never mutates caches (that is managers' concern).
 *
 * Preview-mode enforcement:
 *   When the viewer is in preview mode (unsubscribed user opening a premium
 *   catalogue resource), every navigation path is clamped at
 *   core.getEffectivePageLimit(). This single file is the enforcement point
 *   because every navigation — page input, arrow keys, outline clicks, search
 *   matches, swipes, prefetch — converges on either `navigateTo` or
 *   `_requestRender`. Guarding both covers all callers.
 *
 * Lazy-render window:
 *   Two independent windows keep pages warm ahead of the user:
 *
 *     1. Scroll-direction prefetch — while the user scrolls, `_prefetchAdjacent`
 *        enqueues pages in the active direction. Depth is velocity-aware:
 *        PREFETCH_DEPTH_SLOW (5) at low velocity, PREFETCH_DEPTH_FAST (2) at
 *        high velocity. A symmetric secondary window at lower priority
 *        (PRIORITY.MARGIN) keeps the opposite direction from going cold when
 *        the user reverses.
 *
 *     2. Zoom re-raster window — after a scale change settles,
 *        `ZoomManager._enqueueVisibleRenders` enqueues visible pages at
 *        PRIORITY.VISIBLE and then walks 5 pages above and below at
 *        PRIORITY.ADJACENT. This is what makes magnification feel instant:
 *        the neighbouring pages are already rendered at the new scale before
 *        the user scrolls to them.
 *
 *   Both windows respect the preview-page limit — locked pages are never
 *   enqueued.
 *
 * Tap sequencing note:
 *   Single-tap and double-tap detection live in ui-internal.js as a
 *   click-based sequence handler on #viewer-main. Click events fire
 *   identically on desktop and mobile — the browser synthesises a click after
 *   each qualifying tap — which lets one handler serve both platforms without
 *   the double-fire that a touch-based detector produced alongside it.
 *
 *   Android convention (implemented in ui-internal):
 *     • Single tap → toggle chrome.
 *     • Double tap → toggle zoom (fit-width ↔ 2×), viewport-centered.
 *
 *   Triple tap is deliberately NOT recognised — Android reserves long-press
 *   for text selection, and a triple-tap detector makes that unreliable.
 *
 *   This file retains pinch and swipe recognition, which are fundamentally
 *   touch-only gestures and cannot be expressed via click events.
 *
 * Wheel-zoom gating:
 *   Ctrl/Meta + wheel to zoom is a desktop convention. On native Android
 *   there is rarely a wheel, and even when a Bluetooth mouse is attached the
 *   gesture is not expected. The wheel listener is therefore attached ONLY
 *   when `isWeb()` is true. In `npm run dev` (browser) the full wheel-zoom
 *   path is live. In `npx cap run android` the listener is never attached.
 *
 * Pinch gating note:
 *   The USE_TWO_PHASE_ZOOM flag controls the visual commit STRATEGY, not
 *   whether pinch works at all. Pinch is always recognised; the flag only
 *   changes whether we apply a GPU CSS transform during the gesture (two-
 *   phase) or commit the scale with a short debounce (legacy). Gating the
 *   gesture itself behind the flag was a bug.
 *
 * Rotation integration:
 *   Render jobs carry a `rotation` field mirrored from `state.rotation`.
 *   Every job id includes rotation so a rotation change produces a new job
 *   rather than being deduplicated against the previous rotation. This
 *   matches the id format core.js uses in `_enqueuePageRender`, so the
 *   scheduler treats both enqueue sources as producing the same job for the
 *   same (page, scale, rotation) triple.
 *
 * Performance posture (with core.js's default flags all true):
 *   • Scroll listener is rAF-throttled — the handler runs at most once per
 *     frame regardless of how frequently the underlying scroll event fires.
 *     Some browsers (notably iOS WebKit) can emit scroll events faster than
 *     frame rate; explicit rAF throttling prevents the handler from
 *     re-computing velocity and visibility multiple times per frame.
 *   • Velocity sampling uses an exponential moving average, so per-frame
 *     jitter is smoothed without needing a longer sample window.
 *   • Pause/resume thresholds use hysteresis (SUSPEND / 2 to resume) to
 *     prevent oscillation at the boundary.
 *   • Two-phase zoom keeps the main thread free during a gesture by writing
 *     only a CSS transform per frame — no canvas work until settle.
 *   • Pan writes are coalesced to one per animation frame via rafThrottle.
 *
 * Import discipline:
 *   • { CONFIG, Events, PRIORITY } from './core.js'
 *   • { clamp, debounce, rafThrottle, rectOverlapArea,
 *       getViewerElements } from './utils.js'
 *   • { isWeb } from './platform.js'
 *
 * @module viewer/interaction
 */

'use strict';

import { CONFIG, Events, PRIORITY } from './core.js';
import {
  clamp,
  debounce,
  rafThrottle,
  rectOverlapArea,
  getViewerElements,
} from './utils.js';
import { isWeb } from './platform.js';

// ============================================================================
// MODULE-PRIVATE CONSTANTS
// ============================================================================

/** Pan dead-zone: movement beyond this distance starts a pan. @private */
const PAN_DEAD_ZONE_PX = 2;

/** Swipe: maximum duration of a swipe gesture. @private */
const SWIPE_MAX_MS = 500;

/**
 * Swipe: minimum horizontal displacement. Set to 40 (not 50) because Android
 * thumbs swipe shorter distances than mouse-cursor drags; 40px still rejects
 * accidental scroll wiggles while accepting a deliberate flick.
 * @private
 */
const SWIPE_MIN_DX_PX = 40;

/** Wheel zoom: exponential scale-per-delta factor. @private */
const WHEEL_ZOOM_FACTOR = 0.002;

/** Velocity EMA: weight given to the newest sample. @private */
const VELOCITY_EMA_WEIGHT = 0.3;

/**
 * Number of pages above and below the visible set that zoom re-raster
 * pre-renders at the new scale. This is the "5 pages above and below" window:
 * by the time the user scrolls away from the current page, the text is
 * already sharp at the new scale.
 *
 * Independent of the scroll-direction prefetch depths in CONFIG
 * (PREFETCH_DEPTH_SLOW / FAST) because zoom is a discrete event, not a
 * continuous one — deeper symmetric pre-render pays off here and does not
 * during active scrolling.
 * @private
 */
const ZOOM_PRERENDER_RADIUS = 5;

/**
 * Fraction of PREFETCH_DEPTH_SLOW used for the opposite-direction window
 * during scroll. A user who flicks up, stops, and flicks down should not
 * pay for a full re-fetch in the opposite direction — but should also not
 * hit a cold page.
 * @private
 */
const PREFETCH_OPPOSITE_FRACTION = 0.5;

// ============================================================================
// 1. SCROLL MANAGER
// ============================================================================

/**
 * Owns the scroll listener on `#viewer-main`. Samples scroll velocity and
 * direction on every animation frame; drives scheduler pause/resume at
 * velocity thresholds with hysteresis; recomputes the visible-page set using
 * largest-overlap; enqueues directional prefetch; cancels stale work on
 * direction change; and provides `navigateTo` for fast random access.
 *
 * Preview-mode: every navigation is clamped at `_getEffectiveLimit()`, and
 * `_requestRender` refuses to enqueue renders for pages past that limit.
 *
 * Scroll-mode note:
 *   In scroll mode, #viewer-main is the native scroll surface
 *   (`overflow: auto; touch-action: pan-x pan-y` in CSS). PanManager is
 *   disabled in this mode — the browser handles 360° scrolling natively,
 *   and layering a transform-based pan on top would fight it. Page mode
 *   enables PanManager and disables native scroll.
 */
export class ScrollManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   * @param {Readonly<{ useVelocityThrottle: boolean, useRenderPrefetch: boolean }>} flags
   */
  constructor(core, flags) {
    /** @private */ this._core = core;
    /** @private */ this._flags = flags;

    /** @private @type {HTMLElement|null} */ this._scrollRoot = null;
    /** @private @type {Array<{pageNum:number, wrapper:HTMLElement, top:number, height:number}>} */
    this._wrapperCache = [];
    /** @private @type {Set<number>} */ this._visibleSet = new Set();
    /** @private @type {number} */ this._visibleTopPage = 0;

    /** @private @type {number} */ this._lastScrollTop = 0;
    /** @private @type {number} */ this._lastTimestamp = 0;
    /** @private @type {number} */ this._velocity = 0;
    /** @private @type {number} */ this._direction = 0;
    /** @private @type {number} */ this._directionIdleFrames = 0;

    /** @private */ this._paused = false;
    /** @private */ this._layoutDirty = false;
    /** @private */ this._attached = false;

    /**
     * The rAF-throttled scroll handler. Created once in the constructor so
     * the same function reference is used for both addEventListener and
     * removeEventListener. Coalesces multiple scroll events per frame into a
     * single `_onScrollFrame` invocation with the last-seen arguments.
     *
     * rafThrottle passes (…eventArgs, frameTimestamp) to its callback. We
     * drop the event args and forward only the frame timestamp to
     * `_onScrollFrame`, which is what the velocity math needs.
     *
     * @private
     */
    this._onScrollThrottled = rafThrottle((_event, frameTimestamp) => {
      this._onScrollFrame(frameTimestamp);
    });
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Bind the rAF-throttled scroll listener. Idempotent.
   * @returns {void}
   */
  attach() {
    if (this._attached) return;
    const els = getViewerElements();
    if (!els || !els.main) return;
    this._scrollRoot = els.main;
    this._lastScrollTop = this._scrollRoot.scrollTop;
    // Passive listener — we never call preventDefault in the scroll path.
    // The rAF wrapper does the actual coalescing, so the browser's native
    // scroll performance is not affected by the handler's work.
    this._scrollRoot.addEventListener('scroll', this._onScrollThrottled, { passive: true });
    this._attached = true;
    this.recomputeLayout();
  }

  /**
   * Remove the scroll listener. Idempotent. Also cancels any pending
   * throttled frame so a stale callback cannot fire after detach.
   * @returns {void}
   */
  detach() {
    if (!this._attached || !this._scrollRoot) return;
    try {
      this._scrollRoot.removeEventListener('scroll', this._onScrollThrottled);
    } catch { /* ignore */ }
    try {
      this._onScrollThrottled.cancel();
    } catch { /* ignore */ }
    this._attached = false;
  }

  /**
   * Rebuild the wrapper-geometry cache. Called on layout change, after first
   * canvas insertion, and once on attach. Reads layout once per wrapper.
   *
   * @returns {void}
   */
  recomputeLayout() {
    const els = getViewerElements();
    if (!els || !els.main) {
      this._wrapperCache = [];
      return;
    }
    const root = els.main;
    this._scrollRoot = root;
    const rootRect = root.getBoundingClientRect();
    const wrappers = root.querySelectorAll('.' + CONFIG.CANVAS_WRAPPER_CLASS);
    const cache = [];
    wrappers.forEach((wrapper) => {
      const pageNum = parseInt(wrapper.dataset.page, 10);
      if (!Number.isFinite(pageNum)) return;
      const r = wrapper.getBoundingClientRect();
      cache.push({
        pageNum,
        wrapper,
        top: r.top - rootRect.top + root.scrollTop,
        height: r.height,
      });
    });
    this._wrapperCache = cache;
    this._layoutDirty = false;
  }

  /**
   * Mark the wrapper cache stale; it will be rebuilt on the next scroll frame.
   * Cheaper than rebuilding immediately when many renders complete in
   * sequence.
   *
   * @returns {void}
   */
  markLayoutDirty() {
    this._layoutDirty = true;
  }

  /**
   * Current smoothed velocity in px/frame.
   * @returns {number}
   */
  getVelocity() {
    return this._velocity;
  }

  /**
   * Current scroll direction: 1 for down, -1 for up, 0 for idle.
   * @returns {-1|0|1}
   */
  getDirection() {
    return this._direction > 0 ? 1 : this._direction < 0 ? -1 : 0;
  }

  /**
   * Page numbers currently intersecting the viewport, sorted by descending
   * overlap.
   *
   * @returns {number[]}
   */
  getVisiblePageNumbers() {
    return Array.from(this._visibleSet);
  }

  /**
   * Fast page navigation. Cancels pending work, updates state, scrolls the
   * target wrapper into view (scroll mode only), enqueues a P1 render, and
   * emits PAGE_VISIBLE.
   *
   * Preview mode: navigation is clamped at the effective page limit. When
   * the caller requests a page past the limit, the request is redirected to
   * the last preview page and the CTA at the bottom of the layout signals
   * why. Every navigation path in the viewer converges here (page input,
   * arrow keys, outline, search, swipe, programmatic jumps), so this single
   * clamp covers all of them.
   *
   * @param {number} pageNum
   * @param {{ smooth?: boolean }} [opts]
   * @returns {void}
   */
  navigateTo(pageNum, opts) {
    if (!Number.isFinite(pageNum)) return;
    const totalPages = this._getNumPages();
    const effectiveLimit = this._getEffectiveLimit();

    // Clamp to [1, numPages] first so out-of-range values land on the
    // document's real boundaries, then clamp again at the effective limit
    // (which is ≤ numPages in preview mode).
    const clampedToTotal = clamp(pageNum, 1, Math.max(1, totalPages));
    const target = clampedToTotal > effectiveLimit ? effectiveLimit : clampedToTotal;

    // Cancel all queued and running work.
    try {
      const scheduler = this._core.getScheduler();
      if (scheduler && scheduler.cancelAll) {
        const p = scheduler.cancelAll();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch { /* ignore */ }

    // In scroll mode, scroll the wrapper into view.
    const viewMode = this._getViewMode();
    if (viewMode === 'scroll') {
      if (this._layoutDirty) this.recomputeLayout();
      const entry = this._wrapperCache.find((w) => w.pageNum === target);
      if (entry && this._scrollRoot) {
        const smooth = !!(opts && opts.smooth);
        if (smooth) {
          try {
            entry.wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch {
            this._scrollRoot.scrollTop = entry.top;
          }
        } else {
          this._scrollRoot.scrollTop = entry.top;
        }
      }
    }

    // Update state and notify.
    try {
      const state = this._core.getState();
      state.set('currentPage', target);
      this._core.getBus().emit(Events.PAGE_VISIBLE, { pageNum: target, reason: 'navigation' });
    } catch { /* ignore */ }

    // Request a P1 render for the target.
    this._requestRender(target, PRIORITY.VISIBLE);

    // Reset auto-hide timer via activity signal.
    this._emitActivity();
  }

  /**
   * Called by core after layout change or after a document-loaded event: walk
   * the visible set and request renders for pages missing a canvas at the
   * current scale.
   *
   * @returns {void}
   */
  refreshVisible() {
    if (this._layoutDirty) this.recomputeLayout();
    this._updateVisiblePages();
    for (const pageNum of this._visibleSet) {
      this._requestRender(pageNum, PRIORITY.VISIBLE);
    }
  }

  /**
   * Idempotent destroy.
   * @returns {void}
   */
  destroy() {
    this.detach();
    this._wrapperCache = [];
    this._visibleSet.clear();
    this._visibleTopPage = 0;
    this._lastScrollTop = 0;
    this._lastTimestamp = 0;
    this._velocity = 0;
    this._direction = 0;
    this._paused = false;
    this._layoutDirty = false;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Scroll handler. Runs at most once per animation frame via the outer
   * rafThrottle wrapper. Sampling, velocity, pause/resume, visibility,
   * prefetch, direction-change cancellation all happen here.
   *
   * @private
   * @param {number} [frameTimestamp]  RAF-provided frame timestamp.
   */
  _onScrollFrame(frameTimestamp) {
    if (!this._scrollRoot) return;

    // Rebuild wrapper cache if marked dirty.
    if (this._layoutDirty) this.recomputeLayout();

    const scrollTop = this._scrollRoot.scrollTop;
    const now = typeof frameTimestamp === 'number' ? frameTimestamp : performance.now();

    // ── Velocity + direction.
    if (this._lastTimestamp === 0) {
      this._lastTimestamp = now;
      this._lastScrollTop = scrollTop;
      return; // first frame establishes baseline
    }

    const delta = scrollTop - this._lastScrollTop;
    const dtMs = Math.max(now - this._lastTimestamp, 1);
    const frameMs = 1000 / 60;
    const instantaneous = delta / Math.max(dtMs / frameMs, 0.25);

    this._velocity = (1 - VELOCITY_EMA_WEIGHT) * this._velocity
      + VELOCITY_EMA_WEIGHT * instantaneous;

    if (Math.abs(delta) > 1) {
      const newDirection = delta > 0 ? 1 : -1;
      if (newDirection !== this._direction && this._direction !== 0) {
        // Direction reversed — cancel directional prefetch from previous direction.
        this._cancelDirectionalWork();
      }
      this._direction = newDirection;
      this._directionIdleFrames = 0;
    } else {
      this._directionIdleFrames++;
      if (this._directionIdleFrames > 6) this._direction = 0;
    }

    this._lastTimestamp = now;
    this._lastScrollTop = scrollTop;

    // ── Pause / resume with hysteresis.
    if (this._flags.useVelocityThrottle) {
      this._applyVelocityThrottle();
    }

    // ── Visibility update.
    this._updateVisiblePages();

    // ── Prefetch in the active direction.
    if (this._flags.useRenderPrefetch && Math.abs(this._velocity) < CONFIG.VELOCITY_PREFETCH_MAX) {
      this._prefetchAdjacent();
    }

    // ── Mirror velocity into state (throttled by frame, so cheap).
    try {
      this._core.getState().set('scrollVelocityPxPerFrame', this._velocity);
    } catch { /* ignore */ }

    // ── Emit activity signal for auto-hide.
    this._emitActivity();

    // ── Notify observers of velocity (dev tools, benchmarks).
    try {
      this._core.getBus().emit(Events.SCROLL_VELOCITY, {
        velocity: this._velocity,
        direction: this.getDirection(),
      });
    } catch { /* ignore */ }
  }

  /**
   * @private
   */
  _applyVelocityThrottle() {
    const scheduler = this._core.getScheduler();
    if (!scheduler) return;
    const absV = Math.abs(this._velocity);
    const suspend = CONFIG.VELOCITY_SUSPEND_PX_PER_FRAME;

    if (!this._paused && absV > suspend) {
      try { scheduler.pause(); } catch { /* ignore */ }
      this._paused = true;
    } else if (this._paused && absV < suspend / 2) {
      try { scheduler.resume(); } catch { /* ignore */ }
      this._paused = false;
    }
  }

  /**
   * @private
   */
  _updateVisiblePages() {
    if (!this._scrollRoot || this._wrapperCache.length === 0) return;

    const st = this._scrollRoot.scrollTop;
    const vh = this._scrollRoot.clientHeight;
    if (vh <= 0) return;

    /** @type {Array<{pageNum:number, area:number}>} */
    const visible = [];
    let topPage = 0;
    let maxArea = 0;

    for (const entry of this._wrapperCache) {
      const pageRect = { x: 0, y: entry.top, width: 1, height: entry.height };
      const viewRect = { x: 0, y: st, width: 1, height: vh };
      const area = rectOverlapArea(pageRect, viewRect);
      if (area > 0) {
        visible.push({ pageNum: entry.pageNum, area });
        if (area > maxArea) {
          maxArea = area;
          topPage = entry.pageNum;
        }
      }
    }

    // Sort descending by overlap area.
    visible.sort((a, b) => b.area - a.area);

    const newSet = new Set(visible.map((v) => v.pageNum));
    const previousSet = this._visibleSet;
    this._visibleSet = newSet;

    // Detect newly-entered pages and request renders.
    for (const pageNum of newSet) {
      if (!previousSet.has(pageNum)) {
        this._requestRender(pageNum, PRIORITY.VISIBLE);
      }
    }

    // Update state.currentPage on top-page change.
    if (topPage > 0 && topPage !== this._visibleTopPage) {
      this._visibleTopPage = topPage;
      try {
        const state = this._core.getState();
        if (state.get('currentPage') !== topPage) {
          state.set('currentPage', topPage);
          this._core.getBus().emit(Events.PAGE_VISIBLE, {
            pageNum: topPage,
            reason: 'scroll',
          });
        }
      } catch { /* ignore */ }
    }

    try {
      this._core.getState().set('visiblePageNumbers', Array.from(newSet));
    } catch { /* ignore */ }
  }

  /**
   * @private
   */
  _cancelDirectionalWork() {
    const scheduler = this._core.getScheduler();
    if (!scheduler || !scheduler.cancelBelow) return;
    try { scheduler.cancelBelow(PRIORITY.ADJACENT); } catch { /* ignore */ }
  }

  /**
   * Velocity-aware directional prefetch.
   *
   * The depth of the window in the active direction is chosen from
   * `PREFETCH_DEPTH_SLOW` (5) at low velocity or `PREFETCH_DEPTH_FAST` (2) at
   * high velocity. A secondary, shallower window is emitted in the opposite
   * direction at `PRIORITY.MARGIN` so a quick reversal does not hit cold
   * pages, but at lower priority so it never competes with the active
   * direction for render slots.
   *
   * Preview mode: every page enqueued respects the effective limit.
   *
   * @private
   */
  _prefetchAdjacent() {
    if (!this._scrollRoot) return;

    // Cap the prefetch window at the effective limit, not the real total.
    // In preview mode this means we never prefetch a locked page.
    const limit = this._getEffectiveLimit();
    if (limit <= 1) return;

    const current = this._getCurrentPage();
    if (!Number.isFinite(current)) return;

    const dir = this._direction > 0 ? 1 : this._direction < 0 ? -1 : 0;
    if (dir === 0) return;

    // Velocity-aware depth for the active direction.
    const absV = Math.abs(this._velocity);
    const activeDepth = absV > CONFIG.VELOCITY_SUSPEND_PX_PER_FRAME / 2
      ? CONFIG.PREFETCH_DEPTH_FAST
      : CONFIG.PREFETCH_DEPTH_SLOW;

    // Primary window — active direction, PRIORITY.ADJACENT.
    for (let offset = 1; offset <= activeDepth; offset++) {
      const pageNum = current + dir * offset;
      if (pageNum < 1 || pageNum > limit) continue;
      this._requestRender(pageNum, PRIORITY.ADJACENT);
    }

    // Secondary window — opposite direction, PRIORITY.MARGIN.
    // Shallower than the primary so a reversal has a warm start without
    // stealing slots from the pages the user is actually approaching.
    const oppositeDepth = Math.max(
      1,
      Math.floor(activeDepth * PREFETCH_OPPOSITE_FRACTION),
    );
    for (let offset = 1; offset <= oppositeDepth; offset++) {
      const pageNum = current - dir * offset;
      if (pageNum < 1 || pageNum > limit) continue;
      this._requestRender(pageNum, PRIORITY.MARGIN);
    }
  }

  /**
   * Enqueue a render job for a page. Job id format matches core.js's
   * `_enqueuePageRender` exactly so the scheduler deduplicates across both
   * enqueue sources: `page:${pageNum}:${scale}:${rotation}`.
   *
   * @private
   * @param {number} pageNum
   * @param {number} priority
   */
  _requestRender(pageNum, priority) {
    if (!Number.isFinite(pageNum)) return;

    // Preview mode: never schedule a render for a locked page. This is a
    // belt-and-braces guard — navigation is already clamped in navigateTo,
    // but this catches any other caller that constructs a render request
    // directly (e.g. _updateVisiblePages in a race, or future callers).
    if (pageNum > this._getEffectiveLimit()) return;

    const scheduler = this._core.getScheduler();
    if (!scheduler || !scheduler.enqueue) return;

    let scale = 1;
    let rotation = 0;
    try {
      const state = this._core.getState();
      scale = state.get('scale') || 1;
      rotation = state.get('rotation') || 0;
    } catch { /* ignore */ }

    /** @type {import('./render.js').RenderJob} */
    const job = {
      id: `page:${pageNum}:${scale}:${rotation}`,
      kind: 'page',
      pageNum,
      scale,
      rotation,
      tileRect: null,
      priority,
    };
    try { scheduler.enqueue(job); } catch { /* ignore */ }
  }

  /**
   * @private
   */
  _emitActivity() {
    try { this._core.getBus().emit(Events.INTERACTION_ACTIVITY, {}); } catch { /* ignore */ }
  }

  /**
   * @private @returns {number}
   */
  _getNumPages() {
    try { return this._core.getState().get('numPages') || 1; } catch { return 1; }
  }

  /**
   * Effective page limit for navigation and rendering. Returns the preview
   * limit when in preview mode, otherwise the real total. Delegates to
   * `core.getEffectivePageLimit()` so the value is computed in exactly one
   * place; falls back to `numPages` if the core does not implement the
   * method (defensive, in case a test double is used).
   *
   * @private
   * @returns {number}
   */
  _getEffectiveLimit() {
    try {
      const core = this._core;
      if (core && typeof core.getEffectivePageLimit === 'function') {
        const limit = core.getEffectivePageLimit();
        if (typeof limit === 'number' && limit > 0) return limit;
      }
      return this._getNumPages();
    } catch {
      return this._getNumPages();
    }
  }

  /**
   * @private @returns {string}
   */
  _getViewMode() {
    try { return this._core.getState().get('viewMode') || 'scroll'; } catch { return 'scroll'; }
  }

  /**
   * @private @returns {number}
   */
  _getCurrentPage() {
    try { return this._core.getState().get('currentPage') || 1; } catch { return 1; }
  }
}

// ============================================================================
// 2. ZOOM MANAGER
// ============================================================================

/**
 * Two-phase zoom.
 *
 * Phase A — gesture active: apply CSS transform on the transform node via GPU
 * compositor. One rAF-batched write per frame; no re-render; no state change.
 * Pinch and wheel keep a focal anchor because those gestures have a natural,
 * physically meaningful focal point (the pinch midpoint; the cursor position).
 *
 * Phase B — gesture end + settle debounce: commit `state.scale`, invalidate
 * tile decisions, emit SCALE_APPLIED, enqueue re-raster at the new scale for
 * visible pages AND the surrounding 5-page window. The CSS transform is left
 * in place; core swaps canvases as RENDER_COMPLETE events fire, and
 * interaction.js's RENDER_COMPLETE subscriber clears the transform once the
 * committed scale matches the rendered scale.
 *
 * Preview mode: re-raster enqueue filters out locked pages.
 *
 * Non-focal sources (buttons, keyboard, double-tap) always anchor on the
 * viewport center. Anchoring a magnify action to a tap point is a mobile-
 * browser convention (iOS Safari), not a PDF-viewer convention. Adobe
 * Acrobat toggles fit levels; Apple PDFKit centers on the viewport; Nutrient
 * and Apryse "Smart Zoom" center on a paragraph.
 *
 * The USE_TWO_PHASE_ZOOM flag controls the visual commit STRATEGY only. When
 * it is off, pinch and wheel are still recognised — they simply commit the
 * scale with a short debounce instead of applying a CSS transform during the
 * gesture. Gating the gesture itself behind the flag was a bug.
 */
export class ZoomManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   * @param {Readonly<{ useTwoPhase: boolean }>} flags
   */
  constructor(core, flags) {
    /** @private */ this._core = core;
    /** @private */ this._flags = flags;

    /** @private @type {HTMLElement|null} */ this._transformNode = null;
    /** @private @type {number} */ this._currentScale = 1;
    /** @private @type {number} */ this._targetScale = 1;

    /** @private */ this._gestureActive = false;
    /** @private @type {'pinch'|'wheel'|'button'|'keyboard'|'fit'|'reset'|'double-tap'|null} */
    this._gestureSource = null;
    /** @private @type {{x:number, y:number}} */ this._origin = { x: 0, y: 0 };

    /** @private @type {ReturnType<typeof debounce>|null} */ this._settleTimer = null;
    /** @private @type {ReturnType<typeof debounce>|null} */ this._legacyCommitTimer = null;
    /** @private */ this._rafScheduled = false;
    /** @private @type {number|null} */ this._rafId = null;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Attach the transform node. Replaces any prior attachment. Idempotent when
   * called with the same node.
   *
   * @param {HTMLElement|null} node
   * @returns {void}
   */
  attach(node) {
    this._transformNode = node || null;
  }

  /**
   * @returns {void}
   */
  detach() {
    this._cancelSettle();
    if (this._legacyCommitTimer) {
      try { this._legacyCommitTimer.cancel(); } catch { /* ignore */ }
      this._legacyCommitTimer = null;
    }
    if (this._rafId !== null) {
      try { cancelAnimationFrame(this._rafId); } catch { /* ignore */ }
      this._rafId = null;
    }
    this._rafScheduled = false;
    this._transformNode = null;
    this._gestureActive = false;
    this._gestureSource = null;
  }

  /**
   * Request a zoom to `scale` from a non-gesture source (button, keyboard,
   * double-tap, reset). Behaves as an instantaneous gesture start+end.
   * Always anchored on the viewport center.
   *
   * @param {number} scale
   * @param {string} [source]
   * @returns {void}
   */
  requestZoom(scale, source) {
    const clamped = clamp(scale, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
    this._targetScale = clamped;
    this._gestureSource = (source || 'button');

    // If a gesture is already active, treat the request as a focal update.
    if (this._gestureActive) {
      this._scheduleTransformWrite();
      return;
    }

    // Non-gesture path: apply the new scale and start the settle timer.
    if (this._flags.useTwoPhase) {
      // Apply visual transform first (instant feedback), then settle.
      this._applyOriginFromViewportCenter();
      this._scheduleTransformWrite();
      this._startSettle();
    } else {
      // Immediate commit (rollback path — matches legacy viewer).
      this._commitScale(clamped);
    }
  }

  /**
   * Adopt a scale without a gesture, without a transform write, and without
   * re-rendering. Used by core.js when it needs to install a computed initial
   * scale (fit-to-width) BEFORE the first render is enqueued.
   *
   * Cancels any in-flight gesture state, pending settle timers, and any
   * lingering CSS transform on the transform node — so the viewer starts
   * from a clean, settled state at the new scale.
   *
   * Does NOT emit SCALE_APPLIED and does NOT enqueue renders. The caller
   * (core.js::_loadPdf) is responsible for those if needed.
   *
   * @param {number} scale
   * @returns {void}
   */
  syncScale(scale) {
    const clamped = clamp(scale, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);

    this._cancelSettle();
    if (this._legacyCommitTimer) {
      try { this._legacyCommitTimer.cancel(); } catch { /* ignore */ }
      this._legacyCommitTimer = null;
    }
    if (this._rafId !== null) {
      try { cancelAnimationFrame(this._rafId); } catch { /* ignore */ }
      this._rafId = null;
    }
    this._rafScheduled = false;
    this._gestureActive = false;

    if (this._transformNode) {
      try { this._transformNode.style.transform = ''; } catch { /* ignore */ }
    }

    this._currentScale = clamped;
    this._targetScale = clamped;
  }

  /**
   * Fit the current page to the viewport width.
   * @returns {void}
   */
  requestFit() {
    const els = getViewerElements();
    if (!els || !els.main) return;
    const containerWidth = Math.max(els.main.clientWidth - 40, 100);
    const engine = this._core.getEngine();
    if (!engine) return;

    const pageNum = this._getCurrentPage();
    Promise.resolve()
      .then(() => engine.getPageMetadata(pageNum))
      .then((meta) => {
        if (!meta || !meta.width) return;
        const fit = (containerWidth / meta.width) * 0.95;
        this.requestZoom(fit, 'fit');
      })
      .catch(() => { /* ignore */ });
  }

  /**
   * Begin a continuous gesture (pinch or wheel). Idempotent per gesture.
   * The focal point is the natural anchor of the gesture — pinch midpoint or
   * cursor position — and is used as the CSS transform origin.
   *
   * Note: this method runs regardless of USE_TWO_PHASE_ZOOM. The flag only
   * controls the visual commit strategy; the gesture is always recognised.
   *
   * @param {string} source
   * @param {{x:number, y:number}} [focal]
   * @returns {void}
   */
  startGesture(source, focal) {
    this._cancelSettle();

    this._gestureActive = true;
    this._gestureSource = source || 'pinch';
    this._targetScale = this._currentScale;

    if (focal && typeof focal.x === 'number' && typeof focal.y === 'number') {
      this._origin = { x: focal.x, y: focal.y };
    } else {
      this._applyOriginFromViewportCenter();
    }

    try {
      this._core.getState().set('isZoomGestureActive', true);
      this._core.getBus().emit(Events.ZOOM_GESTURE_START, { source: this._gestureSource });
    } catch { /* ignore */ }
  }

  /**
   * Continuous update during a gesture. May be called at arbitrary frequency.
   *
   * Two-phase mode: rAF-batched CSS transform for instant visual feedback;
   * the actual scale commit happens on gesture end + settle debounce.
   *
   * Legacy mode: debounced commit — every update resets a 120 ms timer; when
   * the timer fires, the scale is committed and pages re-rasterise.
   *
   * @param {number} scale
   * @param {{x:number, y:number}} [focal]
   * @returns {void}
   */
  updateGesture(scale, focal) {
    if (!this._gestureActive) return;
    const clamped = clamp(scale, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
    this._targetScale = clamped;
    if (focal && typeof focal.x === 'number' && typeof focal.y === 'number') {
      this._origin = { x: focal.x, y: focal.y };
    }

    if (this._flags.useTwoPhase) {
      this._scheduleTransformWrite();
    } else {
      this._scheduleLegacyCommit();
    }
  }

  /**
   * End the current gesture. Idempotent when no gesture is active.
   *
   * @returns {void}
   */
  endGesture() {
    if (!this._gestureActive) return;
    this._gestureActive = false;
    try {
      this._core.getState().set('isZoomGestureActive', false);
      this._core.getBus().emit(Events.ZOOM_GESTURE_END, { source: this._gestureSource });
    } catch { /* ignore */ }

    if (this._flags.useTwoPhase) {
      this._startSettle();
    } else {
      this._flushLegacyCommit();
    }
  }

  /**
   * @returns {number}
   */
  getCurrentScale() {
    return this._currentScale;
  }

  /**
   * @returns {number}
   */
  getTargetScale() {
    return this._targetScale;
  }

  /**
   * @returns {boolean}
   */
  isGestureActive() {
    return this._gestureActive;
  }

  /**
   * Handle a device-pixel-ratio change. Re-enqueues re-raster at the same
   * CSS scale but the new DPR. Deferred while a gesture is in flight.
   *
   * @param {number} _newDpr
   * @returns {void}
   */
  applyDprChange(_newDpr) {
    if (this._gestureActive) return;
    this._commitScale(this._currentScale, { force: true });
  }

  /**
   * Clear the CSS transform on the transform node. Called after a page has
   * been re-rendered at the current scale, so the canvas is shown at its
   * native size instead of being double-scaled by the lingering transform.
   *
   * No-op while a gesture is in progress.
   *
   * @returns {void}
   */
  clearTransform() {
    if (this._gestureActive) return;
    if (!this._transformNode) return;
    try { this._transformNode.style.transform = ''; } catch { /* ignore */ }
  }

  /**
   * Idempotent destroy.
   * @returns {void}
   */
  destroy() {
    this.detach();
    this._currentScale = 1;
    this._targetScale = 1;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * @private
   */
  _applyOriginFromViewportCenter() {
    const els = getViewerElements();
    const rect = els && els.main ? els.main.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    this._origin = {
      x: (rect.width || 0) / 2,
      y: (rect.height || 0) / 2,
    };
  }

  /**
   * Schedule a single rAF that applies the transform. Multiple calls in one
   * frame collapse to one write.
   * @private
   */
  _scheduleTransformWrite() {
    if (!this._transformNode) return;
    if (this._rafScheduled) return;
    this._rafScheduled = true;
    try {
      this._rafId = requestAnimationFrame(() => {
        this._rafScheduled = false;
        this._rafId = null;
        this._writeTransformNow();
      });
    } catch {
      this._rafScheduled = false;
    }
  }

  /**
   * @private
   */
  _writeTransformNow() {
    if (!this._transformNode) return;
    const s = this._targetScale;
    const ox = this._origin.x;
    const oy = this._origin.y;
    const tx = -ox * (s - 1);
    const ty = -oy * (s - 1);
    try {
      this._transformNode.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${s})`;
      this._transformNode.style.transformOrigin = '0 0';
    } catch { /* ignore */ }
  }

  /**
   * @private
   */
  _startSettle() {
    if (!this._settleTimer) {
      this._settleTimer = debounce(() => {
        this._settleTimer = null;
        this._onSettle();
      }, CONFIG.ZOOM_SETTLE_DEBOUNCE_MS);
    }
    this._settleTimer();
  }

  /**
   * @private
   */
  _cancelSettle() {
    if (this._settleTimer) {
      try { this._settleTimer.cancel(); } catch { /* ignore */ }
      this._settleTimer = null;
    }
  }

  /**
   * Legacy-mode commit scheduling. Resets a debounce on every gesture update
   * so that the commit only fires once the user pauses.
   * @private
   */
  _scheduleLegacyCommit() {
    if (!this._legacyCommitTimer) {
      this._legacyCommitTimer = debounce(() => {
        this._legacyCommitTimer = null;
        this._commitScale(this._targetScale);
      }, CONFIG.ZOOM_SETTLE_DEBOUNCE_MS);
    }
    this._legacyCommitTimer();
  }

  /**
   * Flush a pending legacy commit immediately (called on gesture end).
   * @private
   */
  _flushLegacyCommit() {
    if (this._legacyCommitTimer) {
      try { this._legacyCommitTimer.cancel(); } catch { /* ignore */ }
      this._legacyCommitTimer = null;
    }
    this._commitScale(this._targetScale);
  }

  /**
   * @private
   */
  _onSettle() {
    const newScale = this._targetScale;
    this._commitScale(newScale);
  }

  /**
   * Commit a final scale: update state, invalidate tile decisions, emit
   * SCALE_APPLIED, enqueue re-raster.
   *
   * @private
   * @param {number} scale
   * @param {{ force?: boolean }} [opts]
   */
  _commitScale(scale, opts) {
    const clamped = clamp(scale, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
    const previousScale = this._currentScale;
    const force = !!(opts && opts.force);
    if (!force && clamped === previousScale) return;

    this._currentScale = clamped;
    this._targetScale = clamped;

    // Invalidate tile decisions for the new scale.
    try {
      const tm = this._core.getTileManager();
      if (tm && tm.invalidateAll) tm.invalidateAll();
    } catch { /* ignore */ }

    // Update state (drives the zoom % display in ui-internal).
    try {
      this._core.getState().set('scale', clamped);
    } catch { /* ignore */ }

    // Notify observers.
    try {
      this._core.getBus().emit(Events.SCALE_APPLIED, {
        scale: clamped,
        source: this._gestureSource || 'unknown',
      });
    } catch { /* ignore */ }

    // Enqueue re-raster for visible pages at the new scale AND the
    // surrounding 5-page window. This is what makes magnification feel
    // instant: neighbouring pages are already sharp before the user
    // scrolls to them.
    this._enqueueVisibleRenders(clamped);
  }

  /**
   * Re-raster the currently visible pages at the new scale, plus the
   * surrounding ZOOM_PRERENDER_RADIUS-page window above and below.
   *
   * Priority assignment:
   *   • Visible pages     → PRIORITY.VISIBLE   (rendered first)
   *   • Neighbouring pages → PRIORITY.ADJACENT  (rendered next)
   *
   * Both bands respect the effective page limit — in preview mode, locked
   * pages are filtered out so we never schedule a render for a page the user
   * is not allowed to see.
   *
   * Job id includes rotation, matching core.js's `_enqueuePageRender` so the
   * scheduler deduplicates across both sources.
   *
   * @private
   * @param {number} scale
   */
  _enqueueVisibleRenders(scale) {
    const scroll = this._core.getScroll();
    const scheduler = this._core.getScheduler();
    if (!scheduler || !scheduler.enqueue) return;

    // Effective limit: preview limit in preview mode, else numPages.
    let limit = 1;
    let rotation = 0;
    try {
      if (this._core && typeof this._core.getEffectivePageLimit === 'function') {
        limit = this._core.getEffectivePageLimit();
      } else {
        limit = this._core.getState().get('numPages') || 1;
      }
      rotation = this._core.getState().get('rotation') || 0;
    } catch {
      limit = this._core.getState().get('numPages') || 1;
    }

    // ── Visible pages at PRIORITY.VISIBLE ────────────────────────────────
    const pages = scroll && scroll.getVisiblePageNumbers
      ? scroll.getVisiblePageNumbers()
      : [];

    const fallback = this._getCurrentPage();
    const visibleList = pages.length > 0 ? pages : [fallback];

    // Track what we've already enqueued so the neighbouring window does not
    // re-enqueue a page that is already in the visible set.
    const enqueued = new Set();

    for (const pageNum of visibleList) {
      if (pageNum > limit) continue;
      if (enqueued.has(pageNum)) continue;
      enqueued.add(pageNum);

      this._enqueuePage(scheduler, pageNum, scale, rotation, PRIORITY.VISIBLE);
    }

    // ── Surrounding window at PRIORITY.ADJACENT ──────────────────────────
    //
    // ZOOM_PRERENDER_RADIUS pages above and below the current page. This is
    // the "5 pages above and below" behaviour: after a pinch or zoom-button
    // press settles, the neighbouring pages start rendering at the new
    // scale in the background while the user is still looking at the
    // current one.
    const current = fallback;
    for (let offset = 1; offset <= ZOOM_PRERENDER_RADIUS; offset++) {
      const above = current - offset;
      if (above >= 1 && above <= limit && !enqueued.has(above)) {
        enqueued.add(above);
        this._enqueuePage(scheduler, above, scale, rotation, PRIORITY.ADJACENT);
      }
      const below = current + offset;
      if (below >= 1 && below <= limit && !enqueued.has(below)) {
        enqueued.add(below);
        this._enqueuePage(scheduler, below, scale, rotation, PRIORITY.ADJACENT);
      }
    }
  }

  /**
   * Enqueue a single page-render job. Job id format matches core.js's
   * `_enqueuePageRender` exactly, so the scheduler deduplicates.
   *
   * @private
   * @param {any} scheduler
   * @param {number} pageNum
   * @param {number} scale
   * @param {number} rotation
   * @param {number} priority
   */
  _enqueuePage(scheduler, pageNum, scale, rotation, priority) {
    /** @type {import('./render.js').RenderJob} */
    const job = {
      id: `page:${pageNum}:${scale}:${rotation}`,
      kind: 'page',
      pageNum,
      scale,
      rotation,
      tileRect: null,
      priority,
    };
    try { scheduler.enqueue(job); } catch { /* ignore */ }
  }

  /**
   * @private @returns {number}
   */
  _getCurrentPage() {
    try { return this._core.getState().get('currentPage') || 1; } catch { return 1; }
  }
}

// ============================================================================
// 3. PAN MANAGER
// ============================================================================

/**
 * Pointer-based panning for page mode and image mode. Accumulates deltas in
 * memory and applies a single rAF-batched `translate3d` write per frame.
 *
 * When `USE_RAF_PAN` is false (rollback path), the write happens directly
 * inside pointermove — matching the previous monolithic viewer's behaviour.
 *
 * Pan is enabled ONLY in page mode and for image documents. In scroll mode,
 * #viewer-main scrolls natively on both axes (`overflow: auto` in CSS), and
 * layering a transform-based pan on top would fight the browser's own
 * scroll handling.
 */
export class PanManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   * @param {Readonly<{ useRafPan: boolean }>} flags
   */
  constructor(core, flags) {
    /** @private */ this._core = core;
    /** @private */ this._flags = flags;

    /** @private @type {HTMLElement|null} */ this._target = null;
    /** @private */ this._enabled = false;
    /** @private */ this._pointerDown = false;
    /** @private @type {number|null} */ this._pointerId = null;
    /** @private */ this._lastX = 0;
    /** @private */ this._lastY = 0;
    /** @private */ this._downX = 0;
    /** @private */ this._downY = 0;

    /** @private */ this._accumX = 0;
    /** @private */ this._accumY = 0;
    /** @private */ this._totalX = 0;
    /** @private */ this._totalY = 0;

    /** @private */ this._isPanning = false;
    /** @private @type {ReturnType<typeof rafThrottle>|null} */ this._rafWrite = null;

    /** @private */ this._onPointerDownBound = this._onPointerDown.bind(this);
    /** @private */ this._onPointerMoveBound = this._onPointerMove.bind(this);
    /** @private */ this._onPointerUpBound = this._onPointerUp.bind(this);
    /** @private */ this._onPointerCancelBound = this._onPointerCancel.bind(this);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Bind the pointer listeners to the given target. Re-binds when called with
   * a new target. Idempotent when called with the same target.
   *
   * @param {HTMLElement|null} target
   * @returns {void}
   */
  attach(target) {
    if (this._target === target) return;
    this._detachListeners();
    this._target = target || null;
    if (!this._target) return;

    if (!this._rafWrite) {
      this._rafWrite = rafThrottle(this._writeTransformNow.bind(this));
    }

    this._target.addEventListener('pointerdown', this._onPointerDownBound);
    this._target.addEventListener('pointermove', this._onPointerMoveBound);
    this._target.addEventListener('pointerup', this._onPointerUpBound);
    this._target.addEventListener('pointercancel', this._onPointerCancelBound);
  }

  /**
   * @returns {void}
   */
  detach() {
    this._detachListeners();
    this._target = null;
    if (this._rafWrite) {
      try { this._rafWrite.cancel(); } catch { /* ignore */ }
      this._rafWrite = null;
    }
  }

  /**
   * Enable or disable panning.
   * @param {boolean} enabled
   * @returns {void}
   */
  setEnabled(enabled) {
    this._enabled = !!enabled;
    if (!enabled) this._resetState();
  }

  /**
   * Reset accumulated offsets and clear the transform.
   * @returns {void}
   */
  reset() {
    this._accumX = 0;
    this._accumY = 0;
    this._totalX = 0;
    this._totalY = 0;
    this._resetState();
    if (this._target) {
      try { this._target.style.transform = ''; } catch { /* ignore */ }
    }
    try { this._core.getState().patch({ panOffsetX: 0, panOffsetY: 0 }); } catch { /* ignore */ }
  }

  /**
   * @returns {{ x: number, y: number }}
   */
  getOffset() {
    return { x: this._totalX, y: this._totalY };
  }

  /**
   * @returns {void}
   */
  destroy() {
    this.detach();
    this._resetState();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * @private
   */
  _detachListeners() {
    if (!this._target) return;
    try {
      this._target.removeEventListener('pointerdown', this._onPointerDownBound);
      this._target.removeEventListener('pointermove', this._onPointerMoveBound);
      this._target.removeEventListener('pointerup', this._onPointerUpBound);
      this._target.removeEventListener('pointercancel', this._onPointerCancelBound);
    } catch { /* ignore */ }
  }

  /**
   * @private
   */
  _resetState() {
    this._pointerDown = false;
    this._pointerId = null;
    this._isPanning = false;
    this._accumX = 0;
    this._accumY = 0;
  }

  /**
   * @private
   * @param {PointerEvent} e
   */
  _onPointerDown(e) {
    if (!this._enabled) return;
    if (e.button !== 0) return;
    if (this._pointerDown) return;

    this._pointerDown = true;
    this._pointerId = e.pointerId;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    this._downX = e.clientX;
    this._downY = e.clientY;
    this._isPanning = false;

    try { this._target.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    // Prevent text selection / image drag while panning.
    if (!this._flags.useRafPan) e.preventDefault();
  }

  /**
   * @private
   * @param {PointerEvent} e
   */
  _onPointerMove(e) {
    if (!this._pointerDown) return;
    if (e.pointerId !== this._pointerId) return;

    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;

    if (!this._isPanning) {
      const totalDx = e.clientX - this._downX;
      const totalDy = e.clientY - this._downY;
      if (Math.abs(totalDx) + Math.abs(totalDy) > PAN_DEAD_ZONE_PX) {
        this._isPanning = true;
        try { this._core.getBus().emit(Events.PAN_START, { x: e.clientX, y: e.clientY }); } catch { /* ignore */ }
        try { this._core.getState().set('isPanning', true); } catch { /* ignore */ }
      }
    }

    if (!this._isPanning) return;

    this._accumX += dx;
    this._accumY += dy;
    this._totalX += dx;
    this._totalY += dy;
    this._lastX = e.clientX;
    this._lastY = e.clientY;

    if (this._flags.useRafPan) {
      if (this._rafWrite) this._rafWrite();
    } else {
      // Rollback path: direct synchronous write (matches legacy viewer).
      this._writeTransformNow();
    }
  }

  /**
   * @private
   * @param {PointerEvent} e
   */
  _onPointerUp(e) {
    if (e.pointerId !== this._pointerId) return;
    this._finishPointer(e);
  }

  /**
   * @private
   * @param {PointerEvent} e
   */
  _onPointerCancel(e) {
    if (e.pointerId !== this._pointerId) return;
    this._finishPointer(e);
  }

  /**
   * @private
   * @param {PointerEvent} e
   */
  _finishPointer(e) {
    const wasPanning = this._isPanning;
    const x = e.clientX;
    const y = e.clientY;

    this._pointerDown = false;
    this._pointerId = null;
    this._isPanning = false;

    try { this._target.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

    if (wasPanning) {
      try { this._core.getBus().emit(Events.PAN_END, { x, y }); } catch { /* ignore */ }
      try { this._core.getState().set('isPanning', false); } catch { /* ignore */ }
    }

    // Cancel any pending rAF write and flush the final position immediately,
    // so the last pointer delta is not lost between the pending frame and the
    // pointer release.
    if (this._rafWrite) {
      try { this._rafWrite.cancel(); } catch { /* ignore */ }
    }
    this._writeTransformNow();
  }

  /**
   * @private
   */
  _writeTransformNow() {
    if (!this._target) return;
    try {
      this._target.style.transform = `translate3d(${this._accumX}px, ${this._accumY}px, 0)`;
    } catch { /* ignore */ }
    try {
      this._core.getState().patch({
        panOffsetX: this._accumX,
        panOffsetY: this._accumY,
      });
    } catch { /* ignore */ }
  }
}

// ============================================================================
// 4. GESTURE MANAGER
// ============================================================================

/**
 * Recognises high-level gestures from raw touch and wheel events and routes
 * them to ZoomManager, PanManager, or the bus.
 *
 *  • Pinch (two-finger touch) → ZoomManager.startGesture/updateGesture/endGesture
 *  • Swipe (single-finger, page mode only) → emit SWIPE
 *  • Ctrl/Meta wheel (web only) → ZoomManager.startGesture('wheel', focal)
 *                                 + updateGesture + debounced endGesture
 *
 * Single-tap and double-tap are NOT handled here. They live in ui-internal.js
 * as a click-based sequence handler, because click events fire identically on
 * desktop and mobile and a single handler avoids the double-fire that a
 * touch-based detector produced alongside a click-based one.
 *
 * Every recognised input also emits INTERACTION_ACTIVITY (used by ui-internal
 * for auto-hide timer reset).
 *
 * Wheel listener is attached only when `isWeb()` is true — see the module
 * doc-comment for the rationale.
 */
export class GestureManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   */
  constructor(core) {
    /** @private */ this._core = core;
    /** @private @type {HTMLElement|null} */ this._target = null;
    /** @private @type {ZoomManager|null} */ this._zoom = null;
    /** @private @type {PanManager|null} */ this._pan = null;
    /** @private @type {ScrollManager|null} */ this._scroll = null;

    // Pinch state.
    /** @private */ this._pinchDistance = 0;
    /** @private */ this._pinchScale = 1;
    /** @private */ this._pinchActive = false;

    // Swipe state.
    /** @private */ this._touchStartX = 0;
    /** @private */ this._touchStartY = 0;
    /** @private */ this._touchStartTime = 0;

    // Wheel settle.
    /** @private @type {ReturnType<typeof debounce>|null} */ this._wheelSettle = null;

    /** @private */ this._onTouchStartBound = this._onTouchStart.bind(this);
    /** @private */ this._onTouchMoveBound = this._onTouchMove.bind(this);
    /** @private */ this._onTouchEndBound = this._onTouchEnd.bind(this);
    /** @private */ this._onWheelBound = this._onWheel.bind(this);
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Bind all touch and (on web) wheel listeners. Idempotent when re-attached
   * to the same target with the same manager references.
   *
   * @param {HTMLElement|null} target
   * @param {{ zoomManager: ZoomManager, panManager: PanManager, scrollManager: ScrollManager }} deps
   * @returns {void}
   */
  attach(target, deps) {
    this.detach();
    if (!target) return;
    this._target = target;
    this._zoom = (deps && deps.zoomManager) || null;
    this._pan = (deps && deps.panManager) || null;
    this._scroll = (deps && deps.scrollManager) || null;

    this._target.addEventListener('touchstart', this._onTouchStartBound, { passive: false });
    this._target.addEventListener('touchmove', this._onTouchMoveBound, { passive: false });
    this._target.addEventListener('touchend', this._onTouchEndBound, { passive: false });
    this._target.addEventListener('touchcancel', this._onTouchEndBound, { passive: false });

    // Wheel-zoom is a desktop convention. On native Android the listener is
    // never attached — dead code avoided, and the hardware back button is not
    // shadowed by any wheel handling.
    if (isWeb()) {
      this._target.addEventListener('wheel', this._onWheelBound, { passive: false });
    }
  }

  /**
   * @returns {void}
   */
  detach() {
    if (this._target) {
      try {
        this._target.removeEventListener('touchstart', this._onTouchStartBound);
        this._target.removeEventListener('touchmove', this._onTouchMoveBound);
        this._target.removeEventListener('touchend', this._onTouchEndBound);
        this._target.removeEventListener('touchcancel', this._onTouchEndBound);
        this._target.removeEventListener('wheel', this._onWheelBound);
      } catch { /* ignore */ }
    }
    if (this._wheelSettle) {
      try { this._wheelSettle.cancel(); } catch { /* ignore */ }
      this._wheelSettle = null;
    }
    this._target = null;
    this._pinchActive = false;
    this._pinchDistance = 0;
  }

  /**
   * @returns {void}
   */
  destroy() {
    this.detach();
    this._zoom = null;
    this._pan = null;
    this._scroll = null;
  }

  // ── Touch handlers ────────────────────────────────────────────────────────

  /**
   * @private
   * @param {TouchEvent} e
   */
  _onTouchStart(e) {
    this._emitActivity();

    if (e.touches.length === 2) {
      // Pinch begins — record baseline, disable pan.
      const [t0, t1] = [e.touches[0], e.touches[1]];
      this._pinchDistance = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      this._pinchScale = this._zoom ? this._zoom.getCurrentScale() : 1;
      this._pinchActive = true;

      if (this._pan) this._pan.setEnabled(false);

      if (this._zoom) {
        const focal = {
          x: (t0.clientX + t1.clientX) / 2,
          y: (t0.clientY + t1.clientY) / 2,
        };
        this._zoom.startGesture('pinch', this._localFocal(focal));
      }
      e.preventDefault();
      return;
    }

    if (e.touches.length === 1) {
      const t = e.touches[0];
      this._touchStartX = t.clientX;
      this._touchStartY = t.clientY;
      this._touchStartTime = Date.now();
    }
  }

  /**
   * @private
   * @param {TouchEvent} e
   */
  _onTouchMove(e) {
    if (e.touches.length === 2 && this._pinchActive) {
      const [t0, t1] = [e.touches[0], e.touches[1]];
      const dist = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
      if (this._pinchDistance > 0) {
        const ratio = dist / this._pinchDistance;
        const newScale = this._pinchScale * ratio;
        if (this._zoom) {
          const focal = {
            x: (t0.clientX + t1.clientX) / 2,
            y: (t0.clientY + t1.clientY) / 2,
          };
          this._zoom.updateGesture(newScale, this._localFocal(focal));
        }
      }
      e.preventDefault();
      this._emitActivity();
    }
  }

  /**
   * @private
   * @param {TouchEvent} e
   */
  _onTouchEnd(e) {
    this._emitActivity();

    // Pinch ended (fewer than 2 remaining touches).
    if (this._pinchActive && e.touches.length < 2) {
      this._pinchActive = false;
      this._pinchDistance = 0;
      // Poison the swipe timer so the remaining finger's touchend cannot be
      // mistaken for a fast single-finger swipe.
      this._touchStartTime = 0;
      if (this._pan) this._pan.setEnabled(true);
      if (this._zoom) this._zoom.endGesture();
      return;
    }

    // Single-finger tap or swipe end.
    if (e.changedTouches.length !== 1) return;
    if (e.touches.length > 0) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - this._touchStartX;
    const dy = t.clientY - this._touchStartY;
    const dt = Date.now() - this._touchStartTime;

    // Swipe (page mode only). Horizontal, fast, and unambiguous — the
    // vertical:horizontal ratio requirement prevents accidental swipes during
    // diagonal scrolls.
    if (
      dt > 0 &&
      dt < SWIPE_MAX_MS &&
      Math.abs(dx) > SWIPE_MIN_DX_PX &&
      Math.abs(dx) > 2 * Math.abs(dy) &&
      this._viewMode() === 'page'
    ) {
      const direction = dx > 0 ? 'left' : 'right';
      try {
        this._core.getBus().emit(Events.SWIPE, { direction });
      } catch { /* ignore */ }
      return;
    }

    // Single-tap and double-tap are handled by ui-internal.js as a
    // click-based sequence. We deliberately do nothing here so that a mobile
    // tap emits exactly one event (via the click handler) rather than two —
    // one from here and one from there.
  }

  // ── Wheel handler (web only) ──────────────────────────────────────────────

  /**
   * @private
   * @param {WheelEvent} e
   */
  _onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    // Ctrl/Meta wheel = zoom. Prevent browser page zoom.
    e.preventDefault();

    this._emitActivity();

    const zoom = this._zoom;
    if (!zoom) return;

    const current = zoom.isGestureActive() ? zoom.getTargetScale() : zoom.getCurrentScale();
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR);
    const newScale = clamp(current * factor, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);

    if (!zoom.isGestureActive()) {
      zoom.startGesture('wheel', this._localFocal({ x: e.clientX, y: e.clientY }));
    }
    zoom.updateGesture(newScale, this._localFocal({ x: e.clientX, y: e.clientY }));

    if (!this._wheelSettle) {
      this._wheelSettle = debounce(() => {
        this._wheelSettle = null;
        if (this._zoom && this._zoom.isGestureActive()) {
          this._zoom.endGesture();
        }
      }, CONFIG.ZOOM_SETTLE_DEBOUNCE_MS);
    }
    this._wheelSettle();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Convert client coordinates to viewer-main-local coordinates. viewer-main
   * is the stable reference frame — it has no transform applied during a
   * gesture, whereas the transform node (page-container) does, so measuring
   * against viewer-main gives consistent values frame over frame.
   *
   * The residual offset between viewer-main's rect and page-container's
   * layout position is bounded by the container's horizontal centering
   * distance and is not compensated — the visual drift is imperceptible
   * during a pinch.
   *
   * @private
   * @param {{x:number, y:number}} clientPoint
   * @returns {{x:number, y:number}}
   */
  _localFocal(clientPoint) {
    const els = getViewerElements();
    const root = els && els.main;
    if (!root) return { x: clientPoint.x, y: clientPoint.y };
    const rect = root.getBoundingClientRect();
    return {
      x: clientPoint.x - rect.left,
      y: clientPoint.y - rect.top,
    };
  }

  /**
   * @private
   */
  _emitActivity() {
    try { this._core.getBus().emit(Events.INTERACTION_ACTIVITY, {}); } catch { /* ignore */ }
  }

  /**
   * @private @returns {string}
   */
  _viewMode() {
    try { return this._core.getState().get('viewMode') || 'scroll'; } catch { return 'scroll'; }
  }
}

// ============================================================================
// 5. FACTORY
// ============================================================================

/**
 * Instantiate all four interaction managers, wire their cross-references, and
 * subscribe to the events that drive them.
 *
 * Pan enablement contract:
 *   Pan is enabled ONLY in page mode and for image documents. Scroll mode
 *   relies on #viewer-main's native `overflow: auto` for 360° scrolling in
 *   both axes — layering a transform-based pan on top would fight the native
 *   scroll handler and produce jitter.
 *
 *   `syncPanEnabled()` is the single source of truth for this decision. It
 *   runs once at construction and again on every view-mode change, layout
 *   change, and document-loaded event.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {{ scroll: ScrollManager, zoom: ZoomManager, pan: PanManager, gestures: GestureManager, teardown: () => void }}
 */
export function createInteractionLayer(core) {
  // Snapshot feature flags once.
  let rawFlags = {};
  try {
    const state = core.getState();
    rawFlags = (state && state.get('flags')) || {};
  } catch { /* ignore */ }

  const flags = Object.freeze({
    useVelocityThrottle: rawFlags.USE_VELOCITY_THROTTLE === true,
    useRenderPrefetch: rawFlags.USE_RENDER_PREFETCH === true,
    useTwoPhase: rawFlags.USE_TWO_PHASE_ZOOM === true,
    useRafPan: rawFlags.USE_RAF_PAN === true,
  });

  const scroll = new ScrollManager(core, flags);
  const zoom = new ZoomManager(core, flags);
  const pan = new PanManager(core, flags);
  const gestures = new GestureManager(core);

  // Attach scroll listener to #viewer-main.
  scroll.attach();

  // Determine initial pan/zoom targets.
  const els = getViewerElements();
  const main = els && els.main ? els.main : null;
  if (main) {
    pan.attach(main);
    gestures.attach(main, { zoomManager: zoom, panManager: pan, scrollManager: scroll });
  }

  // Set the initial transform-node (target of two-phase zoom).
  const pageContainer = main ? main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS) : null;
  zoom.attach(pageContainer || main);

  // Enable pan based on view mode / document kind.
  syncPanEnabled();

  /**
   * Enable pan only in page mode and for image documents. In scroll mode the
   * browser's native overflow:auto handles both axes — see the factory
   * doc-comment for the rationale.
   */
  function syncPanEnabled() {
    let viewMode = 'scroll';
    let documentKind = null;
    try {
      const s = core.getState();
      viewMode = s.get('viewMode') || 'scroll';
      documentKind = s.get('documentKind');
    } catch { /* ignore */ }

    const enabled = viewMode === 'page' || documentKind === 'image';
    pan.setEnabled(enabled);
    if (!enabled) pan.reset();
  }

  /**
   * @private
   * @returns {number}
   */
  function getEffectiveLimit() {
    try {
      if (typeof core.getEffectivePageLimit === 'function') {
        const limit = core.getEffectivePageLimit();
        if (typeof limit === 'number' && limit > 0) return limit;
      }
      return core.getState().get('numPages') || 1;
    } catch {
      return 1;
    }
  }

  /** @type {Array<() => void>} */
  const teardowns = [];

  const bus = core.getBus();

  // ── Page jump requests (from ui-internal, outline, search) ──────────────
  teardowns.push(bus.on(Events.PAGE_JUMP_REQUESTED, (payload) => {
    if (!payload || typeof payload.pageNum !== 'number') return;
    scroll.navigateTo(payload.pageNum, { smooth: true });
  }));

  // ── Scale requests (from ui-internal buttons/keyboard/double-tap) ───────
  teardowns.push(bus.on(Events.SCALE_REQUESTED, (payload) => {
    if (!payload || typeof payload.scale !== 'number') return;
    zoom.requestZoom(payload.scale, payload.source || 'external');
  }));

  // ── Layout changes (view mode toggle, document load) ────────────────────
  teardowns.push(bus.on(Events.LAYOUT_CHANGED, () => {
    // Re-attach pan/zoom to the current target after the DOM rebuilds.
    const currentEls = getViewerElements();
    const currentMain = currentEls && currentEls.main ? currentEls.main : null;
    if (currentMain) {
      pan.attach(currentMain);
      const pc = currentMain.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS);
      zoom.attach(pc || currentMain);
      if (!gestures._target) {
        gestures.attach(currentMain, { zoomManager: zoom, panManager: pan, scrollManager: scroll });
      }
    }
    scroll.markLayoutDirty();
    syncPanEnabled();
    // Defer recompute until next rAF (DOM has not been painted yet).
    Promise.resolve().then(() => {
      scroll.recomputeLayout();
      scroll.refreshVisible();
    });
  }));

  // ── Render complete (marks layout dirty, clears transform on match) ─────
  teardowns.push(bus.on(Events.RENDER_COMPLETE, (payload) => {
    if (!payload || payload.kind === 'thumbnail' || payload.kind === 'metadata') return;
    scroll.markLayoutDirty();

    // Clear the zoom transform once a page has been re-rendered at the
    // committed scale. Without this, the lingering CSS transform would
    // double-scale the fresh canvas.
    if (zoom.isGestureActive()) return;
    const committedScale = zoom.getCurrentScale();
    const renderedScale = typeof payload.scale === 'number' ? payload.scale : -1;
    if (Math.abs(renderedScale - committedScale) < 0.001) {
      zoom.clearTransform();
    }
  }));

  // ── View mode changed (state-level, catches toggles that bypass events) ─
  teardowns.push(core.getState().subscribe('viewMode', () => {
    syncPanEnabled();
    scroll.markLayoutDirty();
    Promise.resolve().then(() => scroll.recomputeLayout());
  }));

  // ── Swipe (page mode) advances/retreats pages ───────────────────────────
  // Preview mode: the new target is clamped at the effective limit, not at
  // numPages. This ensures a swipe on the last preview page is a no-op
  // instead of jumping to a locked page (which would then be re-clamped by
  // navigateTo — this is just an earlier guard that avoids the round-trip).
  teardowns.push(bus.on(Events.SWIPE, (payload) => {
    if (!payload || !payload.direction) return;
    const state = core.getState();
    const current = state.get('currentPage') || 1;
    const limit = getEffectiveLimit();
    const delta = payload.direction === 'left' ? 1 : -1;
    const target = clamp(current + delta, 1, limit);
    if (target === current) return;
    // Emit as a jump request so core handles the render orchestration.
    bus.emit(Events.PAGE_JUMP_REQUESTED, { pageNum: target, reason: 'swipe' });
  }));

  // ── Document destroyed → tear down managers ─────────────────────────────
  teardowns.push(bus.on(Events.DOCUMENT_DESTROYED, () => {
    try { scroll.detach(); } catch { /* ignore */ }
    try { scroll.recomputeLayout(); } catch { /* ignore */ }
    try { zoom.detach(); } catch { /* ignore */ }
    try { pan.reset(); } catch { /* ignore */ }
  }));

  // ── Document loaded → re-attach and refresh ─────────────────────────────
  teardowns.push(bus.on(Events.DOCUMENT_LOADED, () => {
    // Re-attach scroll because the viewer content area may be new.
    try {
      scroll.detach();
      scroll.attach();
    } catch { /* ignore */ }
    syncPanEnabled();
    Promise.resolve().then(() => {
      scroll.recomputeLayout();
      scroll.refreshVisible();
    });
  }));

  /**
   * Idempotent teardown. Removes all managers, subscriptions, and listeners.
   */
  function teardown() {
    for (const fn of teardowns.splice(0)) {
      try { fn(); } catch { /* ignore */ }
    }
    try { scroll.destroy(); } catch { /* ignore */ }
    try { zoom.destroy(); } catch { /* ignore */ }
    try { pan.destroy(); } catch { /* ignore */ }
    try { gestures.destroy(); } catch { /* ignore */ }
  }

  return { scroll, zoom, pan, gestures, teardown };
}