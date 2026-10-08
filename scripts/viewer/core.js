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
 * Performance posture:
 *   All FEATURES flags default to TRUE — the viewer boots with the full
 *   optimized pipeline by default:
 *     • Priority-queue render scheduling with cancellation
 *     • Byte-accounted LRU caches with device-tuned caps
 *     • Hybrid tiled rendering for large pages
 *     • Worker-offloaded search
 *     • Velocity-aware rasterization throttling
 *     • Two-phase zoom (GPU transform → async re-raster)
 *     • rAF-batched pan writes
 *     • Directional render-ahead prefetch (5 pages)
 *     • Low-resolution thumbnail placeholders
 *     • Full EngineAdapter routing (ready for PDFium-WASM swap)
 *
 *   To diagnose a specific subsystem, turn its flag off via the URL:
 *     ?viewerFlags=USE_SCHEDULER,USE_TILING
 *   This *enables* the listed flags on top of the defaults — it does not
 *   disable them. To disable a flag permanently, edit the value in CONFIG.
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
 *         first page. This applies to every document kind — PDF, image,
 *         text, office, unsupported.
 *
 *   Preview mode is scoped to premium catalogue resources opened by
 *   unsubscribed users. External files (file picker, Android intent) and
 *   subscribed users are never affected.
 *
 * Android / Capacitor posture:
 *   `_doInit` calls `setupNativeBridge(this)`, which wires the Android back
 *   button, immersive-mode status bar, keep-awake, and file intents through
 *   `native-bridge.js`. Every native call has a web fallback, so `npm run dev`
 *   works unchanged. Device detection delegates to `platform.js`, which is
 *   the single source of truth for environment questions.
 *
 * Layout invariants:
 *   • The page canvas is the page. `.canvas-wrapper` is a transparent
 *     positioning context only — no clipping, no contain, no fixed size.
 *     Its size tracks the canvas via `_onRenderComplete`.
 *   • #viewer-main is the scroll surface. It scrolls on BOTH axes
 *     (`overflow: auto; touch-action: pan-x pan-y` in CSS) so landscape and
 *     zoomed content is reachable without a pan transform.
 *   • Off-screen pages are skipped in layout/paint by `content-visibility:
 *     auto` on the wrapper (restored, safely, because the wrapper now
 *     always tracks its canvas).
 *
 * Destroy semantics:
 *   `destroy()` runs on every document switch AND on explicit viewer close.
 *   It tears down the engine, workers, scheduler, caches, and state, and it
 *   clears the viewer DOM via `clearViewerContent()` so the next document
 *   starts from a blank slate. The four static chrome nodes declared in
 *   viewer.html (#viewer-loading, #viewer-progress, #viewer-content,
 *   #viewer-text-layer) survive the clear.
 *
 *   The sidebar drawer, its scrim, and every toggle's aria-expanded state
 *   are also reset so the next open starts from a clean, closed state.
 *
 * Import discipline:
 *   • Imports only from ./utils.js and the sibling subsystem factories.
 *   • NEVER imports from ../content.js, ../subscription.js, ../ui.js, ../router.js.
 *   • Is imported by viewer.js only.
 *
 * Cycle resolution:
 *   Sub-modules import { CONFIG, Events, PRIORITY, MIME_TYPES } from './core.js'.
 *   This is safe because:
 *     1. Neither side uses those bindings at module-evaluation time.
 *     2. Their exported consts are hoisted before any sub-module import executes.
 *     3. A dev assertion in createCore() verifies they resolved.
 *
 * Bootstrap ordering (critical):
 *   During `_doInit()`, subsystem factories call `core.getBus()` and
 *   `core.getState()` while `_initialised` is still false. The getters
 *   therefore check the resource they return — not the global `_initialised`
 *   flag — so that factories can read flags and subscribe to the bus as soon
 *   as those resources exist.
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

// Re-export so that consumers of core get MIME_TYPES without a separate import.
export { MIME_TYPES };

// ============================================================================
// PRIVATE HELPERS
// ============================================================================

/**
 * Recursively freeze an object graph. Used to protect CONFIG and PRIORITY
 * from accidental mutation. Arrays are frozen too.
 *
 * @param {any} obj
 * @returns {any}
 */
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
 * Deep-frozen. Any attempted mutation throws in strict mode.
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
  // Android convention: single tap toggles chrome, double tap toggles zoom.
  // Triple tap is not recognized (conflicts with long-press text selection).
  TAP_SEQUENCE_GAP_MS: 350,
  DOUBLE_SETTLE_MS: 250,

  // Multiplier applied by the double-tap zoom toggle. The toggle is always
  // viewport-centered.
  MAGNIFY_FACTOR: 2.0,

  // ── Preview mode ──────────────────────────────────────────────────────────
  // When a premium catalogue resource is opened without an active
  // subscription, this fraction of the document's pages are rendered and a
  // subscribe CTA is appended after the last preview page.
  PREVIEW_PAGE_FRACTION: 0.10,

  // Documents with this many pages or more use the fractional preview cap.
  // Documents with fewer pages are fully blocked — no content renders, the
  // first page is replaced by a subscribe banner. Applies to every document
  // kind, including single-page images / text / office files.
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
  // 5 pages above/below the current page are kept warm while scrolling
  // slowly. At high velocity, only 2 pages — the visible set moves fast
  // enough that deeper prefetch would waste render budget on pages the
  // user has already passed.
  PREFETCH_DEPTH_SLOW: 5,
  PREFETCH_DEPTH_FAST: 2,

  // ── Render concurrency ────────────────────────────────────────────────────
  // Bounded by hardwareConcurrency - 1 to leave one core for the main thread.
  // Capped at 6 to let modern phones and tablets overlap engine work with
  // canvas composition. PDF.js worker contention is the practical ceiling;
  // beyond 6, additional concurrency slows total throughput on most devices.
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

  // ── Worker script paths ───────────────────────────────────────────────────
  WORKER_PATHS: {
    search: './viewer/search.worker.js',
    parser: './viewer/parser.worker.js',
  },

  // ── DOM contracts (class names, storage keys) ─────────────────────────────
  SEARCH_LAYER_CLASS: 'search-layer',
  SEARCH_HIGHLIGHT_CLASS: 'search-highlight active',
  CANVAS_WRAPPER_CLASS: 'canvas-wrapper',
  PAGE_CONTAINER_CLASS: 'page-container',
  PDF_CANVAS_CLASS: 'pdf-canvas',
  VIEW_MODE_STORAGE_KEY: 'viewer-viewMode',

  // ── Fit-to-width layout ───────────────────────────────────────────────────
  // Horizontal padding (px) subtracted from the content area width when
  // computing the initial fit-to-width scale.
  FIT_WIDTH_H_PADDING_PX: 32,

  // Maximum time (ms) to wait for #viewer-main to have a non-zero width
  // before giving up on fit-to-width. Prevents the viewer from hanging if
  // the container is never shown.
  FIT_WIDTH_WAIT_TIMEOUT_MS: 2000,

  // ── Metadata prefetch ─────────────────────────────────────────────────────
  // Eagerly fetch page metadata for the first N pages so the initial
  // scrollbar geometry is approximately correct. Pages past N are fetched
  // on demand when the scroll viewport approaches them.
  EAGER_METADATA_PAGES: 20,

  // ── Dev-mode flags (not feature flags; gate diagnostics) ──────────────────
  DEBUG_VIEWER: false,
  DEBUG_WORKERS: false,
  DEBUG_MEMORY: false,

  // ── Feature flags ─────────────────────────────────────────────────────────
  //
  // All performance features are enabled by default. This is the tuned
  // configuration for production: every subsystem ships its optimized path.
  //
  // Each flag can be turned off individually to diagnose a specific subsystem
  // or to recover a fallback path if an edge case is discovered. The fallback
  // paths are the exact behaviour of the previous monolithic viewer.
  //
  // Flags and their subsystems:
  //   USE_WORKER_SEARCH       → managers.SearchManager → workers / search.worker.js
  //   USE_SCHEDULER           → render.RenderScheduler priority queue
  //   USE_TILING              → render.TileManager hybrid canvas/tile decision
  //   USE_ENGINE_ADAPTER      → engine.EngineAdapter routes all PDF.js calls
  //   USE_LRU_CACHES          → managers.LRUCache + MemoryManager caps
  //   USE_VELOCITY_THROTTLE   → interaction.ScrollManager pause/resume
  //   USE_TWO_PHASE_ZOOM      → interaction.ZoomManager GPU transform
  //   USE_RAF_PAN             → interaction.PanManager rAF-batched writes
  //   USE_RENDER_PREFETCH     → interaction.ScrollManager directional prefetch
  //   USE_LOW_RES_PLACEHOLDER → render.TileManager pinned thumbnails
  //   USE_PARSER_WORKER       → workers / parser.worker.js (Phase 5 stub)
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

/**
 * Task priority bands. Lower numeric value = higher priority. Strictly
 * monotonic; the scheduler sorts ascending.
 *
 * @readonly
 * @enum {number}
 */
export const PRIORITY = deepFreeze({
  VISIBLE: 1,
  ADJACENT: 2,
  MARGIN: 3,
  IDLE: 4,
});

// ============================================================================
// 3. EVENTS
// ============================================================================

/**
 * Every event name emitted or subscribed to within the viewer subsystem.
 * Value strings use colon-separated namespaces.
 *
 * @readonly
 */
export const Events = deepFreeze({
  // Core lifecycle
  CORE_READY: 'core:ready',
  DOCUMENT_LOADING: 'document:loading',
  DOCUMENT_LOADED: 'document:loaded',
  DOCUMENT_ERROR: 'document:error',
  DOCUMENT_DESTROYING: 'document:destroying',
  DOCUMENT_DESTROYED: 'document:destroyed',

  // Layout
  LAYOUT_CHANGED: 'layout:changed',

  // Navigation
  PAGE_VISIBLE: 'page:visible',
  PAGE_JUMP_REQUESTED: 'page:jump-requested',
  NAV_BACK_REQUESTED: 'nav:back-requested',

  // Zoom / scale
  SCALE_REQUESTED: 'scale:requested',
  SCALE_APPLIED: 'scale:applied',
  ZOOM_GESTURE_START: 'zoom:gesture-start',
  ZOOM_GESTURE_END: 'zoom:gesture-end',

  // Rotation
  ROTATE_REQUESTED: 'rotate:requested',
  ROTATION_APPLIED: 'rotation:applied',

  // Panning / gestures
  // Android convention: single tap toggles chrome, double tap toggles zoom.
  SINGLE_TAP: 'single-tap',
  DOUBLE_TAP: 'double-tap',
  TRIPLE_TAP: 'triple-tap', // reserved; not emitted by default UI
  SWIPE: 'swipe',
  PAN_START: 'pan:start',
  PAN_END: 'pan:end',
  INTERACTION_ACTIVITY: 'interaction:activity',
  SCROLL_VELOCITY: 'scroll:velocity',

  // Rendering
  RENDER_ENQUEUE: 'render:enqueue',
  RENDER_START: 'render:start',
  RENDER_COMPLETE: 'render:complete',
  RENDER_CANCELLED: 'render:cancelled',
  RENDER_ERROR: 'render:error',
  TILE_VISIBLE_SET: 'tile:visible-set',

  // Search
  SEARCH_STARTED: 'search:started',
  SEARCH_PROGRESS: 'search:progress',
  SEARCH_COMPLETED: 'search:completed',
  SEARCH_MATCH_FOCUSED: 'search:match-focused',
  SEARCH_CLEARED: 'search:cleared',

  // Outline
  OUTLINE_READY: 'outline:ready',

  // Memory
  MEMORY_PRESSURE: 'memory:pressure',
  MEMORY_REPORT: 'memory:report',

  // Workers
  WORKER_READY: 'worker:ready',
  WORKER_PROGRESS: 'worker:progress',
  WORKER_ERROR: 'worker:error',
  WORKER_TERMINATED: 'worker:terminated',

  // App-level intents
  LOCAL_FILE_OPEN_REQUESTED: 'local-file:open-requested',

  // Network
  NETWORK_OFFLINE: 'network:offline',

  // Preview-mode subscribe CTA. Emitted by the CTA card that core inserts
  // after the last preview page, and by the blocked-preview banner. Handled
  // by viewer.js, which routes the user to the subscription page.
  PREVIEW_SUBSCRIBE_REQUESTED: 'preview:subscribe-requested',

  // State change
  STATE_CHANGED: 'state:changed',
});

// ============================================================================
// 4. EVENT BUS
// ============================================================================

/**
 * Synchronous publish/subscribe hub. Deliberately minimal — no wildcards,
 * no async dispatch, no handler priorities.
 *
 * Reentrancy-safe: emitting an event from within a handler is supported
 * (iteration snapshots the listener list at emission start).
 *
 * Fault-isolated: a handler that throws does not prevent later handlers from
 * running; the error is caught and swallowed.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void}
   */
  on(event, handler) {
    if (typeof event !== 'string' || typeof handler !== 'function') {
      return () => {};
    }
    let set = this._handlers.get(event);
    if (!set) {
      set = new Set();
      this._handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {void}
   */
  off(event, handler) {
    const set = this._handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._handlers.delete(event);
  }

  /**
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void}
   */
  once(event, handler) {
    if (typeof handler !== 'function') return () => {};
    /** @type {Function} */
    const wrapper = (...args) => {
      this.off(event, wrapper);
      try { handler(...args); } catch { /* swallow */ }
    };
    return this.on(event, wrapper);
  }

  /**
   * @param {string} event
   * @param {any} [payload]
   * @returns {void}
   */
  emit(event, payload) {
    const set = this._handlers.get(event);
    if (!set || set.size === 0) return;
    const snapshot = Array.from(set);
    for (const handler of snapshot) {
      try { handler(payload); } catch { /* swallow */ }
    }
  }

  /**
   * @param {string} [event]
   * @returns {void}
   */
  clear(event) {
    if (event === undefined) {
      this._handlers.clear();
      return;
    }
    this._handlers.delete(event);
  }

  /**
   * @param {string} event
   * @returns {number}
   */
  listenerCount(event) {
    const set = this._handlers.get(event);
    return set ? set.size : 0;
  }
}

// ============================================================================
// 5. VIEWER STATE
// ============================================================================

/**
 * Frozen defaults. `reset()` restores from this object, preserving only
 * `flags`, `deviceProfile`, and `initTimestamp`.
 * @private
 */
const DEFAULT_STATE = Object.freeze({
  docId: null,
  mimeType: null,
  title: '',
  isLocalFile: false,
  documentKind: null,
  previewMode: false,
  previewPageLimit: 0, // 0 = no limit (subscribed, non-PDF, or not a preview)
  previewBlocked: false, // true = document fully blocked (fewer than N pages)
  isLoading: false,
  error: null,

  numPages: 1,
  currentPage: 1,
  outline: [],

  scale: 1.0,
  rotation: 0, // 0 | 90 | 180 | 270 (clockwise)
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

/**
 * Observable state container. Every mutation goes through `set()` or
 * `patch()`, which emit change events only when the value actually changes.
 */
export class ViewerState {
  /**
   * @param {EventBus} bus
   */
  constructor(bus) {
    this._bus = bus;
    /** @type {Record<string, any>} */
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
    } catch {
      // localStorage may be unavailable (Safari private mode, etc.)
    }

    try {
      const rawDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      this._data.dpr = clamp(rawDpr, 1, CONFIG.MAX_DPR);
    } catch {
      this._data.dpr = 1;
    }
  }

  /**
   * @param {string} key
   * @returns {any}
   */
  get(key) {
    return this._data[key];
  }

  /**
   * @param {string} key
   * @param {any} value
   * @returns {void}
   */
  set(key, value) {
    const prev = this._data[key];
    if (Object.is(prev, value)) return;
    this._data[key] = value;
    const payload = { key, prev, next: value };
    this._bus.emit(Events.STATE_CHANGED, payload);
    this._bus.emit(`${Events.STATE_CHANGED}:${key}`, payload);
  }

  /**
   * @param {Record<string, any>} partial
   * @returns {void}
   */
  patch(partial) {
    if (!partial || typeof partial !== 'object') return;
    for (const key of Object.keys(partial)) {
      this.set(key, partial[key]);
    }
  }

  /**
   * @returns {Record<string, any>}
   */
  snapshot() {
    const copy = {};
    for (const key of Object.keys(this._data)) {
      const value = this._data[key];
      if (Array.isArray(value)) {
        copy[key] = value.slice();
      } else if (value && typeof value === 'object') {
        copy[key] = { ...value };
      } else {
        copy[key] = value;
      }
    }
    return copy;
  }

  /**
   * @returns {void}
   */
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

  /**
   * @param {string} key
   * @param {(payload: { key: string, prev: any, next: any }) => void} handler
   * @returns {() => void}
   */
  subscribe(key, handler) {
    return this._bus.on(`${Events.STATE_CHANGED}:${key}`, handler);
  }
}

// ============================================================================
// 6. VIEWER CORE
// ============================================================================

/**
 * The orchestrator. Owns the bus, the state, and every subsystem. Delegates
 * every meaningful action to the subsystem that owns the concern.
 */
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
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Idempotent initialisation. Subsequent calls return the same in-flight
   * promise; a failed init can be retried by calling init() again (the
   * promise is cleared on rejection).
   *
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initialised) return;
    if (this._initPromise) return this._initPromise;

    const p = this._doInit();
    this._initPromise = p;

    try {
      await p;
    } catch (err) {
      // Allow a retry after a failed init.
      this._initPromise = null;
      throw err;
    }
  }

  /**
   * Load a document. Never throws — errors are emitted via `document:error`.
   *
   * @param {Blob} blob
   * @param {string|null} [fileType]
   * @param {string} [title]
   * @param {{ previewMode?: boolean }|null} [opts]
   *   Optional hints. When `previewMode` is true, the preview policy
   *   applies: for documents with >= PREVIEW_MIN_PAGES_FOR_FRACTIONAL
   *   pages, the first fraction is rendered with a subscribe CTA; for
   *   documents with fewer pages, the entire document is blocked and a
   *   subscribe banner replaces the first page.
   * @returns {Promise<void>}
   */
  async loadDocument(blob, fileType = null, title = 'Document', opts = null) {
    if (!this._state) {
      throw new Error('ViewerCore not initialised. Call init() first.');
    }

    // Destroy any previous document before starting a new one.
    if (this._state.get('docId') !== null || this._state.get('documentKind') !== null) {
      this.destroy();
    }

    // Apply the preview hint AFTER destroy(), because destroy() resets state
    // and would otherwise clear these fields. Set the initial limits to 0 /
    // false here; the loaders compute the actual policy once the page count
    // is known.
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
        case 'pdf':
          await this._loadPdf(normalised);
          break;
        case 'image':
          this._loadImage(normalised);
          break;
        case 'text':
          await this._loadText(normalised);
          break;
        case 'office':
          this._loadOffice(normalised);
          break;
        default:
          this._loadUnsupported(normalised);
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

  /**
   * Canonical teardown. Idempotent.
   *
   * Runs on every document switch AND on explicit viewer close. Clears the
   * viewer DOM via `clearViewerContent()` so the next document starts from
   * a blank slate — page containers, canvases, search overlays, error
   * containers, and the preview-mode CTA are removed; the four static
   * chrome nodes from viewer.html are preserved.
   *
   * Also resets the sidebar drawer, its scrim, every toggle's aria-expanded
   * state, and the outline drawer's dataset — so the next open starts from
   * a clean, closed state.
   *
   * @returns {void}
   */
  destroy() {
    if (this._destroying) return;
    if (!this._state) return;
    this._destroying = true;

    try {
      this._bus.emit(Events.DOCUMENT_DESTROYING, {});

      // 1. Cancel all scheduler work.
      try {
        const scheduler = this._render && this._render.scheduler;
        if (scheduler && typeof scheduler.cancelAll === 'function') {
          const result = scheduler.cancelAll();
          if (result && typeof result.catch === 'function') {
            result.catch(() => {});
          }
        }
      } catch { /* ignore */ }

      // 2. Abort any in-flight search.
      try {
        if (this._managers && this._managers.search && this._managers.search.cancel) {
          this._managers.search.cancel();
        }
      } catch { /* ignore */ }

      // 3. Release cached canvases BEFORE engine destroy (safe ordering).
      try {
        if (this._managers && this._managers.cache && this._managers.cache.evictAll) {
          this._managers.cache.evictAll();
        }
      } catch { /* ignore */ }

      // 4. Revoke all blob URLs (registered via utils.createObjectURL).
      try {
        revokeAllObjectURLs();
      } catch { /* ignore */ }

      // 5. Destroy the engine (releases PDF.js document + worker).
      try {
        if (this._engine && this._engine.destroy) {
          const result = this._engine.destroy();
          if (result && typeof result.catch === 'function') {
            result.catch(() => {});
          }
        }
      } catch { /* ignore */ }

      // 6. Terminate workers.
      try {
        if (this._workers && this._workers.terminateAll) {
          this._workers.terminateAll('document destroyed');
        }
      } catch { /* ignore */ }

      // 7. Unmount UI chrome (only has an effect in embedded mode; safe always).
      try {
        unmountChrome(this);
      } catch { /* ignore */ }

      // 7b. Clear the viewer DOM so the next document starts from a blank
      //     slate. Preserves the four static chrome nodes declared in
      //     viewer.html: #viewer-loading, #viewer-progress, #viewer-content,
      //     #viewer-text-layer.
      try {
        clearViewerContent();
      } catch { /* ignore */ }

      // 7c. Reset sidebar / scrim / toggle ARIA state.
      this._resetSidebarState();

      // 8. Core's own cross-module subscriptions (in `_teardowns`) and the
      //    native bridge subscriptions are VIEWER-LIFETIME. They must survive
      //    a document switch so the RENDER_COMPLETE handler and the back
      //    button handler remain live.

      // 9. Reset state.
      this._state.reset();
      this._state.set('isDestroyed', false);
      this._state.set('rotation', 0);
      this._pageSizePreloadStarted = false;

      // 10. Notify.
      this._bus.emit(Events.DOCUMENT_DESTROYED, {});
    } finally {
      this._destroying = false;
    }
  }

  /**
   * Re-render the current layout. Delegates structural DOM work to core and
   * canvas production to the render pipeline.
   *
   * When the document is in blocked-preview mode, the banner is re-rendered
   * instead of a layout — no pages, no wrappers, no canvases.
   *
   * @returns {Promise<void>}
   */
  async renderCurrentLayout() {
    if (!this._state) return;

    // Blocked preview — no layout is possible. Re-render the banner.
    if (this._state.get('previewBlocked')) {
      this._renderPreviewBlocked();
      return;
    }

    const viewMode = this._state.get('viewMode');
    this._bus.emit(Events.LAYOUT_CHANGED, { mode: viewMode });

    if (viewMode === 'scroll') {
      await this._renderScrollLayout();
    } else {
      await this._renderPageLayout();
    }
  }

  // ── Subsystem getters ─────────────────────────────────────────────────────
  //
  // IMPORTANT: these getters are called by subsystem factories DURING init(),
  // before `_initialised` becomes true. Each getter therefore checks its own
  // resource — not the global `_initialised` flag — so that factories can
  // read state/flags and subscribe to the bus while the pipeline is still
  // assembling.

  /** @returns {EventBus} */
  getBus() {
    if (!this._bus) {
      throw new Error('ViewerCore bus is not ready yet.');
    }
    return this._bus;
  }

  /** @returns {ViewerState} */
  getState() {
    if (!this._state) {
      throw new Error('ViewerCore state is not ready yet.');
    }
    return this._state;
  }

  /** @returns {any} */
  getEngine() {
    if (!this._engine) {
      throw new Error('ViewerCore engine is not ready yet.');
    }
    return this._engine;
  }

  /** @returns {any} */
  getScheduler() {
    return this._render ? this._render.scheduler : null;
  }

  /** @returns {any} */
  getTileManager() {
    return this._render ? this._render.tileManager : null;
  }

  /** @returns {any} */
  getRenderer() {
    return this._render ? this._render.renderer : null;
  }

  /** @returns {any} */
  getCache() {
    return this._managers ? this._managers.cache : null;
  }

  /** @returns {any} */
  getMemory() {
    return this._managers ? this._managers.memory : null;
  }

  /** @returns {any} */
  getSearch() {
    return this._managers ? this._managers.search : null;
  }

  /** @returns {any} */
  getOutline() {
    return this._managers ? this._managers.outline : null;
  }

  /**
   * The full managers aggregate. Exposes `dispatchPanel(panel)` so ui-internal
   * can force a panel render after opening the sidebar.
   *
   * @returns {any}
   */
  getManagers() {
    return this._managers;
  }

  /** @returns {any} */
  getScroll() {
    return this._interaction ? this._interaction.scroll : null;
  }

  /** @returns {any} */
  getZoom() {
    return this._interaction ? this._interaction.zoom : null;
  }

  /** @returns {any} */
  getPan() {
    return this._interaction ? this._interaction.pan : null;
  }

  /** @returns {any} */
  getGestures() {
    return this._interaction ? this._interaction.gestures : null;
  }

  /** @returns {any} */
  getWorkers() {
    return this._workers;
  }

  /**
   * Effective page count for layout, navigation, and render scheduling.
   * Returns the preview limit when in fractional preview mode, otherwise
   * the real total. When blocked, returns 1 so callers that expect a
   * positive number do not break — the blocked placeholder is the only
   * "page" and it is not navigable. Zero is never returned.
   *
   * @returns {number}
   */
  getEffectivePageLimit() {
    if (!this._state) return 1;

    if (this._state.get('previewBlocked')) return 1;

    const limit = this._state.get('previewPageLimit');
    if (limit > 0) return limit;

    const total = this._state.get('numPages');
    return typeof total === 'number' && total > 0 ? total : 1;
  }

  /**
   * @param {number} pageNum
   * @returns {boolean} true if the page may be rendered and navigated to.
   */
  isPageAllowed(pageNum) {
    if (!Number.isFinite(pageNum)) return false;
    if (this._state && this._state.get('previewBlocked')) return false;
    return pageNum >= 1 && pageNum <= this.getEffectivePageLimit();
  }

  /**
   * Facade exposing ui-internal functions that consumers may need to drive.
   *
   * @returns {{
   *   mountChrome: () => void,
   *   unmountChrome: () => void,
   *   refreshElementCache: () => any,
   *   injectViewerStyles: () => void,
   *   showHeaderFooter: () => void,
   *   hideHeaderFooter: () => void,
   *   resetAutoHideTimer: () => void,
   * }}
   */
  getUI() {
    const core = this;
    return {
      mountChrome: () => mountChrome(core),
      unmountChrome: () => unmountChrome(core),
      refreshElementCache: () => refreshElementCache(),
      injectViewerStyles: () => injectViewerStyles(),
      showHeaderFooter: () => {
        core.getBus().emit(Events.INTERACTION_ACTIVITY, {});
      },
      hideHeaderFooter: () => { /* no-op facade stub */ },
      resetAutoHideTimer: () => {
        core.getBus().emit(Events.INTERACTION_ACTIVITY, {});
      },
    };
  }

  // ── Private: lifecycle ────────────────────────────────────────────────────

  async _doInit() {
    // 1. Environment check — pdfjsLib must be present.
    this._assertPdfjsLibPresent();

    // 2. Create the event bus.
    this._bus = new EventBus();

    // 3. Create the state container.
    this._state = new ViewerState(this._bus);

    // 4. Apply feature-flag snapshot (URL overrides in dev).
    const flags = this._applyUrlFlagOverrides(CONFIG.FEATURES);
    this._state.set('flags', flags);

    // 5. Compute device profile (delegates to platform.js).
    this._state.set('deviceProfile', this._detectDeviceProfile());

    // 6. Inject CSS + refresh element cache.
    injectViewerStyles();
    refreshElementCache();

    // 7. Dev assertion of element IDs.
    this._assertElementIdsPresent();

    // 8. Instantiate subsystems in dependency order.
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
      // Roll back any subsystems already created.
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

    // 9. Initialise the engine (async).
    if (this._engine && this._engine.initialize) {
      await this._engine.initialize();
    }

    // 10. Wire UI.
    setupControls(this);
    setupAutoHideListeners(this);
    setupDPRListener(this);
    bindCoreEvents(this);

    // 10b. Watch for #viewer-main width changes and re-apply fit-to-width
    //      when the user hasn't manually overridden the zoom. Handles
    //      rotation and window resize.
    setupFitWidthObserver(this);

    // 11. Wire core-level cross-module subscriptions.
    this._wireCrossModuleEvents();

    // 12. Wire native bridge (Android back button, immersive mode, keep-awake,
    //     file intents). Web fallbacks are used in `npm run dev` — Escape key
    //     proxies the back button, visibilitychange proxies app state, etc.
    try {
      this._nativeTeardown = setupNativeBridge(this);
    } catch {
      this._nativeTeardown = null;
    }

    // 13. Mark ready.
    this._state.set('initTimestamp', Date.now());
    this._initialised = true;
    this._bus.emit(Events.CORE_READY, { timestamp: this._state.get('initTimestamp') });
  }

  _wireCrossModuleEvents() {
    const bus = this._bus;

    // Memory pressure → cancel low-priority render work.
    this._teardowns.push(bus.on(Events.MEMORY_PRESSURE, (payload) => {
      if (!payload || payload.level !== 'critical') return;
      try {
        const scheduler = this.getScheduler();
        if (scheduler && scheduler.cancelBelow) {
          scheduler.cancelBelow(PRIORITY.MARGIN);
        }
      } catch { /* ignore */ }
    }));

    // Render completion → insert canvas + adopt rendered size on wrapper.
    this._teardowns.push(bus.on(Events.RENDER_COMPLETE, (payload) => {
      this._onRenderComplete(payload);
    }));

    // Page visibility → track current page.
    this._teardowns.push(bus.on(Events.PAGE_VISIBLE, (payload) => {
      if (!payload || typeof payload.pageNum !== 'number') return;
      const prev = this._state.get('currentPage');
      if (prev === payload.pageNum) return;
      this._state.set('currentPage', payload.pageNum);
    }));

    // Scale applied → mirror into state.
    this._teardowns.push(bus.on(Events.SCALE_APPLIED, (payload) => {
      if (!payload || typeof payload.scale !== 'number') return;
      const prev = this._state.get('scale');
      if (prev === payload.scale) return;
      this._state.set('scale', payload.scale);
    }));

    // ── Document loaded → hand the outline tree to OutlineManager ────────
    //
    // `_loadPdf` patches `state.outline` from the engine's getOutline()
    // result, but nothing was forwarding that data to the OutlineManager.
    // The panel rendered "No outline available" even when the PDF had a
    // full tree because the manager's `_items` cache stayed empty.
    //
    // Document_loaded carries the outline in its payload, so we read it
    // from there rather than from state — the payload is the authoritative
    // source and avoids any ordering dependency on the state patch above.
    //
    // NOTE: this subscriber is a SIBLING of the ROTATE_REQUESTED subscriber
    // below, not nested inside it. A previous paste accidentally inlined it
    // into the rotation handler; that has been corrected.
    this._teardowns.push(bus.on(Events.DOCUMENT_LOADED, (payload) => {
      if (!payload || !Array.isArray(payload.outline)) return;
      try {
        const outline = this.getOutline();
        if (outline && typeof outline.build === 'function') {
          outline.build(payload.outline);
        }
      } catch { /* ignore */ }
    }));

    // Rotation requested → update state, emit applied, re-render visible.
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
      // Force a layout rebuild so page wrappers pick up the new dimensions
      // (rotation swaps width and height for 90° / 270°).
      Promise.resolve()
        .then(() => this.renderCurrentLayout())
        .catch(() => { /* ignore */ });
    }));

    // Search lifecycle.
    this._teardowns.push(bus.on(Events.SEARCH_STARTED, () => {
      this._state.set('isSearching', true);
    }));
    this._teardowns.push(bus.on(Events.SEARCH_COMPLETED, (payload) => {
      this._state.set('isSearching', false);
      this._state.set(
        'searchMatches',
        payload && Array.isArray(payload.matches) ? payload.matches : [],
      );
      this._state.set(
        'currentMatchIndex',
        payload && typeof payload.currentIndex === 'number' ? payload.currentIndex : -1,
      );
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

    // ── View-mode change → persist AND rebuild the layout ─────────────
    //
    // Two responsibilities:
    //
    //   1. Persist the user's choice to localStorage so the next session
    //      starts in the same mode.
    //
    //   2. Rebuild the layout. `state.set('viewMode', 'page')` alone only
    //      mutates state — it does not touch the DOM. The toggle in
    //      ui-internal.js emits LAYOUT_CHANGED on click, but that event is
    //      informational; nothing subscribes to it to trigger a rebuild.
    //
    //      This subscriber IS the rebuild trigger.
    this._teardowns.push(this._state.subscribe('viewMode', (payload) => {
      try {
        localStorage.setItem(CONFIG.VIEW_MODE_STORAGE_KEY, payload.next);
      } catch { /* ignore */ }

      Promise.resolve()
        .then(() => this.renderCurrentLayout())
        .catch(() => { /* ignore */ });
    }));

    // Document destroy → reset preload flag.
    this._teardowns.push(bus.on(Events.DOCUMENT_DESTROYED, () => {
      this._pageSizePreloadStarted = false;
    }));
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
    ) {
      return 'text';
    }
    if (
      m.includes('vnd.openxmlformats-officedocument') ||
      m === 'application/msword' ||
      m === 'application/vnd.ms-powerpoint' ||
      m === 'application/vnd.ms-excel'
    ) {
      return 'office';
    }
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

    // Clear the sidebar drawer's content so the new document's outline
    // renders into a clean shell.
    try {
      const drawer = document.getElementById('viewer-outline-drawer');
      if (drawer) {
        drawer.innerHTML = '';
        drawer.dataset.panel = 'outline';
      }
    } catch { /* ignore */ }

    // Apply the preview policy. Decides between fractional preview
    // (>= PREVIEW_MIN_PAGES_FOR_FRACTIONAL pages) and fully blocked
    // (< min pages). Must run BEFORE DOCUMENT_LOADED fires so ui-internal
    // reads the correct state.
    this._applyPreviewPolicy(numPages);

    // ── Fit-to-width ────────────────────────────────────────────────────
    // Skipped when blocked — the banner is sized from cached metadata, and
    // no page rendering is going to happen.
    if (!this._state.get('previewBlocked')) {
      await this._applyFitToWidth();
    } else {
      // Ensure page 1 metadata is cached so _renderPreviewBlocked can
      // size the placeholder correctly.
      await this._ensurePageMetadata(1);
    }

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages,
      outline,
      mimeType: this._state.get('mimeType'),
      documentKind: 'pdf',
      previewBlocked: this._state.get('previewBlocked') === true,
    });

    // Blocked — render the banner instead of the actual document.
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
        numPages: 1,
        outline: [],
        mimeType: this._state.get('mimeType'),
        documentKind: 'image',
        previewBlocked: true,
      });
      return;
    }

    const main = els.main;
    main.classList.remove('scroll-view');
    main.classList.add('page-view');
    this._clearViewerMainPreservingChrome();

    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';
    wrapper.style.transformOrigin = 'center center';

    const img = document.createElement('img');
    img.src = createObjectURL(blob);
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.objectFit = 'contain';
    img.style.transformOrigin = 'center center';

    wrapper.appendChild(img);
    main.appendChild(wrapper);

    if (els.footer) els.footer.style.display = 'none';

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages: 1,
      outline: [],
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
        numPages: 1,
        outline: [],
        mimeType: this._state.get('mimeType'),
        documentKind: 'text',
        previewBlocked: true,
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
    pre.style.overflow = 'auto';
    pre.style.height = '100%';
    pre.style.boxSizing = 'border-box';

    this._clearViewerMainPreservingChrome();
    els.main.appendChild(pre);

    if (els.footer) els.footer.style.display = 'none';

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages: 1,
      outline: [],
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
        numPages: 1,
        outline: [],
        mimeType: this._state.get('mimeType'),
        documentKind: 'office',
        previewBlocked: true,
      });
      return;
    }

    const url = createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';

    this._clearViewerMainPreservingChrome();
    els.main.appendChild(iframe);

    if (els.footer) els.footer.style.display = 'none';

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages: 1,
      outline: [],
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
        numPages: 1,
        outline: [],
        mimeType: this._state.get('mimeType'),
        documentKind: 'unsupported',
        previewBlocked: true,
      });
      return;
    }

    const url = createObjectURL(blob);
    const safeMime = escapeHtml(this._state.get('mimeType') || 'unknown');
    this._clearViewerMainPreservingChrome();

    const container = document.createElement('div');
    container.className = 'unsupported';
    container.innerHTML = `
      <p>Preview not available for this file type (${safeMime}).</p>
      <a href="${url}" download class="btn-primary">Download to view locally</a>
    `;
    els.main.appendChild(container);

    if (els.footer) els.footer.style.display = 'none';

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages: 1,
      outline: [],
      mimeType: this._state.get('mimeType'),
      documentKind: 'unsupported',
    });
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
        const wrapper = document.createElement('div');
        wrapper.className = CONFIG.CANVAS_WRAPPER_CLASS;
        wrapper.dataset.page = String(i);
        // A minimum height reserves space before the first render so the
        // scrollbar doesn't jump. The wrapper is later resized to the exact
        // canvas dimensions in _onRenderComplete.
        wrapper.style.minHeight = '200px';
        container.appendChild(wrapper);
      }

      // Preview mode: append the subscribe CTA after the last preview page.
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
      this._syncWrapperDimensions();
    }

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.recomputeLayout) scroll.recomputeLayout();
    } catch { /* ignore */ }

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.refreshVisible) {
        scroll.refreshVisible();
      }
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

    // Clamp the page to the preview limit defensively.
    const rawPageNum = this._state.get('currentPage');
    const pageNum = this.isPageAllowed(rawPageNum)
      ? rawPageNum
      : this.getEffectivePageLimit();

    if (pageNum !== rawPageNum) {
      this._state.set('currentPage', pageNum);
    }

    // ── Create the wrapper for this page ──────────────────────────────────
    // Without this, _syncWrapperDimensionsSingle and _onRenderComplete both
    // find no wrapper and bail silently. The page renders blank.
    const wrapper = document.createElement('div');
    wrapper.className = CONFIG.CANVAS_WRAPPER_CLASS;
    wrapper.dataset.page = String(pageNum);
    wrapper.style.minHeight = '200px';
    container.appendChild(wrapper);

    await this._ensurePageMetadata(pageNum);
    this._syncWrapperDimensionsSingle(pageNum);

    this._enqueuePageRender(pageNum, PRIORITY.VISIBLE);
  }

  _enqueuePageRender(pageNum, priority) {
    // Preview mode: refuse to schedule renders for locked pages.
    if (!this.isPageAllowed(pageNum)) return;

    const scheduler = this.getScheduler();
    const scale = this._state.get('scale');
    const rotation = this._state.get('rotation') || 0;

    const job = {
      // Include rotation in the ID so a rotation change produces a new job
      // rather than being deduplicated against the previous rotation.
      id: `page:${pageNum}:${scale}:${rotation}`,
      kind: 'page',
      pageNum,
      scale,
      rotation,
      tileRect: null,
      priority,
      onComplete: () => { /* handled via RENDER_COMPLETE event */ },
      onError: () => { /* handled via RENDER_ERROR event */ },
      onCancel: () => { /* handled via RENDER_CANCELLED event */ },
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
   * RENDER_COMPLETE handler.
   *
   * Inserts the freshly-rendered canvas into its wrapper AND adopts the
   * canvas's rendered CSS size on the wrapper.
   *
   * @private
   * @param {any} payload
   */
  _onRenderComplete(payload) {
    if (!payload || !payload.canvas) return;
    const { pageNum, scale, canvas, kind } = payload;
    if (kind === 'thumbnail' || kind === 'metadata') return;
    if (kind === 'tile') return;

    const els = getViewerElements();
    if (!els || !els.main) return;
    const wrapper = els.main.querySelector(
      `.${CONFIG.CANVAS_WRAPPER_CLASS}[data-page="${pageNum}"]`,
    );
    if (!wrapper) return;

    wrapper.innerHTML = '';
    wrapper.appendChild(canvas);
    wrapper.dataset.renderedScale = String(scale);

    // Adopt the canvas's own CSS size on the wrapper.
    const cw = canvas.style.width;
    const ch = canvas.style.height;
    if (cw) wrapper.style.width = cw;
    if (ch) {
      wrapper.style.height = ch;
      wrapper.style.minHeight = ch;
    }

    // Mark layout dirty (do NOT recompute synchronously).
    try {
      const scroll = this.getScroll();
      if (scroll && scroll.markLayoutDirty) {
        scroll.markLayoutDirty();
      } else if (scroll && scroll.recomputeLayout) {
        scroll.recomputeLayout();
      }
    } catch { /* ignore */ }
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

  /**
   * Eagerly fetch metadata for the first N pages so the initial scrollbar
   * geometry is approximately correct. Pages past N are fetched on demand.
   *
   * @private
   * @returns {Promise<void>}
   */
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
          this._syncWrapperDimensionsSingle(pageNum, meta);
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

    // Metadata for the first screen is now cached. Recompute once so the
    // scrollbar reflects the true document height.
    try {
      const scroll = this.getScroll();
      if (scroll && scroll.recomputeLayout) scroll.recomputeLayout();
      if (scroll && scroll.refreshVisible) scroll.refreshVisible();
    } catch { /* ignore */ }
  }

  _syncWrapperDimensions() {
    const els = getViewerElements();
    if (!els || !els.main) return;
    const wrappers = els.main.querySelectorAll('.' + CONFIG.CANVAS_WRAPPER_CLASS);
    const scale = this._state.get('scale');
    wrappers.forEach((wrapper) => {
      // Skip wrappers that already hold a rendered canvas at the current
      // scale — those were sized correctly by _onRenderComplete.
      const rendered = wrapper.dataset.renderedScale;
      if (rendered && Number(rendered) === scale) return;

      const pageNum = parseInt(wrapper.dataset.page, 10);
      if (!Number.isFinite(pageNum)) return;
      this._syncWrapperDimensionsSingle(pageNum, undefined, wrapper, scale);
    });
  }

  _syncWrapperDimensionsSingle(pageNum, metaOverride, wrapperOverride, scaleOverride) {
    const cache = this.getCache();
    const meta = metaOverride || (cache && cache.getPageViewport ? cache.getPageViewport(pageNum) : null);
    if (!meta) return;
    const scale = typeof scaleOverride === 'number' ? scaleOverride : this._state.get('scale');
    const rotation = this._state.get('rotation') || 0;
    const els = getViewerElements();
    if (!els || !els.main) return;
    const wrapper = wrapperOverride
      || els.main.querySelector(`.${CONFIG.CANVAS_WRAPPER_CLASS}[data-page="${pageNum}"]`);
    if (!wrapper) return;

    // Swap width/height for 90° / 270° rotations.
    const swapped = rotation === 90 || rotation === 270;
    const naturalW = swapped ? meta.height : meta.width;
    const naturalH = swapped ? meta.width : meta.height;
    const w = naturalW * scale;
    const h = naturalH * scale;
    wrapper.style.width = `${w}px`;
    wrapper.style.height = `${h}px`;
    wrapper.style.minHeight = `${h}px`;

    // Mark scroll layout dirty so the wrapper cache rebuilds on the next
    // frame. This avoids a synchronous forced layout per wrapper.
    try {
      const scroll = this.getScroll();
      if (scroll && scroll.markLayoutDirty) scroll.markLayoutDirty();
    } catch { /* ignore */ }
  }

  /**
   * Compute the fit-to-width scale for page 1 and install it in state.
   *
   * @private
   * @returns {Promise<void>}
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

      const usable = Math.max(
        availableWidth - CONFIG.FIT_WIDTH_H_PADDING_PX,
        100,
      );
      const fitScale = clamp(usable / meta.width, CONFIG.MIN_ZOOM, CONFIG.MAX_ZOOM);

      this._state.set('scale', fitScale);
      const zoom = this.getZoom();
      if (zoom && typeof zoom.syncScale === 'function') {
        zoom.syncScale(fitScale);
      }
    } catch { /* keep the default scale */ }
  }

  /**
   * Resolve with `element.clientWidth` once it becomes non-zero, or after
   * `timeoutMs` elapses.
   *
   * @private
   * @param {HTMLElement} element
   * @param {number} timeoutMs
   * @returns {Promise<number>}
   */
  _waitForViewerWidth(element, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      /** @type {ResizeObserver|null} */
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

  /**
   * Remove every direct child of #viewer-main except the four static chrome
   * nodes declared in viewer.html.
   *
   * @private
   * @returns {void}
   */
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

  /**
   * Reset the sidebar drawer, its scrim, and every toggle's aria-expanded
   * state to a clean, closed state.
   *
   * @private
   * @returns {void}
   */
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

      // Header dropdown menu — the hamburger is the only toggle in the
      // new header. Its aria-expanded reflects whether the menu is open.
      const menuBtn = document.getElementById('viewer-menu-btn');
      if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');

      const menuPanel = document.getElementById('viewer-menu');
      if (menuPanel) menuPanel.hidden = true;

      const searchBar = document.getElementById('viewer-search-bar');
      if (searchBar) searchBar.classList.remove('active');

      // Legacy top-level toggles (present only in the old header).
      const outlineBtn = document.getElementById('viewer-outline-btn');
      if (outlineBtn) outlineBtn.setAttribute('aria-expanded', 'false');
      const searchBtn = document.getElementById('viewer-search-btn');
      if (searchBtn) searchBtn.setAttribute('aria-expanded', 'false');
      const moreBtn = document.getElementById('viewer-more-btn');
      if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');
    } catch { /* ignore */ }
  }

  // ── Private: preview policy ───────────────────────────────────────────────

  /**
   * Apply the preview policy for a document with `numPages` pages.
   *
   * Two outcomes:
   *   • numPages >= CONFIG.PREVIEW_MIN_PAGES_FOR_FRACTIONAL
   *       Set `previewPageLimit = floor(numPages * PREVIEW_PAGE_FRACTION)`
   *       (min 1). Normal fractional preview.
   *   • numPages < CONFIG.PREVIEW_MIN_PAGES_FOR_FRACTIONAL
   *       Set `previewBlocked = true`. Nothing renders; a banner replaces
   *       the first page. Applies to every document kind.
   *
   * When not in preview mode, both flags are cleared.
   *
   * @private
   * @param {number} numPages
   * @returns {void}
   */
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
      // Fewer than `minPages` — block the entire document.
      this._state.set('previewPageLimit', 0);
      this._state.set('previewBlocked', true);
    }
  }

  /**
   * Render the blocked-preview view. Replaces the viewer's content with a
   * page-shaped placeholder carrying a centered subscribe banner. No page
   * wrappers, no canvases, no navigation targets.
   *
   * @private
   * @returns {void}
   */
  _renderPreviewBlocked() {
    const els = getViewerElements();
    if (!els || !els.main) return;

    const main = els.main;
    // Drop both layout modifiers so #viewer-main returns to its default
    // overflow: auto — the blocked placeholder may exceed the viewport on
    // short screens and must be scrollable.
    main.classList.remove('scroll-view');
    main.classList.remove('page-view');
    this._clearViewerMainPreservingChrome();

    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS + ' preview-blocked';
    main.appendChild(container);

    // Size the placeholder: page 1 dimensions × current scale for PDFs;
    // a generic A4-ish shape for everything else.
    const cache = this.getCache();
    const meta = cache && cache.getPageViewport ? cache.getPageViewport(1) : null;
    const scale = this._state.get('scale') || 1;
    const naturalW = meta && meta.width > 0 ? meta.width : 600;
    const naturalH = meta && meta.height > 0 ? meta.height : 800;

    // Cap to the available viewport so the placeholder is never wider
    // than the screen.
    const availW = Math.max(main.clientWidth - 32, 200);
    const availH = Math.max(main.clientHeight - 32, 260);
    const w = Math.min(naturalW * scale, availW);
    const h = Math.min(naturalH * scale, availH);

    const placeholder = document.createElement('div');
    placeholder.className = CONFIG.CANVAS_WRAPPER_CLASS + ' preview-blocked-placeholder';
    placeholder.style.width = `${w}px`;
    placeholder.style.height = `${h}px`;
    placeholder.style.minHeight = `${h}px`;
    placeholder.appendChild(this._buildPreviewBlockedBanner());
    container.appendChild(placeholder);
  }

  /**
   * Build the blocked-preview banner. Emits PREVIEW_SUBSCRIBE_REQUESTED on
   * the bus when the subscribe button is clicked; viewer.js handles that
   * event and routes to the subscription page.
   *
   * @private
   * @returns {HTMLElement}
   */
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

  /**
   * Build the preview-mode subscribe call-to-action card (fractional
   * preview). Emits PREVIEW_SUBSCRIBE_REQUESTED on the bus when the button
   * is clicked; viewer.js handles that event and routes to the subscription
   * page.
   *
   * @private
   * @param {number} previewLimit
   * @param {number} totalPages
   * @returns {HTMLElement}
   */
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
   * Build the device profile passed to state and consumed by CacheManager /
   * MemoryManager for cap sizing.
   *
   * @private
   * @returns {object}
   */
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

  // ── Private: assertions ───────────────────────────────────────────────────

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

/** @type {ViewerCore|null} */
let _singleton = null;

/**
 * Return the singleton ViewerCore instance, constructing it on first call.
 *
 * @returns {ViewerCore}
 */
export function createCore() {
  if (_singleton) return _singleton;
  _singleton = new ViewerCore();
  return _singleton;
}

// ============================================================================
// 8. TAIL — utilities for tests
// ============================================================================

/**
 * Test-only: reset the module-level singleton, tearing down the native
 * bridge subscriptions that survive a document switch.
 *
 * @private
 */
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