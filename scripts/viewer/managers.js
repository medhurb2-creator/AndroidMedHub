// frontend-user/scripts/viewer/managers.js

/**
 * Universal Document Viewer — Managers
 * ============================================================================
 *
 * The viewer's memory, search, and navigation subsystem. Owns every cache
 * tier, every memory-pressure decision, the search pipeline, the outline,
 * and the search/more sidebar panels.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * INVARIANTS (do not violate — see project spec):
 *
 *   1. #viewer-main is a fixed window. It is never transformed, never a
 *      gesture target, and never measured except for viewport dimensions.
 *
 *   2. .page-container holds one slot per page. Each slot is either a
 *      <canvas class="page" data-page="n"> (rendered) or a
 *      <div class="cover" data-page="n"> (placeholder awaiting render).
 *      Every slot is sized natural × displayScale by core.js — resolution
 *      changes the bitmap, never the slot's CSS size.
 *
 *   3. Highlight overlays are anchored over their target slot's exact
 *      position and size. They live inside .page-container, positioned
 *      absolutely against the container. They only ever overlay a rendered
 *      canvas (.page), never a cover — a cover has no visible content.
 *
 *   4. Nothing in this file inserts or mutates canvases in the DOM as
 *      pages. Canvases flow in from the render pipeline; the search
 *      overlay is the only thing this file appends to .page-container.
 *
 *   5. MemoryManager enforces the cap by EVICTING BEFORE REGISTERING. When
 *      a new canvas would push usage over the cap, existing canvases are
 *      evicted (farthest from the current page first, oldest as a
 *      tiebreaker) until the new one fits. Memory pressure events are the
 *      fallback for the case where the pyramid alone cannot keep up — not
 *      the primary mechanism.
 *
 *   6. The cap is chosen from the device profile's memoryCapBytes, which
 *      core.js derives from navigator.deviceMemory and the platform tier.
 *      No consumer recomputes it from raw constants.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Exports (7):
 *   • LRUCache        — byte-accounted least-recently-used cache primitive
 *   • CacheManager    — five-tier cache (text / viewport / canvas / thumb / spatial)
 *   • MemoryManager   — canvas registry + pressure-level emission
 *   • SearchManager   — worker-backed search + highlight overlays + results list
 *   • OutlineManager  — outline tree + destination navigation
 *   • MorePanel       — document properties + action buttons
 *   • createManagers(core) — factory
 *
 * Boundary rule (architecture spec § 2.3):
 *   • This is the ONLY file permitted to hold page-keyed or canvas-keyed Maps.
 *   • The only DOM boundaries are: the sidebar drawer panels and .search-layer
 *     overlays inside .page-container.
 *   • Never touches the engine directly for rendering — engine access via
 *     core.getEngine(). Metadata access goes through the adapter.
 *   • Never creates page canvases — those are produced by PageRenderer and
 *     handed in for caching.
 *
 * Sidebar integration:
 *   The drawer (#viewer-outline-drawer) hosts three panels selected by
 *   `data-panel`:
 *     • "outline"  → OutlineManager renders the tree
 *     • "search"   → SearchManager renders input + results list
 *     • "more"     → MorePanel renders properties + actions
 *
 *   ui-internal.js sets `data-panel` and adds `.open`. This factory observes
 *   the drawer with a MutationObserver and dispatches to the correct
 *   manager's renderPanel method whenever either attribute changes.
 *
 * Import discipline:
 *   • { CONFIG, Events } from './core.js'
 *   • { escapeHtml, isAbortError, createAbortError, debounce } from './utils.js'
 *
 * @module viewer/managers
 */

'use strict';

import { CONFIG, Events } from './core.js';
import {
  escapeHtml,
  isAbortError,
  createAbortError,
  debounce,
  getViewerElements,
} from './utils.js';

// ============================================================================
// MODULE-PRIVATE CONSTANTS
// ============================================================================

/** Search progress: emit SEARCH_PROGRESS every N pages. @private */
const SEARCH_PROGRESS_INTERVAL = 10;

/** Main-thread fallback: yield to the event loop every N pages. @private */
const SEARCH_YIELD_INTERVAL = 4;

/** Bytes heuristic per text item (str + transform + dimensions). @private */
const TEXT_ITEM_BYTES = 64;

/** Bytes per cached viewport entry. @private */
const VIEWPORT_ENTRY_BYTES = 48;

/** Bytes per canvas pixel (RGBA). @private */
const CANVAS_BYTE_PER_PIXEL = 4;

/** Mem-pressure threshold: warning at 75% of cap. @private */
const PRESSURE_WARNING_RATIO = 0.75;

/** Mem-pressure threshold: critical at 90% of cap. @private */
const PRESSURE_CRITICAL_RATIO = 0.9;

/**
 * Mem-pressure hysteresis: reset to 'none' below 65%. Wider than the
 * classic 70% so eviction does not immediately trigger a new alloc→evict
 * cycle when the pyramid rebuilds.
 * @private
 */
const PRESSURE_RESET_RATIO = 0.65;

/** Eviction radius sequence when under pressure. @private */
const EVICTION_RADII = [4, 3, 2, 1, 0];

/** Fallback cap when deviceProfile is missing. @private */
const FALLBACK_CAP_BYTES = 200 * 1024 * 1024;

// ============================================================================
// 1. LRU CACHE
// ============================================================================

/**
 * Byte-accounted least-recently-used cache. Uses Map insertion order for
 * cheap LRU: `get` and successful `set` promote an entry to the tail by
 * deleting and re-inserting.
 */
export class LRUCache {
  /**
   * @param {{
   *   maxEntries?: number,
   *   maxBytes?: number,
   *   sizeOf?: (value: any) => number,
   *   onEvict?: (key: any, value: any) => void,
   *   name?: string,
   * }} [options]
   */
  constructor(options) {
    const opts = options || {};
    /** @private @type {Map<any, { value: any, bytes: number }>} */
    this._map = new Map();
    /** @private */ this._bytes = 0;
    /** @private */ this._maxEntries = typeof opts.maxEntries === 'number' && opts.maxEntries > 0
      ? opts.maxEntries
      : 100;
    /** @private */ this._maxBytes = typeof opts.maxBytes === 'number' && opts.maxBytes > 0
      ? opts.maxBytes
      : Infinity;
    /** @private */ this._sizeOf = typeof opts.sizeOf === 'function' ? opts.sizeOf : null;
    /** @private @type {((key: any, value: any) => void) | null} */
    this._onEvict = typeof opts.onEvict === 'function' ? opts.onEvict : null;
    /** @private @type {string} */ this._name = opts.name || 'LRUCache';
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** @param {any} key @returns {any} */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /** @param {any} key @returns {boolean} */
  has(key) {
    return this._map.has(key);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** @param {any} key @param {any} value @returns {void} */
  set(key, value) {
    const bytes = this._computeBytes(value);

    if (this._map.has(key)) {
      const prev = this._map.get(key);
      this._bytes -= prev ? prev.bytes : 0;
      this._map.delete(key);
    }

    if (bytes > this._maxBytes) {
      this._evictAllExcept(key);
      this._map.set(key, { value, bytes });
      this._bytes = bytes;
      if (CONFIG.DEBUG_VIEWER) {
        // eslint-disable-next-line no-console
        console.warn(`[${this._name}] Single entry exceeds maxBytes (${bytes} > ${this._maxBytes}); evicting others.`);
      }
      return;
    }

    this._map.set(key, { value, bytes });
    this._bytes += bytes;

    this._enforceCaps();
  }

  /** @param {any} key @returns {boolean} */
  delete(key) {
    const entry = this._map.get(key);
    if (!entry) return false;
    this._map.delete(key);
    this._bytes -= entry.bytes;
    if (this._onEvict) {
      try { this._onEvict(key, entry.value); } catch { /* ignore */ }
    }
    return true;
  }

  /** @returns {void} */
  clear() {
    for (const [key, entry] of this._map) {
      if (this._onEvict) {
        try { this._onEvict(key, entry.value); } catch { /* ignore */ }
      }
    }
    this._map.clear();
    this._bytes = 0;
  }

  // ── Iteration ─────────────────────────────────────────────────────────────

  /** @returns {IterableIterator<any>} */
  keys() {
    return this._map.keys();
  }

  /** @returns {IterableIterator<[any, any]>} */
  entries() {
    const map = this._map;
    return (function* () {
      for (const [k, v] of map) yield [k, v.value];
    })();
  }

  /**
   * Iterate live entries. Caller must not mutate during iteration.
   * @param {(key: any, value: any) => void} fn
   * @returns {void}
   */
  forEach(fn) {
    for (const [k, v] of this._map) {
      try { fn(k, v.value); } catch { /* ignore */ }
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /** @returns {number} */
  size() {
    return this._map.size;
  }

  /** @returns {number} */
  usedBytes() {
    return this._bytes;
  }

  /** @returns {{ size: number, bytes: number, maxEntries: number, maxBytes: number, name: string }} */
  stats() {
    return {
      size: this._map.size,
      bytes: this._bytes,
      maxEntries: this._maxEntries,
      maxBytes: this._maxBytes,
      name: this._name,
    };
  }

  // ── Explicit eviction ─────────────────────────────────────────────────────

  /** @param {number} count @returns {number} */
  evictLeastRecent(count) {
    let evicted = 0;
    for (const key of Array.from(this._map.keys())) {
      if (evicted >= count) break;
      this.delete(key);
      evicted++;
    }
    return evicted;
  }

  /** @param {number} maxEntries @param {number} [maxBytes] @returns {void} */
  resize(maxEntries, maxBytes) {
    if (typeof maxEntries === 'number' && maxEntries > 0) {
      this._maxEntries = maxEntries;
    }
    if (typeof maxBytes === 'number' && maxBytes > 0) {
      this._maxBytes = maxBytes;
    }
    this._enforceCaps();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** @private @param {any} value @returns {number} */
  _computeBytes(value) {
    if (!this._sizeOf) return 1;
    try {
      const b = this._sizeOf(value);
      return typeof b === 'number' && b > 0 ? b : 1;
    } catch {
      return 1;
    }
  }

  /** @private */
  _enforceCaps() {
    while (this._map.size > this._maxEntries && this._map.size > 0) {
      const oldestKey = this._map.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
    while (this._bytes > this._maxBytes && this._map.size > 0) {
      const oldestKey = this._map.keys().next().value;
      if (oldestKey === undefined) break;
      this.delete(oldestKey);
    }
  }

  /** @private @param {any} keepKey */
  _evictAllExcept(keepKey) {
    const keys = Array.from(this._map.keys());
    for (const key of keys) {
      if (key === keepKey) continue;
      this.delete(key);
    }
  }
}

// ============================================================================
// 2. CACHE MANAGER
// ============================================================================

/**
 * Five-tier cache: text content, page viewports, rendered canvases,
 * pinned thumbnails, and reserved spatial index. All tiers except the
 * thumbnail tier enforce LRU caps.
 *
 * The byte cap is read once from the device profile. Subsequent tier
 * allocations derive their own sub-caps from that single value.
 */
export class CacheManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   * @param {Readonly<{ useLru: boolean }>} flags
   */
  constructor(core, flags) {
    /** @private */ this._core = core;
    /** @private */ this._flags = flags;

    const capBytes = this._computeCapBytes();
    /** @private */ this._capBytes = capBytes;

    const lru = flags.useLru;

    // ── Text tier ────────────────────────────────────────────────────────────
    /** @private */
    this._text = lru ? new LRUCache({
      maxEntries: 64,
      sizeOf: (content) => {
        const items = content && Array.isArray(content.items) ? content.items : [];
        return items.length * TEXT_ITEM_BYTES;
      },
      name: 'text',
    }) : new Map();

    // ── Viewport tier ────────────────────────────────────────────────────────
    /** @private */
    this._viewport = lru ? new LRUCache({
      maxEntries: 512,
      sizeOf: () => VIEWPORT_ENTRY_BYTES,
      name: 'viewport',
    }) : new Map();

    // ── Canvas tier ──────────────────────────────────────────────────────────
    /** @private */
    this._canvas = lru ? new LRUCache({
      maxEntries: 32,
      maxBytes: Math.max(1, Math.floor(capBytes * 0.75)),
      sizeOf: (canvas) => this._canvasBytes(canvas),
      onEvict: (key, canvas) => this._onCanvasEvict(canvas),
      name: 'canvas',
    }) : new Map();

    // ── Thumbnail tier (pinned; never evicted by LRU) ────────────────────────
    /** @private @type {Map<number, HTMLCanvasElement>} */
    this._thumbnail = new Map();

    // ── Spatial tier (reserved) ──────────────────────────────────────────────
    /** @private */
    this._spatial = lru ? new LRUCache({
      maxEntries: 128,
      sizeOf: (arr) => (Array.isArray(arr) ? arr.length * 32 : 32),
      name: 'spatial',
    }) : new Map();

    /** @private @type {{ text: number, viewport: number, canvas: number, spatial: number, evictions: number }} */
    this._stats = { text: 0, viewport: 0, canvas: 0, spatial: 0, evictions: 0 };

    try {
      const bus = core.getBus();
      bus.on(Events.MEMORY_PRESSURE, (payload) => this._onMemoryPressure(payload));
    } catch { /* ignore */ }
  }

  // ── Text tier ─────────────────────────────────────────────────────────────

  /** @param {number} pageNum @returns {any} */
  getTextContent(pageNum) {
    return this._text.get(pageNum);
  }

  /** @param {number} pageNum @param {any} content */
  setTextContent(pageNum, content) {
    if (!content) return;
    this._text.set(pageNum, content);
    this._stats.text = this._text.size;
  }

  /** @param {number} pageNum @returns {boolean} */
  hasTextContent(pageNum) {
    return this._text.has(pageNum);
  }

  /** @returns {void} */
  clearTextCache() {
    this._text.clear();
  }

  // ── Viewport tier ─────────────────────────────────────────────────────────

  /** @param {number} pageNum @returns {any} */
  getPageViewport(pageNum) {
    return this._viewport.get(pageNum);
  }

  /** @param {number} pageNum @param {any} viewport */
  setPageViewport(pageNum, viewport) {
    if (!viewport) return;
    this._viewport.set(pageNum, viewport);
    this._stats.viewport = this._viewport.size;
  }

  /** @param {number} pageNum @returns {boolean} */
  hasPageViewport(pageNum) {
    return this._viewport.has(pageNum);
  }

  // ── Canvas tier ───────────────────────────────────────────────────────────

  /**
   * @param {number} pageNum
   * @param {number} scale
   * @param {string} [tileKey]
   * @returns {string}
   */
  canvasKey(pageNum, scale, tileKey) {
    return tileKey ? `${pageNum}:${scale}:${tileKey}` : `${pageNum}:${scale}`;
  }

  /** @param {string} key @returns {HTMLCanvasElement|undefined} */
  getCanvas(key) {
    return this._canvas.get(key);
  }

  /** @param {string} key @param {HTMLCanvasElement} canvas @param {number} pageNum */
  setCanvas(key, canvas, pageNum) {
    if (!canvas) return;
    this._canvas.set(key, { canvas, pageNum });
    this._stats.canvas = this._canvas.size;
  }

  /** @param {string} key @returns {boolean} */
  hasCanvas(key) {
    return this._canvas.has(key);
  }

  /** @param {string} key @returns {boolean} */
  deleteCanvas(key) {
    return this._canvas.delete(key);
  }

  // ── Thumbnail tier ────────────────────────────────────────────────────────

  /** @param {number} pageNum @returns {HTMLCanvasElement|undefined} */
  getThumbnail(pageNum) {
    return this._thumbnail.get(pageNum);
  }

  /** @param {number} pageNum @param {HTMLCanvasElement} canvas */
  storeThumbnail(pageNum, canvas) {
    if (!canvas) return;
    this._thumbnail.set(pageNum, canvas);
  }

  /** @param {number} pageNum @returns {boolean} */
  hasThumbnail(pageNum) {
    return this._thumbnail.has(pageNum);
  }

  // ── Eviction ──────────────────────────────────────────────────────────────

  /**
   * Evict every canvas whose page is outside `[currentPage - radius, currentPage + radius]`.
   * Thumbnails are never evicted. Returns count evicted.
   *
   * @param {number} currentPage
   * @param {number} radius
   * @returns {number}
   */
  evictFarFrom(currentPage, radius) {
    if (!Number.isFinite(currentPage)) return 0;
    const minPage = currentPage - radius;
    const maxPage = currentPage + radius;

    const toEvict = [];
    if (this._flags.useLru) {
      this._canvas.forEach((key, value) => {
        const page = value && typeof value.pageNum === 'number' ? value.pageNum : -1;
        if (page < minPage || page > maxPage) toEvict.push(key);
      });
    } else {
      for (const [key, value] of this._canvas) {
        const page = value && typeof value.pageNum === 'number' ? value.pageNum : -1;
        if (page < minPage || page > maxPage) toEvict.push(key);
      }
    }

    let count = 0;
    for (const key of toEvict) {
      if (this._canvas.delete(key)) count++;
    }
    return count;
  }

  /**
   * Evict every non-pinned tier entry. Pinned thumbnails are cleared too.
   * @returns {void}
   */
  evictAll() {
    if (this._flags.useLru) {
      this._text.clear();
      this._viewport.clear();
      this._canvas.clear();
      this._spatial.clear();
    } else {
      this._text.clear();
      this._viewport.clear();
      for (const [, value] of this._canvas) {
        this._onCanvasEvict(value);
      }
      this._canvas.clear();
      this._spatial.clear();
    }
    for (const [, canvas] of this._thumbnail) {
      try { canvas.width = 0; canvas.height = 0; } catch { /* ignore */ }
    }
    this._thumbnail.clear();
    this._stats = { text: 0, viewport: 0, canvas: 0, spatial: 0, evictions: 0 };
  }

  // ── Reporting ─────────────────────────────────────────────────────────────

  /** @returns {number} */
  usedBytes() {
    if (this._flags.useLru) {
      return this._text.usedBytes() + this._viewport.usedBytes()
        + this._canvas.usedBytes() + this._spatial.usedBytes();
    }
    let bytes = 0;
    for (const [, canvas] of this._canvas) {
      const c = canvas && canvas.canvas ? canvas.canvas : null;
      bytes += this._canvasBytes(c);
    }
    return bytes;
  }

  /** @returns {number} */
  pinnedBytes() {
    let bytes = 0;
    for (const [, canvas] of this._thumbnail) {
      bytes += this._canvasBytes(canvas);
    }
    return bytes;
  }

  /** @returns {object} */
  report() {
    const textStats = this._flags.useLru ? this._text.stats() : { size: this._text.size, bytes: 0 };
    const viewportStats = this._flags.useLru ? this._viewport.stats() : { size: this._viewport.size, bytes: 0 };
    const canvasStats = this._flags.useLru ? this._canvas.stats() : { size: this._canvas.size, bytes: this.usedBytes() };
    const spatialStats = this._flags.useLru ? this._spatial.stats() : { size: this._spatial.size, bytes: 0 };
    return {
      text: textStats,
      viewport: viewportStats,
      canvas: canvasStats,
      spatial: spatialStats,
      thumbnail: { size: this._thumbnail.size, bytes: this.pinnedBytes(), pinned: true },
      totalBytes: this.usedBytes(),
      pinnedBytes: this.pinnedBytes(),
      capBytes: this._capBytes,
      evictions: this._stats.evictions,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** @private @param {HTMLCanvasElement|null} canvas @returns {number} */
  _canvasBytes(canvas) {
    if (!canvas || typeof canvas.width !== 'number' || typeof canvas.height !== 'number') {
      return 0;
    }
    return Math.max(0, canvas.width * canvas.height * CANVAS_BYTE_PER_PIXEL);
  }

  /** @private @param {any} value  { canvas, pageNum } wrapper or bare canvas */
  _onCanvasEvict(value) {
    const canvas = value && value.canvas ? value.canvas : value;
    try {
      const memory = this._core.getMemory();
      if (memory && memory.unregisterCanvas && canvas) {
        memory.unregisterCanvas(canvas);
      }
    } catch { /* ignore */ }
    if (canvas) {
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch { /* ignore */ }
    }
    this._stats.evictions++;
  }

  /** @private @param {{ level?: string }} payload */
  _onMemoryPressure(payload) {
    if (!payload || payload.level !== 'critical') return;
    let currentPage = 1;
    try { currentPage = this._core.getState().get('currentPage') || 1; } catch { /* ignore */ }
    const memory = this._core.getMemory();
    for (const radius of EVICTION_RADII) {
      this.evictFarFrom(currentPage, radius);
      if (!memory) break;
      try {
        const used = memory.usedBytes() + memory.pinnedBytes();
        const cap = memory.capBytes();
        if (used <= cap * PRESSURE_RESET_RATIO) break;
      } catch { break; }
    }
  }

  /**
   * Read the byte cap from the device profile set up by core.js. Falls
   * back to a conservative default if the profile is missing (web build,
   * bootstrap failure).
   * @private @returns {number}
   */
  _computeCapBytes() {
    try {
      const state = this._core.getState();
      const profile = state ? state.get('deviceProfile') : null;
      if (profile && typeof profile.memoryCapBytes === 'number' && profile.memoryCapBytes > 0) {
        return profile.memoryCapBytes;
      }
    } catch { /* ignore */ }
    return FALLBACK_CAP_BYTES;
  }
}

// ============================================================================
// 3. MEMORY MANAGER
// ============================================================================

/**
 * Tracks every canvas the viewer allocates, enforces the total cap, and
 * emits MEMORY_PRESSURE events at configurable thresholds.
 *
 * EVICT-BEFORE-REGISTER:
 *   Before a new canvas is admitted, existing canvases are evicted until
 *   the incoming allocation fits. This is what keeps MEMORY_PRESSURE from
 *   firing on every render — the cap is never breached, so the warning
 *   and critical thresholds are reserved for the rare cases where the
 *   pyramid itself cannot keep up.
 *
 *   Eviction order: farthest from `keepPage` first (so a page 20 away
 *   goes before a page 3 away), oldest registration as the tiebreaker.
 *
 * ITERATION:
 *   WeakMap has no iteration API. A parallel Set holds the same canvas
 *   references so eviction can find and sort candidates. The Set is the
 *   companion to the WeakMap, not a duplicate store — removal from one
 *   is always paired with removal from the other.
 */
export class MemoryManager {
  /** @param {import('./core.js').ViewerCore} core */
  constructor(core) {
    /** @private */ this._core = core;

    /** @private @type {WeakMap<HTMLCanvasElement, { pageNum: number, bytes: number, pinned: boolean, registeredAt: number }>} */
    this._canvases = new WeakMap();

    /** @private @type {Set<HTMLCanvasElement>} */
    this._registered = new Set();

    /** @private */ this._bytesUsed = 0;
    /** @private */ this._bytesPinned = 0;
    /** @private */ this._canvasCount = 0;

    /** @private @type {number} */ this._capBytes = this._computeCapBytes();
    /** @private @type {'none'|'warning'|'critical'} */ this._lastPressureLevel = 'none';
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * Register a canvas.
   *
   * If the incoming canvas alone exceeds the cap, it is admitted and every
   * other non-pinned canvas is evicted first — refusing the render would
   * leave the visible page blank, which is worse than a temporarily tight
   * budget.
   *
   * Otherwise, eviction runs BEFORE the registration so the cap is never
   * breached even momentarily.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {number} pageNum
   * @param {{ pinned?: boolean }} [options]
   * @returns {void}
   */
  registerCanvas(canvas, pageNum, options) {
    if (!canvas) return;
    const bytes = this._canvasBytes(canvas);
    const pinned = !!(options && options.pinned);

    // Single-canvas-larger-than-cap: admit and clear everything else.
    if (bytes > this._capBytes) {
      this._evictAllExcept(canvas);
    } else {
      // Evict before registering so the cap is never exceeded.
      const needed = (this._bytesUsed + this._bytesPinned + bytes) - this._capBytes;
      if (needed > 0) {
        this._evictToTarget(
          this._capBytes - this._bytesPinned - bytes,
          pageNum,
          canvas,
        );
      }
    }

    const existing = this._canvases.get(canvas);
    if (existing) {
      if (existing.pinned) this._bytesPinned -= existing.bytes;
      else this._bytesUsed -= existing.bytes;
    } else {
      this._canvasCount++;
    }

    this._canvases.set(canvas, {
      pageNum,
      bytes,
      pinned,
      registeredAt: Date.now(),
    });
    this._registered.add(canvas);
    if (pinned) this._bytesPinned += bytes;
    else this._bytesUsed += bytes;

    this._evaluatePressure();
  }

  /** @param {HTMLCanvasElement} canvas @returns {void} */
  unregisterCanvas(canvas) {
    if (!canvas) return;
    const entry = this._canvases.get(canvas);
    if (!entry) return;
    if (entry.pinned) this._bytesPinned -= entry.bytes;
    else this._bytesUsed -= entry.bytes;
    this._canvasCount = Math.max(0, this._canvasCount - 1);
    this._canvases.delete(canvas);
    this._registered.delete(canvas);
    this._evaluatePressure();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /** @returns {number} */ usedBytes() { return this._bytesUsed; }
  /** @returns {number} */ pinnedBytes() { return this._bytesPinned; }
  /** @returns {number} */ capBytes() { return this._capBytes; }
  /** @returns {boolean} */ isOverCap() { return this._bytesUsed + this._bytesPinned > this._capBytes; }
  /** @returns {'none'|'warning'|'critical'} */ pressureLevel() { return this._lastPressureLevel; }

  /** @returns {object} */
  report() {
    return {
      usedBytes: this._bytesUsed,
      pinnedBytes: this._bytesPinned,
      capBytes: this._capBytes,
      canvasCount: this._canvasCount,
      level: this._lastPressureLevel,
    };
  }

  // ── Enforcement ───────────────────────────────────────────────────────────

  /** @returns {void} */
  enforceCap() {
    if (!this.isOverCap()) return;
    try {
      this._core.getBus().emit(Events.MEMORY_PRESSURE, {
        level: 'critical',
        usedBytes: this._bytesUsed + this._bytesPinned,
        capBytes: this._capBytes,
      });
    } catch { /* ignore */ }
    this._lastPressureLevel = 'critical';
  }

  /**
   * Schedule an idle-time eviction to bring usage back toward the resume
   * band (RESET_RATIO of the cap). Called by core.js when MEMORY_PRESSURE
   * fires at warning level. Non-blocking.
   *
   * @param {number} activePageIndex
   * @returns {void}
   */
  scheduleBackgroundEviction(activePageIndex) {
    const run = () => {
      if (this._bytesUsed + this._bytesPinned <= this._capBytes * PRESSURE_RESET_RATIO) {
        return;
      }
      const target = this._capBytes * PRESSURE_RESET_RATIO - this._bytesPinned;
      this._evictToTarget(target, activePageIndex, null);
    };

    try {
      if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: 1000 });
      } else {
        setTimeout(run, 200);
      }
    } catch { /* ignore */ }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** @private */
  _evaluatePressure() {
    const total = this._bytesUsed + this._bytesPinned;
    const ratio = this._capBytes > 0 ? total / this._capBytes : 0;

    if (ratio >= PRESSURE_CRITICAL_RATIO) {
      if (this._lastPressureLevel !== 'critical') {
        this._lastPressureLevel = 'critical';
        this._emit('critical', total);
      }
    } else if (ratio >= PRESSURE_WARNING_RATIO) {
      if (this._lastPressureLevel === 'none') {
        this._lastPressureLevel = 'warning';
        this._emit('warning', total);
      }
    } else if (ratio < PRESSURE_RESET_RATIO) {
      this._lastPressureLevel = 'none';
    }
  }

  /** @private @param {'warning'|'critical'} level @param {number} usedBytes */
  _emit(level, usedBytes) {
    try {
      this._core.getBus().emit(Events.MEMORY_PRESSURE, {
        level,
        usedBytes,
        capBytes: this._capBytes,
      });
    } catch { /* ignore */ }
  }

  /**
   * Evict non-pinned canvases (farthest from `keepPage` first, oldest
   * registration as tiebreaker) until total used bytes are at or below
   * `targetBytes`. Skips `skipCanvas` — used when registering a canvas
   * that hasn't been added to `_registered` yet.
   *
   * @private
   * @param {number} targetBytes
   * @param {number} keepPage
   * @param {HTMLCanvasElement|null} skipCanvas
   */
  _evictToTarget(targetBytes, keepPage, skipCanvas) {
    const candidates = [];

    for (const canvas of this._registered) {
      if (canvas === skipCanvas) continue;
      const rec = this._canvases.get(canvas);
      if (!rec || rec.pinned) continue;
      candidates.push({ canvas, rec });
    }

    // Sort: farthest from keepPage first, then oldest registration.
    candidates.sort((a, b) => {
      const da = Math.abs(a.rec.pageNum - keepPage);
      const db = Math.abs(b.rec.pageNum - keepPage);
      if (da !== db) return db - da;
      return a.rec.registeredAt - b.rec.registeredAt;
    });

    for (const c of candidates) {
      if (this._bytesUsed <= targetBytes) break;
      this.unregisterCanvas(c.canvas);
    }
  }

  /**
   * Evict every non-pinned canvas except `keepCanvas`. Used when a single
   * canvas is larger than the whole cap.
   *
   * @private
   * @param {HTMLCanvasElement} keepCanvas
   */
  _evictAllExcept(keepCanvas) {
    const snapshot = Array.from(this._registered);
    for (const canvas of snapshot) {
      if (canvas === keepCanvas) continue;
      const rec = this._canvases.get(canvas);
      if (rec && rec.pinned) continue;
      this.unregisterCanvas(canvas);
    }
  }

  /** @private @param {HTMLCanvasElement|null} canvas @returns {number} */
  _canvasBytes(canvas) {
    if (!canvas || typeof canvas.width !== 'number' || typeof canvas.height !== 'number') return 0;
    return Math.max(0, canvas.width * canvas.height * CANVAS_BYTE_PER_PIXEL);
  }

  /**
   * Read the byte cap from the device profile set up by core.js. Falls
   * back to a conservative default if the profile is missing.
   * @private @returns {number}
   */
  _computeCapBytes() {
    try {
      const state = this._core.getState();
      const profile = state ? state.get('deviceProfile') : null;
      if (profile && typeof profile.memoryCapBytes === 'number' && profile.memoryCapBytes > 0) {
        return profile.memoryCapBytes;
      }
    } catch { /* ignore */ }
    return FALLBACK_CAP_BYTES;
  }
}

// ============================================================================
// 4. SEARCH MANAGER
// ============================================================================

/**
 * Full-text search, worker-backed when the flag is on and main-thread when
 * it is off. Owns the match list, the current match index, the highlight
 * overlays, and the search panel's results list.
 *
 * Highlight overlays are anchored over a rendered page's slot:
 *   • The slot is found by [data-page="n"] inside .page-container.
 *   • If the slot is still a .cover (not yet rendered), no highlights are
 *     drawn — there is no visible content to highlight.
 *   • The layer is absolutely positioned inside .page-container, sized and
 *     offset to match the slot's exact rendered geometry.
 *
 * Rect coordinates are stored at page-local scale-1 coordinates; they are
 * multiplied by `state.scale` at display time so highlights stay aligned
 * across zoom changes without recomputing.
 */
export class SearchManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   * @param {Readonly<{ useWorker: boolean }>} flags
   */
  constructor(core, flags) {
    /** @private */ this._core = core;
    /** @private */ this._flags = flags;

    /** @private @type {string} */ this._query = '';
    /** @private */ this._caseSensitive = false;
    /** @private */ this._wholeWord = false;

    /** @private @type {Array<{ pageNum: number, text: string, rects: any[] }>} */
    this._matches = [];
    /** @private */ this._currentIndex = -1;

    /** @private @type {ReturnType<typeof debounce>|null} */ this._searchDebounce = null;
    /** @private @type {AbortController|null} */ this._abortController = null;
    /** @private @type {Map<number, HTMLElement>} */ this._highlightLayer = new Map();
    /** @private */ this._progress = { scanned: 0, total: 0, startedAt: 0 };
    /** @private */ this._destroyed = false;

    /** @private @type {HTMLElement|null} */ this._panelContainer = null;
    /** @private @type {HTMLElement|null} */ this._resultsList = null;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Run a search. Resolves with the match count. Aborts any prior search.
   * Never rejects.
   *
   * @param {string} query
   * @param {{ caseSensitive?: boolean, wholeWord?: boolean }} [options]
   * @returns {Promise<number>}
   */
  async search(query, options) {
    if (this._destroyed) return 0;

    this.cancel();

    const q = typeof query === 'string' ? query.trim() : '';
    this._query = q;
    this._caseSensitive = !!(options && options.caseSensitive);
    this._wholeWord = !!(options && options.wholeWord);

    if (!q) {
      this._clearInternal();
      this._emitCleared();
      this._renderResultsList();
      return 0;
    }

    const controller = new AbortController();
    this._abortController = controller;
    this._progress = { scanned: 0, total: this._getNumPages(), startedAt: Date.now() };

    try {
      this._core.getState().set('searchQuery', q);
      this._core.getState().set('searchCaseSensitive', this._caseSensitive);
      this._core.getState().set('searchWholeWord', this._wholeWord);
      this._core.getBus().emit(Events.SEARCH_STARTED, {
        query: q,
        caseSensitive: this._caseSensitive,
        wholeWord: this._wholeWord,
      });
    } catch { /* ignore */ }

    let matches = [];
    try {
      if (this._flags.useWorker) {
        matches = await this._searchViaWorker(q, controller.signal);
      } else {
        matches = await this._searchMainThread(q, controller.signal);
      }
    } catch (err) {
      if (!isAbortError(err) && CONFIG.DEBUG_VIEWER) {
        // eslint-disable-next-line no-console
        console.warn('[SearchManager] Search failed:', err);
      }
      matches = [];
    }

    if (controller.signal.aborted || this._destroyed) {
      return 0;
    }

    this._matches = matches;
    this._currentIndex = matches.length > 0 ? 0 : -1;

    try {
      this._core.getState().set('searchMatches', matches);
      this._core.getState().set('currentMatchIndex', this._currentIndex);
      this._core.getBus().emit(Events.SEARCH_COMPLETED, {
        count: matches.length,
        matches,
        currentIndex: this._currentIndex,
      });
    } catch { /* ignore */ }

    this._renderResultsList();
    if (matches.length > 0) this.jumpTo(0);
    return matches.length;
  }

  /**
   * Debounced search. Called by ui-internal on input.
   *
   * @param {string} query
   * @param {{ caseSensitive?: boolean, wholeWord?: boolean }} [options]
   * @returns {void}
   */
  searchDebounced(query, options) {
    if (!this._searchDebounce) {
      this._searchDebounce = debounce((q, o) => {
        this.search(q, o).catch(() => { /* ignore */ });
      }, CONFIG.SEARCH_DEBOUNCE_MS);
    }
    this._searchDebounce(query, options);
  }

  /** @returns {void} */
  cancel() {
    if (this._abortController) {
      try { this._abortController.abort(); } catch { /* ignore */ }
      this._abortController = null;
    }
  }

  /** @returns {boolean} */
  next() {
    if (this._matches.length === 0) return false;
    this._currentIndex = (this._currentIndex + 1) % this._matches.length;
    this._focusCurrent();
    this._renderResultsList();
    return true;
  }

  /** @returns {boolean} */
  previous() {
    if (this._matches.length === 0) return false;
    this._currentIndex = (this._currentIndex - 1 + this._matches.length) % this._matches.length;
    this._focusCurrent();
    this._renderResultsList();
    return true;
  }

  /** @param {number} index @returns {boolean} */
  jumpTo(index) {
    if (this._matches.length === 0) return false;
    const clamped = Math.max(0, Math.min(index, this._matches.length - 1));
    this._currentIndex = clamped;
    this._focusCurrent();
    this._renderResultsList();
    return true;
  }

  /** @returns {any} */
  currentMatch() {
    if (this._currentIndex < 0 || this._currentIndex >= this._matches.length) return null;
    return this._matches[this._currentIndex];
  }

  /** @returns {number} */
  matchCount() { return this._matches.length; }

  /** @returns {number} */
  currentIndex() { return this._currentIndex; }

  /** @returns {void} */
  clear() {
    this.cancel();
    this._clearInternal();
    this._emitCleared();
    this._renderResultsList();
  }

  /**
   * Render highlight overlays for every page with a rendered canvas. Called
   * on RENDER_COMPLETE (page-scoped) and SCALE_APPLIED (all pages).
   *
   * INVARIANTS:
   *   • Highlights are drawn only over a slot whose class is .page (a
   *     rendered canvas). A .cover slot is skipped — no visible content to
   *     highlight yet.
   *   • The layer is a child of .page-container, positioned absolutely to
   *     match the slot's exact geometry.
   *   • rect.x/y/width/height are stored at scale-1 page coordinates;
   *     multiplying by the current display scale keeps them aligned across
   *     zoom without recomputation.
   *
   * @param {number} [onlyPageNum]
   * @returns {void}
   */
  renderHighlights(onlyPageNum) {
    if (this._matches.length === 0) return;
    const scale = this._getScale();

    const els = getViewerElements();
    if (!els || !els.main) return;

    const container = els.main.querySelector('.' + CONFIG.PAGE_CONTAINER_CLASS);
    if (!container) return;

    // Make .page-container the positioning context for the highlight layers.
    if (container.style.position !== 'relative') {
      container.style.position = 'relative';
    }

    // Group this render's matches by page.
    const grouped = new Map();
    for (const match of this._matches) {
      if (typeof onlyPageNum === 'number' && match.pageNum !== onlyPageNum) continue;
      if (!grouped.has(match.pageNum)) grouped.set(match.pageNum, []);
      grouped.get(match.pageNum).push(match);
    }

    const currentMatch = this._matches[this._currentIndex];

    for (const [pageNum, matches] of grouped) {
      const slot = container.querySelector(`[data-page="${pageNum}"]`);
      if (!slot) continue;

      // Only render over a rendered canvas — a cover has nothing to show.
      if (!slot.classList.contains(CONFIG.PAGE_CLASS)) continue;

      // Get or create the layer for this page.
      let layer = this._highlightLayer.get(pageNum);
      if (!layer || !layer.isConnected || layer.parentElement !== container) {
        layer = document.createElement('div');
        layer.className = CONFIG.SEARCH_LAYER_CLASS;
        layer.style.position = 'absolute';
        layer.style.pointerEvents = 'none';
        layer.style.zIndex = '2';
        layer.setAttribute('aria-hidden', 'true');
        container.appendChild(layer);
        this._highlightLayer.set(pageNum, layer);
      }

      // Anchor the layer exactly over the slot's rendered box.
      const containerRect = container.getBoundingClientRect();
      const slotRect = slot.getBoundingClientRect();
      layer.style.left = (slotRect.left - containerRect.left) + 'px';
      layer.style.top = (slotRect.top - containerRect.top) + 'px';
      layer.style.width = slotRect.width + 'px';
      layer.style.height = slotRect.height + 'px';

      layer.innerHTML = '';

      for (const match of matches) {
        const isActive = match === currentMatch;
        for (const rect of match.rects) {
          const el = document.createElement('div');
          el.className = isActive ? CONFIG.SEARCH_HIGHLIGHT_CLASS : 'search-highlight';
          el.style.position = 'absolute';
          el.style.left = (rect.x * scale) + 'px';
          el.style.top = (rect.y * scale) + 'px';
          el.style.width = (rect.width * scale) + 'px';
          el.style.height = (rect.height * scale) + 'px';
          layer.appendChild(el);
        }
      }
    }
  }

  /**
   * Render the search panel into the given container. Called by the factory
   * when the drawer's panel switches to "search".
   *
   * @param {HTMLElement|null} container
   * @returns {void}
   */
  renderPanel(container) {
    if (!container) return;
    this._panelContainer = container;
    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'search-panel-header';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Find in document…';
    input.className = 'search-panel-input';
    input.value = this._query || '';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    input.addEventListener('input', () => {
      const q = input.value || '';
      const cs = caseToggle.checked;
      const ww = wholeToggle.checked;
      this.searchDebounced(q, { caseSensitive: cs, wholeWord: ww });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) this.previous();
        else this.next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        input.value = '';
        this.clear();
      }
    });

    const options = document.createElement('div');
    options.className = 'search-panel-options';

    const caseLabel = document.createElement('label');
    caseLabel.className = 'search-panel-toggle';
    const caseToggle = document.createElement('input');
    caseToggle.type = 'checkbox';
    caseToggle.checked = this._caseSensitive;
    caseToggle.addEventListener('change', () => {
      const q = input.value || '';
      if (q) this.searchDebounced(q, { caseSensitive: caseToggle.checked, wholeWord: wholeToggle.checked });
    });
    caseLabel.appendChild(caseToggle);
    caseLabel.appendChild(document.createTextNode(' Aa'));

    const wholeLabel = document.createElement('label');
    wholeLabel.className = 'search-panel-toggle';
    const wholeToggle = document.createElement('input');
    wholeToggle.type = 'checkbox';
    wholeToggle.checked = this._wholeWord;
    wholeToggle.addEventListener('change', () => {
      const q = input.value || '';
      if (q) this.searchDebounced(q, { caseSensitive: caseToggle.checked, wholeWord: wholeToggle.checked });
    });
    wholeLabel.appendChild(wholeToggle);
    wholeLabel.appendChild(document.createTextNode(' “”'));

    options.appendChild(caseLabel);
    options.appendChild(wholeLabel);

    const count = document.createElement('div');
    count.className = 'search-panel-count';
    count.textContent = this._formatCount();

    header.appendChild(input);
    header.appendChild(options);
    header.appendChild(count);

    const resultsList = document.createElement('div');
    resultsList.className = 'search-panel-results';

    container.appendChild(header);
    container.appendChild(resultsList);

    this._resultsList = resultsList;
    this._renderResultsList();

    Promise.resolve().then(() => {
      try { input.focus(); } catch { /* ignore */ }
      try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* ignore */ }
    });
  }

  /** @returns {void} */
  destroy() {
    this._destroyed = true;
    this.cancel();
    if (this._searchDebounce) {
      try { this._searchDebounce.cancel(); } catch { /* ignore */ }
      this._searchDebounce = null;
    }
    for (const [, layer] of this._highlightLayer) {
      try { layer.remove(); } catch { /* ignore */ }
    }
    this._highlightLayer.clear();
    this._clearInternal();
    this._panelContainer = null;
    this._resultsList = null;
  }

  // ── Results list rendering ────────────────────────────────────────────────

  /** @private */
  _renderResultsList() {
    const list = this._resultsList;
    if (!list) return;
    list.innerHTML = '';

    if (this._matches.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'search-panel-empty';
      empty.textContent = this._query ? 'No matches' : 'Type to search';
      list.appendChild(empty);
      this._updateCountEl();
      return;
    }

    const grouped = new Map();
    for (const match of this._matches) {
      if (!grouped.has(match.pageNum)) grouped.set(match.pageNum, []);
      grouped.get(match.pageNum).push(match);
    }

    const currentMatch = this._matches[this._currentIndex];

    for (const [pageNum, matches] of grouped) {
      const group = document.createElement('div');
      group.className = 'search-panel-group';

      const header = document.createElement('div');
      header.className = 'search-panel-group-header';
      header.textContent = `Page ${pageNum}`;
      group.appendChild(header);

      for (const match of matches) {
        const isActive = match === currentMatch;
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'search-panel-result' + (isActive ? ' active' : '');
        item.setAttribute('aria-current', isActive ? 'true' : 'false');

        const snippet = document.createElement('span');
        snippet.className = 'search-panel-snippet';
        snippet.textContent = match.text || '';
        item.appendChild(snippet);

        item.addEventListener('click', () => {
          const idx = this._matches.indexOf(match);
          if (idx >= 0) this.jumpTo(idx);
        });

        group.appendChild(item);
      }

      list.appendChild(group);
    }

    try {
      const active = list.querySelector('.search-panel-result.active');
      if (active && typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' });
      }
    } catch { /* ignore */ }

    this._updateCountEl();
  }

  /** @private */
  _updateCountEl() {
    const container = this._panelContainer;
    if (!container) return;
    const count = container.querySelector('.search-panel-count');
    if (!count) return;
    count.textContent = this._formatCount();
  }

  /** @private @returns {string} */
  _formatCount() {
    if (this._matches.length === 0) {
      return this._query ? '0/0' : '';
    }
    const idx = this._currentIndex >= 0 ? this._currentIndex + 1 : 1;
    return `${idx}/${this._matches.length}`;
  }

  // ── Worker path ───────────────────────────────────────────────────────────

  /** @private */
  async _searchViaWorker(query, signal) {
    const workers = this._core.getWorkers();
    if (!workers || !workers.ensureSearchWorker || !workers.postToSearch) {
      return this._searchMainThread(query, signal);
    }

    let workerHandle;
    try {
      workerHandle = await workers.ensureSearchWorker();
    } catch (err) {
      if (err && err.code === 'WORKER_DISABLED') {
        return this._searchMainThread(query, signal);
      }
      return this._searchMainThread(query, signal);
    }
    if (!workerHandle || signal.aborted) return [];

    try { await workers.postToSearch('clear', {}, { signal }); } catch { /* ignore */ }

    const total = this._getNumPages();
    for (let i = 1; i <= total; i++) {
      if (signal.aborted) throw createAbortError('Search cancelled');
      const items = await this._getTextItems(i);
      if (!items) continue;
      const fullText = items.map((it) => (it && typeof it.str === 'string' ? it.str : '')).join('');
      try {
        await workers.postToSearch('index-page', {
          pageNum: i,
          fullText,
          itemCount: items.length,
        }, { signal });
      } catch (err) {
        if (isAbortError(err)) throw err;
      }
    }

    if (signal.aborted) throw createAbortError('Search cancelled');

    let rawResult;
    try {
      rawResult = await workers.postToSearch('search', {
        query,
        options: { caseSensitive: this._caseSensitive, wholeWord: this._wholeWord },
        pages: Array.from({ length: total }, (_, i) => i + 1),
      }, { signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      return [];
    }

    if (signal.aborted) return [];

    const rawMatches = rawResult && Array.isArray(rawResult.matches) ? rawResult.matches : [];

    const finalMatches = [];
    for (const raw of rawMatches) {
      if (signal.aborted) throw createAbortError('Search cancelled');
      const items = await this._getTextItems(raw.pageNum);
      if (!items) continue;
      const viewport = await this._getViewportAtScale1(raw.pageNum);
      if (!viewport) continue;
      const rects = computeRectsForMatch(
        { matchStart: raw.matchStart, matchEnd: raw.matchEnd },
        items,
        viewport,
      );
      if (rects.length > 0) {
        finalMatches.push({ pageNum: raw.pageNum, text: raw.text, rects });
      }
    }
    return finalMatches;
  }

  // ── Main-thread path ──────────────────────────────────────────────────────

  /** @private */
  async _searchMainThread(query, signal) {
    const regex = buildSearchRegex(query, this._caseSensitive, this._wholeWord);
    if (!regex) return [];

    const total = this._getNumPages();
    const matches = [];
    let scanned = 0;

    for (let i = 1; i <= total; i++) {
      if (signal.aborted) throw createAbortError('Search cancelled');
      scanned = i;

      if (i % SEARCH_PROGRESS_INTERVAL === 0) {
        this._emitProgress(scanned, total);
        await new Promise((r) => setTimeout(r, 0));
      }

      let items;
      try { items = await this._getTextItems(i); } catch { continue; }
      if (!items || items.length === 0) continue;

      const viewport = await this._getViewportAtScale1(i);
      if (!viewport) continue;

      const fullText = items.map((it) => (it && typeof it.str === 'string' ? it.str : '')).join('');
      if (!fullText) continue;

      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(fullText)) !== null) {
        const rects = computeRectsForMatch(
          { matchStart: m.index, matchEnd: m.index + m[0].length },
          items,
          viewport,
        );
        if (rects.length > 0) {
          matches.push({ pageNum: i, text: m[0], rects });
        }
        if (m[0].length === 0) regex.lastIndex++;
      }
    }

    this._emitProgress(total, total);
    return matches;
  }

  // ── Focus / navigation ────────────────────────────────────────────────────

  /** @private */
  _focusCurrent() {
    const match = this.currentMatch();
    if (!match) return;

    this.renderHighlights();

    try {
      this._core.getState().set('currentMatchIndex', this._currentIndex);
      this._core.getBus().emit(Events.SEARCH_MATCH_FOCUSED, {
        index: this._currentIndex,
        pageNum: match.pageNum,
      });
    } catch { /* ignore */ }

    let currentPage = 1;
    try { currentPage = this._core.getState().get('currentPage') || 1; } catch { /* ignore */ }
    if (currentPage !== match.pageNum) {
      try {
        this._core.getBus().emit(Events.PAGE_JUMP_REQUESTED, {
          pageNum: match.pageNum,
          reason: 'search',
        });
      } catch { /* ignore */ }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** @private @param {number} pageNum @returns {Promise<any[]|null>} */
  async _getTextItems(pageNum) {
    const cache = this._core.getCache();
    if (cache && cache.hasTextContent && cache.hasTextContent(pageNum)) {
      const cached = cache.getTextContent(pageNum);
      if (cached && Array.isArray(cached.items)) return cached.items;
    }
    const engine = this._core.getEngine();
    if (!engine || !engine.extractText) return null;
    try {
      const content = await engine.extractText(pageNum);
      if (cache && cache.setTextContent) cache.setTextContent(pageNum, content);
      return content && Array.isArray(content.items) ? content.items : null;
    } catch {
      return null;
    }
  }

  /** @private @param {number} pageNum @returns {Promise<any|null>} */
  async _getViewportAtScale1(pageNum) {
    const engine = this._core.getEngine();
    if (!engine || !engine.getViewport) return null;
    try {
      return await engine.getViewport(pageNum, 1);
    } catch {
      return null;
    }
  }

  /** @private */
  _clearInternal() {
    this._matches = [];
    this._currentIndex = -1;
    this._query = '';
    for (const [, layer] of this._highlightLayer) {
      try { layer.innerHTML = ''; } catch { /* ignore */ }
    }
  }

  /** @private */
  _emitCleared() {
    try {
      this._core.getState().set('searchMatches', []);
      this._core.getState().set('currentMatchIndex', -1);
      this._core.getBus().emit(Events.SEARCH_CLEARED, {});
    } catch { /* ignore */ }
  }

  /** @private @param {number} scanned @param {number} total */
  _emitProgress(scanned, total) {
    try {
      this._core.getBus().emit(Events.SEARCH_PROGRESS, {
        scanned,
        total,
        startedAt: this._progress.startedAt,
      });
    } catch { /* ignore */ }
  }

  /** @private @returns {number} */
  _getScale() {
    try {
      const s = this._core.getState().get('scale');
      return typeof s === 'number' && s > 0 ? s : 1;
    } catch { return 1; }
  }

  /** @private @returns {number} */
  _getNumPages() {
    try { return this._core.getState().get('numPages') || 1; } catch { return 1; }
  }
}

// ============================================================================
// 4a. SEARCH HELPERS
// ============================================================================

/**
 * Build a regex from a query string.
 * @private
 */
function buildSearchRegex(query, caseSensitive, wholeWord) {
  if (!query) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

/**
 * Compute display rects for a match range in `items` using a scale-1 viewport.
 * @private
 */
function computeRectsForMatch(match, items, viewport) {
  const rects = [];
  if (!Array.isArray(items) || items.length === 0) return rects;
  if (!viewport || typeof viewport.convertToViewportRectangle !== 'function') return rects;

  const startIdx = match.matchStart;
  const endIdx = match.matchEnd;
  if (!(endIdx > startIdx)) return rects;

  let charCount = 0;
  for (const item of items) {
    if (!item || typeof item.str !== 'string') continue;
    const len = item.str.length;
    const itemStart = charCount;
    const itemEnd = charCount + len;
    charCount = itemEnd;

    if (itemEnd <= startIdx) continue;
    if (itemStart >= endIdx) break;

    const tx = item.transform;
    if (!Array.isArray(tx) || tx.length < 6) continue;

    const x1 = tx[4];
    const y1 = tx[5];
    const x2 = x1 + (typeof item.width === 'number' ? item.width : 0);
    const y2 = y1 + (typeof item.height === 'number' ? item.height : 0);

    let rect;
    try {
      rect = viewport.convertToViewportRectangle([x1, y1, x2, y2]);
    } catch {
      continue;
    }
    if (!Array.isArray(rect) || rect.length < 4) continue;

    const x = Math.min(rect[0], rect[2]);
    const y = Math.min(rect[1], rect[3]);
    const w = Math.abs(rect[2] - rect[0]);
    const h = Math.abs(rect[3] - rect[1]);
    rects.push({ x, y, width: w, height: h });
  }

  return rects;
}

// ============================================================================
// 5. OUTLINE MANAGER
// ============================================================================

/**
 * Renders the document outline as a collapsible tree into the sidebar's
 * "outline" panel and translates item clicks into PAGE_JUMP_REQUESTED events.
 *
 * NAVIGATION MODEL — why buttons, not anchors:
 *   Outline items are <button> elements, not <a href="#...">. An anchor
 *   inside an SPA shell can be intercepted by a router, or (on Android
 *   WebView) trigger a reload when the default action isn't prevented in
 *   time. Buttons have no default navigation, so the reload vector is
 *   eliminated structurally — no reliance on preventDefault succeeding.
 *
 * TREE MODEL:
 *   • Level 0 items start expanded if they have children.
 *   • Deeper levels start collapsed.
 *   • A disclosure triangle (▸/▾) toggles children on click.
 *   • Clicking the label (not the triangle) navigates to the destination.
 *
 * Levels beyond 3 are flattened to level 3 to prevent runaway indentation
 * on malformed outlines.
 */
export class OutlineManager {
  /** @param {import('./core.js').ViewerCore} core */
  constructor(core) {
    /** @private */ this._core = core;
    /** @private @type {any[]} */ this._items = [];
    /** @private @type {HTMLElement|null} */ this._drawerElement = null;
    /** @private */ this._empty = true;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /** @param {any[]|null} items @returns {void} */
  build(items) {
    this._items = Array.isArray(items) ? items : [];
    this._empty = this._items.length === 0;

    const drawer = this._getDrawer();
    if (!drawer) return;
    this._drawerElement = drawer;

    drawer.innerHTML = '';

    if (this._empty) {
      const empty = document.createElement('div');
      empty.className = 'outline-empty';
      empty.textContent = 'No outline available';
      drawer.appendChild(empty);
      this._emitReady(0);
      return;
    }

    const root = document.createElement('div');
    root.className = 'outline-root';
    root.appendChild(this._renderItems(this._items, 0));
    drawer.appendChild(root);

    this._emitReady(this._items.length);
  }

  /** @returns {void} */
  rebuild() {
    this.build(this._items);
  }

  /** @param {HTMLElement|null} container @returns {void} */
  renderPanel(container) {
    if (!container) return;
    this._drawerElement = container;
    this.build(this._items);
  }

  /** @returns {void} */
  toggle() {
    const drawer = this._getDrawer();
    if (!drawer) return;
    drawer.classList.toggle('open');
  }

  /** @returns {void} */
  close() {
    const drawer = this._getDrawer();
    if (!drawer) return;
    drawer.classList.remove('open');
  }

  /** @returns {void} */
  clear() {
    const drawer = this._getDrawer();
    if (drawer) drawer.innerHTML = '';
    this._items = [];
    this._empty = true;
  }

  /** @param {any} dest @returns {Promise<void>} */
  async navigateToDest(dest) {
    if (!dest) return;
    const engine = this._core.getEngine();
    if (!engine || !engine.getPageIndex) return;
    try {
      const index = await engine.getPageIndex(dest);
      if (typeof index !== 'number' || index < 0) return;
      const pageNum = index + 1;
      this._core.getBus().emit(Events.PAGE_JUMP_REQUESTED, {
        pageNum,
        reason: 'outline',
      });
    } catch (err) {
      if (CONFIG.DEBUG_VIEWER) {
        // eslint-disable-next-line no-console
        console.warn('[OutlineManager] Failed to resolve destination:', err);
      }
    }
  }

  /** @returns {void} */
  destroy() {
    this.clear();
    this._drawerElement = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** @private @returns {HTMLElement|null} */
  _getDrawer() {
    if (this._drawerElement && this._drawerElement.isConnected) {
      return this._drawerElement;
    }
    try {
      const el = document.getElementById('viewer-outline-drawer');
      this._drawerElement = el;
      return el;
    } catch {
      return null;
    }
  }

  /**
   * Recursively render an outline level. Returns the <ul> for that level;
   * the caller attaches it to the DOM (root) or to a hidden container that
   * a disclosure triangle toggles.
   *
   * @private
   * @param {any[]} items
   * @param {number} level
   * @returns {HTMLUListElement}
   */
  _renderItems(items, level) {
    const ul = document.createElement('ul');
    ul.className = 'outline-list';
    const safeLevel = Math.min(level, 3);

    for (const item of items) {
      if (!item) continue;

      const li = document.createElement('li');
      li.className = `outline-item level-${safeLevel}`;

      const hasChildren = Array.isArray(item.items) && item.items.length > 0;

      // Row wraps toggle + label. Clicking the toggle expands/collapses;
      // clicking the label navigates.
      const row = document.createElement('div');
      row.className = 'outline-row';

      // Disclosure triangle (or a spacer to keep labels aligned).
      if (hasChildren) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'outline-toggle';
        toggle.setAttribute('aria-label', 'Toggle section');
        toggle.textContent = level === 0 ? '▾' : '▸';
        row.appendChild(toggle);

        // Nested children, hidden unless this is a top-level expanded item.
        const childUl = this._renderItems(item.items, level + 1);
        childUl.classList.add('outline-nested');
        const startExpanded = level === 0;
        childUl.hidden = !startExpanded;
        toggle.setAttribute('aria-expanded', startExpanded ? 'true' : 'false');

        toggle.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const expanded = toggle.getAttribute('aria-expanded') === 'true';
          toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
          toggle.textContent = expanded ? '▸' : '▾';
          childUl.hidden = expanded;
        });

        li.appendChild(childUl);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'outline-toggle-spacer';
        spacer.setAttribute('aria-hidden', 'true');
        row.appendChild(spacer);
      }

      // The label. Uses <button>, never <a href>. Buttons have no default
      // navigation, so a router or WebView cannot trigger a reload on click.
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'outline-link';
      label.textContent = item.title || 'Untitled';
      label.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.navigateToDest(item.dest).catch(() => { /* ignore */ });
        try {
          if (typeof window !== 'undefined' && window.innerWidth < 768) {
            this.close();
          }
        } catch { /* ignore */ }
      });
      row.appendChild(label);

      li.insertBefore(row, li.firstChild);
      ul.appendChild(li);
    }

    return ul;
  }

  /** @private @param {number} count */
  _emitReady(count) {
    try {
      this._core.getBus().emit(Events.OUTLINE_READY, { count });
    } catch { /* ignore */ }
  }
}

// ============================================================================
// 6. MORE PANEL
// ============================================================================

/**
 * Renders the "more" sidebar panel: document properties, page count, file
 * information, and action buttons (rotate, download, print).
 */
export class MorePanel {
  /** @param {import('./core.js').ViewerCore} core */
  constructor(core) {
    /** @private */ this._core = core;
    /** @private @type {object|null} */ this._info = null;
    /** @private @type {HTMLElement|null} */ this._container = null;
  }

  /** @param {HTMLElement|null} container @returns {Promise<void>} */
  async renderPanel(container) {
    if (!container) return;
    this._container = container;
    container.innerHTML = '';

    if (!this._info) {
      this._info = await this._fetchInfo();
    }

    const info = this._info || {};

    const infoSection = document.createElement('div');
    infoSection.className = 'more-section';

    const infoTitle = document.createElement('h4');
    infoTitle.textContent = 'Document Information';
    infoSection.appendChild(infoTitle);

    const dl = document.createElement('dl');
    dl.className = 'more-info-list';
    this._appendRow(dl, 'Title', info.title || '—');
    this._appendRow(dl, 'Author', info.author || '—');
    this._appendRow(dl, 'Subject', info.subject || '—');
    this._appendRow(dl, 'Keywords', info.keywords || '—');
    this._appendRow(dl, 'Pages', info.numPages != null ? String(info.numPages) : '—');
    this._appendRow(dl, 'Created', info.creationDate || '—');
    this._appendRow(dl, 'Modified', info.modDate || '—');
    this._appendRow(dl, 'Producer', info.producer || '—');
    this._appendRow(dl, 'PDF Version', info.pdfVersion || '—');
    infoSection.appendChild(dl);

    const actionsSection = document.createElement('div');
    actionsSection.className = 'more-section';

    const actionsTitle = document.createElement('h4');
    actionsTitle.textContent = 'Actions';
    actionsSection.appendChild(actionsTitle);

    const actions = document.createElement('div');
    actions.className = 'more-actions';

    actions.appendChild(this._makeAction('Rotate 90° clockwise', () => {
      this._core.getBus().emit(Events.ROTATE_REQUESTED, { delta: 90 });
    }));
    actions.appendChild(this._makeAction('Rotate 90° counter-clockwise', () => {
      this._core.getBus().emit(Events.ROTATE_REQUESTED, { delta: -90 });
    }));
    actions.appendChild(this._makeAction('Fit to width', () => {
      try {
        const zoom = this._core.getZoom();
        if (zoom && typeof zoom.requestFit === 'function') zoom.requestFit();
      } catch { /* ignore */ }
    }));
    actions.appendChild(this._makeAction('Print', () => {
      try { window.print(); } catch { /* ignore */ }
    }));

    actions.appendChild(this._makeAction('Download', () => {
      try {
        const state = this._core.getState();
        const title = state.get('title') || 'document';
        const hint = document.createElement('div');
        hint.className = 'more-hint';
        hint.textContent = `"${title}" is already open. Use your browser's save option to keep a copy.`;
        actionsSection.appendChild(hint);
        setTimeout(() => { try { hint.remove(); } catch { /* ignore */ } }, 4000);
      } catch { /* ignore */ }
    }));

    actionsSection.appendChild(actions);

    try {
      const hasFinePointer = typeof window !== 'undefined'
        && typeof window.matchMedia === 'function'
        && window.matchMedia('(pointer: fine)').matches;

      if (hasFinePointer) {
        const shortcutsSection = document.createElement('div');
        shortcutsSection.className = 'more-section';

        const stTitle = document.createElement('h4');
        stTitle.textContent = 'Keyboard Shortcuts';
        shortcutsSection.appendChild(stTitle);

        const shortcutsDl = document.createElement('dl');
        shortcutsDl.className = 'more-info-list';
        this._appendRow(shortcutsDl, 'Search', 'Ctrl / ⌘ + F');
        this._appendRow(shortcutsDl, 'Next match', 'F3');
        this._appendRow(shortcutsDl, 'Previous match', 'Shift + F3');
        this._appendRow(shortcutsDl, 'Zoom in', 'Ctrl / ⌘ + +');
        this._appendRow(shortcutsDl, 'Zoom out', 'Ctrl / ⌘ + -');
        this._appendRow(shortcutsDl, 'Reset zoom', 'Ctrl / ⌘ + 0');
        this._appendRow(shortcutsDl, 'Next / prev page', 'Page Up / Page Down');
        this._appendRow(shortcutsDl, 'First / last page', 'Home / End');
        this._appendRow(shortcutsDl, 'Fullscreen', 'F11');
        shortcutsSection.appendChild(shortcutsDl);
        container.appendChild(shortcutsSection);
      }
    } catch { /* ignore */ }

    container.appendChild(infoSection);
    container.appendChild(actionsSection);
  }

  /** @returns {void} */
  clear() {
    this._info = null;
    this._container = null;
  }

  /** @returns {void} */
  destroy() {
    this.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** @private @returns {Promise<object>} */
  async _fetchInfo() {
    const info = {
      title: null,
      author: null,
      subject: null,
      keywords: null,
      numPages: null,
      creationDate: null,
      modDate: null,
      producer: null,
      pdfVersion: null,
    };

    try {
      const state = this._core.getState();
      info.numPages = state.get('numPages') || null;
      info.title = state.get('title') || null;
    } catch { /* ignore */ }

    try {
      const engine = this._core.getEngine();
      let rawMeta = null;
      if (engine && typeof engine.getMetadata === 'function') {
        rawMeta = await engine.getMetadata();
      } else if (engine && engine._pdfDoc && typeof engine._pdfDoc.getMetadata === 'function') {
        rawMeta = await engine._pdfDoc.getMetadata();
      }
      if (rawMeta && rawMeta.info) {
        const i = rawMeta.info;
        info.title = i.Title || info.title;
        info.author = i.Author || null;
        info.subject = i.Subject || null;
        info.keywords = i.Keywords || null;
        info.creationDate = formatPdfDate(i.CreationDate);
        info.modDate = formatPdfDate(i.ModDate);
        info.producer = i.Producer || null;
      }
      if (rawMeta && rawMeta.metadata) {
        try {
          const xmp = rawMeta.metadata;
          if (xmp && typeof xmp.get === 'function') {
            info.pdfVersion = info.pdfVersion || null;
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    return info;
  }

  /** @private */
  _appendRow(dl, label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  /** @private */
  _makeAction(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'more-action-btn';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      try { onClick(); } catch { /* ignore */ }
    });
    return btn;
  }
}

/**
 * Format a PDF date string (`D:YYYYMMDDHHmmSS...`) as a human-readable
 * date. Returns the input unchanged if it does not match the expected
 * shape.
 *
 * @private
 */
function formatPdfDate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return raw;
  const [, y, mo, d, h, mi] = m;
  try {
    const date = new Date(
      Number(y),
      Number(mo) - 1,
      Number(d),
      Number(h || 0),
      Number(mi || 0),
    );
    return date.toLocaleString();
  } catch {
    return raw;
  }
}

// ============================================================================
// 7. FACTORY
// ============================================================================

/**
 * Instantiate all managers, wire cross-module subscriptions, and return the
 * aggregate plus a teardown function.
 *
 * Panel wiring:
 *   The drawer's `data-panel` attribute is the single source of truth for
 *   which panel is active. A MutationObserver watches both `data-panel` and
 *   `class` (for the `.open` toggle) on the drawer element. Whenever either
 *   changes, the corresponding manager's renderPanel method is invoked.
 *
 *   `dispatchPanel(panel)` is exposed on the aggregate so ui-internal can
 *   force a render explicitly — this is a belt-and-braces path for the
 *   "same panel, drawer re-opened" case, where the attribute doesn't change
 *   and therefore the observer doesn't fire.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {{
 *   cache: CacheManager,
 *   memory: MemoryManager,
 *   search: SearchManager,
 *   outline: OutlineManager,
 *   more: MorePanel,
 *   dispatchPanel: (panel: string) => Promise<void>,
 *   teardown: () => void,
 * }}
 */
export function createManagers(core) {
  let rawFlags = {};
  try {
    const state = core.getState();
    rawFlags = (state && state.get('flags')) || {};
  } catch { /* ignore */ }

  const flags = Object.freeze({
    useLru: rawFlags.USE_LRU_CACHES === true,
    useWorker: rawFlags.USE_WORKER_SEARCH === true,
  });

  const cache = new CacheManager(core, flags);
  const memory = new MemoryManager(core);
  const search = new SearchManager(core, flags);
  const outline = new OutlineManager(core);
  const more = new MorePanel(core);

  // ── Cross-module subscriptions ────────────────────────────────────────────
  /** @type {Array<() => void>} */
  const teardowns = [];
  const bus = core.getBus();

  // RENDER_COMPLETE → refresh highlights on that page only.
  teardowns.push(bus.on(Events.RENDER_COMPLETE, (payload) => {
    if (!payload || typeof payload.pageNum !== 'number') return;
    if (search.matchCount() === 0) return;
    try { search.renderHighlights(payload.pageNum); } catch { /* ignore */ }
  }));

  // SCALE_APPLIED → refresh all highlights (rects scale with the pages).
  teardowns.push(bus.on(Events.SCALE_APPLIED, () => {
    if (search.matchCount() === 0) return;
    try { search.renderHighlights(); } catch { /* ignore */ }
  }));

  // DOCUMENT_LOADED → hand the outline tree to OutlineManager.
  teardowns.push(bus.on(Events.DOCUMENT_LOADED, (payload) => {
    if (!payload || !Array.isArray(payload.outline)) return;
    try { outline.build(payload.outline); } catch { /* ignore */ }
  }));

  // DOCUMENT_DESTROYED → clear all manager state.
  teardowns.push(bus.on(Events.DOCUMENT_DESTROYED, () => {
    try { search.clear(); } catch { /* ignore */ }
    try { outline.clear(); } catch { /* ignore */ }
    try { more.clear(); } catch { /* ignore */ }
    try { cache.evictAll(); } catch { /* ignore */ }
  }));

  // MEMORY_PRESSURE (critical) → enforce cache eviction.
  //
  // MemoryManager now evicts before registering, so it rarely emits at
  // critical level. When it does, the pyramid could not keep up — the
  // cache tiers are swept in addition to whatever MemoryManager did.
  teardowns.push(bus.on(Events.MEMORY_PRESSURE, (payload) => {
    if (!payload || payload.level !== 'critical') return;
    try { cache._onMemoryPressure(payload); } catch { /* ignore */ }
  }));

  // ── Panel dispatch ────────────────────────────────────────────────────────

  /** @param {'outline'|'search'|'more'|null|undefined} panel */
  async function _dispatchPanel(panel) {
    const drawer = document.getElementById('viewer-outline-drawer');
    if (!drawer) return;

    // Only render into an open drawer. Rendering into a hidden drawer
    // wastes metadata calls and runs layout work nobody will see.
    if (!drawer.classList.contains('open')) return;

    switch (panel) {
      case 'outline':
        outline.renderPanel(drawer);
        break;
      case 'search':
        search.renderPanel(drawer);
        break;
      case 'more':
        try { await more.renderPanel(drawer); } catch { /* ignore */ }
        break;
      default:
        drawer.dataset.panel = 'outline';
        outline.renderPanel(drawer);
        break;
    }
  }

  // Watch the drawer for panel changes and open/close transitions.
  let drawerObserver = null;
  try {
    const drawer = document.getElementById('viewer-outline-drawer');
    if (drawer && typeof MutationObserver === 'function') {
      drawerObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' &&
              (m.attributeName === 'data-panel' || m.attributeName === 'class')) {
            Promise.resolve().then(() => _dispatchPanel(drawer.dataset.panel));
            return;
          }
        }
      });
      drawerObserver.observe(drawer, {
        attributes: true,
        attributeFilter: ['data-panel', 'class'],
      });

      teardowns.push(() => {
        try { drawerObserver.disconnect(); } catch { /* ignore */ }
      });
    }
  } catch { /* ignore */ }

  const api = {
    cache,
    memory,
    search,
    outline,
    more,
    /** @param {string} panel */
    dispatchPanel: (panel) => _dispatchPanel(panel),

    /** Idempotent teardown. */
    teardown() {
      for (const fn of teardowns.splice(0)) {
        try { fn(); } catch { /* ignore */ }
      }
      try { search.destroy(); } catch { /* ignore */ }
      try { outline.destroy(); } catch { /* ignore */ }
      try { more.destroy(); } catch { /* ignore */ }
      try { cache.evictAll(); } catch { /* ignore */ }
    },
  };

  return api;
}