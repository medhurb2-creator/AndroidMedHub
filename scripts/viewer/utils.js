// frontend-user/scripts/viewer/utils.js

/**
 * Universal Document Viewer — Utilities (Leaf Module)
 * ============================================================================
 *
 * The bottom of the viewer's dependency graph. This file imports nothing from
 * any sibling module; it may be safely imported by every other module in
 * `scripts/viewer/` without introducing a cycle.
 *
 * Public exports (20):
 *   ── Data ─────────────────────────────────────────────────────────────────
 *     MIME_TYPES
 *
 *   ── Text & DOM ───────────────────────────────────────────────────────────
 *     escapeHtml
 *     getViewerElements
 *     getScrollTopOffset
 *
 *   ── MIME / Blob ──────────────────────────────────────────────────────────
 *     getMimeType
 *     ensureMimeType
 *
 *   ── Numbers / Timing ─────────────────────────────────────────────────────
 *     clamp
 *     debounce
 *     throttle
 *     rafThrottle
 *     nextFrame
 *
 *   ── Geometry ─────────────────────────────────────────────────────────────
 *     rectsIntersect
 *     rectOverlapArea
 *     tileGridForViewport
 *     computeVisibleTiles
 *
 *   ── Cancellation ─────────────────────────────────────────────────────────
 *     createAbortError
 *     isAbortError
 *
 *   ── Object URL lifecycle ─────────────────────────────────────────────────
 *     createObjectURL
 *     revokeObjectURL
 *     revokeAllObjectURLs
 *
 * Design constraints (from the architecture spec § 6):
 *   • No imports from viewer/* (leaf module; no cycles possible).
 *   • No DOM writes (except the private object-URL registry's side effects).
 *   • No console.* calls (callers own logging).
 *   • No event-bus knowledge.
 *   • No feature-flag reads.
 *   • No side effects at import time.
 *   • Deterministic: same inputs → same outputs (except URL registry).
 *
 * @module viewer/utils
 */

'use strict';

// ============================================================================
// 1. DATA — MIME_TYPES
// ============================================================================

/**
 * Canonical file-extension → MIME-type table. Frozen; the single source of
 * truth for the viewer. `core.js` re-exports this for API symmetry, but
 * ownership lives here so that `getMimeType` / `ensureMimeType` never need to
 * import from core (which would create a cycle).
 *
 * Keys are lowercase, dot-less extensions. Values are MIME strings.
 *
 * @readonly
 * @type {Readonly<Record<string, string>>}
 */
export const MIME_TYPES = Object.freeze({
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
});

/**
 * The fallback MIME type returned when an extension is unknown or absent.
 * @private
 * @constant {string}
 */
const DEFAULT_MIME = 'application/octet-stream';

// ============================================================================
// 2. MIME / BLOB
// ============================================================================

/**
 * Map a file extension (with or without a leading dot, any case) to a MIME
 * type. Unknown extensions and nullish inputs resolve to
 * `'application/octet-stream'`.
 *
 * @param {string|null|undefined} fileType
 * @returns {string}
 */
export function getMimeType(fileType) {
  if (fileType == null) return DEFAULT_MIME;
  const key = String(fileType).toLowerCase().replace(/^\./, '');
  if (!key) return DEFAULT_MIME;
  return MIME_TYPES[key] || DEFAULT_MIME;
}

/**
 * If a Blob has no type (or `application/octet-stream`) but a known file
 * extension is provided, return a new Blob with the correct MIME type.
 * Otherwise return the original Blob reference unchanged.
 *
 * Short-circuits without reading the blob's bytes whenever a re-wrap would be
 * a no-op. This matters for large files: a 50 MB PDF should not be copied
 * into a new Blob just because its type is already correct.
 *
 * Never mutates the input. Preserves byte length.
 *
 * @param {Blob} blob
 * @param {string|null|undefined} fileType
 * @returns {Promise<Blob>}
 */
export async function ensureMimeType(blob, fileType) {
  if (!blob) return blob;

  const currentType = blob.type || '';
  const needsRemap = !currentType || currentType === DEFAULT_MIME;
  if (!needsRemap) return blob;

  const mapped = getMimeType(fileType);
  if (mapped === DEFAULT_MIME) return blob;

  const buffer = await blob.arrayBuffer();
  return new Blob([buffer], { type: mapped });
}

// ============================================================================
// 3. TEXT & DOM HELPERS
// ============================================================================

/**
 * Escape HTML special characters in a string for safe insertion into
 * `innerHTML`. Uses the browser's native text-node encoding — the same
 * technique the previous monolithic viewer used — so output is identical.
 *
 * Not safe for attribute context without quotes; not safe for URL context.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

/**
 * Return a live map of every viewer-controlled DOM element, keyed by semantic
 * name. Performs a fresh `getElementById` on every call — this function does
 * not cache. Caching is the responsibility of `ui-internal.js`.
 *
 * Returns `null` if the root `#viewer` element is not present, which is the
 * only condition under which the viewer cannot mount.
 *
 * Individual keys may be `null` if the corresponding DOM node is missing;
 * every consumer must null-check each key it uses.
 *
 * The ID strings here form a hard contract with `viewer.html`. Renaming any
 * of them here without renaming the DOM breaks the viewer.
 *
 * @returns {{
 *   container: HTMLElement,
 *   main: HTMLElement|null,
 *   content: HTMLElement|null,
 *   loading: HTMLElement|null,
 *   progress: HTMLProgressElement|null,
 *   title: HTMLElement|null,
 *   footer: HTMLElement|null,
 *   pageNum: HTMLElement|null,
 *   pageCount: HTMLElement|null,
 *   pageInput: HTMLInputElement|null,
 *   prevBtn: HTMLElement|null,
 *   nextBtn: HTMLElement|null,
 *   zoomIn: HTMLElement|null,
 *   zoomOut: HTMLElement|null,
 *   zoomLevel: HTMLElement|null,
 *   zoomFit: HTMLElement|null,
 *   zoomReset: HTMLElement|null,
 *   backBtn: HTMLElement|null,
 *   fullscreenBtn: HTMLElement|null,
 *   toggleViewBtn: HTMLElement|null,
 *   searchBtn: HTMLElement|null,
 *   searchBar: HTMLElement|null,
 *   searchInput: HTMLInputElement|null,
 *   searchPrev: HTMLElement|null,
 *   searchNext: HTMLElement|null,
 *   searchCount: HTMLElement|null,
 *   searchOptions: HTMLElement|null,
 *   searchCaseSensitive: HTMLInputElement|null,
 *   searchWholeWord: HTMLInputElement|null,
 *   searchClose: HTMLElement|null,
 *   outlineBtn: HTMLElement|null,
 *   outlineDrawer: HTMLElement|null,
 *   openLocalBtn: HTMLElement|null,
 *   fileInput: HTMLInputElement|null,
 *   textLayerContainer: HTMLElement|null
 * } | null}
 */
export function getViewerElements() {
  const container = document.getElementById('viewer');
  if (!container) return null;

  return {
    container,
    main: document.getElementById('viewer-main'),
    content: document.getElementById('viewer-content'),
    loading: document.getElementById('viewer-loading'),
    progress: /** @type {HTMLProgressElement|null} */ (document.getElementById('viewer-progress')),
    title: document.getElementById('viewer-title'),
    footer: document.getElementById('viewer-footer'),
    pageNum: document.getElementById('viewer-page-num'),
    pageCount: document.getElementById('viewer-page-count'),
    pageInput: /** @type {HTMLInputElement|null} */ (document.getElementById('viewer-page-input')),
    prevBtn: document.getElementById('viewer-prev-page'),
    nextBtn: document.getElementById('viewer-next-page'),
    zoomIn: document.getElementById('viewer-zoom-in'),
    zoomOut: document.getElementById('viewer-zoom-out'),
    zoomLevel: document.getElementById('viewer-zoom-level'),
    zoomFit: document.getElementById('viewer-zoom-fit'),
    zoomReset: document.getElementById('viewer-zoom-reset'),
    backBtn: document.getElementById('viewer-back-btn'),
    fullscreenBtn: document.getElementById('viewer-fullscreen-btn'),
    toggleViewBtn: document.getElementById('viewer-toggle-view'),
    searchBtn: document.getElementById('viewer-search-btn'),
    searchBar: document.getElementById('viewer-search-bar'),
    searchInput: /** @type {HTMLInputElement|null} */ (document.getElementById('viewer-search-input')),
    searchPrev: document.getElementById('viewer-search-prev'),
    searchNext: document.getElementById('viewer-search-next'),
    searchCount: document.getElementById('viewer-search-count'),
    searchOptions: document.getElementById('viewer-search-options'),
    searchCaseSensitive: /** @type {HTMLInputElement|null} */ (document.getElementById('viewer-search-case')),
    searchWholeWord: /** @type {HTMLInputElement|null} */ (document.getElementById('viewer-search-whole')),
    searchClose: document.getElementById('viewer-search-close'),
    outlineBtn: document.getElementById('viewer-outline-btn'),
    outlineDrawer: document.getElementById('viewer-outline-drawer'),
    openLocalBtn: document.getElementById('viewer-open-local'),
    fileInput: /** @type {HTMLInputElement|null} */ (document.getElementById('viewer-file-input')),
    textLayerContainer: document.getElementById('viewer-text-layer'),
  };
}

/**
 * Compute the top offset of `el` relative to the scroll content of
 * `scrollRoot`, in pixels. This is the value the previous monolithic viewer
 * recomputed inline three separate times.
 *
 * Returns `0` if either argument is nullish or lacks a
 * `getBoundingClientRect` method. Performs a single layout read per call —
 * callers in a loop must batch via `rafThrottle` or `nextFrame`.
 *
 * @param {HTMLElement|null} el
 * @param {HTMLElement|null} scrollRoot
 * @returns {number}
 */
export function getScrollTopOffset(el, scrollRoot) {
  if (!el || !scrollRoot) return 0;
  if (typeof el.getBoundingClientRect !== 'function') return 0;
  if (typeof scrollRoot.getBoundingClientRect !== 'function') return 0;
  const elRect = el.getBoundingClientRect();
  const rootRect = scrollRoot.getBoundingClientRect();
  return elRect.top + scrollRoot.scrollTop - rootRect.top;
}

// ============================================================================
// 4. NUMBERS
// ============================================================================

/**
 * Clamp a numeric value into `[min, max]`. `NaN` resolves to `min`
 * (deterministic, not `NaN`); infinities clamp to the nearer bound.
 * Assumes `min <= max` (caller's responsibility).
 *
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
  if (Number.isNaN(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ============================================================================
// 5. TIMING
// ============================================================================

/**
 * Trailing-edge debounce. The returned function delays invocation until
 * `delayMs` have elapsed since the last call. Provides `.cancel()` and
 * `.flush()` methods.
 *
 * Preserves `this` and forwards all arguments. Uses `setTimeout` — not
 * `requestAnimationFrame` (that is `rafThrottle`'s job).
 *
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} delayMs
 * @returns {F & { cancel: () => void, flush: () => void }}
 */
export function debounce(fn, delayMs) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  /** @type {any[]|null} */
  let lastArgs = null;
  /** @type {any} */
  let lastThis = null;

  const wrapped = function (...args) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args = lastArgs;
      const ctx = lastThis;
      lastArgs = null;
      lastThis = null;
      if (args) fn.apply(ctx, args);
    }, delayMs);
  };

  wrapped.cancel = function () {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
    lastThis = null;
  };

  wrapped.flush = function () {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    const args = lastArgs;
    const ctx = lastThis;
    lastArgs = null;
    lastThis = null;
    if (args) fn.apply(ctx, args);
  };

  return /** @type {any} */ (wrapped);
}

/**
 * Leading-edge throttle. The returned function fires immediately on the first
 * call, then drops subsequent calls within `intervalMs`. No trailing call.
 * Provides `.cancel()`.
 *
 * Preserves `this` and forwards arguments.
 *
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} intervalMs
 * @returns {F & { cancel: () => void }}
 */
export function throttle(fn, intervalMs) {
  let lastCall = 0;

  const wrapped = function (...args) {
    const now = Date.now();
    if (now - lastCall >= intervalMs) {
      lastCall = now;
      fn.apply(this, args);
    }
  };

  wrapped.cancel = function () {
    lastCall = 0;
  };

  return /** @type {any} */ (wrapped);
}

/**
 * Coalesce DOM writes to one per animation frame. Multiple synchronous calls
 * within a single frame result in a single invocation with the *last*
 * arguments seen. Uses `requestAnimationFrame` and forwards the frame
 * timestamp as an additional trailing argument to `fn`.
 *
 * Provides `.cancel()` to cancel a pending frame.
 *
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @returns {F & { cancel: () => void }}
 */
export function rafThrottle(fn) {
  /** @type {number|null} */
  let rafId = null;
  /** @type {any[]|null} */
  let pendingArgs = null;
  /** @type {any} */
  let pendingThis = null;

  const wrapped = function (...args) {
    pendingArgs = args;
    pendingThis = this;
    if (rafId !== null) return;

    rafId = requestAnimationFrame((timestamp) => {
      rafId = null;
      const args = pendingArgs;
      const ctx = pendingThis;
      pendingArgs = null;
      pendingThis = null;
      if (args) fn.apply(ctx, [...args, timestamp]);
    });
  };

  wrapped.cancel = function () {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    pendingArgs = null;
    pendingThis = null;
  };

  return /** @type {any} */ (wrapped);
}

/**
 * Promise-based `requestAnimationFrame`. Resolves with the frame timestamp.
 * Never rejects; cancellation is not supported (callers who need it use
 * `rafThrottle` and check a flag).
 *
 * @returns {Promise<number>}
 */
export function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame((timestamp) => resolve(timestamp));
  });
}

// ============================================================================
// 6. GEOMETRY
// ============================================================================

/**
 * @typedef {Object} Rect
 * @property {number} x       Top-left x, in pixels.
 * @property {number} y       Top-left y, in pixels.
 * @property {number} width   Width, in pixels.
 * @property {number} height  Height, in pixels.
 */

/**
 * Axis-aligned rectangle intersection test. Touching edges count as
 * intersecting (a page whose top edge is exactly at the viewport top returns
 * `true`). Degenerate rectangles (zero or negative width/height) return
 * `false`. Nullish inputs return `false`.
 *
 * @param {Rect|null|undefined} a
 * @param {Rect|null|undefined} b
 * @returns {boolean}
 */
export function rectsIntersect(a, b) {
  if (!a || !b) return false;
  if (a.width <= 0 || a.height <= 0) return false;
  if (b.width <= 0 || b.height <= 0) return false;
  return (
    a.x <= b.x + b.width &&
    b.x <= a.x + a.width &&
    a.y <= b.y + b.height &&
    b.y <= a.y + a.height
  );
}

/**
 * Area of intersection of two rectangles, in px². Returns `0` when they do
 * not overlap or either input is nullish. Used by the scroll manager to pick
 * the "most visible" page (largest-overlap criterion).
 *
 * @param {Rect|null|undefined} a
 * @param {Rect|null|undefined} b
 * @returns {number}
 */
export function rectOverlapArea(a, b) {
  if (!a || !b) return 0;
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * Enumerate the uniform tile grid covering a page of the given dimensions.
 * Row-major order (top-left → right → down). Edge tiles are truncated to fit
 * the page — the union of returned tiles exactly equals the page area, with
 * no gaps and no overlaps.
 *
 * @param {number} width     Page width in pixels (must be > 0).
 * @param {number} height    Page height in pixels (must be > 0).
 * @param {number} tileSize  Tile edge length in pixels (must be > 0).
 * @returns {Array<{ row: number, col: number, x: number, y: number, width: number, height: number }>}
 */
export function tileGridForViewport(width, height, tileSize) {
  if (!(width > 0) || !(height > 0) || !(tileSize > 0)) return [];

  const tiles = [];
  let row = 0;
  for (let y = 0; y < height; y += tileSize, row++) {
    const h = Math.min(tileSize, height - y);
    let col = 0;
    for (let x = 0; x < width; x += tileSize, col++) {
      const w = Math.min(tileSize, width - x);
      tiles.push({ row, col, x, y, width: w, height: h });
    }
  }
  return tiles;
}

/**
 * Filter a tile grid down to those tiles intersecting a viewport rectangle.
 * If `tiles` is omitted, `tileGridForViewport` is called internally. Order
 * matches the input grid (row-major). Uses `rectsIntersect` — touching edges
 * count.
 *
 * @param {Rect} viewportRect
 * @param {{ width: number, height: number }} pageRect
 * @param {number} tileSize
 * @param {Array<{ row: number, col: number, x: number, y: number, width: number, height: number }>} [tiles]
 * @returns {Array<{ row: number, col: number, x: number, y: number, width: number, height: number }>}
 */
export function computeVisibleTiles(viewportRect, pageRect, tileSize, tiles) {
  if (!viewportRect || !pageRect) return [];
  if (!(tileSize > 0)) return [];
  const grid = tiles || tileGridForViewport(pageRect.width, pageRect.height, tileSize);
  return grid.filter((tile) => rectsIntersect(viewportRect, tile));
}

// ============================================================================
// 7. CANCELLATION
// ============================================================================

/**
 * Construct a DOMException-compatible AbortError with a consistent shape
 * across the viewer. Falls back to a plain Error with `name` overridden when
 * `DOMException` is unavailable.
 *
 * @param {string} [message='Operation aborted']
 * @returns {Error}
 */
export function createAbortError(message = 'Operation aborted') {
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

/**
 * Determine whether a caught error represents an intentional cancellation.
 * Recognises both the standard `AbortError` (from `AbortController.abort()`)
 * and PDF.js's `RenderingCancelledException`. Never throws.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isAbortError(err) {
  if (!err || typeof err !== 'object') return false;
  const name = /** @type {{ name?: string }} */ (err).name;
  return name === 'AbortError' || name === 'RenderingCancelledException';
}

// ============================================================================
// 8. OBJECT URL LIFECYCLE
// ============================================================================

/**
 * Module-private registry of every blob URL created through
 * `createObjectURL`. Drained by `revokeAllObjectURLs`. This is the single
 * piece of state in an otherwise pure module, and its purpose is to close a
 * real memory leak in the previous monolith (blob URLs were created but never
 * revoked on document switch).
 *
 * @private
 * @type {Set<string>}
 */
const objectURLRegistry = new Set();

/**
 * Create a blob URL and register it for later revocation. Callers must
 * eventually revoke the URL — either directly via `revokeObjectURL` or in
 * bulk via `revokeAllObjectURLs` during viewer teardown.
 *
 * @param {Blob} blob
 * @returns {string}
 */
export function createObjectURL(blob) {
  const url = URL.createObjectURL(blob);
  objectURLRegistry.add(url);
  return url;
}

/**
 * Revoke a specific blob URL and remove it from the registry. Idempotent;
 * safe with nullish input. If the URL was not created through
 * `createObjectURL` but is a valid blob URL, it is still revoked.
 *
 * @param {string|null|undefined} url
 * @returns {void}
 */
export function revokeObjectURL(url) {
  if (!url || typeof url !== 'string') return;

  const known = objectURLRegistry.has(url);
  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore — URL may be malformed or already revoked
  }

  if (known) objectURLRegistry.delete(url);
}

/**
 * Revoke every blob URL created through `createObjectURL` and clear the
 * registry. Called by `ViewerCore.destroy()` as part of the canonical
 * teardown sequence. Idempotent; never throws (a single failure does not
 * abort the batch).
 *
 * @returns {void}
 */
export function revokeAllObjectURLs() {
  for (const url of objectURLRegistry) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore individual failures
    }
  }
  objectURLRegistry.clear();
}