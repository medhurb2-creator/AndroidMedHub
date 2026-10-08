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
  MEMORY_CAP_MOBILE_MB: 80,
  MEMORY_CAP_DESKTOP_MB: 200,

  // ── Device pixel ratio ────────────────────────────────────────────────────
  MAX_DPR: 2,

  // ── Velocity thresholds ───────────────────────────────────────────────────
  VELOCITY_SUSPEND_PX_PER_FRAME: 40,
  VELOCITY_PREFETCH_MAX: 500,
  PREFETCH_DEPTH_SLOW: 5,
  PREFETCH_DEPTH_FAST: 2,

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
    this._bus = null;
    this._state = null;

    this._engine = null;
    this._render = null;
    this._interaction = null;
    this._managers = null;
    this._workers = null;

    this._initPromise = null;
    this._initialised = false;
    this._destroying = false;

    this._teardowns = [];
    this._nativeTeardown = null;

    this._pageSizePreloadStarted = false;
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
        case 'image':  this._loadImage(normalised); break;
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

    // ── Memory pressure → cancel low-priority render work ─────────────────
    this._teardowns.push(bus.on(Events.MEMORY_PRESSURE, (payload) => {
      if (!payload || payload.level !== 'critical') return;
      try {
        const scheduler = this.getScheduler();
        if (scheduler && scheduler.cancelBelow) {
          scheduler.cancelBelow(PRIORITY.MARGIN);
        }
      } catch { /* ignore */ }
    }));

    // ── RENDER_COMPLETE → install page into its slot ──────────────────────
    this._teardowns.push(bus.on(Events.RENDER_COMPLETE, (payload) => {
      this._onRenderComplete(payload);
    }));

    // ── PAGE_VISIBLE → track current page AND slide the pyramid window ────
    //
    // Every navigation path (scroll, page-jump, swipe, outline click, search
    // match) converges on PAGE_VISIBLE. Sliding the pyramid here means the
    // window always tracks the current page regardless of how the user got
    // there, and it guarantees the +5 page is already enqueued by the time
    // the user's next scroll frame begins.
    this._teardowns.push(bus.on(Events.PAGE_VISIBLE, (payload) => {
      if (!payload || typeof payload.pageNum !== 'number') return;

      const prev = this._state.get('currentPage');
      if (prev === payload.pageNum) return;

      this._state.set('currentPage', payload.pageNum);

      // Slide the ring boundaries. Five pages change ring per step — all
      // five upgrades fire in the same tick through the scheduler.
      try { this._applyPyramidWindow(payload.pageNum); } catch { /* ignore */ }
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
      try { this._applyPyramidWindow(this._state.get('currentPage') || 1); } catch { /* ignore */ }
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

  async _loadPdf(blob) {
    const arrayBuffer = await blob.arrayBuffer();

    const handle = await this._engine.loadDocument(arrayBuffer, {
      onProgress: (progress) => { void progress; },
    });

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

  _loadImage(blob) {
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

    // The image IS the page — wrap it in .page-container so zoom/pan attach.
    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS;

    const img = document.createElement('img');
    img.className = CONFIG.PAGE_CLASS;
    img.src = createObjectURL(blob);
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.objectFit = 'contain';
    img.style.transformOrigin = 'center center';
    img.style.display = 'block';

    container.appendChild(img);
    main.appendChild(container);

    if (els.footer) els.footer.style.display = 'none';

    this._updateXAxisLock();
    this._bus.emit(Events.LAYOUT_CHANGED, { mode: 'page', container });

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
      // width intentionally unset — resolved by the container once page 1
      // metadata arrives.
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
   * Called on zoom settle, after metadata arrives, and after rotation.
   * Never touches the bitmap — resolution is the renderer's concern.
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
   *
   * CSS rule: #viewer-main is overflow-x: hidden by default, which locks
   * X and lets margin: 0 auto centre the page. When the page is wider than
   * the viewport, we add .x-scroll and the browser gives a native X
   * scrollbar.
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

  // ── Private: resolution pyramid ──────────────────────────────────────────

  /**
   * Slide the resolution pyramid so the window is centred on `centerPage`.
   *
   * Forward rings (distance d from the centre):
   *   d = 0..5   → 100%   (full resolution)
   *   d = 6..9   →  80%
   *   d = 10..12 →  60%
   *   d = 13..14 →  40%
   *   d = 15     →  20%
   *   d ≥ 16     → plain cover (canvas released)
   *
   * Behind rings:
   *   d = -1     → 100%   (one page kept warm for quick scroll-back)
   *   d = -2..-3 →  40%
   *   d ≤ -4     → plain cover
   *
   * Because every page's resolution depends only on its distance from the
   * centre, a single page step moves the ring boundaries by one — so exactly
   * five pages change ring per step:
   *
   *   +6  80%   → 100%
   *   +10 60%   →  80%
   *   +13 40%   →  60%
   *   +15 20%   →  40%
   *   +16 cover →  20%
   *
   * All five upgrades are enqueued in the same tick. Concurrency is
   * RENDER_CONCURRENCY (up to 6). Every upgrade is a re-render of a page
   * whose PDF.js operator list is already cached, so each completes in
   * roughly 40–90 ms on desktop. The +5 page (the page the user is about
   * to scroll onto) is sharp well within 150 ms.
   *
   * Idempotent: calling it twice with the same centre is a no-op.
   *
   * @private
   * @param {number} centerPage
   */
  _applyPyramidWindow(centerPage) {
    if (!Number.isFinite(centerPage)) return;
    if (this._state.get('previewBlocked')) return;

    const els = getViewerElements();
    const container = els && els.main
      ? els.main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS)
      : null;
    if (!container) return;

    const limit = this.getEffectivePageLimit();
    const displayScale = this._state.get('scale') || 1;
    const rotation = this._state.get('rotation') || 0;
    const scheduler = this.getScheduler();

    const MAX_AHEAD = CONFIG.PYRAMID_MAX_AHEAD;
    const MAX_BEHIND = CONFIG.PYRAMID_MAX_BEHIND;

    for (let d = -MAX_BEHIND; d <= MAX_AHEAD; d++) {
      const pageNum = centerPage + d;
      if (pageNum < 1 || pageNum > limit) continue;

      const desiredRes = this._ringResolutionForDistance(d);
      const slot = container.querySelector(`[data-page="${pageNum}"]`);
      if (!slot) continue;

      const isCanvas = slot.classList.contains(CONFIG.PAGE_CLASS);
      const currentRes = isCanvas ? Number(slot.dataset.res || 0) : 0;

      // Already at the correct resolution — no-op.
      if (Math.abs(currentRes - desiredRes) < 0.01) continue;

      // Desired 0 → release the canvas and drop back to a plain cover.
      if (desiredRes === 0) {
        if (isCanvas) {
          try {
            if (scheduler && scheduler.cancelPage) scheduler.cancelPage(pageNum);
          } catch { /* ignore */ }

          // Unregister from MemoryManager before the element is dropped.
          try {
            const memory = this.getMemory();
            if (memory && memory.unregisterCanvas) memory.unregisterCanvas(slot);
          } catch { /* ignore */ }

          const cover = this._makeCover(pageNum);
          slot.replaceWith(cover);
        }
        continue;
      }

      // Cancel any in-flight render for this page at the old ring — the
      // pyramid wants exactly one render per page at a time.
      try {
        if (scheduler && scheduler.cancelPage) scheduler.cancelPage(pageNum);
      } catch { /* ignore */ }

      // renderScale is the BITMAP density. The slot's DISPLAY size stays
      // natural × displayScale (see _syncSlotDimensions / _applySlotSize).
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
      // Forward-biased pyramid.
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
   * Job shape matches _enqueuePageRender but carries `ringRes` so
   * _onRenderComplete can record it on the slot's dataset. The job id
   * includes the render scale and rotation — but NOT the ringRes — so
   * re-enqueueing the same page at a different ring is naturally
   * de-duplicated against a still-running older render at the same scale
   * (which the pyramid has already cancelled via scheduler.cancelPage).
   *
   * @private
   * @param {number} pageNum
   * @param {number} renderScale
   * @param {number} ringRes
   * @param {number} rotation
   * @param {number} priority
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
   *
   * Invariants enforced here:
   *   • The slot's rendered size is natural × displayScale — the same for
   *     cover, thumbnail, and full canvas.
   *   • Swapping a cover for a canvas is a paint event, not a layout event.
   *     Same size, same position, no scroll jump.
   *   • The rendered bitmap density differs by ring; the CSS size does
   *     not. `data-res` records the ring this bitmap belongs to so
   *     _applyPyramidWindow can decide whether the slot needs upgrading.
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

    // Record the RING resolution. This is what _applyPyramidWindow reads
    // to decide whether the slot is already at the right level.
    if (typeof payload.ringRes === 'number') {
      page.dataset.res = String(payload.ringRes);
    }

    // Swap cover → canvas. Same slot, same dimensions — paint only.
    if (slot !== page) {
      slot.replaceWith(page);
    }

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
   */
  async _applyFitToWidth() {
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

      // Resize every slot that already exists. A no-op the first time
      // (no slots yet). This is what makes the "viewer was hidden during
      // initial load, then shown" path end up fit-to-width instead of
      // stuck at the default scale.
      this._syncSlotDimensions();
      this._updateXAxisLock();

      // Recompute the pyramid so the +5 window renders at the new scale.
      try { this._applyPyramidWindow(this._state.get('currentPage') || 1); } catch { /* ignore */ }
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

  _detectDeviceProfile() {
    const base = getDeviceProfile();
    const capMb = (base.isMobile || base.isLowMemory)
      ? CONFIG.MEMORY_CAP_MOBILE_MB
      : CONFIG.MEMORY_CAP_DESKTOP_MB;

    return Object.freeze({
      ...base,
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