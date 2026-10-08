// frontend-user/scripts/viewer/interaction.js

/**
 * Universal Document Viewer — Interaction Layer
 * ============================================================================
 *
 * Sensory and motor layer of the viewer. Owns every user-input listener that
 * produces motion (scroll, pointer, wheel, touch, gesture recognition) and
 * every motion-timing decision.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * INVARIANTS ENFORCED BY THIS FILE (do not violate):
 *
 *   1. #viewer-main is a fixed window. It receives NATIVE SCROLL only. This
 *      file never transforms it, never attaches a gesture that moves it, and
 *      never measures it for anything except "what size is the viewport".
 *
 *   2. .page-container is the ONLY interactive element. Zoom (pinch/wheel)
 *      and the (now-retired) pan transform target ONLY .page-container. If
 *      it does not exist, zoom and pan are inert — no fallback to main.
 *
 *   3. Native scroll owns X and Y. PanManager is a no-op stub kept only for
 *      backward compatibility; it is never attached and never enabled.
 *
 *   4. On zoom settle: capture the page-point under the focal point in
 *      natural-page coordinates, clear the visual transform, let core.js
 *      resize every slot via its SCALE_APPLIED subscriber, then restore
 *      scrollLeft/scrollTop so the same page-point stays under the focal
 *      point. Slots are sized natural × displayScale by core; this file
 *      never writes slot dimensions.
 *
 *   5. Pinch and Ctrl+wheel are recognised ONLY when they originate inside
 *      .page-container (or its descendants). Touches on the background do
 *      nothing.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Boundary rule:
 *   • This is the ONLY file permitted to attach scroll / pointer / wheel /
 *     touch listeners.
 *   • Never touches the engine. Accesses subsystems exclusively via
 *     core.getScheduler(), core.getTileManager(), core.getRenderer(),
 *     core.getScroll(), core.getZoom(), core.getPan().
 *   • Never inserts canvases into the DOM (that is core's RENDER_COMPLETE
 *     subscriber). Never mutates caches.
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

const SWIPE_MAX_MS = 500;
const SWIPE_MIN_DX_PX = 40;
const WHEEL_ZOOM_FACTOR = 0.002;
const VELOCITY_EMA_WEIGHT = 0.3;
const ZOOM_PRERENDER_RADIUS = 5;
const PREFETCH_OPPOSITE_FRACTION = 0.5;

// ============================================================================
// 1. SCROLL MANAGER
// ============================================================================

/**
 * Owns the scroll listener on `#viewer-main`. Samples scroll velocity and
 * direction on every animation frame; drives scheduler pause/resume with
 * hysteresis; recomputes the visible-page set using largest-overlap;
 * enqueues directional prefetch; cancels stale work on direction change;
 * provides `navigateTo` for fast random access.
 *
 * Slots are found by `[data-page]` inside `.page-container`. Both covers and
 * rendered canvases carry that attribute, so this manager is agnostic to
 * whether a page has been rendered yet.
 */
export class ScrollManager {
  constructor(core, flags) {
    this._core = core;
    this._flags = flags;

    /** @type {HTMLElement|null} */ this._scrollRoot = null;
    /** @type {Array<{pageNum:number, slot:HTMLElement, top:number, height:number}>} */
    this._slotCache = [];
    /** @type {Set<number>} */ this._visibleSet = new Set();
    /** @type {number} */ this._visibleTopPage = 0;

    /** @type {number} */ this._lastScrollTop = 0;
    /** @type {number} */ this._lastTimestamp = 0;
    /** @type {number} */ this._velocity = 0;
    /** @type {number} */ this._direction = 0;
    /** @type {number} */ this._directionIdleFrames = 0;

    this._paused = false;
    this._layoutDirty = false;
    this._attached = false;

    this._onScrollThrottled = rafThrottle((_event, frameTimestamp) => {
      this._onScrollFrame(frameTimestamp);
    });
  }

  // ── Public ────────────────────────────────────────────────────────────────

  attach() {
    if (this._attached) return;
    const els = getViewerElements();
    if (!els || !els.main) return;
    this._scrollRoot = els.main;
    this._lastScrollTop = this._scrollRoot.scrollTop;
    this._scrollRoot.addEventListener('scroll', this._onScrollThrottled, { passive: true });
    this._attached = true;
    this.recomputeLayout();
  }

  detach() {
    if (!this._attached || !this._scrollRoot) return;
    try {
      this._scrollRoot.removeEventListener('scroll', this._onScrollThrottled);
    } catch { /* ignore */ }
    try { this._onScrollThrottled.cancel(); } catch { /* ignore */ }
    this._attached = false;
  }

  /**
   * Rebuild the slot-geometry cache. Queries `[data-page]` inside
   * `.page-container` so covers and canvases are treated identically.
   */
  recomputeLayout() {
    const els = getViewerElements();
    if (!els || !els.main) {
      this._slotCache = [];
      return;
    }
    const root = els.main;
    this._scrollRoot = root;
    const rootRect = root.getBoundingClientRect();
    const container = root.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS);
    if (!container) {
      this._slotCache = [];
      this._layoutDirty = false;
      return;
    }
    const slots = container.querySelectorAll('[data-page]');
    const cache = [];
    slots.forEach((slot) => {
      const pageNum = parseInt(slot.dataset.page, 10);
      if (!Number.isFinite(pageNum)) return;
      const r = slot.getBoundingClientRect();
      cache.push({
        pageNum,
        slot,
        top: r.top - rootRect.top + root.scrollTop,
        height: r.height,
      });
    });
    this._slotCache = cache;
    this._layoutDirty = false;
  }

  markLayoutDirty() {
    this._layoutDirty = true;
  }

  getVelocity() { return this._velocity; }

  getDirection() {
    return this._direction > 0 ? 1 : this._direction < 0 ? -1 : 0;
  }

  getVisiblePageNumbers() {
    return Array.from(this._visibleSet);
  }

  /**
   * Fast page navigation. Cancels pending work, updates state, scrolls the
   * target slot into view (scroll mode only), enqueues a P1 render, and
   * emits PAGE_VISIBLE.
   */
  navigateTo(pageNum, opts) {
    if (!Number.isFinite(pageNum)) return;
    const totalPages = this._getNumPages();
    const effectiveLimit = this._getEffectiveLimit();

    const clampedToTotal = clamp(pageNum, 1, Math.max(1, totalPages));
    const target = clampedToTotal > effectiveLimit ? effectiveLimit : clampedToTotal;

    try {
      const scheduler = this._core.getScheduler();
      if (scheduler && scheduler.cancelAll) {
        const p = scheduler.cancelAll();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      }
    } catch { /* ignore */ }

    const viewMode = this._getViewMode();
    if (viewMode === 'scroll') {
      if (this._layoutDirty) this.recomputeLayout();
      const entry = this._slotCache.find((w) => w.pageNum === target);
      if (entry && this._scrollRoot) {
        const smooth = !!(opts && opts.smooth);
        if (smooth) {
          try {
            entry.slot.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } catch {
            this._scrollRoot.scrollTop = entry.top;
          }
        } else {
          this._scrollRoot.scrollTop = entry.top;
        }
      }
    }

    try {
      const state = this._core.getState();
      state.set('currentPage', target);
      this._core.getBus().emit(Events.PAGE_VISIBLE, { pageNum: target, reason: 'navigation' });
    } catch { /* ignore */ }

    this._requestRender(target, PRIORITY.VISIBLE);
    this._emitActivity();
  }

  refreshVisible() {
    if (this._layoutDirty) this.recomputeLayout();
    this._updateVisiblePages();
    for (const pageNum of this._visibleSet) {
      this._requestRender(pageNum, PRIORITY.VISIBLE);
    }
  }

  destroy() {
    this.detach();
    this._slotCache = [];
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

  _onScrollFrame(frameTimestamp) {
    if (!this._scrollRoot) return;
    if (this._layoutDirty) this.recomputeLayout();

    const scrollTop = this._scrollRoot.scrollTop;
    const now = typeof frameTimestamp === 'number' ? frameTimestamp : performance.now();

    if (this._lastTimestamp === 0) {
      this._lastTimestamp = now;
      this._lastScrollTop = scrollTop;
      return;
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

    if (this._flags.useVelocityThrottle) {
      this._applyVelocityThrottle();
    }

    this._updateVisiblePages();

    if (this._flags.useRenderPrefetch && Math.abs(this._velocity) < CONFIG.VELOCITY_PREFETCH_MAX) {
      this._prefetchAdjacent();
    }

    try {
      this._core.getState().set('scrollVelocityPxPerFrame', this._velocity);
    } catch { /* ignore */ }

    this._emitActivity();

    try {
      this._core.getBus().emit(Events.SCROLL_VELOCITY, {
        velocity: this._velocity,
        direction: this.getDirection(),
      });
    } catch { /* ignore */ }
  }

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

  _updateVisiblePages() {
    if (!this._scrollRoot || this._slotCache.length === 0) return;

    const st = this._scrollRoot.scrollTop;
    const vh = this._scrollRoot.clientHeight;
    if (vh <= 0) return;

    const visible = [];
    let topPage = 0;
    let maxArea = 0;

    for (const entry of this._slotCache) {
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

    visible.sort((a, b) => b.area - a.area);

    const newSet = new Set(visible.map((v) => v.pageNum));
    const previousSet = this._visibleSet;
    this._visibleSet = newSet;

    for (const pageNum of newSet) {
      if (!previousSet.has(pageNum)) {
        this._requestRender(pageNum, PRIORITY.VISIBLE);
      }
    }

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

  _cancelDirectionalWork() {
    const scheduler = this._core.getScheduler();
    if (!scheduler || !scheduler.cancelBelow) return;
    try { scheduler.cancelBelow(PRIORITY.ADJACENT); } catch { /* ignore */ }
  }

  _prefetchAdjacent() {
    if (!this._scrollRoot) return;

    const limit = this._getEffectiveLimit();
    if (limit <= 1) return;

    const current = this._getCurrentPage();
    if (!Number.isFinite(current)) return;

    const dir = this._direction > 0 ? 1 : this._direction < 0 ? -1 : 0;
    if (dir === 0) return;

    const absV = Math.abs(this._velocity);
    const activeDepth = absV > CONFIG.VELOCITY_SUSPEND_PX_PER_FRAME / 2
      ? CONFIG.PREFETCH_DEPTH_FAST
      : CONFIG.PREFETCH_DEPTH_SLOW;

    for (let offset = 1; offset <= activeDepth; offset++) {
      const pageNum = current + dir * offset;
      if (pageNum < 1 || pageNum > limit) continue;
      this._requestRender(pageNum, PRIORITY.ADJACENT);
    }

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

  _requestRender(pageNum, priority) {
    if (!Number.isFinite(pageNum)) return;
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

  _emitActivity() {
    try { this._core.getBus().emit(Events.INTERACTION_ACTIVITY, {}); } catch { /* ignore */ }
  }

  _getNumPages() {
    try { return this._core.getState().get('numPages') || 1; } catch { return 1; }
  }

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

  _getViewMode() {
    try { return this._core.getState().get('viewMode') || 'scroll'; } catch { return 'scroll'; }
  }

  _getCurrentPage() {
    try { return this._core.getState().get('currentPage') || 1; } catch { return 1; }
  }
}

// ============================================================================
// 2. ZOOM MANAGER
// ============================================================================

/**
 * Two-phase zoom targeting .page-container only.
 *
 * Phase A — gesture active: apply a CSS transform to .page-container via the
 * GPU compositor. The transform is `translate(tx, ty) scale(ratio)` where
 * `ratio = targetScale / gestureStartScale` and `tx, ty` keep the focal
 * point anchored. One rAF-batched write per frame; no re-render; no state
 * change.
 *
 * Phase B — gesture end + settle: capture the page-point under the focal
 * point in natural-page coordinates, clear the transform, emit
 * SCALE_APPLIED (core resizes slots to natural × newScale), then on next
 * frame adjust scrollLeft/scrollTop so the same page-point stays under the
 * focal point. Finally enqueue re-raster for visible pages plus the
 * surrounding 5-page window.
 *
 * If .page-container does not exist, attach(null) makes the manager inert.
 * There is no fallback to #viewer-main.
 */
export class ZoomManager {
  constructor(core, flags) {
    this._core = core;
    this._flags = flags;

    /** @type {HTMLElement|null} */ this._transformNode = null;
    /** @type {number} */ this._currentScale = 1;
    /** @type {number} */ this._targetScale = 1;
    /** @type {number} */ this._gestureStartScale = 1;

    this._gestureActive = false;
    /** @type {string|null} */ this._gestureSource = null;
    /** @type {{x:number, y:number}} */ this._origin = { x: 0, y: 0 };

    // Focal in client (viewport) coords — captured at gesture start and
    // preserved across settle.
    /** @type {number} */ this._focalClientX = 0;
    /** @type {number} */ this._focalClientY = 0;

    // The transform node's untransformed layout origin, captured once at
    // gesture start. Its client position is stable during a pinch because
    // neither the container's layout size nor the viewer's scroll changes
    // while two fingers are down.
    /** @type {{x:number, y:number}|null} */ this._gestureLayoutOrigin = null;

    /** @type {ReturnType<typeof debounce>|null} */ this._settleTimer = null;
    /** @type {ReturnType<typeof debounce>|null} */ this._legacyCommitTimer = null;
    this._rafScheduled = false;
    /** @type {number|null} */ this._rafId = null;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Attach the transform node. Pass null to make the manager inert (no
   * fallback to #viewer-main).
   */
  attach(node) {
    if (this._transformNode === (node || null)) return;
    // Detach any in-flight gesture from the previous node.
    this._cancelSettle();
    this._gestureActive = false;
    this._transformNode = node || null;
    this._gestureLayoutOrigin = null;
  }

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
    this._gestureLayoutOrigin = null;
  }

  /**
   * Non-gesture zoom (button, keyboard, double-tap, fit, reset).
   * Behaves as an instantaneous gesture start+end, anchored on the
   * viewport center.
   */
  requestZoom(scale, source) {
    const clamped = clamp(scale, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
    this._targetScale = clamped;
    this._gestureSource = (source || 'button');

    if (this._gestureActive) {
      this._scheduleTransformWrite();
      return;
    }

    if (!this._flags.useTwoPhase) {
      this._commitScale(clamped);
      return;
    }

    // Treat as a synthetic gesture whose focal is the viewport center.
    this._beginSyntheticGesture('center');
    this._scheduleTransformWrite();
    this._startSettle();
  }

  /**
   * Adopt a scale without a gesture, without a transform write, and without
   * re-rendering. Used by core.js for the initial fit-to-width.
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
    this._gestureStartScale = clamped;
  }

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
   * Begin a continuous gesture.
   *
   * @param {string} source
   * @param {{x:number, y:number}} [focal] — in CLIENT coords.
   */
  startGesture(source, focal) {
    if (!this._transformNode) return;

    this._cancelSettle();

    this._gestureActive = true;
    this._gestureSource = source || 'pinch';
    this._gestureStartScale = this._currentScale;
    this._targetScale = this._currentScale;

    // Capture focal in client coords.
    if (focal && typeof focal.x === 'number' && typeof focal.y === 'number') {
      this._focalClientX = focal.x;
      this._focalClientY = focal.y;
    } else {
      const els = getViewerElements();
      const rect = els && els.main ? els.main.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
      this._focalClientX = rect.left + (rect.width || 0) / 2;
      this._focalClientY = rect.top + (rect.height || 0) / 2;
    }

    // Cache the transform node's untransformed layout origin in client
    // coords, so per-frame writes don't force a synchronous reflow.
    const node = this._transformNode;
    const prev = node.style.transform;
    node.style.transform = '';
    const r = node.getBoundingClientRect();
    node.style.transform = prev;
    this._gestureLayoutOrigin = { x: r.left, y: r.top };

    try {
      this._core.getState().set('isZoomGestureActive', true);
      this._core.getBus().emit(Events.ZOOM_GESTURE_START, { source: this._gestureSource });
    } catch { /* ignore */ }
  }

  /**
   * Continuous update during a gesture.
   *
   * @param {number} scale — absolute target scale.
   * @param {{x:number, y:number}} [focal] — in CLIENT coords.
   */
  updateGesture(scale, focal) {
    if (!this._gestureActive) return;
    const clamped = clamp(scale, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
    this._targetScale = clamped;

    if (focal && typeof focal.x === 'number' && typeof focal.y === 'number') {
      this._focalClientX = focal.x;
      this._focalClientY = focal.y;
    }

    if (this._flags.useTwoPhase) {
      this._scheduleTransformWrite();
    } else {
      this._scheduleLegacyCommit();
    }
  }

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

  getCurrentScale() { return this._currentScale; }
  getTargetScale() { return this._targetScale; }
  isGestureActive() { return this._gestureActive; }

  applyDprChange(_newDpr) {
    if (this._gestureActive) return;
    this._commitScale(this._currentScale, { force: true });
  }

  clearTransform() {
    if (this._gestureActive) return;
    if (!this._transformNode) return;
    try { this._transformNode.style.transform = ''; } catch { /* ignore */ }
  }

  destroy() {
    this.detach();
    this._currentScale = 1;
    this._targetScale = 1;
    this._gestureStartScale = 1;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _beginSyntheticGesture(_source) {
    const els = getViewerElements();
    const main = els && els.main;
    const rect = main ? main.getBoundingClientRect()
      : { left: 0, top: 0, width: 0, height: 0 };

    this._gestureStartScale = this._currentScale;
    this._focalClientX = rect.left + (rect.width || 0) / 2;
    this._focalClientY = rect.top + (rect.height || 0) / 2;
    this._gestureActive = true;

    const node = this._transformNode;
    if (node) {
      const prev = node.style.transform;
      node.style.transform = '';
      const r = node.getBoundingClientRect();
      node.style.transform = prev;
      this._gestureLayoutOrigin = { x: r.left, y: r.top };
    } else {
      this._gestureLayoutOrigin = null;
    }
  }

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

  _writeTransformNow() {
    if (!this._transformNode) return;

    const target = this._targetScale;
    const baseline = this._gestureStartScale || this._currentScale || 1;
    const ratio = target / baseline;

    let ox = this._focalClientX;
    let oy = this._focalClientY;
    if (this._gestureLayoutOrigin) {
      ox = this._focalClientX - this._gestureLayoutOrigin.x;
      oy = this._focalClientY - this._gestureLayoutOrigin.y;
    }

    const tx = -ox * (ratio - 1);
    const ty = -oy * (ratio - 1);

    try {
      this._transformNode.style.transform =
        `translate3d(${tx}px, ${ty}px, 0) scale(${ratio})`;
      this._transformNode.style.transformOrigin = '0 0';
    } catch { /* ignore */ }
  }

  _startSettle() {
    if (!this._settleTimer) {
      this._settleTimer = debounce(() => {
        this._settleTimer = null;
        this._onSettle();
      }, CONFIG.ZOOM_SETTLE_DEBOUNCE_MS);
    }
    this._settleTimer();
  }

  _cancelSettle() {
    if (this._settleTimer) {
      try { this._settleTimer.cancel(); } catch { /* ignore */ }
      this._settleTimer = null;
    }
  }

  _scheduleLegacyCommit() {
    if (!this._legacyCommitTimer) {
      this._legacyCommitTimer = debounce(() => {
        this._legacyCommitTimer = null;
        this._commitScale(this._targetScale);
      }, CONFIG.ZOOM_SETTLE_DEBOUNCE_MS);
    }
    this._legacyCommitTimer();
  }

  _flushLegacyCommit() {
    if (this._legacyCommitTimer) {
      try { this._legacyCommitTimer.cancel(); } catch { /* ignore */ }
      this._legacyCommitTimer = null;
    }
    this._commitScale(this._targetScale);
  }

  _onSettle() {
    this._commitScale(this._targetScale);
  }

  /**
   * Commit a final scale.
   *
   * Steps:
   *   1. Capture the page-point under the focal point in natural-page coords.
   *   2. Clear the visual transform.
   *   3. Emit SCALE_APPLIED — core.js resizes every slot to natural × scale.
   *   4. On next frame, adjust scroll so the same page-point stays under the
   *      focal point.
   *   5. Enqueue re-raster for the visible ring + the surrounding window.
   */
  _commitScale(scale, opts) {
    const clamped = clamp(scale, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
    const previousScale = this._currentScale;
    const force = !!(opts && opts.force);

    if (!force && clamped === previousScale) {
      if (this._transformNode) {
        try { this._transformNode.style.transform = ''; } catch { /* ignore */ }
      }
      this._gestureActive = false;
      this._gestureLayoutOrigin = null;
      return;
    }

    const els = getViewerElements();
    const main = els && els.main;
    const node = this._transformNode;
    let restore = null;

    if (main && node && this._gestureActive) {
      // Where the focal point currently sits, and what page-point (in
      // natural-page coordinates) is under it.
      const rect = node.getBoundingClientRect();
      const pxNat = (this._focalClientX - rect.left) / clamped;
      const pyNat = (this._focalClientY - rect.top) / clamped;
      restore = {
        pxNat,
        pyNat,
        focalClientX: this._focalClientX,
        focalClientY: this._focalClientY,
      };
    }

    this._currentScale = clamped;
    this._targetScale = clamped;
    this._gestureStartScale = clamped;
    this._gestureActive = false;

    // Clear the visual transform. Slots are still at the OLD size — core's
    // SCALE_APPLIED subscriber is about to resize them.
    if (node) {
      try { node.style.transform = ''; } catch { /* ignore */ }
    }

    try {
      const tm = this._core.getTileManager();
      if (tm && tm.invalidateAll) tm.invalidateAll();
    } catch { /* ignore */ }

    try {
      this._core.getState().set('scale', clamped);
    } catch { /* ignore */ }

    try {
      this._core.getBus().emit(Events.SCALE_APPLIED, {
        scale: clamped,
        source: this._gestureSource || 'unknown',
      });
    } catch { /* ignore */ }

    // After core resizes slots, adjust scroll so the focal point is preserved.
    if (restore && main && node) {
      requestAnimationFrame(() => {
        try {
          const newRect = node.getBoundingClientRect();
          const targetX = newRect.left + restore.pxNat * clamped;
          const targetY = newRect.top + restore.pyNat * clamped;
          main.scrollLeft += targetX - restore.focalClientX;
          main.scrollTop += targetY - restore.focalClientY;
        } catch { /* ignore */ }
      });
    }

    this._gestureLayoutOrigin = null;

    this._enqueueVisibleRenders(clamped);
  }

  _enqueueVisibleRenders(scale) {
    const scroll = this._core.getScroll();
    const scheduler = this._core.getScheduler();
    if (!scheduler || !scheduler.enqueue) return;

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

    const pages = scroll && scroll.getVisiblePageNumbers
      ? scroll.getVisiblePageNumbers()
      : [];

    const fallback = this._getCurrentPage();
    const visibleList = pages.length > 0 ? pages : [fallback];

    const enqueued = new Set();

    for (const pageNum of visibleList) {
      if (pageNum > limit) continue;
      if (enqueued.has(pageNum)) continue;
      enqueued.add(pageNum);
      this._enqueuePage(scheduler, pageNum, scale, rotation, PRIORITY.VISIBLE);
    }

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

  _enqueuePage(scheduler, pageNum, scale, rotation, priority) {
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

  _getCurrentPage() {
    try { return this._core.getState().get('currentPage') || 1; } catch { return 1; }
  }
}

// ============================================================================
// 3. PAN MANAGER — RETIRED STUB
// ============================================================================

/**
 * Pan is dead. Native scroll on #viewer-main owns both axes. This class is
 * retained only so the factory's return signature and any external callers
 * keep working. Every method is a no-op.
 */
export class PanManager {
  constructor() { /* no-op */ }
  attach(_target) { /* no-op */ }
  detach() { /* no-op */ }
  setEnabled(_enabled) { /* no-op */ }
  reset() { /* no-op */ }
  getOffset() { return { x: 0, y: 0 }; }
  destroy() { /* no-op */ }
}

// ============================================================================
// 4. GESTURE MANAGER
// ============================================================================

/**
 * Recognises pinch and swipe from raw touch events, and Ctrl/Meta wheel on
 * desktop. Attaches ONLY to .page-container (or null). Every event carries
 * the focal point in CLIENT coords so ZoomManager doesn't need to re-derive
 * it.
 *
 * Single-tap and double-tap live in ui-internal.js as a click-based
 * sequence — this file never synthesises those.
 */
export class GestureManager {
  constructor(core) {
    this._core = core;
    /** @type {HTMLElement|null} */ this._target = null;
    /** @type {ZoomManager|null} */ this._zoom = null;
    /** @type {PanManager|null} */ this._pan = null;
    /** @type {ScrollManager|null} */ this._scroll = null;

    this._pinchDistance = 0;
    this._pinchScale = 1;
    this._pinchActive = false;

    this._touchStartX = 0;
    this._touchStartY = 0;
    this._touchStartTime = 0;

    /** @type {ReturnType<typeof debounce>|null} */ this._wheelSettle = null;

    this._onTouchStartBound = this._onTouchStart.bind(this);
    this._onTouchMoveBound = this._onTouchMove.bind(this);
    this._onTouchEndBound = this._onTouchEnd.bind(this);
    this._onWheelBound = this._onWheel.bind(this);
  }

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

    if (isWeb()) {
      this._target.addEventListener('wheel', this._onWheelBound, { passive: false });
    }
  }

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

  destroy() {
    this.detach();
    this._zoom = null;
    this._pan = null;
    this._scroll = null;
  }

  // ── Touch handlers ────────────────────────────────────────────────────────

  _onTouchStart(e) {
    this._emitActivity();

    if (e.touches.length === 2) {
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
        this._zoom.startGesture('pinch', focal);
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
          this._zoom.updateGesture(newScale, focal);
        }
      }
      e.preventDefault();
      this._emitActivity();
    }
  }

  _onTouchEnd(e) {
    this._emitActivity();

    if (this._pinchActive && e.touches.length < 2) {
      this._pinchActive = false;
      this._pinchDistance = 0;
      this._touchStartTime = 0;
      if (this._pan) this._pan.setEnabled(false);
      if (this._zoom) this._zoom.endGesture();
      return;
    }

    if (e.changedTouches.length !== 1) return;
    if (e.touches.length > 0) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - this._touchStartX;
    const dy = t.clientY - this._touchStartY;
    const dt = Date.now() - this._touchStartTime;

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
    }
  }

  // ── Wheel handler (web only) ──────────────────────────────────────────────

  _onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();

    this._emitActivity();

    const zoom = this._zoom;
    if (!zoom) return;

    const current = zoom.isGestureActive() ? zoom.getTargetScale() : zoom.getCurrentScale();
    const factor = Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR);
    const newScale = clamp(current * factor, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
    const focal = { x: e.clientX, y: e.clientY };

    if (!zoom.isGestureActive()) {
      zoom.startGesture('wheel', focal);
    }
    zoom.updateGesture(newScale, focal);

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

  _emitActivity() {
    try { this._core.getBus().emit(Events.INTERACTION_ACTIVITY, {}); } catch { /* ignore */ }
  }

  _viewMode() {
    try { return this._core.getState().get('viewMode') || 'scroll'; } catch { return 'scroll'; }
  }
}

// ============================================================================
// 5. FACTORY
// ============================================================================

/**
 * Instantiate the interaction managers, wire their cross-references, and
 * subscribe to the events that drive them.
 *
 * Attach contract:
 *   • scroll.attach()           → #viewer-main (the fixed window; scroll is native)
 *   • zoom.attach(pageContainer) → the ONLY transform target; null if absent
 *   • gestures.attach(pageContainer) → the ONLY gesture target; null if absent
 *   • pan                        → dead stub; never attached, never enabled
 *
 * Re-attachment:
 *   • LAYOUT_CHANGED — after core rebuilds the DOM, re-attach zoom/gestures
 *     to the fresh .page-container.
 *   • DOCUMENT_LOADED — belt-and-braces re-attach.
 */
export function createInteractionLayer(core) {
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
  const pan = new PanManager();  // stub
  const gestures = new GestureManager(core);

  scroll.attach();

  const els = getViewerElements();
  const main = els && els.main ? els.main : null;

  // Zoom and gestures target ONLY .page-container. No fallback to main.
  const initialContainer = main ? main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS) : null;
  zoom.attach(initialContainer);
  gestures.attach(initialContainer, {
    zoomManager: zoom,
    panManager: pan,
    scrollManager: scroll,
  });

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

  // ── Layout changes — re-attach zoom/gestures to the fresh container ────
  teardowns.push(bus.on(Events.LAYOUT_CHANGED, () => {
    const currentEls = getViewerElements();
    const currentMain = currentEls && currentEls.main ? currentEls.main : null;
    if (currentMain) {
      const pc = currentMain.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS);
      zoom.attach(pc);
      gestures.attach(pc, {
        zoomManager: zoom,
        panManager: pan,
        scrollManager: scroll,
      });
    } else {
      zoom.attach(null);
      gestures.attach(null, {});
    }
    scroll.markLayoutDirty();
    Promise.resolve().then(() => {
      scroll.recomputeLayout();
      scroll.refreshVisible();
    });
  }));

  // ── Render complete — mark layout dirty; clear stale transform on match ─
  teardowns.push(bus.on(Events.RENDER_COMPLETE, (payload) => {
    if (!payload || payload.kind === 'thumbnail' || payload.kind === 'metadata') return;
    scroll.markLayoutDirty();

    if (zoom.isGestureActive()) return;
    const committedScale = zoom.getCurrentScale();
    const renderedScale = typeof payload.scale === 'number' ? payload.scale : -1;
    if (Math.abs(renderedScale - committedScale) < 0.001) {
      zoom.clearTransform();
    }
  }));

  // ── View-mode changed ──────────────────────────────────────────────────
  teardowns.push(core.getState().subscribe('viewMode', () => {
    scroll.markLayoutDirty();
    Promise.resolve().then(() => scroll.recomputeLayout());
  }));

  // ── Swipe (page mode) advances/retreats pages ──────────────────────────
  teardowns.push(bus.on(Events.SWIPE, (payload) => {
    if (!payload || !payload.direction) return;
    const state = core.getState();
    const current = state.get('currentPage') || 1;
    const limit = (() => {
      try {
        if (typeof core.getEffectivePageLimit === 'function') {
          const l = core.getEffectivePageLimit();
          if (typeof l === 'number' && l > 0) return l;
        }
        return state.get('numPages') || 1;
      } catch { return 1; }
    })();
    const delta = payload.direction === 'left' ? 1 : -1;
    const target = clamp(current + delta, 1, limit);
    if (target === current) return;
    bus.emit(Events.PAGE_JUMP_REQUESTED, { pageNum: target, reason: 'swipe' });
  }));

  // ── Document destroyed — tear down gestures/zoom ────────────────────────
  teardowns.push(bus.on(Events.DOCUMENT_DESTROYED, () => {
    try { scroll.detach(); } catch { /* ignore */ }
    try { scroll.recomputeLayout(); } catch { /* ignore */ }
    try { zoom.detach(); } catch { /* ignore */ }
    try { gestures.detach(); } catch { /* ignore */ }
  }));

  // ── Document loaded — re-attach scroll and re-evaluate the container ────
  teardowns.push(bus.on(Events.DOCUMENT_LOADED, () => {
    try {
      scroll.detach();
      scroll.attach();
    } catch { /* ignore */ }

    const currentEls = getViewerElements();
    const currentMain = currentEls && currentEls.main ? currentEls.main : null;
    if (currentMain) {
      const pc = currentMain.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS);
      zoom.attach(pc);
      gestures.attach(pc, {
        zoomManager: zoom,
        panManager: pan,
        scrollManager: scroll,
      });
    }

    Promise.resolve().then(() => {
      scroll.recomputeLayout();
      scroll.refreshVisible();
    });
  }));

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