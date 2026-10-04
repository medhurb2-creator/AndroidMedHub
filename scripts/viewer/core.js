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
 * Preview-mode support:
 *   When `loadDocument(blob, fileType, title, { previewMode: true })` is
 *   called, the PDF path caps the render pipeline to
 *   CONFIG.PREVIEW_PAGE_FRACTION of the total page count and appends a
 *   subscribe call-to-action after the last preview page. Navigation,
 *   rendering, and metadata prefetch are all clamped to that limit.
 *
 *   Preview mode is scoped to premium catalogue resources opened by
 *   unsubscribed users. External files (file picker, Android intent) and
 *   subscribed users are never affected. See resource-browser.js for the
 *   trigger and viewer.js for the transport.
 *
 * Destroy semantics:
 *   `destroy()` runs on every document switch AND on explicit viewer close.
 *   It tears down the engine, workers, scheduler, caches, and state, and it
 *   clears the viewer DOM via `clearViewerContent()` so the next document
 *   starts from a blank slate. The four static chrome nodes declared in
 *   viewer.html (#viewer-loading, #viewer-progress, #viewer-content,
 *   #viewer-text-layer) survive the clear.
 *
 * Import discipline:
 *   • Imports only from ./utils.js and the six sibling subsystem factories.
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

  // ── Tap sequences (double-tap / triple-tap) ───────────────────────────────
  TAP_SEQUENCE_GAP_MS: 350,
  DOUBLE_SETTLE_MS: 250,

  // Multiplier applied by the triple-tap magnify toggle. Magnify is always
  // viewport-centered, never anchored to the tap point.
  MAGNIFY_FACTOR: 2.0,

  // ── Preview mode ──────────────────────────────────────────────────────────
  // When a premium catalogue resource is opened without an active
  // subscription, only this fraction of the document's pages are rendered.
  // A subscribe CTA is appended after the last preview page. External files
  // (file picker, Android intent) are never subject to this limit.
  PREVIEW_PAGE_FRACTION: 0.10,

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
  PREFETCH_DEPTH_SLOW: 2,
  PREFETCH_DEPTH_FAST: 0,

  // ── Render concurrency ────────────────────────────────────────────────────
  RENDER_CONCURRENCY: (() => {
    try {
      const hc = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
      return Math.max(1, Math.min(4, hc - 1));
    } catch {
      return 2;
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

  // ── Dev-mode flags (not feature flags; gate diagnostics) ──────────────────
  DEBUG_VIEWER: false,
  DEBUG_WORKERS: false,
  DEBUG_MEMORY: false,

  // ── Feature flags ─────────────────────────────────────────────────────────
  // Defaults false so the viewer boots with behaviour identical to the
  // previous monolithic viewer. Each phase flips one flag on.
  FEATURES: {
    USE_WORKER_SEARCH: false,
    USE_SCHEDULER: false,
    USE_TILING: false,
    USE_ENGINE_ADAPTER: false,
    USE_LRU_CACHES: false,
    USE_VELOCITY_THROTTLE: false,
    USE_TWO_PHASE_ZOOM: false,
    USE_RAF_PAN: false,
    USE_RENDER_PREFETCH: false,
    USE_LOW_RES_PLACEHOLDER: false,
    USE_PARSER_WORKER: false,
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

  // Panning / gestures
  PAN_START: 'pan:start',
  PAN_END: 'pan:end',
  DOUBLE_TAP: 'double-tap',
  TRIPLE_TAP: 'triple-tap',
  SWIPE: 'swipe',
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

  // Preview-mode subscribe CTA. Emitted by the CTA card that core inserts
  // after the last preview page. Handled by viewer.js, which routes the user
  // to the subscription page.
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
      try {
        handler(...args);
      } catch {
        // swallow — mirrors emit's fault isolation
      }
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
      try {
        handler(payload);
      } catch {
        // Intentionally swallowed. Modules own their own error reporting.
      }
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
  isLoading: false,
  error: null,

  numPages: 1,
  currentPage: 1,
  outline: [],

  scale: 1.0,
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
   *   Optional hints. When `previewMode` is true, the PDF path caps the
   *   rendered pages to CONFIG.PREVIEW_PAGE_FRACTION of the total and appends
   *   a subscribe call-to-action after the last preview page. Ignored for
   *   non-PDF documents.
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
    // and would otherwise clear these fields. Set the limit to 0 here; the
    // PDF loader computes the actual cap once numPages is known.
    const previewMode = !!(opts && opts.previewMode);
    this._state.set('previewMode', previewMode);
    this._state.set('previewPageLimit', 0);

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
   * Canonical teardown. Idempotent. Ordered per architecture spec § 5.6.
   *
   * Runs on every document switch AND on explicit viewer close. Clears the
   * viewer DOM via `clearViewerContent()` so the next document starts from
   * a blank slate — page containers, canvases, search overlays, error
   * containers, and the preview-mode CTA are removed; the four static
   * chrome nodes from viewer.html are preserved.
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
      //     slate. Without this, the previous document's wrappers, canvases,
      //     search-highlight overlays, and error containers survive the
      //     close and bleed into the next open.
      //
      //     Preserves the four static chrome nodes declared in viewer.html:
      //     #viewer-loading, #viewer-progress, #viewer-content,
      //     #viewer-text-layer. Also resets loading/progress visible state,
      //     empties the outline drawer, and clears the viewer title.
      try {
        clearViewerContent();
      } catch { /* ignore */ }

      // 8. Core's own cross-module subscriptions (in `_teardowns`) are
      //    VIEWER-LIFETIME. They are registered exactly once during
      //    `_doInit()` and MUST survive a document switch.
      //
      //    `destroy()` runs on every document switch, not just on full
      //    viewer teardown. Tearing the subscriptions down here would strip
      //    the core of its `RENDER_COMPLETE` handler, and the next document
      //    would render its canvases into memory that is never inserted
      //    into the DOM — producing the white blank pages on the second
      //    open of the same document.
      //
      //    The subscriptions die naturally with the JS context when the
      //    page is unloaded. No explicit teardown is needed.

      // 9. Reset state.
      this._state.reset();
      this._state.set('isDestroyed', false);
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
   * @returns {Promise<void>}
   */
  async renderCurrentLayout() {
    if (!this._state) return;
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
   * Returns the preview limit when in preview mode, otherwise the real
   * total. Zero is never returned — a document is always at least 1 page.
   *
   * @returns {number}
   */
  getEffectivePageLimit() {
    if (!this._state) return 1;
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
      hideHeaderFooter: () => {
        // No-op facade stub — hidden internally.
      },
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

    // 5. Compute device profile.
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

    // 11. Wire core-level cross-module subscriptions.
    this._wireCrossModuleEvents();

    // 12. Mark ready.
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

    // Render completion → insert canvas.
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

    // View-mode change → persist.
    this._teardowns.push(this._state.subscribe('viewMode', (payload) => {
      try {
        localStorage.setItem(CONFIG.VIEW_MODE_STORAGE_KEY, payload.next);
      } catch { /* ignore */ }
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
      scale: 1.0,
    });

    // Preview mode: cap rendered pages to CONFIG.PREVIEW_PAGE_FRACTION of the
    // total. Always at least 1 so short documents still show something. This
    // must be set BEFORE DOCUMENT_LOADED fires, because ui-internal reads
    // `getEffectivePageLimit()` in its DOCUMENT_LOADED subscriber to clamp
    // the page counter and page input.
    if (this._state.get('previewMode')) {
      const fraction = CONFIG.PREVIEW_PAGE_FRACTION;
      const limit = Math.max(1, Math.floor(numPages * fraction));
      this._state.set('previewPageLimit', limit);
    } else {
      this._state.set('previewPageLimit', 0);
    }

    this._bus.emit(Events.DOCUMENT_LOADED, {
      numPages,
      outline,
      mimeType: this._state.get('mimeType'),
      documentKind: 'pdf',
    });

    await this.renderCurrentLayout();
  }

  _loadImage(blob) {
    const els = getViewerElements();
    if (!els || !els.main) return;

    const main = els.main;
    main.classList.remove('scroll-view');
    main.classList.add('page-view');
    main.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.style.width = '100%';
    wrapper.style.height = '100%';
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'center';
    wrapper.style.justifyContent = 'center';
    wrapper.style.transformOrigin = 'center center';
    wrapper.style.touchAction = 'none';

    const img = document.createElement('img');
    img.src = createObjectURL(blob);
    img.style.maxWidth = 'none';
    img.style.maxHeight = 'none';
    img.style.objectFit = 'contain';
    img.style.transformOrigin = 'center center';
    img.style.transition = 'transform 0.1s';
    img.style.touchAction = 'none';

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

    els.main.innerHTML = '';
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

    const url = createObjectURL(blob);
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';

    els.main.innerHTML = '';
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

    const url = createObjectURL(blob);
    const safeMime = escapeHtml(this._state.get('mimeType') || 'unknown');
    els.main.innerHTML = `<div class="unsupported">
      <p>Preview not available for this file type (${safeMime}).</p>
      <a href="${url}" download class="btn-primary">Download to view locally</a>
    </div>`;

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
      main.innerHTML = '';
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
    main.innerHTML = '';

    const container = document.createElement('div');
    container.className = CONFIG.PAGE_CONTAINER_CLASS;
    container.style.transformOrigin = '0 0';
    main.appendChild(container);

    // Clamp the page to the preview limit defensively. Navigation requests
    // are already clamped in interaction.js, but a stale currentPage (e.g.
    // from a previous document) could slip through if the caller bypasses
    // destroy().
    const rawPageNum = this._state.get('currentPage');
    const pageNum = this.isPageAllowed(rawPageNum)
      ? rawPageNum
      : this.getEffectivePageLimit();

    if (pageNum !== rawPageNum) {
      this._state.set('currentPage', pageNum);
    }

    await this._ensurePageMetadata(pageNum);
    this._syncWrapperDimensionsSingle(pageNum);

    this._enqueuePageRender(pageNum, PRIORITY.VISIBLE);
  }

  _enqueuePageRender(pageNum, priority) {
    // Preview mode: refuse to schedule renders for locked pages. This is a
    // belt-and-braces guard — interaction.js already clamps navigation, but
    // this ensures no code path can enqueue a locked render.
    if (!this.isPageAllowed(pageNum)) return;

    const scheduler = this.getScheduler();
    const scale = this._state.get('scale');

    const job = {
      id: `page:${pageNum}:${scale}`,
      kind: 'page',
      pageNum,
      scale,
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

    try {
      const scroll = this.getScroll();
      if (scroll && scroll.recomputeLayout) scroll.recomputeLayout();
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

  async _preloadPageSizes() {
    if (this._pageSizePreloadStarted) return;
    this._pageSizePreloadStarted = true;

    // In preview mode, only prefetch metadata for the pages that will be
    // rendered. This keeps the prefetch budget proportional to what the user
    // can actually see, and avoids fetching metadata for locked pages.
    const numPages = this.getEffectivePageLimit();
    const cache = this.getCache();

    const queue = [];
    for (let i = 1; i <= numPages; i++) {
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
  }

  _syncWrapperDimensions() {
    const els = getViewerElements();
    if (!els || !els.main) return;
    const wrappers = els.main.querySelectorAll('.' + CONFIG.CANVAS_WRAPPER_CLASS);
    const scale = this._state.get('scale');
    wrappers.forEach((wrapper) => {
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
    const els = getViewerElements();
    if (!els || !els.main) return;
    const wrapper = wrapperOverride
      || els.main.querySelector(`.${CONFIG.CANVAS_WRAPPER_CLASS}[data-page="${pageNum}"]`);
    if (!wrapper) return;
    const w = meta.width * scale;
    const h = meta.height * scale;
    wrapper.style.width = `${w}px`;
    wrapper.style.height = `${h}px`;
    wrapper.style.minHeight = `${h}px`;
  }

  /**
   * Build the preview-mode subscribe call-to-action card. Emits
   * PREVIEW_SUBSCRIBE_REQUESTED on the bus when the button is clicked;
   * viewer.js handles that event and routes to the subscription page.
   *
   * The card itself carries no styling in JS — all classes are declared in
   * ui-internal.js's injected CSS.
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

  _detectDeviceProfile() {
    let isMobile = false;
    let isLowMemory = false;
    let hardwareConcurrency = 4;
    let deviceMemory = 4;

    try {
      if (typeof navigator !== 'undefined') {
        const ua = navigator.userAgent || '';
        isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
        hardwareConcurrency = navigator.hardwareConcurrency || 4;
        if (typeof navigator.deviceMemory === 'number') {
          deviceMemory = navigator.deviceMemory;
          isLowMemory = deviceMemory < 4;
        }
      }
    } catch { /* ignore */ }

    const capMb = isMobile || isLowMemory
      ? CONFIG.MEMORY_CAP_MOBILE_MB
      : CONFIG.MEMORY_CAP_DESKTOP_MB;

    return Object.freeze({
      isMobile,
      isLowMemory,
      hardwareConcurrency,
      deviceMemory,
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
 * Test-only: reset the module-level singleton.
 *
 * @private
 */
export function __resetCoreSingletonForTests() {
  if (_singleton) {
    try { _singleton.destroy(); } catch { /* ignore */ }
  }
  _singleton = null;
}