// frontend-user/scripts/viewer/core.js

/**
 * Universal Document Viewer — Core
 * ============================================================================
 *
 * Root orchestrator and single source of truth for the viewer subsystem.
 * Owns:
 *   • CONFIG       — frozen constants + feature flags + device-tuned thresholds
 *   • MIME_TYPES   — re-exported from utils.js (single source of truth lives there)
 *   • PRIORITY     — frozen task priority bands
 *   • Events       — frozen event-name constants
 *   • EventBus     — synchronous pub/sub, reentrancy-safe
 *   • ViewerState  — observable state container with change events
 *   • ViewerCore   — lifecycle, document loading, subsystem orchestration
 *   • createCore() — singleton factory
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * INVARIANTS (do not violate — see project spec):
 *
 *   1. #viewer-main is a fixed window. It paints the background colour and
 *      owns the native scroll box. It is NEVER transformed, NEVER a gesture
 *      target, NEVER measured for anything except viewport size.
 *
 *   2. .page-container is the ONLY interactive element. It receives the
 *      zoom/pan transform during a pinch. It is the sole child of #viewer-main
 *      that participates in the document.
 *
 *   3. Every page slot is either:
 *        <canvas class="page" data-page="n" data-res="r">   (rendered)
 *        <div    class="cover" data-page="n">                (placeholder)
 *      Both are sized inline to natural × displayScale. No wrapper.
 *      Sharp corners. White background. The canvas IS the page.
 *
 *   4. Every slot in every ring is sized natural × displayScale. Resolution
 *      changes the bitmap inside a canvas — never the slot's size. Cover →
 *      canvas swaps are a paint event, not a layout event.
 *
 *   5. X-axis lock: when the page fits horizontally, #viewer-main is
 *      overflow-x: hidden (page centered by margin auto). When the page is
 *      wider than the viewport, core flips the .x-scroll class on so the
 *      browser gives a native X scrollbar. Native scroll owns both axes.
 *
 *   6. The resolution pyramid SLIDES with the current page. Five pages
 *      change ring per single-page step; all five upgrades are enqueued in
 *      the same tick. See _applyPyramidWindow().
 *
 *   7. Velocity drives three render modes:
 *        paper  (|v| ≥ 100 px/frame) — covers only, nothing renders
 *        glance (30 ≤ |v| < 100)     — centre page at 100% (the page the
 *                                       user is reading stays sharp);
 *                                       periphery inside ±4 at 20%;
 *                                       beyond ±8 released to cover
 *        idle   (|v| < 30)           — full pyramid
 *      The mode is set by the SCROLL_VELOCITY subscriber from the smoothed
 *      velocity ScrollManager emits, and reset to idle by the 150 ms quiet
 *      tick ScrollManager also emits.
 *
 *   8. Images open fit-to-width, aspect ratio preserved. The slot's
 *      display size is naturalW × fitScale by naturalH × fitScale, and
 *      `object-fit: contain` fills that slot exactly — no cropping, no
 *      distortion. The fit-width observer does not override the initial
 *      fit for images (there is no page-1 metadata to consult); pinch and
 *      the "Fit to width" menu action re-fit on demand.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Preview-mode support:
 *   Two policies, selected by the document's total page count:
 *
 *     • numPages >= CONFIG.PREVIEW_MIN_PAGES_FOR_FRACTIONAL
 *         Render the first floor(numPages × PREVIEW_PAGE_FRACTION) pages
 *         and append a subscribe CTA after the last preview page.
 *
 *     • numPages < CONFIG.PREVIEW_MIN_PAGES_FOR_FRACTIONAL
 *         Block the entire document. Nothing renders. A page-shaped
 *         placeholder with a centered subscribe banner replaces the
 *         first page.
 *
 * Android / Capacitor posture:
 *   `_doInit` calls `setupNativeBridge(this)`, which wires the Android back
 *   button, immersive-mode status bar, keep-awake, and file intents through
 *   `native-bridge.js`. Every native call has a web fallback.
 *
 * Destroy semantics:
 *   `destroy()` runs on every document switch AND on explicit viewer close.
 *   Clears the viewer DOM via `clearViewerContent()`. The four static chrome
 *   nodes (#viewer-loading, #viewer-progress, #viewer-content,
 *   #viewer-text-layer) survive the clear.
 *
 * @module viewer/core
 */

'use strict';

// ============================================================================
// IMPORTS
// ============================================================================

import {
  MIME_TYPES,
  ensureMimeType,
  escapeHtml,
  clamp,
  getViewerElements,
  createObjectURL,
  revokeAllObjectURLs,
} from './utils.js';

import { getDeviceProfile } from './platform.js';
import { setupNativeBridge } from './native-bridge.js';

import { createEngine } from './engine.js';
import { createRenderPipeline } from './render.js';
import { createInteractionLayer } from './interaction.js';
import { createManagers } from './managers.js';
import { createWorkers } from './workers.js';

import {
  injectViewerStyles,
  refreshElementCache,
  setupControls,
  setupAutoHideListeners,
  setupDPRListener,
  setupFitWidthObserver,
  bindCoreEvents,
  teardownControls,
  mountChrome,
  unmountChrome,
  clearViewerContent,
} from './ui-internal.js';

export { MIME_TYPES };

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const key of Object.getOwnPropertyNames(obj)) {
    const value = /** @type {any} */ (obj)[key];
    if (value && typeof value === 'object') deepFreeze(value);
  }
  return obj;
}

// ============================================================================
// 1. CONFIG
// ============================================================================

/**
 * All viewer constants, thresholds, feature flags, and DOM class contracts.
 * Deep-frozen.
 *
 * @readonly
 */
export const CONFIG = deepFreeze({
  // ── Zoom ──────────────────────────────────────────────────────────────────
  ZOOM_STEP: 0.25,
  MIN_ZOOM: 0.25,
  MAX_ZOOM: 5.0,
  ZOOM_SETTLE_DEBOUNCE_MS: 120,

  // ── Tap sequences ─────────────────────────────────────────────────────────
  TAP_SEQUENCE_GAP_MS: 350,
  DOUBLE_SETTLE_MS: 250,
  MAGNIFY_FACTOR: 2.0,

  // ── Preview mode ──────────────────────────────────────────────────────────
  PREVIEW_PAGE_FRACTION: 0.10,
  PREVIEW_MIN_PAGES_FOR_FRACTIONAL: 10,

  // ── Search ────────────────────────────────────────────────────────────────
  SEARCH_DEBOUNCE_MS: 300,

  // ── Scroll / layout ───────────────────────────────────────────────────────
  LAZY_LOAD_MARGIN_PX: 200,
  SCROLL_DEBOUNCE_MS: 50,

  // ── Auto-hide chrome ──────────────────────────────────────────────────────
  AUTO_HIDE_DELAY_MS: 3000,

  // ── Tiling ────────────────────────────────────────────────────────────────
  TILE_SIZE_PX: 512,
  HYBRID_CANVAS_THRESHOLD_PX: 2000,
  TILE_PYRAMID_SCALES: [0.5, 1, 2, 4],
  THUMBNAIL_SCALE: 0.1,

  // ── Memory ────────────────────────────────────────────────────────────────
  // Tiered caps chosen from navigator.deviceMemory (approximate hardware RAM
  // in GB, bucketed to powers of two). The values are raw canvas bytes; the
  // real browser RSS footprint is 2.5–4× this due to GPU compositor backing,
  // decoded image bitmaps, and PDF.js worker state.
  MEMORY_CAP_LOW_MEMORY_MB: 40,     // ≤2 GB devices
  MEMORY_CAP_MOBILE_MB: 80,         // 4 GB devices
  MEMORY_CAP_HIGH_MOBILE_MB: 150,   // ≥8 GB mobile
  MEMORY_CAP_DESKTOP_MB: 250,       // desktop
  // Legacy aliases retained so older callers don't break.
  MEMORY_CAP_MOBILE_MB_LEGACY: 80,
  MEMORY_CAP_DESKTOP_MB_LEGACY: 200,

  // ── Device pixel ratio ────────────────────────────────────────────────────
  MAX_DPR: 2,
  MAX_DPR_MOBILE: 1.5,
  MAX_DPR_LOW_MEMORY: 1.25,
  MAX_DPR_VERY_LOW_MEMORY: 1.0,

  // ── Velocity thresholds ───────────────────────────────────────────────────
  VELOCITY_SUSPEND_PX_PER_FRAME: 40,
  VELOCITY_PREFETCH_MAX: 500,
  PREFETCH_DEPTH_SLOW: 5,
  PREFETCH_DEPTH_FAST: 2,

  // Velocity → render-mode bands. See _velocityState().
  VELOCITY_GLANCE_MIN: 30,   // above this, low-res placeholder mode
  VELOCITY_PAPER_MIN: 100,   // above this, covers only

  // ── Render concurrency ────────────────────────────────────────────────────
  RENDER_CONCURRENCY: (() => {
    try {
      const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
      return Math.max(1, Math.min(6, hc - 1));
    } catch {
      return 3;
    }
  })(),

  // ── Worker pool sizes ─────────────────────────────────────────────────────
  SEARCH_WORKER_MAX: 1,
  PARSER_WORKER_MAX: 1,
  WORKER_READY_TIMEOUT_MS: 5000,
  WORKER_REQUEST_TIMEOUT_MS: 30000,

  // ── PDF.js bootstrap ──────────────────────────────────────────────────────
  PDFJS_WORKER_SRC:
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js',

  WORKER_PATHS: {
    search: './viewer/search.worker.js',
    parser: './viewer/parser.worker.js',
  },

  // ── PDF load limits ───────────────────────────────────────────────────────
  MAX_PDF_BYTES_DESKTOP: 500 * 1024 * 1024,
  MAX_PDF_BYTES_MOBILE: 200 * 1024 * 1024,
  MAX_PDF_BYTES_LOW_MEMORY: 100 * 1024 * 1024,
  PDF_LOAD_TIMEOUT_DESKTOP_MS: 60000,
  PDF_LOAD_TIMEOUT_MOBILE_MS: 30000,

  // ── DOM contracts ─────────────────────────────────────────────────────────
  PAGE_CONTAINER_CLASS: 'page-container',   // the sole interactive element
  PAGE_CLASS: 'page',                       // the canvas that IS the page
  COVER_CLASS: 'cover',                     // the placeholder that becomes one
  SEARCH_LAYER_CLASS: 'search-layer',
  SEARCH_HIGHLIGHT_CLASS: 'search-highlight active',
  X_SCROLL_CLASS: 'x-scroll',               // toggled on #viewer-main
  VIEW_MODE_STORAGE_KEY: 'viewer-viewMode',

  // ── Fit-to-width layout ───────────────────────────────────────────────────
  FIT_WIDTH_H_PADDING_PX: 32,
  FIT_WIDTH_WAIT_TIMEOUT_MS: 2000,

  // ── Metadata prefetch ─────────────────────────────────────────────────────
  EAGER_METADATA_PAGES: 20,

  // ── Pyramid window geometry ───────────────────────────────────────────────
  // Forward rings (distance from current page):
  //   d=0..5   → 100%
  //   d=6..9   →  80%
  //   d=10..12 →  60%
  //   d=13..14 →  40%
  //   d=15     →  20%
  //   d≥16     → cover (0%)
  // Behind rings:
  //   d=-1     → 100%
  //   d=-2..-3 →  40%
  //   d≤-4     → cover (0%)
  PYRAMID_MAX_AHEAD: 16,
  PYRAMID_MAX_BEHIND: 4,

  // Glance band window radii. Centre page gets 100%; periphery inside
  // INNER gets the GLANCE_RES bitmap; outside OUTER, canvases release to
  // cover.
  PYRAMID_GLANCE_INNER: 4,
  PYRAMID_GLANCE_OUTER: 8,
  PYRAMID_GLANCE_RES: 0.20,

  // ── Dev-mode flags ────────────────────────────────────────────────────────
  DEBUG_VIEWER: false,
  DEBUG_WORKERS: false,
  DEBUG_MEMORY: false,

  // ── Feature flags ─────────────────────────────────────────────────────────
  FEATURES: {
    USE_WORKER_SEARCH: true,
    USE_SCHEDULER: true,
    USE_TILING: true,
    USE_ENGINE_ADAPTER: true,
    USE_LRU_CACHES: true,
    USE_VELOCITY_THROTTLE: true,
    USE_TWO_PHASE_ZOOM: true,
    USE_RAF_PAN: true,
    USE_RENDER_PREFETCH: true,
    USE_LOW_RES_PLACEHOLDER: true,
    USE_PARSER_WORKER: true,
  },
});

// ============================================================================
// 2. PRIORITY
// ============================================================================

export const PRIORITY = deepFreeze({
  VISIBLE: 1,
  ADJACENT: 2,
  MARGIN: 3,
  IDLE: 4,
});

// ============================================================================
// 3. EVENTS
// ============================================================================

export const Events = deepFreeze({
  CORE_READY: 'core:ready',
  DOCUMENT_LOADING: 'document:loading',
  DOCUMENT_PROGRESS: 'document:progress',
  DOCUMENT_LOADED: 'document:loaded',
  DOCUMENT_ERROR: 'document:error',
  DOCUMENT_DESTROYING: 'document:destroying',
  DOCUMENT_DESTROYED: 'document:destroyed',

  LAYOUT_CHANGED: 'layout:changed',

  PAGE_VISIBLE: 'page:visible',
  PAGE_JUMP_REQUESTED: 'page:jump-requested',
  NAV_BACK_REQUESTED: 'nav:back-requested',

  SCALE_REQUESTED: 'scale:requested',
  SCALE_APPLIED: 'scale:applied',
  ZOOM_GESTURE_START: 'zoom:gesture-start',
  ZOOM_GESTURE_END: 'zoom:gesture-end',

  ROTATE_REQUESTED: 'rotate:requested',
  ROTATION_APPLIED: 'rotation:applied',

  SINGLE_TAP: 'single-tap',
  DOUBLE_TAP: 'double-tap',
  TRIPLE_TAP: 'triple-tap',
  SWIPE: 'swipe',
  PAN_START: 'pan:start',
  PAN_END: 'pan:end',
  INTERACTION_ACTIVITY: 'interaction:activity',
  SCROLL_VELOCITY: 'scroll:velocity',

  RENDER_ENQUEUE: 'render:enqueue',
  RENDER_START: 'render:start',
  RENDER_COMPLETE: 'render:complete',
  RENDER_CANCELLED: 'render:cancelled',
  RENDER_ERROR: 'render:error',
  TILE_VISIBLE_SET: 'tile:visible-set',

  SEARCH_STARTED: 'search:started',
  SEARCH_PROGRESS: 'search:progress',
  SEARCH_COMPLETED: 'search:completed',
  SEARCH_MATCH_FOCUSED: 'search:match-focused',
  SEARCH_CLEARED: 'search:cleared',

  OUTLINE_READY: 'outline:ready',

  MEMORY_PRESSURE: 'memory:pressure',
  MEMORY_REPORT: 'memory:report',

  WORKER_READY: 'worker:ready',
  WORKER_PROGRESS: 'worker:progress',
  WORKER_ERROR: 'worker:error',
  WORKER_TERMINATED: 'worker:terminated',

  LOCAL_FILE_OPEN_REQUESTED: 'local-file:open-requested',
  NETWORK_OFFLINE: 'network:offline',
  PREVIEW_SUBSCRIBE_REQUESTED: 'preview:subscribe-requested',
  STATE_CHANGED: 'state:changed',
});

// ============================================================================
// 4. EVENT BUS
// ============================================================================

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  on(event, handler) {
    if (typeof event !== 'string' || typeof handler !== 'function') return () => {};
    let set = this._handlers.get(event);
    if (!set) { set = new Set(); this._handlers.set(event, set); }
    set.add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this._handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._handlers.delete(event);
  }

  once(event, handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapper = (...args) => {
      this.off(event, wrapper);
      try { handler(...args); } catch { /* swallow */ }
    };
    return this.on(event, wrapper);
  }

  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set || set.size === 0) return;
    const snapshot = Array.from(set);
    for (const handler of snapshot) {
      try { handler(payload); } catch { /* swallow */ }
    }
  }

  clear(event) {
    if (event === undefined) { this._handlers.clear(); return; }
    this._handlers.delete(event);
  }

  listenerCount(event) {
    const set = this._handlers.get(event);
    return set ? set.size : 0;
  }
}

// ============================================================================
// 5. VIEWER STATE
// ============================================================================

const DEFAULT_STATE = Object.freeze({
  docId: null,
  mimeType: null,
  title: '',
  isLocalFile: false,
  documentKind: null,
  previewMode: false,
  previewPageLimit: 0,
  previewBlocked: false,
  isLoading: false,
  error: null,

  numPages: 1,
  currentPage: 1,
  outline: [],

  scale: 1.0,
  rotation: 0,
  viewMode: 'scroll',
  dpr: 1,
  scrollVelocityPxPerFrame: 0,
  visiblePageNumbers: [],

  isZoomGestureActive: false,
  isPanning: false,
  panOffsetX: 0,
  panOffsetY: 0,

  searchQuery: '',
  searchMatches: [],
  currentMatchIndex: -1,
  searchCaseSensitive: false,
  searchWholeWord: false,
  isSearching: false,

  isDestroyed: false,
  initTimestamp: 0,

  flags: {},
  deviceProfile: {
    isMobile: false,
    isLowMemory: false,
    hardwareConcurrency: 4,
    memoryCapBytes: 200 * 1024 * 1024,
    deviceMemory: 4,
    isNative: false,
    platform: 'web',
  },
});

export class ViewerState {
  constructor(bus) {
    this._bus = bus;
    this._data = { ...DEFAULT_STATE };

    this._data.outline = [];
    this._data.visiblePageNumbers = [];
    this._data.searchMatches = [];
    this._data.flags = {};
    this._data.deviceProfile = { ...DEFAULT_STATE.deviceProfile };

    try {
      const stored = localStorage.getItem(CONFIG.VIEW_MODE_STORAGE_KEY);
      if (stored === 'scroll' || stored === 'page') {
        this._data.viewMode = stored;
      }
    } catch { /* ignore */ }

    try {
      const rawDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      this._data.dpr = clamp(rawDpr, 1, CONFIG.MAX_DPR);
    } catch {
      this._data.dpr = 1;
    }
  }

  get(key) { return this._data[key]; }

  set(key, value) {
    const prev = this._data[key];
    if (Object.is(prev, value)) return;
    this._data[key] = value;
    const payload = { key, prev, next: value };
    this._bus.emit(Events.STATE_CHANGED, payload);
    this._bus.emit(`${Events.STATE_CHANGED}:${key}`, payload);
  }

  patch(partial) {
    if (!partial || typeof partial !== 'object') return;
    for (const key of Object.keys(partial)) this.set(key, partial[key]);
  }

  snapshot() {
    const copy = {};
    for (const key of Object.keys(this._data)) {
      const value = this._data[key];
      if (Array.isArray(value)) copy[key] = value.slice();
      else if (value && typeof value === 'object') copy[key] = { ...value };
      else copy[key] = value;
    }
    return copy;
  }

  reset() {
    const preserved = {
      flags: this._data.flags,
      deviceProfile: this._data.deviceProfile,
      initTimestamp: this._data.initTimestamp,
    };
    for (const key of Object.keys(DEFAULT_STATE)) {
      if (key in preserved) continue;
      const defaultValue = DEFAULT_STATE[key];
      const cloned = Array.isArray(defaultValue) ? [] : defaultValue;
      this.set(key, cloned);
    }
    this._data.flags = preserved.flags;
    this._data.deviceProfile = preserved.deviceProfile;
    this._data.initTimestamp = preserved.initTimestamp;
  }

  subscribe(key, handler) {
    return this._bus.on(`${Events.STATE_CHANGED}:${key}`, handler);
  }
}

// ============================================================================
// 6. VIEWER CORE
// ============================================================================

export class ViewerCore {
  constructor() {
    /** @type {EventBus|null} */ this._bus = null;
    /** @type {ViewerState|null} */ this._state = null;

    /** @type {any} */ this._engine = null;
    /** @type {any} */ this._render = null;
    /** @type {any} */ this._interaction = null;
    /** @type {any} */ this._managers = null;
    /** @type {any} */ this._workers = null;

    /** @type {Promise<void>|null} */ this._initPromise = null;
    /** @type {boolean} */ this._initialised = false;
    /** @type {boolean} */ this._destroying = false;

    /** @type {Array<() => void>} */ this._teardowns = [];
    /** @type {null | (() => void)} */ this._nativeTeardown = null;

    /** @type {boolean} */ this._pageSizePreloadStarted = false;

    // ── Render-mode state driven by SCROLL_VELOCITY ──────────────────────
    //
    // _renderMode picks the reconciliation strategy for the pyramid:
    //   'idle'   — full ring geometry (see _ringResolutionForDistance)
    //   'glance' — centre page at 100%, periphery at 20%
    //   'paper'  — every canvas in range releases to cover; nothing renders
    //
    // _renderBias shifts the effective centre forward (positive) or
    // backward (negative) by a few pages during motion, so pages coming
    // toward the user get the render budget and pages behind release
    // early.
    /** @private @type {'paper'|'glance'|'idle'} */
    this._renderMode = 'idle';
    /** @private @type {number} */
    this._renderBias = 0;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async init() {
    if (this._initialised) return;
    if (this._initPromise) return this._initPromise;

    const p = this._doInit();
    this._initPromise = p;

    try {
      await p;
    } catch (err) {
      this._initPromise = null;
      throw err;
    }
  }

  async loadDocument(blob, fileType = null, title = 'Document', opts = null) {
    if (!this._state) {
      throw new Error('ViewerCore not initialised. Call init() first.');
    }

    if (this._state.get('docId') !== null || this._state.get('documentKind') !== null) {
      this.destroy();
    }

    const previewMode = !!(opts && opts.previewMode);
    this._state.set('previewMode', previewMode);
    this._state.set('previewPageLimit', 0);
    this._state.set('previewBlocked', false);
    this._state.set('rotation', 0);

    // Reset the velocity state on every new document — a stale 'paper' or
    // 'glance' from the previous document would suppress the first renders.
    this._renderMode = 'idle';
    this._renderBias = 0;

    this._state.set('isLoading', true);
    this._state.set('error', null);
    this._state.set('title', title || 'Document');
    this._bus.emit(Events.DOCUMENT_LOADING, { title });

    try {
      const normalised = await ensureMimeType(blob, fileType);
      const mimeType = normalised.type || '';
      const kind = this._detectDocumentKind(mimeType);

      this._state.set('mimeType', mimeType);
      this._state.set('documentKind', kind);

      switch (kind) {
        case 'pdf':    await this._loadPdf(normalised); break;
        case 'image':  await this._loadImage(normalised); break;
        case 'text':   await this._loadText(normalised); break;
        case 'office': this._loadOffice(normalised); break;
        default:       this._loadUnsupported(normalised);
      }

      this._state.set('isLoading', false);
    } catch (err) {
      this._state.set('isLoading', false);
      this._state.set('error', err);
      this._bus.emit(Events.DOCUMENT_ERROR, {
        message: err && err.message ? err.message : 'Unknown error',
        stack: err && err.stack ? err.stack : '',
      });
    }
  }

  destroy() {
    if (this._destroying) return;
    if (!this._state) return;
    this._destroying = true;

    try {
      this._bus.emit(Events.DOCUMENT_DESTROYING, {});

      try {
        const scheduler = this._render && this._render.scheduler;
        if (scheduler && typeof scheduler.cancelAll === 'function') {
          const result = scheduler.cancelAll();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        }
      } catch { /* ignore */ }

      try {
        if (this._managers && this._managers.search && this._managers.search.cancel) {
          this._managers.search.cancel();
        }
      } catch { /* ignore */ }

      try {
        if (this._managers && this._managers.cache && this._managers.cache.evictAll) {
          this._managers.cache.evictAll();
        }
      } catch { /* ignore */ }

      try { revokeAllObjectURLs(); } catch { /* ignore */ }

      try {
        if (this._engine && this._engine.destroy) {
          const result = this._engine.destroy();
          if (result && typeof result.catch === 'function') result.catch(() => {});
        }
      } catch { /* ignore */ }

      try {
        if (this._workers && this._workers.terminateAll) {
          this._workers.terminateAll('document destroyed');
        }
      } catch { /* ignore */ }

      try { unmountChrome(this); } catch { /* ignore */ }
      try { clearViewerContent(); } catch { /* ignore */ }
      this._resetSidebarState();

      this._state.reset();
      this._state.set('isDestroyed', false);
      this._state.set('rotation', 0);
      this._pageSizePreloadStarted = false;
      this._renderMode = 'idle';
      this._renderBias = 0;

      this._bus.emit(Events.DOCUMENT_DESTROYED, {});
    } finally {
      this._destroying = false;
    }
  }

  /**
   * Re-render the current layout. Emits LAYOUT_CHANGED after the DOM is
   * built so that interaction.js finds a live .page-container.
   */
  async renderCurrentLayout() {
    if (!this._state) return;

    if (this._state.get('previewBlocked')) {
      this._renderPreviewBlocked();
      return;
    }

    const viewMode = this._state.get('viewMode');

    if (viewMode === 'scroll') {
      await this._renderScrollLayout();
    } else {
      await this._renderPageLayout();
    }

    this._bus.emit(Events.LAYOUT_CHANGED, { mode: viewMode });
  }

  // ── Subsystem getters ─────────────────────────────────────────────────────

  getBus() {
    if (!this._bus) throw new Error('ViewerCore bus is not ready yet.');
    return this._bus;
  }

  getState() {
    if (!this._state) throw new Error('ViewerCore state is not ready yet.');
    return this._state;
  }

  getEngine() {
    if (!this._engine) throw new Error('ViewerCore engine is not ready yet.');
    return this._engine;
  }

  getScheduler() { return this._render ? this._render.scheduler : null; }
  getTileManager() { return this._render ? this._render.tileManager : null; }
  getRenderer() { return this._render ? this._render.renderer : null; }
  getCache() { return this._managers ? this._managers.cache : null; }
  getMemory() { return this._managers ? this._managers.memory : null; }
  getSearch() { return this._managers ? this._managers.search : null; }
  getOutline() { return this._managers ? this._managers.outline : null; }
  getManagers() { return this._managers; }

  getScroll() { return this._interaction ? this._interaction.scroll : null; }
  getZoom() { return this._interaction ? this._interaction.zoom : null; }
  getPan() { return this._interaction ? this._interaction.pan : null; }
  getGestures() { return this._interaction ? this._interaction.gestures : null; }

  getWorkers() { return this._workers; }

  getEffectivePageLimit() {
    if (!this._state) return 1;
    if (this._state.get('previewBlocked')) return 1;
    const limit = this._state.get('previewPageLimit');
    if (limit > 0) return limit;
    const total = this._state.get('numPages');
    return typeof total === 'number' && total > 0 ? total : 1;
  }

  isPageAllowed(pageNum) {
    if (!Number.isFinite(pageNum)) return false;
    if (this._state && this._state.get('previewBlocked')) return false;
    return pageNum >= 1 && pageNum <= this.getEffectivePageLimit();
  }

  getUI() {
    const core = this;
    return {
      mountChrome: () => mountChrome(core),
      unmountChrome: () => unmountChrome(core),
      refreshElementCache: () => refreshElementCache(),
      injectViewerStyles: () => injectViewerStyles(),
      showHeaderFooter: () => { core.getBus().emit(Events.INTERACTION_ACTIVITY, {}); },
      hideHeaderFooter: () => { /* no-op */ },
      resetAutoHideTimer: () => { core.getBus().emit(Events.INTERACTION_ACTIVITY, {}); },
    };
  }

  // ── Private: lifecycle ────────────────────────────────────────────────────

  async _doInit() {
    this._assertPdfjsLibPresent();

    this._bus = new EventBus();
    this._state = new ViewerState(this._bus);

    const flags = this._applyUrlFlagOverrides(CONFIG.FEATURES);
    this._state.set('flags', flags);

    this._state.set('deviceProfile', this._detectDeviceProfile());

    injectViewerStyles();
    refreshElementCache();

    this._assertElementIdsPresent();

    const created = [];
    try {
      this._workers = createWorkers(this);
      created.push(() => this._workers && this._workers.destroy && this._workers.destroy());

      this._engine = createEngine(this);
      created.push(() => this._engine && this._engine.destroy && this._engine.destroy());

      this._managers = createManagers(this);
      created.push(() => {
        if (this._managers && this._managers.cache && this._managers.cache.evictAll) {
          this._managers.cache.evictAll();
        }
      });

      this._render = createRenderPipeline(this);
      created.push(() => {
        if (this._render && this._render.scheduler && this._render.scheduler.destroy) {
          this._render.scheduler.destroy();
        }
      });

      this._interaction = createInteractionLayer(this);
      created.push(() => {
        if (this._interaction) {
          for (const k of ['scroll', 'zoom', 'pan', 'gestures']) {
            const m = this._interaction[k];
            if (m && m.destroy) {
              try { m.destroy(); } catch { /* ignore */ }
            }
          }
        }
      });
    } catch (err) {
      for (let i = created.length - 1; i >= 0; i--) {
        try { created[i](); } catch { /* ignore */ }
      }
      this._workers = null;
      this._engine = null;
      this._managers = null;
      this._render = null;
      this._interaction = null;
      this._teardowns = [];
      throw err;
    }

    if (this._engine && this._engine.initialize) {
      await this._engine.initialize();
    }

    setupControls(this);
    setupAutoHideListeners(this);
    setupDPRListener(this);
    bindCoreEvents(this);
    setupFitWidthObserver(this);

    this._wireCrossModuleEvents();

    try {
      this._nativeTeardown = setupNativeBridge(this);
    } catch {
      this._nativeTeardown = null;
    }

    this._state.set('initTimestamp', Date.now());
    this._initialised = true;
    this._bus.emit(Events.CORE_READY, { timestamp: this._state.get('initTimestamp') });
  }

  _wireCrossModuleEvents() {
    const bus = this._bus;

    // ── MEMORY_PRESSURE → cancel low-priority work, evict if critical ────
    this._teardowns.push(bus.on(Events.MEMORY_PRESSURE, (payload) => {
      if (!payload) return;
      const level = payload.level;
      const memory = this.getMemory();

      if (level === 'warning') {
        // Schedule idle-time eviction to bring usage back toward the
        // resume band. Never blocks the main thread.
        try {
          if (memory && typeof memory.scheduleBackgroundEviction === 'function') {
            memory.scheduleBackgroundEviction(this._state.get('currentPage') || 1);
          }
        } catch { /* ignore */ }
        return;
      }

      if (level === 'critical') {
        // Cancel everything below visible and force an immediate eviction.
        try {
          const scheduler = this.getScheduler();
          if (scheduler && scheduler.cancelBelow) {
            scheduler.cancelBelow(PRIORITY.MARGIN);
          }
        } catch { /* ignore */ }

        try {
          if (memory && typeof memory.capBytes === 'function'
              && typeof memory._evictToTarget === 'function') {
            const target = memory.capBytes() * 0.65 - memory.pinnedBytes();
            memory._evictToTarget(target, this._state.get('currentPage') || 1);
          }
        } catch { /* ignore */ }
      }
    }));

    // ── RENDER_COMPLETE → install page into its slot ──────────────────────
    this._teardowns.push(bus.on(Events.RENDER_COMPLETE, (payload) => {
      this._onRenderComplete(payload);
    }));

    // ── SCROLL_VELOCITY → drive the render mode ───────────────────────────
    //
    // The velocity sample is the sole input to the render-mode decision.
    // idle → full pyramid. glance → centre sharp + low-res periphery.
    // paper → covers only. The 150 ms idle tick emitted by ScrollManager
    // restores idle mode automatically once motion stops.
    this._teardowns.push(bus.on(Events.SCROLL_VELOCITY, (payload) => {
      const vel = payload && typeof payload.velocity === 'number' ? payload.velocity : 0;
      const dir = payload && typeof payload.direction === 'number' ? payload.direction : 0;

      const next = this._velocityState(vel, dir);
      if (next.mode === this._renderMode && next.bias === this._renderBias) return;

      this._renderMode = next.mode;
      this._renderBias = next.bias;

      // On entering paper, drop every queued render below VISIBLE so the
      // scheduler isn't working on anything we're about to release anyway.
      if (next.mode === 'paper') {
        try {
          const scheduler = this.getScheduler();
          if (scheduler && scheduler.cancelBelow) {
            scheduler.cancelBelow(PRIORITY.VISIBLE);
          }
        } catch { /* ignore */ }
      }

      try {
        this._applyPyramidWindow(this._state.get('currentPage') || 1, {
          mode: this._renderMode,
          bias: this._renderBias,
        });
      } catch { /* ignore */ }
    }));

    // ── PAGE_VISIBLE → set current page AND slide the pyramid ─────────────
    //
    // Do NOT early-return when currentPage already matches. navigateTo()
    // sets currentPage before emitting PAGE_VISIBLE, and _updateVisiblePages
    // does the same during scroll — if this subscriber bails on the match,
    // the pyramid is never applied for any navigation that didn't originate
    // from a scroll-frame that found a new top page.
    //
    // In page-view mode there is only one slot, so instead of the pyramid
    // we rebuild the layout for the new page.
    this._teardowns.push(bus.on(Events.PAGE_VISIBLE, (payload) => {
      if (!payload || typeof payload.pageNum !== 'number') return;

      const prev = this._state.get('currentPage');
      if (prev !== payload.pageNum) {
        this._state.set('currentPage', payload.pageNum);
      }

      const viewMode = this._state.get('viewMode');

      if (viewMode === 'page') {
        Promise.resolve()
          .then(() => this._renderPageLayout())
          .then(() => this._bus.emit(Events.LAYOUT_CHANGED, { mode: 'page' }))
          .catch(() => { /* ignore */ });
        return;
      }

      try {
        this._applyPyramidWindow(payload.pageNum, {
          mode: this._renderMode,
          bias: this._renderBias,
        });
      } catch { /* ignore */ }
    }));

    // ── SCALE_APPLIED → resize every slot, then re-evaluate X-axis lock ───
    this._teardowns.push(bus.on(Events.SCALE_APPLIED, (payload) => {
      if (!payload || typeof payload.scale !== 'number') return;

      const prev = this._state.get('scale');
      if (prev !== payload.scale) {
        this._state.set('scale', payload.scale);
      }

      this._syncSlotDimensions();
      this._updateXAxisLock();

      // Re-render the visible ring at the new scale.
      try {
        this._applyPyramidWindow(this._state.get('currentPage') || 1, {
          mode: this._renderMode,
          bias: this._renderBias,
        });
      } catch { /* ignore */ }
    }));

    // ── DOCUMENT_LOADED → hand outline to OutlineManager ──────────────────
    this._teardowns.push(bus.on(Events.DOCUMENT_LOADED, (payload) => {
      if (!payload || !Array.isArray(payload.outline)) return;
      try {
        const outline = this.getOutline();
        if (outline && typeof outline.build === 'function') {
          outline.build(payload.outline);
        }
      } catch { /* ignore */ }
    }));

    // ── ROTATE_REQUESTED → update state, rebuild layout ───────────────────
    this._teardowns.push(bus.on(Events.ROTATE_REQUESTED, (payload) => {
      const current = this._state.get('rotation') || 0;
      let next;
      if (payload && typeof payload.rotation === 'number') {
        next = ((payload.rotation % 360) + 360) % 360;
      } else if (payload && payload.delta === -90) {
        next = ((current - 90) % 360 + 360) % 360;
      } else {
        next = (current + 90) % 360;
      }
      if (next === current) return;
      this._state.set('rotation', next);
      this._bus.emit(Events.ROTATION_APPLIED, { rotation: next });
      Promise.resolve()
        .then(() => this.renderCurrentLayout())
        .catch(() => { /* ignore */ });
    }));

    // ── Search lifecycle ──────────────────────────────────────────────────
    this._teardowns.push(bus.on(Events.SEARCH_STARTED, () => {
      this._state.set('isSearching', true);
    }));
    this._teardowns.push(bus.on(Events.SEARCH_COMPLETED, (payload) => {
      this._state.set('isSearching', false);
      this._state.set('searchMatches',
        payload && Array.isArray(payload.matches) ? payload.matches : []);
      this._state.set('currentMatchIndex',
        payload && typeof payload.currentIndex === 'number' ? payload.currentIndex : -1);
    }));
    this._teardowns.push(bus.on(Events.SEARCH_CLEARED, () => {
      this._state.set('isSearching', false);
      this._state.set('searchMatches', []);
      this._state.set('currentMatchIndex', -1);
      this._state.set('searchQuery', '');
    }));
    this._teardowns.push(bus.on(Events.SEARCH_MATCH_FOCUSED, (payload) => {
      if (!payload || typeof payload.index !== 'number') return;
      this._state.set('currentMatchIndex', payload.index);
    }));

    // ── View-mode change → persist AND rebuild layout ─────────────────────
    this._teardowns.push(this._state.subscribe('viewMode', (payload) => {
      try {
        localStorage.setItem(CONFIG.VIEW_MODE_STORAGE_KEY, payload.next);
      } catch { /* ignore */ }

      Promise.resolve()
        .then(() => this.renderCurrentLayout())
        .catch(() => { /* ignore */ });
    }));

    this._teardowns.push(bus.on(Events.DOCUMENT_DESTROYED, () => {
      this._pageSizePreloadStarted = false;
      this._renderMode = 'idle';
      this._renderBias = 0;
    }));

    // ── Window resize → re-evaluate X-axis lock ───────────────────────────
    if (typeof window !== 'undefined') {
      const onResize = () => {
        try { this._updateXAxisLock(); } catch { /* ignore */ }
      };
      window.addEventListener('resize', onResize, { passive: true });
      this._teardowns.push(() => {
        try { window.removeEventListener('resize', onResize); } catch { /* ignore */ }
      });
    }

    // ── Visibility change → integrity probe ───────────────────────────────
    // Android WebView silently purges canvas backing stores when the app is
    // backgrounded. On return, canvases with wiped bitmaps show as transparent
    // even though width/height are non-zero. Detect this and demote them to
    // covers so the pyramid re-renders them.
    if (typeof document !== 'undefined') {
      const onVisibility = () => {
        if (document.visibilityState !== 'visible') return;
        try {
          const els = getViewerElements();
          if (!els || !els.main) return;
          const container = els.main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS);
          if (!container) return;

          let reEnqueue = 0;
          for (const slot of container.querySelectorAll('.' + CONFIG.PAGE_CLASS)) {
            const canvas = /** @type {HTMLCanvasElement} */ (slot);
            if (!canvas.width || !canvas.height) continue;

            let survived = true;
            try {
              const ctx = canvas.getContext('2d');
              if (!ctx) { survived = false; }
              else {
                const px = ctx.getImageData(0, 0, 1, 1).data;
                if (px[3] === 0) survived = false;
              }
            } catch { survived = false; }

            if (!survived) {
              const pageNum = Number(canvas.dataset.page);
              if (Number.isFinite(pageNum)) {
                try {
                  const memory = this.getMemory();
                  if (memory && memory.unregisterCanvas) memory.unregisterCanvas(canvas);
                } catch { /* ignore */ }
                const cover = this._makeCover(pageNum);
                canvas.replaceWith(cover);
                reEnqueue++;
              }
            }
          }

          if (reEnqueue > 0) {
            try {
              this._applyPyramidWindow(this._state.get('currentPage') || 1, {
                mode: this._renderMode,
                bias: this._renderBias,
              });
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      };

      document.addEventListener('visibilitychange', onVisibility);
      this._teardowns.push(() => {
        try { document.removeEventListener('visibilitychange', onVisibility); } catch { /* ignore */ }
      });
    }
  }

  // ── Private: document kind detection & loaders ────────────────────────────

  _detectDocumentKind(mimeType) {
    const m = String(mimeType || '').toLowerCase();
    if (m === 'application/pdf') return 'pdf';
    if (m.startsWith('image/')) return 'image';
    if (
      m === 'text/plain' ||
      m === 'text/markdown' ||
      m === 'text/csv' ||
      m === 'application/rtf' ||
      m === 'application/vnd.oasis.opendocument.text'
    ) return 'text';
    if (
      m.includes('vnd.openxmlformats-officedocument') ||
      m === 'application/msword' ||
      m === 'application/vnd.ms-powerpoint' ||
      m === 'application/vnd.ms-excel'
    ) return 'office';
    return 'unsupported';
  }

  /**
   * Load a PDF.
   *
   * SIZE HANDLING:
   *   Passes a blob URL to the engine adapter so PDF.js can stream from
   *   Chromium's blob storage instead of materializing the whole file into
   *   the main JS heap via blob.arrayBuffer(). When the adapter doesn't
   *   yet accept URL descriptors, falls back to the ArrayBuffer path —
   *   which caps the practical file size at ~30 MB (see app-storage.js
   *   for the corresponding readBlob path on the native side).
   *
   * The engine adapter is expected to accept either:
   *   { url, rangeChunkSize, disableAutoFetch }   → preferred
   *   ArrayBuffer                                  → fallback
   */
  async _loadPdf(blob) {
    const profile = this._state.get('deviceProfile') || {};
    const isLowMemory = profile.isLowMemory === true;
    const isMobile = profile.isMobile === true;

    // Size guard: refuse rather than silently OOM inside the worker.
    const capBytes = isLowMemory
      ? CONFIG.MAX_PDF_BYTES_LOW_MEMORY
      : isMobile
        ? CONFIG.MAX_PDF_BYTES_MOBILE
        : CONFIG.MAX_PDF_BYTES_DESKTOP;

    if (blob && typeof blob.size === 'number' && blob.size > capBytes) {
      const sizeMb = Math.round(blob.size / (1024 * 1024));
      const capMb = Math.round(capBytes / (1024 * 1024));
      throw new Error(
        `This PDF is ${sizeMb} MB — larger than the ${capMb} MB limit for ` +
        `this device. Open it on a desktop browser.`,
      );
    }

    const loadTimeout = isMobile
      ? CONFIG.PDF_LOAD_TIMEOUT_MOBILE_MS
      : CONFIG.PDF_LOAD_TIMEOUT_DESKTOP_MS;

    const url = createObjectURL(blob);
    let handle = null;

    // Preferred path: URL descriptor. PDF.js streams from the blob URL;
    // the file never enters the main-thread JS heap as one contiguous
    // ArrayBuffer.
    try {
      handle = await Promise.race([
        this._engine.loadDocument(
          { url, rangeChunkSize: 65536, disableAutoFetch: true },
          {
            onProgress: (progress) => {
              try {
                this._bus.emit(Events.DOCUMENT_PROGRESS, {
                  loaded: progress && progress.loaded,
                  total: progress && progress.total,
                });
              } catch { /* ignore */ }
            },
          },
        ),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(
            `Timed out loading PDF after ${loadTimeout / 1000}s.`,
          )),
          loadTimeout,
        )),
      ]);
    } catch (urlErr) {
      // Fallback: adapter may not accept URL descriptors yet. Materialize
      // as ArrayBuffer — the practical cap is ~30 MB.
      try {
        const arrayBuffer = await blob.arrayBuffer();
        handle = await this._engine.loadDocument(arrayBuffer, {
          onProgress: () => { /* no-op */ },
        });
      } catch (bufErr) {
        // Both paths failed — surface the original URL error message so
        // the caller sees the informative timeout rather than a generic
        // adapter error.
        throw urlErr;
      }
    }

    const numPages = handle && typeof handle.numPages === 'number' ? handle.numPages : 1;
    const outline = (handle && Array.isArray(handle.outline)) ? handle.outline : [];

    this._state.patch({
      numPages,
      outline,
      currentPage: 1,
      rotation: 0,
      scale: 1.0,
    });

    try {
      const drawer = document.getElementById('viewer-outline-drawer');
      if (drawer) {
        drawer.innerHTML = '';
        drawer.dataset.panel = 'outline';
      }
    } catch { /* ignore */ }

    this._applyPreviewPolicy(numPages);

    if (!this._state.get('previewBlocked')) {
      await this._applyFitToWidth();
    } else {
      await this._ensurePageMetadata(1);
    }

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages,
      outline,
      mimeType: this._state.get('mimeType'),
      documentKind: 'pdf',
      previewBlocked: this._state.get('previewBlocked') === true,
    });

    if (this._state.get('previewBlocked')) {
      this._renderPreviewBlocked();
      return;
    }

    await this.renderCurrentLayout();
  }

  /**
   * Load an image into the viewer.
   *
   * SIZING MODEL:
   *   An image is a one-page document. It follows the SAME invariant as a
   *   PDF page slot:
   *
   *     displayed width  = naturalWidth  × displayScale
   *     displayed height = naturalHeight × displayScale
   *
   *   displayScale starts at fit-to-width — the same value _applyFitToWidth
   *   computes for PDF page 1 — so the image opens edge-to-edge with the
   *   same 3px gutter. Pan and zoom then multiply both dimensions by the
   *   same factor, preserving aspect ratio exactly.
   *
   * NO CROPPING:
   *   `object-fit: contain` scales the bitmap to fill the slot exactly.
   *   Because the slot's aspect ratio is derived from the bitmap's own
   *   natural ratio (same scale factor applied to both axes), `contain`
   *   fills the slot without letterboxing, and no pixel is clipped.
   *   The earlier `object-fit: none` was the bug: it rendered the bitmap
   *   at intrinsic pixels and clipped to the slot whenever the slot was
   *   smaller than natural — which happens for any scale below 1.0.
   */
  async _loadImage(blob) {
    const els = getViewerElements();
    if (!els || !els.main) return;

    this._applyPreviewPolicy(1);

    if (this._state.get('previewBlocked')) {
      this._renderPreviewBlocked();
      if (els.footer) els.footer.style.display = 'none';
      this._bus.emit(Events.DOCUMENT_LOADED, {
        numPages: 1, outline: [],
        mimeType: this._state.get('mimeType'),
        documentKind: 'image', previewBlocked: true,
      });
      return;
    }

    const main = els.main;
    main.classList.remove('scroll-view');
    main.classList.add('page-view');
    this._clearViewerMainPreservingChrome();

    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS;
    main.appendChild(container);

    const url = createObjectURL(blob);
    const img = document.createElement('img');
    img.className = CONFIG.PAGE_CLASS;
    img.dataset.page = '1';
    img.src = url;
    img.alt = '';
    img.draggable = false;

    img.style.display = 'block';
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    // object-fit: contain — the bitmap scales to fit inside the slot
    // without distorting. The slot's aspect ratio is derived from the
    // bitmap's natural ratio, so `contain` fills it exactly. `none` was
    // the bug: it renders the bitmap at intrinsic pixels and clips to
    // the slot, cropping whenever the slot is smaller than natural.
    img.style.objectFit = 'contain';
    img.style.transformOrigin = '0 0';
    img.style.background = '#fff';
    img.style.userSelect = 'none';
    img.style.webkitUserDrag = 'none';

    container.appendChild(img);

    // Wait for intrinsic dimensions before sizing.
    try {
      if (typeof img.decode === 'function') {
        await img.decode();
      } else {
        await new Promise((resolve) => {
          if (img.complete && img.naturalWidth > 0) return resolve();
          img.addEventListener('load', () => resolve(), { once: true });
          img.addEventListener('error', () => resolve(), { once: true });
        });
      }
    } catch { /* image failed to decode */ }

    const naturalW = img.naturalWidth || 0;
    const naturalH = img.naturalHeight || 0;

    if (!(naturalW > 0) || !(naturalH > 0)) {
      container.remove();
      this._loadUnsupported(blob);
      return;
    }

    img.dataset.naturalWidth = String(naturalW);
    img.dataset.naturalHeight = String(naturalH);

    // ── Fit-to-width, aspect ratio preserved ────────────────────────────
    // The image opens at the viewport width, minus the standard gutter.
    // Height is computed from the image's own aspect ratio:
    //
    //   displayW = usable
    //   displayH = usable × (naturalH / naturalW)
    //
    // That's what _applySlotSize does when we hand it a scale of
    // `usable / naturalW`. Because the same factor is applied to both
    // axes, the aspect ratio is preserved exactly.
    let availableWidth = main.clientWidth;
    if (!(availableWidth > 0)) {
      availableWidth = await this._waitForViewerWidth(
        main,
        CONFIG.FIT_WIDTH_WAIT_TIMEOUT_MS,
      );
    }

    let fitScale = 1;
    if (availableWidth > 0) {
      const usable = Math.max(availableWidth - CONFIG.FIT_WIDTH_H_PADDING_PX, 100);
      fitScale = clamp(usable / naturalW, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);
    }

    this._state.set('scale', fitScale);

    // Slot becomes naturalW × fitScale by naturalH × fitScale.
    // At fit-to-width this is `usable` wide by `usable × ratio` tall.
    this._applySlotSize(img, { width: naturalW, height: naturalH });

    try {
      const zoom = this.getZoom();
      if (zoom && typeof zoom.syncScale === 'function') {
        zoom.syncScale(fitScale);
      }
    } catch { /* ignore */ }

    if (els.footer) els.footer.style.display = 'none';

    this._updateXAxisLock();

    this._bus.emit(Events.LAYOUT_CHANGED, { mode: 'page' });

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages: 1, outline: [],
      mimeType: this._state.get('mimeType'),
      documentKind: 'image',
    });
  }

  async _loadText(blob) {
    const els = getViewerElements();
    if (!els || !els.main) return;

    this._applyPreviewPolicy(1);

    if (this._state.get('previewBlocked')) {
      this._renderPreviewBlocked();
      if (els.footer) els.footer.style.display = 'none';
      this._bus.emit(Events.DOCUMENT_LOADED, {
        numPages: 1, outline: [],
        mimeType: this._state.get('mimeType'),
        documentKind: 'text', previewBlocked: true,
      });
      return;
    }

    const text = await blob.text();
    const pre = document.createElement('pre');
    pre.textContent = text;
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.wordBreak = 'break-word';
    pre.style.margin = '0';
    pre.style.padding = '1rem';
    pre.style.fontFamily = 'var(--font-mono, monospace)';
    pre.style.fontSize = '0.95rem';
    pre.style.lineHeight = '1.5';
    pre.style.boxSizing = 'border-box';

    this._clearViewerMainPreservingChrome();

    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS;
    container.appendChild(pre);
    els.main.appendChild(container);

    if (els.footer) els.footer.style.display = 'none';

    this._updateXAxisLock();
    this._bus.emit(Events.LAYOUT_CHANGED, { mode: 'scroll', container });

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages: 1, outline: [],
      mimeType: this._state.get('mimeType'),
      documentKind: 'text',
    });
  }

  _loadOffice(blob) {
    const els = getViewerElements();
    if (!els || !els.main) return;

    this._applyPreviewPolicy(1);

    if (this._state.get('previewBlocked')) {
      this._renderPreviewBlocked();
      if (els.footer) els.footer.style.display = 'none';
      this._bus.emit(Events.DOCUMENT_LOADED, {
        numPages: 1, outline: [],
        mimeType: this._state.get('mimeType'),
        documentKind: 'office', previewBlocked: true,
      });
      return;
    }

    const url = createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.display = 'block';

    this._clearViewerMainPreservingChrome();

    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS;
    container.style.width = '100%';
    container.style.height = '100%';
    container.appendChild(iframe);
    els.main.appendChild(container);

    if (els.footer) els.footer.style.display = 'none';

    this._updateXAxisLock();
    this._bus.emit(Events.LAYOUT_CHANGED, { mode: 'page', container });

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages: 1, outline: [],
      mimeType: this._state.get('mimeType'),
      documentKind: 'office',
    });
  }

  _loadUnsupported(blob) {
    const els = getViewerElements();
    if (!els || !els.main) return;

    this._applyPreviewPolicy(1);

    if (this._state.get('previewBlocked')) {
      this._renderPreviewBlocked();
      if (els.footer) els.footer.style.display = 'none';
      this._bus.emit(Events.DOCUMENT_LOADED, {
        numPages: 1, outline: [],
        mimeType: this._state.get('mimeType'),
        documentKind: 'unsupported', previewBlocked: true,
      });
      return;
    }

    const url = createObjectURL(blob);
    const safeMime = escapeHtml(this._state.get('mimeType') || 'unknown');
    this._clearViewerMainPreservingChrome();

    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS;
    const inner = document.createElement('div');
    inner.className = 'unsupported';
    inner.innerHTML = `
      <p>Preview not available for this file type (${safeMime}).</p>
      <a href="${url}" download class="btn-primary">Download to view locally</a>
    `;
    container.appendChild(inner);
    els.main.appendChild(container);

    if (els.footer) els.footer.style.display = 'none';

    this._updateXAxisLock();
    this._bus.emit(Events.LAYOUT_CHANGED, { mode: 'scroll', container });

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages: 1, outline: [],
      mimeType: this._state.get('mimeType'),
      documentKind: 'unsupported',
    });
  }

  // ── Private: slot factory and sizing ─────────────────────────────────────

  /**
   * Create a <div class="cover"> for the given page.
   *
   * If metadata is cached, the cover is sized exactly to the eventual
   * canvas. If not, it reserves a generic min-height and is resized by
   * _applySlotSize once metadata arrives.
   *
   * NOTE: the fallback deliberately leaves `width` UNSET. A `width: 100%`
   * fallback would be circular against .page-container's `width:
   * fit-content` — the container's intrinsic width depends on its
   * children's widths, which depend on the container. The container's
   * width comes from the first child that has an explicit width, which
   * arrives with page 1's metadata.
   */
  _makeCover(pageNum) {
    const el = document.createElement('div');
    el.className = CONFIG.COVER_CLASS;
    el.dataset.page = String(pageNum);

    const cache = this.getCache();
    const meta = cache && cache.getPageViewport ? cache.getPageViewport(pageNum) : null;

    if (meta && meta.width > 0 && meta.height > 0) {
      this._applySlotSize(el, meta);
    } else {
      el.style.minHeight = '200px';
    }
    return el;
  }

  /**
   * Size a slot to natural × displayScale, and record the naturals on the
   * slot so subsequent resizes (on zoom settle) don't need metadata again.
   *
   * Rotation-aware: swaps naturals for 90° / 270°.
   */
  _applySlotSize(el, meta) {
    const scale = this._state.get('scale') || 1;
    const rotation = this._state.get('rotation') || 0;
    const swapped = rotation === 90 || rotation === 270;
    const naturalW = swapped ? meta.height : meta.width;
    const naturalH = swapped ? meta.width : meta.height;

    el.dataset.naturalWidth = String(naturalW);
    el.dataset.naturalHeight = String(naturalH);

    const w = naturalW * scale;
    const h = naturalH * scale;
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.minHeight = `${h}px`;
  }

  /**
   * Resize every slot (cover or canvas) to natural × displayScale.
   */
  _syncSlotDimensions() {
    const els = getViewerElements();
    if (!els || !els.main) return;

    const scale = this._state.get('scale') || 1;

    const slots = els.main.querySelectorAll(`.${CONFIG.PAGE_CLASS}, .${CONFIG.COVER_CLASS}`);
    slots.forEach((slot) => {
      const natW = Number(slot.dataset.naturalWidth);
      const natH = Number(slot.dataset.naturalHeight);
      if (!natW || !natH) return;

      const w = natW * scale;
      const h = natH * scale;
      slot.style.width = `${w}px`;
      slot.style.height = `${h}px`;
      slot.style.minHeight = `${h}px`;
    });

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.markLayoutDirty) scroll.markLayoutDirty();
    } catch { /* ignore */ }
  }

  /**
   * Toggle the .x-scroll class on #viewer-main.
   */
  _updateXAxisLock() {
    const els = getViewerElements();
    if (!els || !els.main) return;
    const main = els.main;

    if (this._state.get('previewBlocked')) {
      main.classList.add(CONFIG.X_SCROLL_CLASS);
      return;
    }

    const container = main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS);
    if (!container) {
      main.classList.remove(CONFIG.X_SCROLL_CLASS);
      return;
    }

    const contentW = container.scrollWidth || container.offsetWidth;
    const viewportW = main.clientWidth;

    if (contentW > viewportW + 1) {
      main.classList.add(CONFIG.X_SCROLL_CLASS);
    } else {
      main.classList.remove(CONFIG.X_SCROLL_CLASS);
      if (main.scrollLeft !== 0) main.scrollLeft = 0;
    }
  }

  // ── Private: velocity → render-mode ──────────────────────────────────────

  /**
   * Translate a velocity sample into a render state.
   *
   * Three bands, keyed on absolute velocity:
   *
   *   paper  (≥ 100 px/frame)  — moving faster than anyone can read.
   *                              Release every canvas; leave white cover
   *                              rectangles so scroll position is
   *                              preserved. No renders enqueued.
   *
   *   glance (30–99)           — moving fast, but the page under the
   *                              user's attention must stay sharp.
   *                              _reconcileGlance renders the centre at
   *                              100% and the ±4 periphery at 20%.
   *
   *   idle   (< 30)            — the full pyramid. Ring geometry from
   *                              _ringResolutionForDistance drives
   *                              everything.
   *
   * @private
   * @param {number} velocity   px/frame (signed)
   * @param {number} direction  -1 | 0 | 1
   * @returns {{ mode: 'paper'|'glance'|'idle', bias: number }}
   */
  _velocityState(velocity, direction) {
    const absV = Math.abs(velocity);
    const sign = direction >= 0 ? 1 : -1;

    if (absV >= CONFIG.VELOCITY_PAPER_MIN) {
      return { mode: 'paper', bias: sign * 3 };
    }
    if (absV >= CONFIG.VELOCITY_GLANCE_MIN) {
      return { mode: 'glance', bias: sign * 2 };
    }
    return { mode: 'idle', bias: 0 };
  }

  // ── Private: pyramid reconcilers ─────────────────────────────────────────

  /**
   * Reconcile every slot in the pyramid window against the current render
   * state. Behaviour depends on the velocity band:
   *
   *   idle   — full ring geometry (0..5 at 100%, 6..9 at 80%, …)
   *   glance — centre at 100%, periphery at 20%
   *   paper  — release everything; covers only
   *
   * @private
   * @param {number} centerPage
   * @param {{ mode?: 'paper'|'glance'|'idle', bias?: number }} [opts]
   */
  _applyPyramidWindow(centerPage, opts = {}) {
    if (!Number.isFinite(centerPage)) return;
    if (this._state.get('previewBlocked')) return;

    const els = getViewerElements();
    const container = els && els.main
      ? els.main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS)
      : null;
    if (!container) return;

    const mode = opts.mode || 'idle';
    const bias = Number.isFinite(opts.bias) ? opts.bias : 0;

    const limit = this.getEffectivePageLimit();
    const displayScale = this._state.get('scale') || 1;
    const rotation = this._state.get('rotation') || 0;
    const scheduler = this.getScheduler();

    const effectiveCentre = clamp(centerPage + bias, 1, limit);

    if (mode === 'paper') {
      this._reconcilePaper(container, effectiveCentre, limit, scheduler);
      return;
    }

    if (mode === 'glance') {
      this._reconcileGlance(
        container, effectiveCentre, limit, displayScale, rotation, scheduler,
      );
      return;
    }

    this._reconcilePyramid(
      container, effectiveCentre, limit, displayScale, rotation, scheduler,
    );
  }

  /**
   * PAPER band: release every rendered canvas within the total influence
   * range. Leave covers in place so scroll position and dimensions are
   * preserved. Enqueue nothing.
   *
   * @private
   */
  _reconcilePaper(container, effectiveCentre, limit, scheduler) {
    const RANGE = CONFIG.PYRAMID_MAX_AHEAD + CONFIG.PYRAMID_MAX_BEHIND;

    for (let d = -RANGE; d <= RANGE; d++) {
      const pageNum = effectiveCentre + d;
      if (pageNum < 1 || pageNum > limit) continue;

      const slot = container.querySelector(`[data-page="${pageNum}"]`);
      if (!slot) continue;
      if (!slot.classList.contains(CONFIG.PAGE_CLASS)) continue;

      try {
        if (scheduler && scheduler.cancelPage) scheduler.cancelPage(pageNum);
      } catch { /* ignore */ }

      try {
        const memory = this.getMemory();
        if (memory && memory.unregisterCanvas) memory.unregisterCanvas(slot);
      } catch { /* ignore */ }

      const cover = this._makeCover(pageNum);
      slot.replaceWith(cover);
    }
  }

  /**
   * GLANCE band: the page under the user's attention (the effective
   * centre) is rendered at 100% so it stays readable during slow
   * scrolling. The surrounding ±INNER window is rendered at 20% —
   * enough to show page structure and let the user orient, but cheap
   * enough that the outer ring does not compete for render budget.
   * Everything outside ±OUTER is released to cover.
   *
   * Without the 100% centre, a user scrolling at 30–99 px/frame would
   * see the page under their eye render at 20% resolution — legible
   * only as a shape, not as text. The whole point of glance mode is
   * "moving fast enough that structure matters more than sharpness",
   * but the page the user is currently on is always sharp.
   *
   * @private
   */
  _reconcileGlance(container, effectiveCentre, limit, displayScale, rotation, scheduler) {
    const INNER = CONFIG.PYRAMID_GLANCE_INNER;
    const OUTER = CONFIG.PYRAMID_GLANCE_OUTER;
    const GLANCE_RES = CONFIG.PYRAMID_GLANCE_RES;

    // ── 1. Release everything outside the outer band ───────────────────
    const RANGE = CONFIG.PYRAMID_MAX_AHEAD + CONFIG.PYRAMID_MAX_BEHIND;
    for (let d = -RANGE; d <= RANGE; d++) {
      if (Math.abs(d) <= OUTER) continue;
      const pageNum = effectiveCentre + d;
      if (pageNum < 1 || pageNum > limit) continue;

      const slot = container.querySelector(`[data-page="${pageNum}"]`);
      if (!slot || !slot.classList.contains(CONFIG.PAGE_CLASS)) continue;

      try {
        if (scheduler && scheduler.cancelPage) scheduler.cancelPage(pageNum);
      } catch { /* ignore */ }
      try {
        const memory = this.getMemory();
        if (memory && memory.unregisterCanvas) memory.unregisterCanvas(slot);
      } catch { /* ignore */ }

      const cover = this._makeCover(pageNum);
      slot.replaceWith(cover);
    }

    // ── 2. Within the inner band: centre at 100%, rest at 20% ──────────
    //
    // The centre (d === 0) is the page the user is currently reading.
    // It gets the same full-resolution treatment it would have gotten
    // in idle mode. Everything else in the window gets the coarser
    // glance resolution.
    //
    // Resolution is checked per slot, not "is it a canvas". A page that
    // was previously rendered at 20% and is now the centre must upgrade
    // to 100%; a page that was at 100% and is now on the periphery must
    // downgrade to 20%. The slot's data-res attribute records which
    // ring the current bitmap belongs to.
    for (let d = -INNER; d <= INNER; d++) {
      const pageNum = effectiveCentre + d;
      if (pageNum < 1 || pageNum > limit) continue;

      const slot = container.querySelector(`[data-page="${pageNum}"]`);
      if (!slot) continue;

      const isCentre = d === 0;
      const desiredRes = isCentre ? 1.00 : GLANCE_RES;

      const isCanvas = slot.classList.contains(CONFIG.PAGE_CLASS);
      const currentRes = isCanvas ? Number(slot.dataset.res || 0) : 0;

      // Already at the correct resolution — no-op.
      if (Math.abs(currentRes - desiredRes) < 0.01) continue;

      // Cancel any in-flight render for this page at the wrong ring.
      try {
        if (scheduler && scheduler.cancelPage) scheduler.cancelPage(pageNum);
      } catch { /* ignore */ }

      const renderScale = displayScale * desiredRes;

      // The centre render is the highest priority in the system — the
      // user is looking at it. The periphery is ADJACENT: worth doing
      // soon, but never at the cost of the centre.
      const priority = isCentre ? PRIORITY.VISIBLE : PRIORITY.ADJACENT;

      this._enqueueRingRender(pageNum, renderScale, desiredRes, rotation, priority);
    }
  }

  /**
   * IDLE band: the original pyramid. Ring geometry from
   * _ringResolutionForDistance. Every slot reconciles to its ring's
   * resolution; out-of-range slots release to cover.
   *
   * @private
   */
  _reconcilePyramid(container, effectiveCentre, limit, displayScale, rotation, scheduler) {
    const MAX_AHEAD = CONFIG.PYRAMID_MAX_AHEAD;
    const MAX_BEHIND = CONFIG.PYRAMID_MAX_BEHIND;

    for (let d = -MAX_BEHIND; d <= MAX_AHEAD; d++) {
      const pageNum = effectiveCentre + d;
      if (pageNum < 1 || pageNum > limit) continue;

      const desiredRes = this._ringResolutionForDistance(d);
      const slot = container.querySelector(`[data-page="${pageNum}"]`);
      if (!slot) continue;

      const isCanvas = slot.classList.contains(CONFIG.PAGE_CLASS);
      const currentRes = isCanvas ? Number(slot.dataset.res || 0) : 0;

      if (Math.abs(currentRes - desiredRes) < 0.01) continue;

      if (desiredRes === 0) {
        if (isCanvas) {
          try {
            if (scheduler && scheduler.cancelPage) scheduler.cancelPage(pageNum);
          } catch { /* ignore */ }
          try {
            const memory = this.getMemory();
            if (memory && memory.unregisterCanvas) memory.unregisterCanvas(slot);
          } catch { /* ignore */ }

          const cover = this._makeCover(pageNum);
          slot.replaceWith(cover);
        }
        continue;
      }

      try {
        if (scheduler && scheduler.cancelPage) scheduler.cancelPage(pageNum);
      } catch { /* ignore */ }

      const renderScale = displayScale * desiredRes;

      let priority;
      if (desiredRes >= 1.00) priority = PRIORITY.VISIBLE;
      else if (desiredRes >= 0.60) priority = PRIORITY.ADJACENT;
      else priority = PRIORITY.MARGIN;

      this._enqueueRingRender(pageNum, renderScale, desiredRes, rotation, priority);
    }
  }

  /**
   * Resolve a signed distance-from-centre to a bitmap resolution, or 0 for
   * "release to cover".
   *
   * @private
   * @param {number} d
   * @returns {number}
   */
  _ringResolutionForDistance(d) {
    const abs = Math.abs(d);

    if (d >= 0) {
      if (abs <= 5)  return 1.00;
      if (abs <= 9)  return 0.80;
      if (abs <= 12) return 0.60;
      if (abs <= 14) return 0.40;
      if (abs <= 15) return 0.20;
      return 0;
    }

    // Behind: one page at full res for scroll-back, two at 40%, rest freed.
    if (abs <= 1) return 1.00;
    if (abs <= 3) return 0.40;
    return 0;
  }

  /**
   * Enqueue a page render at a specific ring resolution.
   *
   * @private
   */
  _enqueueRingRender(pageNum, renderScale, ringRes, rotation, priority) {
    const scheduler = this.getScheduler();
    if (!scheduler || !scheduler.enqueue) return;

    const job = {
      id: `page:${pageNum}:${renderScale}:${rotation}`,
      kind: 'page',
      pageNum,
      scale: renderScale,
      ringRes,
      rotation,
      tileRect: null,
      priority,
      onComplete: () => { /* handled via RENDER_COMPLETE */ },
      onError: () => { /* handled via RENDER_ERROR */ },
      onCancel: () => { /* handled via RENDER_CANCELLED */ },
    };
    try { scheduler.enqueue(job); } catch { /* ignore */ }
  }

  // ── Private: layout builders ──────────────────────────────────────────────

  async _renderScrollLayout() {
    const els = getViewerElements();
    if (!els || !els.main) return;

    const main = els.main;
    main.classList.add('scroll-view');
    main.classList.remove('page-view');

    let container = main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS);

    if (!container) {
      this._clearViewerMainPreservingChrome();
      container = document.createElement('div');
      container.className = CONFIG.PAGE_CONTAINER_CLASS;

      const totalPages = this._state.get('numPages');
      const previewLimit = this._state.get('previewPageLimit');
      const visibleCount = previewLimit > 0
        ? Math.min(previewLimit, totalPages)
        : totalPages;

      for (let i = 1; i <= visibleCount; i++) {
        container.appendChild(this._makeCover(i));
      }

      if (previewLimit > 0 && totalPages > previewLimit) {
        container.appendChild(this._buildPreviewCTA(previewLimit, totalPages));
      }

      main.appendChild(container);

      this._preloadPageSizes();
    } else {
      try {
        const tm = this.getTileManager();
        if (tm && tm.invalidateAll) tm.invalidateAll();
      } catch { /* ignore */ }
      this._syncSlotDimensions();
    }

    this._updateXAxisLock();

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.recomputeLayout) scroll.recomputeLayout();
    } catch { /* ignore */ }

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.refreshVisible) scroll.refreshVisible();
    } catch { /* ignore */ }

    // Prime the pyramid at the current page so the +5 sharp window renders
    // immediately, not on the first scroll.
    try {
      this._applyPyramidWindow(this._state.get('currentPage') || 1, {
        mode: this._renderMode,
        bias: this._renderBias,
      });
    } catch { /* ignore */ }
  }

  async _renderPageLayout() {
    const els = getViewerElements();
    if (!els || !els.main) return;

    const main = els.main;
    main.classList.add('page-view');
    main.classList.remove('scroll-view');
    this._clearViewerMainPreservingChrome();

    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS;
    main.appendChild(container);

    const rawPageNum = this._state.get('currentPage');
    const pageNum = this.isPageAllowed(rawPageNum)
      ? rawPageNum
      : this.getEffectivePageLimit();

    if (pageNum !== rawPageNum) {
      this._state.set('currentPage', pageNum);
    }

    const meta = await this._ensurePageMetadata(pageNum);
    const cover = this._makeCover(pageNum);
    if (meta) this._applySlotSize(cover, meta);
    container.appendChild(cover);

    this._updateXAxisLock();
    this._enqueuePageRender(pageNum, PRIORITY.VISIBLE);
  }

  /**
   * Single-page render enqueue (page-view mode, single-shot navigation).
   * The pyramid drives scroll-mode rendering; this drives page-mode.
   */
  _enqueuePageRender(pageNum, priority) {
    if (!this.isPageAllowed(pageNum)) return;

    const scheduler = this.getScheduler();
    const scale = this._state.get('scale');
    const rotation = this._state.get('rotation') || 0;

    const job = {
      id: `page:${pageNum}:${scale}:${rotation}`,
      kind: 'page',
      pageNum,
      scale,
      ringRes: 1.0,
      rotation,
      tileRect: null,
      priority,
      onComplete: () => { /* handled via RENDER_COMPLETE */ },
      onError: () => { /* handled via RENDER_ERROR */ },
      onCancel: () => { /* handled via RENDER_CANCELLED */ },
    };

    try {
      if (scheduler && scheduler.enqueue) {
        scheduler.enqueue(job);
      } else if (this._render && this._render.renderer && this._render.renderer.renderJob) {
        const controller = new AbortController();
        const handle = this._render.renderer.renderJob(job, controller);
        if (handle && handle.promise) {
          handle.promise.then(
            (result) => this._onRenderComplete({
              pageNum: result.pageNum,
              scale: result.scale,
              ringRes: 1.0,
              kind: 'page',
              canvas: result.canvas,
            }),
            () => { /* swallow */ },
          );
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * RENDER_COMPLETE handler — the ONLY place a slot transitions from cover
   * to canvas.
   */
  _onRenderComplete(payload) {
    if (!payload || !payload.canvas) return;
    const { pageNum, scale, canvas, kind } = payload;
    if (kind === 'thumbnail' || kind === 'metadata' || kind === 'tile') return;

    const els = getViewerElements();
    if (!els || !els.main) return;

    const slot = els.main.querySelector(`[data-page="${pageNum}"]`);
    if (!slot) return;

    const displayScale = this._state.get('scale') || scale;
    const natW = Number(slot.dataset.naturalWidth);
    const natH = Number(slot.dataset.naturalHeight);

    // Reuse the slot if it's already a canvas; otherwise create one and
    // swap it in place (same dimensions, same data-page).
    let page = slot;
    if (!page.classList.contains(CONFIG.PAGE_CLASS)) {
      page = document.createElement('canvas');
      page.className = CONFIG.PAGE_CLASS;
      page.dataset.page = String(pageNum);
      page.dataset.res = '0';
      if (natW) page.dataset.naturalWidth = String(natW);
      if (natH) page.dataset.naturalHeight = String(natH);
    }

    // Adopt the freshly-rendered bitmap.
    page.width = canvas.width;
    page.height = canvas.height;
    const ctx = page.getContext('2d');
    ctx.clearRect(0, 0, page.width, page.height);
    ctx.drawImage(canvas, 0, 0);

    // Displayed size is ALWAYS natural × displayScale.
    if (natW && natH) {
      const w = natW * displayScale;
      const h = natH * displayScale;
      page.style.width = `${w}px`;
      page.style.height = `${h}px`;
      page.style.minHeight = `${h}px`;
    } else if (canvas.style.width && canvas.style.height) {
      page.style.width = canvas.style.width;
      page.style.height = canvas.style.height;
      page.style.minHeight = page.style.height;
    }

    page.dataset.renderedScale = String(scale);

    // Record the RING resolution so _applyPyramidWindow can decide
    // whether the slot needs upgrading.
    if (typeof payload.ringRes === 'number') {
      page.dataset.res = String(payload.ringRes);
    }

    // Swap cover → canvas. Same slot, same dimensions — paint only.
    if (slot !== page) {
      slot.replaceWith(page);
    }

    // Register the slot canvas with MemoryManager. This is the ONE copy
    // of this page's bitmap that survives — the scratch surface has
    // already been released by the scheduler.
    try {
      const memory = this.getMemory();
      if (memory && typeof memory.registerCanvas === 'function') {
        if (typeof memory.unregisterCanvas === 'function') {
          try { memory.unregisterCanvas(page); } catch { /* ignore */ }
        }
        memory.registerCanvas(page, pageNum, { pinned: false });
      }
    } catch { /* ignore */ }

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.markLayoutDirty) scroll.markLayoutDirty();
    } catch { /* ignore */ }

    this._updateXAxisLock();
  }

  // ── Private: metadata prefetch & sizing ───────────────────────────────────

  async _ensurePageMetadata(pageNum) {
    const cache = this.getCache();
    if (cache && cache.getPageViewport && cache.hasPageViewport && cache.hasPageViewport(pageNum)) {
      return cache.getPageViewport(pageNum);
    }
    try {
      const meta = await this._engine.getPageMetadata(pageNum);
      if (cache && cache.setPageViewport) cache.setPageViewport(pageNum, meta);
      return meta;
    } catch {
      return null;
    }
  }

  async _preloadPageSizes() {
    if (this._pageSizePreloadStarted) return;
    this._pageSizePreloadStarted = true;

    const numPages = this.getEffectivePageLimit();
    const cache = this.getCache();

    const eagerCount = Math.min(numPages, CONFIG.EAGER_METADATA_PAGES);

    const queue = [];
    for (let i = 1; i <= eagerCount; i++) {
      if (cache && cache.hasPageViewport && cache.hasPageViewport(i)) continue;
      queue.push(i);
    }

    const concurrency = Math.max(1, CONFIG.RENDER_CONCURRENCY);
    const worker = async () => {
      while (queue.length > 0) {
        if (this._state.get('isDestroyed')) return;
        const pageNum = queue.shift();
        if (typeof pageNum !== 'number') return;
        try {
          const meta = await this._engine.getPageMetadata(pageNum);
          if (cache && cache.setPageViewport) cache.setPageViewport(pageNum, meta);

          const els = getViewerElements();
          if (els && els.main) {
            const slot = els.main.querySelector(`[data-page="${pageNum}"]`);
            if (slot && slot.classList.contains(CONFIG.COVER_CLASS)) {
              this._applySlotSize(slot, meta);
            }
          }
        } catch {
          // ignore individual failures
        }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
      workers.push(worker());
    }
    await Promise.allSettled(workers);

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.recomputeLayout) scroll.recomputeLayout();
      if (scroll && scroll.refreshVisible) scroll.refreshVisible();
    } catch { /* ignore */ }

    this._updateXAxisLock();
  }

  /**
   * Ensure metadata — and therefore real geometry — for every page in
   * 1..target is cached, and that any existing slot for those pages is
   * sized correctly.
   *
   * WHY THIS EXISTS:
   *   Pages past EAGER_METADATA_PAGES sit as 200px placeholders until
   *   metadata arrives. On a jump to page 500 from page 1, pages 21..500
   *   contribute 480 × 200 = 96,000px to the target's offsetTop — but the
   *   real sum is ~750,000px. scrollIntoView lands on the wrong page and
   *   the viewer appears hung.
   *
   * Called ONLY from ScrollManager.navigateTo.
   *
   * @private
   * @param {number} target
   * @returns {Promise<void>}
   */
  async _preloadSizesUpTo(target) {
    if (!Number.isFinite(target) || target <= 0) return;

    const cache = this.getCache();
    if (!cache) return;

    const engine = this._engine;
    if (!engine || typeof engine.getPageMetadata !== 'function') return;

    const els = getViewerElements();
    const container = els && els.main
      ? els.main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS)
      : null;

    const queue = [];
    for (let i = 1; i <= target; i++) {
      if (cache.hasPageViewport && cache.hasPageViewport(i)) continue;
      queue.push(i);
    }
    if (queue.length === 0) return;

    const concurrency = Math.max(1, CONFIG.RENDER_CONCURRENCY);

    const worker = async () => {
      while (queue.length > 0) {
        const p = queue.shift();
        if (typeof p !== 'number') return;
        try {
          const meta = await engine.getPageMetadata(p);
          if (!meta) continue;
          if (cache.setPageViewport) cache.setPageViewport(p, meta);

          if (container) {
            const slot = container.querySelector(`[data-page="${p}"]`);
            if (slot && slot.classList.contains(CONFIG.COVER_CLASS)) {
              this._applySlotSize(slot, meta);
            }
          }
        } catch { /* ignore individual failures */ }
      }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
      workers.push(worker());
    }
    await Promise.allSettled(workers);

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.recomputeLayout) scroll.recomputeLayout();
    } catch { /* ignore */ }
  }

  /**
   * Compute the fit-to-width scale for page 1 and install it in state.
   *
   * Called:
   *   • Once from _loadPdf before the first layout (scale installed,
   *     no slots exist yet → the sync/apply calls are no-ops).
   *   • Again from setupFitWidthObserver every time #viewer-main's width
   *     changes (rotation, window resize, viewer becoming visible).
   *
   * The second call is what closes the "viewer was hidden at init" gap —
   * slots may already exist from a layout that ran at the default scale,
   * and this method MUST resize them in place. Setting state.scale alone
   * is not enough.
   *
   * IMAGES BAIL OUT:
   *   `_loadImage` computes its own fit-to-width scale from the image's
   *   natural dimensions. `_applyFitToWidth` looks up page 1's metadata
   *   from the page cache, which images do not populate. Running this
   *   method for an image would either compute a wrong scale (if the
   *   cache happens to hold a stale PDF's metadata) or silently bail
   *   after the `if (!meta)` guard. Either way, the early return below
   *   makes the intent explicit.
   */
  async _applyFitToWidth() {
    if (this._state.get('documentKind') === 'image') return;

    try {
      const els = getViewerElements();
      if (!els || !els.main) return;

      let availableWidth = els.main.clientWidth;
      if (!(availableWidth > 0)) {
        availableWidth = await this._waitForViewerWidth(
          els.main,
          CONFIG.FIT_WIDTH_WAIT_TIMEOUT_MS,
        );
        if (!(availableWidth > 0)) return;
      }

      const cache = this.getCache();
      let meta = cache && cache.getPageViewport ? cache.getPageViewport(1) : null;
      if (!meta && this._engine && this._engine.getPageMetadata) {
        try {
          meta = await this._engine.getPageMetadata(1);
          if (meta && cache && cache.setPageViewport) cache.setPageViewport(1, meta);
        } catch { /* ignore */ }
      }
      if (!meta || !(meta.width > 0)) return;

      const usable = Math.max(availableWidth - CONFIG.FIT_WIDTH_H_PADDING_PX, 100);
      const fitScale = clamp(usable / meta.width, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);

      this._state.set('scale', fitScale);
      const zoom = this.getZoom();
      if (zoom && typeof zoom.syncScale === 'function') {
        zoom.syncScale(fitScale);
      }

      this._syncSlotDimensions();
      this._updateXAxisLock();

      try {
        this._applyPyramidWindow(this._state.get('currentPage') || 1, {
          mode: this._renderMode,
          bias: this._renderBias,
        });
      } catch { /* ignore */ }
    } catch { /* keep the default scale */ }
  }

  _waitForViewerWidth(element, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      let ro = null;

      const finish = (w) => {
        if (done) return;
        done = true;
        if (timer) { clearTimeout(timer); timer = null; }
        try { if (ro) ro.disconnect(); } catch { /* ignore */ }
        resolve(typeof w === 'number' && w > 0 ? w : 0);
      };

      try {
        if (typeof ResizeObserver !== 'function') {
          timer = setTimeout(() => finish(element.clientWidth), timeoutMs);
          return;
        }
        ro = new ResizeObserver(() => {
          const w = element.clientWidth;
          if (w > 0) finish(w);
        });
        ro.observe(element);
        timer = setTimeout(() => finish(element.clientWidth), timeoutMs);
      } catch {
        finish(element.clientWidth);
      }
    });
  }

  _clearViewerMainPreservingChrome() {
    const els = getViewerElements();
    if (!els || !els.main) return;
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
  }

  _resetSidebarState() {
    try {
      const drawer = document.getElementById('viewer-outline-drawer');
      if (drawer) {
        drawer.classList.remove('open');
        drawer.setAttribute('aria-hidden', 'true');
        drawer.innerHTML = '';
        drawer.dataset.panel = 'outline';
      }

      const scrim = document.getElementById('viewer-drawer-scrim');
      if (scrim) scrim.classList.remove('open');

      const menuBtn = document.getElementById('viewer-menu-btn');
      if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');

      const menuPanel = document.getElementById('viewer-menu');
      if (menuPanel) menuPanel.hidden = true;

      const searchBar = document.getElementById('viewer-search-bar');
      if (searchBar) searchBar.classList.remove('active');

      const outlineBtn = document.getElementById('viewer-outline-btn');
      if (outlineBtn) outlineBtn.setAttribute('aria-expanded', 'false');
      const searchBtn = document.getElementById('viewer-search-btn');
      if (searchBtn) searchBtn.setAttribute('aria-expanded', 'false');
      const moreBtn = document.getElementById('viewer-more-btn');
      if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
    } catch { /* ignore */ }
  }

  // ── Private: preview policy ───────────────────────────────────────────────

  _applyPreviewPolicy(numPages) {
    if (!this._state.get('previewMode')) {
      this._state.set('previewPageLimit', 0);
      this._state.set('previewBlocked', false);
      return;
    }

    const minPages = CONFIG.PREVIEW_MIN_PAGES_FOR_FRACTIONAL;
    const total = typeof numPages === 'number' && numPages > 0 ? numPages : 1;

    if (total >= minPages) {
      const limit = Math.max(1, Math.floor(total * CONFIG.PREVIEW_PAGE_FRACTION));
      this._state.set('previewPageLimit', limit);
      this._state.set('previewBlocked', false);
    } else {
      this._state.set('previewPageLimit', 0);
      this._state.set('previewBlocked', true);
    }
  }

  _renderPreviewBlocked() {
    const els = getViewerElements();
    if (!els || !els.main) return;

    const main = els.main;
    main.classList.remove('scroll-view');
    main.classList.remove('page-view');
    this._clearViewerMainPreservingChrome();

    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS + ' preview-blocked';
    main.appendChild(container);

    const cache = this.getCache();
    const meta = cache && cache.getPageViewport ? cache.getPageViewport(1) : null;
    const scale = this._state.get('scale') || 1;
    const naturalW = meta && meta.width > 0 ? meta.width : 600;
    const naturalH = meta && meta.height > 0 ? meta.height : 800;

    const availW = Math.max(main.clientWidth - 32, 200);
    const availH = Math.max(main.clientHeight - 32, 260);
    const w = Math.min(naturalW * scale, availW);
    const h = Math.min(naturalH * scale, availH);

    const placeholder = document.createElement('div');
    placeholder.className = `${CONFIG.COVER_CLASS} preview-blocked-placeholder`;
    placeholder.style.width = `${w}px`;
    placeholder.style.height = `${h}px`;
    placeholder.style.minHeight = `${h}px`;
    placeholder.appendChild(this._buildPreviewBlockedBanner());
    container.appendChild(placeholder);

    main.classList.remove(CONFIG.X_SCROLL_CLASS);

    this._bus.emit(Events.LAYOUT_CHANGED, { mode: 'page', container });
  }

  _buildPreviewBlockedBanner() {
    const minPages = CONFIG.PREVIEW_MIN_PAGES_FOR_FRACTIONAL;

    const banner = document.createElement('div');
    banner.className = 'viewer-preview-blocked';

    const inner = document.createElement('div');
    inner.className = 'viewer-preview-blocked-inner';

    const icon = document.createElement('div');
    icon.className = 'viewer-preview-blocked-icon';
    icon.textContent = '🔒';

    const title = document.createElement('h3');
    title.className = 'viewer-preview-blocked-title';
    title.textContent = 'Preview unavailable';

    const body = document.createElement('p');
    body.className = 'viewer-preview-blocked-body';
    body.textContent =
      `This document has fewer than ${minPages} pages. ` +
      `Subscribe to view it in full.`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'viewer-preview-blocked-btn';
    btn.textContent = 'Subscribe to Continue';
    btn.addEventListener('click', () => {
      try {
        this._bus.emit(Events.PREVIEW_SUBSCRIBE_REQUESTED, {
          reason: 'blocked',
          numPages: this._state.get('numPages'),
        });
      } catch { /* ignore */ }
    });

    inner.appendChild(icon);
    inner.appendChild(title);
    inner.appendChild(body);
    inner.appendChild(btn);
    banner.appendChild(inner);
    return banner;
  }

  _buildPreviewCTA(previewLimit, totalPages) {
    const lockedCount = totalPages - previewLimit;
    const cta = document.createElement('div');
    cta.className = 'viewer-preview-cta';

    const inner = document.createElement('div');
    inner.className = 'viewer-preview-cta-inner';

    const icon = document.createElement('div');
    icon.className = 'viewer-preview-cta-icon';
    icon.textContent = '🔒';

    const title = document.createElement('h3');
    title.className = 'viewer-preview-cta-title';
    title.textContent = 'Preview Mode';

    const body = document.createElement('p');
    body.className = 'viewer-preview-cta-body';
    body.textContent =
      `You are previewing the first ${previewLimit} of ${totalPages} pages. ` +
      `Subscribe to unlock the remaining ${lockedCount} ` +
      `${lockedCount === 1 ? 'page' : 'pages'}.`;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'viewer-preview-cta-btn';
    btn.textContent = 'Subscribe to Continue';
    btn.addEventListener('click', () => {
      try {
        this._bus.emit(Events.PREVIEW_SUBSCRIBE_REQUESTED, {
          previewLimit,
          totalPages,
        });
      } catch { /* ignore */ }
    });

    inner.appendChild(icon);
    inner.appendChild(title);
    inner.appendChild(body);
    inner.appendChild(btn);
    cta.appendChild(inner);
    return cta;
  }

  // ── Private: environment detection ────────────────────────────────────────

  /**
   * Build the device profile. Chooses the memory cap from the device's
   * approximate RAM (navigator.deviceMemory, bucketed to powers of two).
   *
   * Falls back to 4 GB when the API is unavailable (Safari, Firefox).
   */
  _detectDeviceProfile() {
    const base = getDeviceProfile();
    const mem = typeof base.deviceMemory === 'number' ? base.deviceMemory : 4;

    let capMb;
    if (base.isLowMemory || mem <= 2) {
      capMb = CONFIG.MEMORY_CAP_LOW_MEMORY_MB;
    } else if (mem <= 4) {
      capMb = CONFIG.MEMORY_CAP_MOBILE_MB;
    } else if (base.isMobile) {
      capMb = CONFIG.MEMORY_CAP_HIGH_MOBILE_MB;
    } else {
      capMb = CONFIG.MEMORY_CAP_DESKTOP_MB;
    }

    return Object.freeze({
      ...base,
      deviceMemory: mem,
      memoryCapBytes: capMb * 1024 * 1024,
    });
  }

  _applyUrlFlagOverrides(baseFlags) {
    const flags = { ...baseFlags };
    try {
      if (typeof window !== 'undefined' && window.location && window.location.search) {
        const params = new URLSearchParams(window.location.search);
        const override = params.get('viewerFlags');
        if (override) {
          for (const raw of override.split(',')) {
            const name = raw.trim();
            if (name && Object.prototype.hasOwnProperty.call(flags, name)) {
              flags[name] = true;
            }
          }
        }
      }
    } catch { /* ignore */ }
    return Object.freeze(flags);
  }

  _assertPdfjsLibPresent() {
    if (typeof window === 'undefined') return;
    if (typeof window.pdfjsLib === 'undefined') {
      throw new Error(
        'pdfjsLib is not available on window. Ensure the PDF.js script is loaded before initialising the viewer.',
      );
    }
  }

  _assertElementIdsPresent() {
    if (!CONFIG.DEBUG_VIEWER) return;
    try {
      const els = getViewerElements();
      if (!els) return;
      const missing = [];
      for (const key of Object.keys(els)) {
        if (key === 'container') continue;
        if (els[key] === null || els[key] === undefined) missing.push(key);
      }
      if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.warn('[Viewer] Missing DOM element keys:', missing.join(', '));
      }
    } catch { /* ignore */ }
  }
}

// ============================================================================
// 7. FACTORY
// ============================================================================

let _singleton = null;

export function createCore() {
  if (_singleton) return _singleton;
  _singleton = new ViewerCore();
  return _singleton;
}

// ============================================================================
// 8. TAIL — utilities for tests
// ============================================================================

export function __resetCoreSingletonForTests() {
  if (_singleton) {
    try { _singleton.destroy(); } catch { /* ignore */ }
    try {
      if (typeof _singleton._nativeTeardown === 'function') {
        _singleton._nativeTeardown();
      }
    } catch { /* ignore */ }
    _singleton._nativeTeardown = null;
  }
  _singleton = null;
}