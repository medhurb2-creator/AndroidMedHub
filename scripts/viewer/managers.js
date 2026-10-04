// frontend-user/scripts/viewer/managers.js

/**
 * Universal Document Viewer — Managers
 * ============================================================================
 *
 * The viewer's memory, search, and navigation subsystem. Owns every cache
 * tier, every memory-pressure decision, the search pipeline, and the outline.
 *
 * Exports (6):
 *   • LRUCache        — byte-accounted least-recently-used cache primitive
 *   • CacheManager    — five-tier cache (text / viewport / canvas / thumb / spatial)
 *   • MemoryManager   — canvas registry + pressure-level emission
 *   • SearchManager   — worker-backed search + highlight overlays
 *   • OutlineManager  — outline tree + destination navigation
 *   • createManagers(core) — factory
 *
 * Boundary rule (architecture spec § 2.3):
 *   • This is the ONLY file permitted to hold page-keyed or canvas-keyed Maps.
 *   • The only DOM boundaries are: the outline drawer and .search-layer overlays.
 *   • Never touches the engine directly — engine access via core.getEngine().
 *   • Never creates canvases — those are produced by PageRenderer and handed
 *     in for caching.
 *
 * Import discipline:
 *   • { CONFIG, Events, PRIORITY } from './core.js'
 *   • { escapeHtml, isAbortError, createAbortError, debounce,
 *       rectOverlapArea } from './utils.js'
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

/** Mem-pressure hysteresis: reset to 'none' below 70%. @private */
const PRESSURE_RESET_RATIO = 0.7;

/** Eviction radius sequence when under pressure. @private */
const EVICTION_RADII = [4, 3, 2, 1, 0];

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

  /**
   * @param {any} key
   * @returns {any}
   */
  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    // Promote to most-recently-used.
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  /**
   * @param {any} key
   * @returns {boolean}
   */
  has(key) {
    return this._map.has(key);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /**
   * @param {any} key
   * @param {any} value
   * @returns {void}
   */
  set(key, value) {
    const bytes = this._computeBytes(value);

    // Replace if existing.
    if (this._map.has(key)) {
      const prev = this._map.get(key);
      this._bytes -= prev ? prev.bytes : 0;
      this._map.delete(key);
    }

    // Single-value-larger-than-cap: store anyway, evict everything else.
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

  /**
   * @param {any} key
   * @returns {boolean}
   */
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

  /**
   * @returns {void}
   */
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

  /**
   * @param {number} count
   * @returns {number}
   */
  evictLeastRecent(count) {
    let evicted = 0;
    for (const key of Array.from(this._map.keys())) {
      if (evicted >= count) break;
      this.delete(key);
      evicted++;
    }
    return evicted;
  }

  /**
   * @param {number} maxEntries
   * @param {number} [maxBytes]
   * @returns {void}
   */
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

  /**
   * @private
   * @param {any} value
   * @returns {number}
   */
  _computeBytes(value) {
    if (!this._sizeOf) return 1;
    try {
      const b = this._sizeOf(value);
      return typeof b === 'number' && b > 0 ? b : 1;
    } catch {
      return 1;
    }
  }

  /**
   * @private
   */
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

  /**
   * @private
   * @param {any} keepKey
   */
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
 */
export class CacheManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   * @param {Readonly<{ useLru: boolean }>} flags
   */
  constructor(core, flags) {
    /** @private */ this._core = core;
    /** @private */ this._flags = flags;

    // Compute cap from device profile.
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

    // Subscribe to memory pressure for the enforceCap path.
    try {
      const bus = core.getBus();
      bus.on(Events.MEMORY_PRESSURE, (payload) => this._onMemoryPressure(payload));
    } catch { /* ignore */ }
  }

  // ── Text tier ─────────────────────────────────────────────────────────────

  /** @param {number} pageNum @returns {any} */
  getTextContent(pageNum) {
    return this._flags.useLru ? this._text.get(pageNum) : this._text.get(pageNum);
  }

  /** @param {number} pageNum @param {any} content */
  setTextContent(pageNum, content) {
    if (!content) return;
    if (this._flags.useLru) this._text.set(pageNum, content);
    else this._text.set(pageNum, content);
    this._stats.text = this._text.size || this._text.size;
  }

  /** @param {number} pageNum @returns {boolean} */
  hasTextContent(pageNum) {
    return this._text.has(pageNum);
  }

  /** @returns {void} */
  clearTextCache() {
    if (this._flags.useLru) this._text.clear();
    else this._text.clear();
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
    // Store as {canvas, pageNum} so evictFarFrom can inspect the page number.
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
      // Non-LRU Map: manually unregister canvases.
      for (const [, value] of this._canvas) {
        this._onCanvasEvict(value);
      }
      this._canvas.clear();
      this._spatial.clear();
    }
    // Release pinned thumbnails too on full teardown.
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
    // Non-LRU: approximate.
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

  /**
   * @private
   * @param {HTMLCanvasElement|null} canvas
   * @returns {number}
   */
  _canvasBytes(canvas) {
    if (!canvas || typeof canvas.width !== 'number' || typeof canvas.height !== 'number') {
      return 0;
    }
    return Math.max(0, canvas.width * canvas.height * CANVAS_BYTE_PER_PIXEL);
  }

  /**
   * @private
   * @param {any} value  { canvas, pageNum } wrapper or bare canvas
   */
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

  /**
   * @private
   * @param {{ level?: string }} payload
   */
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
   * @private
   * @returns {number}
   */
  _computeCapBytes() {
    let isMobile = false;
    try {
      const state = this._core.getState();
      const profile = state ? state.get('deviceProfile') : null;
      if (profile && profile.isMobile) isMobile = true;
    } catch { /* ignore */ }
    const mb = isMobile ? CONFIG.MEMORY_CAP_MOBILE_MB : CONFIG.MEMORY_CAP_DESKTOP_MB;
    return mb * 1024 * 1024;
  }
}

// ============================================================================
// 3. MEMORY MANAGER
// ============================================================================

/**
 * Tracks every canvas the viewer allocates, enforces the total cap, and emits
 * MEMORY_PRESSURE events at configurable thresholds.
 */
export class MemoryManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   */
  constructor(core) {
    /** @private */ this._core = core;
    /** @private @type {WeakMap<HTMLCanvasElement, { pageNum: number, bytes: number, pinned: boolean, registeredAt: number }>} */
    this._canvases = new WeakMap();
    /** @private */ this._bytesUsed = 0;
    /** @private */ this._bytesPinned = 0;
    /** @private */ this._canvasCount = 0;
    /** @private @type {number} */ this._capBytes = this._computeCapBytes();
    /** @private @type {'none'|'warning'|'critical'} */ this._lastPressureLevel = 'none';
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {number} pageNum
   * @param {{ pinned?: boolean }} [options]
   * @returns {void}
   */
  registerCanvas(canvas, pageNum, options) {
    if (!canvas) return;
    const bytes = this._canvasBytes(canvas);
    const pinned = !!(options && options.pinned);

    const existing = this._canvases.get(canvas);
    if (existing) {
      // Update counters for re-registration.
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
    if (pinned) this._bytesPinned += bytes;
    else this._bytesUsed += bytes;

    this._evaluatePressure();
  }

  /**
   * @param {HTMLCanvasElement} canvas
   * @returns {void}
   */
  unregisterCanvas(canvas) {
    if (!canvas) return;
    const entry = this._canvases.get(canvas);
    if (!entry) return;
    if (entry.pinned) this._bytesPinned -= entry.bytes;
    else this._bytesUsed -= entry.bytes;
    this._canvasCount = Math.max(0, this._canvasCount - 1);
    this._canvases.delete(canvas);
    this._evaluatePressure();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  /** @returns {number} */
  usedBytes() {
    return this._bytesUsed;
  }

  /** @returns {number} */
  pinnedBytes() {
    return this._bytesPinned;
  }

  /** @returns {number} */
  capBytes() {
    return this._capBytes;
  }

  /** @returns {boolean} */
  isOverCap() {
    return this._bytesUsed + this._bytesPinned > this._capBytes;
  }

  /** @returns {'none'|'warning'|'critical'} */
  pressureLevel() {
    return this._lastPressureLevel;
  }

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

  /**
   * Emit a critical pressure event if the cap is currently exceeded. Callers
   * (CacheManager) subscribe and evict.
   * @returns {void}
   */
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

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * @private
   */
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

  /**
   * @private
   * @param {'warning'|'critical'} level
   * @param {number} usedBytes
   */
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
   * @private
   * @param {HTMLCanvasElement|null} canvas
   * @returns {number}
   */
  _canvasBytes(canvas) {
    if (!canvas || typeof canvas.width !== 'number' || typeof canvas.height !== 'number') return 0;
    return Math.max(0, canvas.width * canvas.height * CANVAS_BYTE_PER_PIXEL);
  }

  /**
   * @private
   * @returns {number}
   */
  _computeCapBytes() {
    let isMobile = false;
    try {
      const state = this._core.getState();
      const profile = state ? state.get('deviceProfile') : null;
      if (profile && profile.isMobile) isMobile = true;
    } catch { /* ignore */ }
    const mb = isMobile ? CONFIG.MEMORY_CAP_MOBILE_MB : CONFIG.MEMORY_CAP_DESKTOP_MB;
    return mb * 1024 * 1024;
  }
}

// ============================================================================
// 4. SEARCH MANAGER
// ============================================================================

/**
 * Full-text search, worker-backed when the flag is on and main-thread when
 * it is off. Owns the match list, the current match index, the highlight
 * overlays, and the abort lifecycle.
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

    // Abort any prior search.
    this.cancel();

    const q = typeof query === 'string' ? query.trim() : '';
    this._query = q;
    this._caseSensitive = !!(options && options.caseSensitive);
    this._wholeWord = !!(options && options.wholeWord);

    if (!q) {
      this._clearInternal();
      this._emitCleared();
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
      if (!isAbortError(err)) {
        // Log once in dev; do not surface.
        if (CONFIG.DEBUG_VIEWER) {
          // eslint-disable-next-line no-console
          console.warn('[SearchManager] Search failed:', err);
        }
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

  /**
   * Abort the in-flight search. Idempotent.
   * @returns {void}
   */
  cancel() {
    if (this._abortController) {
      try { this._abortController.abort(); } catch { /* ignore */ }
      this._abortController = null;
    }
  }

  /**
   * Advance to the next match (wrap-around).
   * @returns {boolean}
   */
  next() {
    if (this._matches.length === 0) return false;
    this._currentIndex = (this._currentIndex + 1) % this._matches.length;
    this._focusCurrent();
    return true;
  }

  /**
   * Move to the previous match (wrap-around).
   * @returns {boolean}
   */
  previous() {
    if (this._matches.length === 0) return false;
    this._currentIndex = (this._currentIndex - 1 + this._matches.length) % this._matches.length;
    this._focusCurrent();
    return true;
  }

  /**
   * Jump to a specific match index.
   * @param {number} index
   * @returns {boolean}
   */
  jumpTo(index) {
    if (this._matches.length === 0) return false;
    const clamped = Math.max(0, Math.min(index, this._matches.length - 1));
    this._currentIndex = clamped;
    this._focusCurrent();
    return true;
  }

  /** @returns {any} */
  currentMatch() {
    if (this._currentIndex < 0 || this._currentIndex >= this._matches.length) return null;
    return this._matches[this._currentIndex];
  }

  /** @returns {number} */
  matchCount() {
    return this._matches.length;
  }

  /** @returns {number} */
  currentIndex() {
    return this._currentIndex;
  }

  /**
   * Remove highlights, clear match list, reset index.
   * @returns {void}
   */
  clear() {
    this.cancel();
    this._clearInternal();
    this._emitCleared();
  }

  /**
   * Render highlight overlays for every page with a rendered canvas. Called
   * on RENDER_COMPLETE (page-scoped) and SCALE_APPLIED (all pages).
   *
   * @param {number} [onlyPageNum]  If provided, only touch that page's overlay.
   * @returns {void}
   */
  renderHighlights(onlyPageNum) {
    if (this._matches.length === 0) return;
    const scale = this._getScale();

    const grouped = new Map();
    for (const match of this._matches) {
      if (typeof onlyPageNum === 'number' && match.pageNum !== onlyPageNum) continue;
      if (!grouped.has(match.pageNum)) grouped.set(match.pageNum, []);
      grouped.get(match.pageNum).push(match);
    }

    const els = this._getViewerElements();
    if (!els || !els.main) return;

    for (const [pageNum, matches] of grouped) {
      const wrapper = els.main.querySelector(`.${CONFIG.CANVAS_WRAPPER_CLASS}[data-page="${pageNum}"]`);
      if (!wrapper) continue;
      const canvas = wrapper.querySelector('canvas.' + CONFIG.PDF_CANVAS_CLASS);
      if (!canvas) continue;

      let layer = this._highlightLayer.get(pageNum);
      if (!layer || !layer.isConnected) {
        layer = document.createElement('div');
        layer.className = CONFIG.SEARCH_LAYER_CLASS;
        layer.style.position = 'absolute';
        layer.style.top = '0';
        layer.style.left = '0';
        layer.style.width = '100%';
        layer.style.height = '100%';
        layer.style.pointerEvents = 'none';
        wrapper.style.position = 'relative';
        wrapper.appendChild(layer);
        this._highlightLayer.set(pageNum, layer);
      }
      layer.innerHTML = '';

      for (const match of matches) {
        const isActive = this._matches[this._currentIndex] === match;
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
   * Idempotent destroy: cancel search, remove overlay layers, clear state.
   * @returns {void}
   */
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
  }

  // ── Worker path ───────────────────────────────────────────────────────────

  /**
   * @private
   * @param {string} query
   * @param {AbortSignal} signal
   * @returns {Promise<Array<{ pageNum: number, text: string, rects: any[] }>>}
   */
  async _searchViaWorker(query, signal) {
    const workers = this._core.getWorkers();
    if (!workers || !workers.ensureSearchWorker || !workers.postToSearch) {
      // Worker not available → fall back to main thread.
      return this._searchMainThread(query, signal);
    }

    let workerHandle;
    try {
      workerHandle = await workers.ensureSearchWorker();
    } catch (err) {
      if (err && err.code === 'WORKER_DISABLED') {
        // Flag is off — run main-thread fallback.
        return this._searchMainThread(query, signal);
      }
      return this._searchMainThread(query, signal);
    }
    if (!workerHandle || signal.aborted) return [];

    // Reset worker state.
    try { await workers.postToSearch('clear', {}, { signal }); } catch { /* ignore */ }

    // Index all pages into the worker.
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
        // Continue on individual page failure.
      }
    }

    if (signal.aborted) throw createAbortError('Search cancelled');

    // Run search; worker returns matches without rects.
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

    // Compute rects on main thread from cached text items.
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

  /**
   * @private
   * @param {string} query
   * @param {AbortSignal} signal
   * @returns {Promise<Array<{ pageNum: number, text: string, rects: any[] }>>}
   */
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
        // Yield to the event loop.
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
        // Avoid infinite loop on zero-length matches.
        if (m[0].length === 0) regex.lastIndex++;
      }
    }

    this._emitProgress(total, total);
    return matches;
  }

  // ── Focus / navigation ────────────────────────────────────────────────────

  /**
   * @private
   */
  _focusCurrent() {
    const match = this.currentMatch();
    if (!match) return;

    // Update overlays.
    this.renderHighlights();

    // Emit focus event.
    try {
      this._core.getState().set('currentMatchIndex', this._currentIndex);
      this._core.getBus().emit(Events.SEARCH_MATCH_FOCUSED, {
        index: this._currentIndex,
        pageNum: match.pageNum,
      });
    } catch { /* ignore */ }

    // If the target page is not visible, request a jump.
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

  /**
   * @private
   * @param {number} pageNum
   * @returns {Promise<any[]|null>}
   */
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

  /**
   * @private
   * @param {number} pageNum
   * @returns {Promise<any|null>}
   */
  async _getViewportAtScale1(pageNum) {
    const engine = this._core.getEngine();
    if (!engine || !engine.getViewport) return null;
    try {
      return await engine.getViewport(pageNum, 1);
    } catch {
      return null;
    }
  }

  /**
   * @private
   */
  _clearInternal() {
    this._matches = [];
    this._currentIndex = -1;
    this._query = '';
    for (const [, layer] of this._highlightLayer) {
      try { layer.innerHTML = ''; } catch { /* ignore */ }
    }
  }

  /**
   * @private
   */
  _emitCleared() {
    try {
      this._core.getState().set('searchMatches', []);
      this._core.getState().set('currentMatchIndex', -1);
      this._core.getBus().emit(Events.SEARCH_CLEARED, {});
    } catch { /* ignore */ }
  }

  /**
   * @private
   * @param {number} scanned
   * @param {number} total
   */
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

  /** @private */
  _getViewerElements() {
    // Read the live DOM directly. We do NOT import getViewerElements here
    // to keep this file's imports minimal; the manager queries only two IDs.
    try {
      const main = document.getElementById('viewer-main');
      return main ? { main } : null;
    } catch {
      return null;
    }
  }
}

// ============================================================================
// 4a. SEARCH HELPERS
// ============================================================================

/**
 * Build a regex from a query string.
 * @private
 * @param {string} query
 * @param {boolean} caseSensitive
 * @param {boolean} wholeWord
 * @returns {RegExp|null}
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
 * The rects are in scale-1 page-local coordinates; callers multiply by
 * `state.scale` at display time.
 *
 * @private
 * @param {{ matchStart: number, matchEnd: number }} match
 * @param {any[]} items
 * @param {{ convertToViewportRectangle: (rect: number[]) => number[] }} viewport
 * @returns {Array<{ x: number, y: number, width: number, height: number }>}
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
 * Renders the document outline tree into the drawer and translates item
 * clicks into PAGE_JUMP_REQUESTED events.
 */
export class OutlineManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   */
  constructor(core) {
    /** @private */ this._core = core;
    /** @private @type {any[]} */ this._items = [];
    /** @private @type {HTMLElement|null} */ this._drawerElement = null;
    /** @private */ this._empty = true;
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Render the outline tree. Passing `null` or `[]` renders the empty state.
   *
   * @param {any[]|null} items
   * @returns {void}
   */
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
      empty.textContent = 'No outline';
      drawer.appendChild(empty);
      this._emitReady(0);
      return;
    }

    this._renderItems(this._items, drawer, 0);
    this._emitReady(this._items.length);
  }

  /**
   * Re-render the cached outline tree.
   * @returns {void}
   */
  rebuild() {
    this.build(this._items);
  }

  /**
   * Toggle the drawer open state.
   * @returns {void}
   */
  toggle() {
    const drawer = this._getDrawer();
    if (!drawer) return;
    drawer.classList.toggle('open');
  }

  /**
   * Close the drawer.
   * @returns {void}
   */
  close() {
    const drawer = this._getDrawer();
    if (!drawer) return;
    drawer.classList.remove('open');
  }

  /**
   * Clear the drawer and reset state.
   * @returns {void}
   */
  clear() {
    const drawer = this._getDrawer();
    if (drawer) drawer.innerHTML = '';
    this._items = [];
    this._empty = true;
  }

  /**
   * Resolve a destination to a page number and emit PAGE_JUMP_REQUESTED.
   *
   * @param {any} dest
   * @returns {Promise<void>}
   */
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

  /**
   * @returns {void}
   */
  destroy() {
    this.clear();
    this._drawerElement = null;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * @private
   * @returns {HTMLElement|null}
   */
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
   * @private
   * @param {any[]} items
   * @param {HTMLElement} parent
   * @param {number} level
   */
  _renderItems(items, parent, level) {
    const ul = document.createElement('ul');
    ul.className = 'outline-list';
    const safeLevel = Math.min(level, 3);

    for (const item of items) {
      if (!item) continue;
      const li = document.createElement('li');
      li.className = `outline-item level-${safeLevel}`;

      const link = document.createElement('a');
      link.textContent = item.title || 'Untitled';
      link.href = '#';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.navigateToDest(item.dest).catch(() => { /* ignore */ });
        try {
          if (typeof window !== 'undefined' && window.innerWidth < 768) {
            this.close();
          }
        } catch { /* ignore */ }
      });
      li.appendChild(link);

      if (Array.isArray(item.items) && item.items.length > 0) {
        this._renderItems(item.items, li, level + 1);
      }

      ul.appendChild(li);
    }

    parent.appendChild(ul);
  }

  /**
   * @private
   * @param {number} count
   */
  _emitReady(count) {
    try {
      this._core.getBus().emit(Events.OUTLINE_READY, { count });
    } catch { /* ignore */ }
  }
}

// ============================================================================
// 6. FACTORY
// ============================================================================

/**
 * Instantiate all four managers, wire cross-module subscriptions, and return
 * the aggregate plus a teardown function.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {{
 *   cache: CacheManager,
 *   memory: MemoryManager,
 *   search: SearchManager,
 *   outline: OutlineManager,
 *   teardown: () => void,
 * }}
 */
export function createManagers(core) {
  // Snapshot feature flags once.
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

  // ── Cross-module subscriptions ────────────────────────────────────────────
  /** @type {Array<() => void>} */
  const teardowns = [];
  const bus = core.getBus();

  // Render complete → scoped highlight re-render.
  teardowns.push(bus.on(Events.RENDER_COMPLETE, (payload) => {
    if (!payload || typeof payload.pageNum !== 'number') return;
    if (search.matchCount() === 0) return;
    search.renderHighlights(payload.pageNum);
  }));

  // Scale applied → full highlight re-render.
  teardowns.push(bus.on(Events.SCALE_APPLIED, () => {
    if (search.matchCount() === 0) return;
    search.renderHighlights();
  }));

  // Document destroyed → clear all state.
  teardowns.push(bus.on(Events.DOCUMENT_DESTROYED, () => {
    try { search.clear(); } catch { /* ignore */ }
    try { outline.clear(); } catch { /* ignore */ }
    try { cache.evictAll(); } catch { /* ignore */ }
  }));

  // Memory pressure critical → enforce cache eviction.
  teardowns.push(bus.on(Events.MEMORY_PRESSURE, (payload) => {
    if (!payload || payload.level !== 'critical') return;
    try {
      cache._onMemoryPressure(payload);
    } catch { /* ignore */ }
  }));

  /**
   * Idempotent teardown.
   */
  function teardown() {
    for (const fn of teardowns.splice(0)) {
      try { fn(); } catch { /* ignore */ }
    }
    try { search.destroy(); } catch { /* ignore */ }
    try { outline.destroy(); } catch { /* ignore */ }
    try { cache.evictAll(); } catch { /* ignore */ }
  }

  return { cache, memory, search, outline, teardown };
}