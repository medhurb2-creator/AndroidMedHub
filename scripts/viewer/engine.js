// frontend-user/scripts/viewer/engine.js

/**
 * Universal Document Viewer — Engine Adapter
 * ============================================================================
 *
 * The boundary between the viewer subsystem and the concrete PDF-rendering
 * engine. Every raw PDF.js call in the entire codebase lives here. No other
 * file — other than the app-facing `viewer.js` — may reference `pdfjsLib`,
 * `pdfDoc`, or `page.*`.
 *
 * Exports (5):
 *   • EngineAdapter      — abstract class defining the interface (10 methods)
 *   • PdfJsAdapter       — concrete implementation over window.pdfjsLib
 *   • WasmPdfiumAdapter  — reserved stub for the Phase 5/8 engine swap
 *   • RenderTaskHandle   — cancelable render handle (shape contract)
 *   • createEngine(core) — factory selecting the active adapter
 *
 * Import discipline (from the architecture spec § 2.2):
 *   • Imports only { CONFIG, Events } from ./core.js
 *   • Imports only { isAbortError, createAbortError } from ./utils.js
 *   • Never imports from ../content.js, ../subscription.js, ../ui.js,
 *     ../router.js, or any other viewer sibling.
 *
 * Runtime contract:
 *   • No side effects at import time. The module does not touch window,
 *     does not set pdfjsLib.GlobalWorkerOptions.workerSrc, does not create
 *     timers, does not attach listeners.
 *   • All initialisation happens inside `initialize()`, which core awaits.
 *
 * @module viewer/engine
 */

'use strict';

import { CONFIG, Events } from './core.js';
import { isAbortError, createAbortError } from './utils.js';

// ============================================================================
// 1. RENDER TASK HANDLE
// ============================================================================

/**
 * A cancelable render operation.
 *
 * Contract (from the architecture spec § 4.5):
 *   • `promise` rejects with a canonical AbortError when cancelled.
 *   • `cancel()` is idempotent and callable at any time — even before the
 *     underlying engine task exists.
 *   • `isCancelled()` returns true after `cancel()` is called, regardless of
 *     whether the underlying task has settled.
 *   • The handle is created and returned *synchronously* from `renderPage` /
 *     `renderTile`; the caller receives it before any rendering begins.
 *
 * The shape is what consumers depend on; the class is exported primarily for
 * testing convenience.
 */
export class RenderTaskHandle {
  /**
   * @param {{
   *   pageNum: number,
   *   scale: number,
   *   internalPromise: Promise<{ canvas: HTMLCanvasElement, pageNum: number, scale: number }>,
   *   internalCancel: () => void,
   * }} options
   */
  constructor({ pageNum, scale, internalPromise, internalCancel }) {
    /** @type {number} */
    this.pageNum = pageNum;
    /** @type {number} */
    this.scale = scale;

    /** @private @type {boolean} */
    this._cancelled = false;
    /** @private @type {() => void} */
    this._internalCancel = internalCancel;

    /**
     * Normalise cancellation errors: PDF.js throws
     * `RenderingCancelledException`; we convert to a canonical `AbortError`
     * so that every caller can use `utils.isAbortError` uniformly.
     *
     * @type {Promise<{ canvas: HTMLCanvasElement, pageNum: number, scale: number }>}
     */
    this.promise = internalPromise.catch((err) => {
      if (isAbortError(err)) throw createAbortError('Render cancelled');
      throw err;
    });

    // Attach a no-op catch so that a caller who ignores the handle's promise
    // does not trigger an unhandled-rejection warning. This does NOT prevent
    // the promise from rejecting for callers who do await it — multiple
    // handlers on the same promise are fine.
    this.promise.catch(() => { /* swallow for unhandled-rejection safety */ });
  }

  /**
   * Cancel the render. Idempotent. Safe to call before the underlying engine
   * task has been created (e.g. while the page metadata is still loading).
   *
   * @returns {void}
   */
  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    try {
      this._internalCancel();
    } catch {
      // Swallow — cancel must never throw.
    }
  }

  /**
   * @returns {boolean} true if `cancel()` has been called.
   */
  isCancelled() {
    return this._cancelled;
  }
}

// ============================================================================
// 2. ENGINE ADAPTER — abstract interface
// ============================================================================

/**
 * Abstract base class defining the engine contract. Subclasses override every
 * method. Calling any method on an instance of this class throws a descriptive
 * error naming the method.
 *
 * @abstract
 */
export class EngineAdapter {
  /**
   * @param {import('./core.js').ViewerCore} core
   */
  constructor(core) {
    /** @protected @type {import('./core.js').ViewerCore} */
    this._core = core;
    /** @protected @type {boolean} */
    this._initialized = false;
  }

  /**
   * Prepare the engine. Must be idempotent. May be async.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    throw new Error('EngineAdapter.initialize is not implemented');
  }

  /**
   * Load a document from a byte buffer. Returns engine-level metadata.
   *
   * @param {ArrayBuffer} data
   * @param {{ onProgress?: (progress: { loaded: number, total: number }) => void }} [options]
   * @returns {Promise<{ numPages: number, outline: any[], fingerprint: string|null }>}
   */
  async loadDocument(data, options) {
    throw new Error('EngineAdapter.loadDocument is not implemented');
  }

  /**
   * Return page dimensions and rotation at scale 1.
   *
   * @param {number} pageNum
   * @returns {Promise<{ pageNum: number, width: number, height: number, rotation: number }>}
   */
  async getPageMetadata(pageNum) {
    throw new Error('EngineAdapter.getPageMetadata is not implemented');
  }

  /**
   * Return a shallow viewport proxy at the requested scale.
   *
   * @param {number} pageNum
   * @param {number} scale
   * @returns {Promise<{
   *   width: number, height: number, scale: number, rotation: number,
   *   convertToViewportRectangle: (rect: number[]) => number[],
   * }>}
   */
  async getViewport(pageNum, scale) {
    throw new Error('EngineAdapter.getViewport is not implemented');
  }

  /**
   * Begin rendering a full page into the provided canvas.
   * Synchronous — returns the handle before rendering starts.
   *
   * @param {{
   *   pageNum: number,
   *   canvas: HTMLCanvasElement,
   *   scale: number,
   *   dpr?: number,
   *   transform?: number[],
   * }} params
   * @returns {RenderTaskHandle}
   */
  renderPage(params) {
    throw new Error('EngineAdapter.renderPage is not implemented');
  }

  /**
   * Begin rendering a rectangular sub-region of a page into the provided
   * canvas. Synchronous — returns the handle before rendering starts.
   *
   * @param {{
   *   pageNum: number,
   *   canvas: HTMLCanvasElement,
   *   scale: number,
   *   tileRect: { x: number, y: number, width: number, height: number },
   *   dpr?: number,
   * }} params
   * @returns {RenderTaskHandle}
   */
  renderTile(params) {
    throw new Error('EngineAdapter.renderTile is not implemented');
  }

  /**
   * Extract text content for a page. Returns the raw engine structure; the
   * caller decides how to cache or serialise it.
   *
   * @param {number} pageNum
   * @returns {Promise<any>}
   */
  async extractText(pageNum) {
    throw new Error('EngineAdapter.extractText is not implemented');
  }

  /**
   * Return the document outline tree. Always resolves to an array (possibly
   * empty) — never null.
   *
   * @returns {Promise<any[]>}
   */
  async getOutline() {
    throw new Error('EngineAdapter.getOutline is not implemented');
  }

  /**
   * Resolve an outline destination to a zero-based page index.
   *
   * @param {any} dest
   * @returns {Promise<number>}
   */
  async getPageIndex(dest) {
    throw new Error('EngineAdapter.getPageIndex is not implemented');
  }

  /**
   * Release the document and any engine-level resources. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async destroy() {
    throw new Error('EngineAdapter.destroy is not implemented');
  }
}

// ============================================================================
// 3. PDF.JS ADAPTER — concrete implementation
// ============================================================================

/**
 * Concrete engine adapter over `window.pdfjsLib`.
 *
 * Every PDF.js-specific behaviour in the viewer flows through this class.
 * Callers must not touch `pdfjsLib`, `pdfDoc`, or `page.*` directly.
 */
export class PdfJsAdapter extends EngineAdapter {
  constructor(core) {
    super(core);
    /** @private @type {any} */ this._pdfDoc = null;
    /** @private @type {boolean} */ this._workerSrcSet = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;

    if (typeof window === 'undefined' || typeof window.pdfjsLib === 'undefined') {
      throw new Error(
        'pdfjsLib is not available on window. ' +
        'Ensure the PDF.js script is loaded before initialising the viewer.',
      );
    }

    if (!this._workerSrcSet) {
      const opts = window.pdfjsLib.GlobalWorkerOptions;
      if (opts && !opts.workerSrc) {
        opts.workerSrc = CONFIG.PDFJS_WORKER_SRC;
      }
      this._workerSrcSet = true;
    }

    this._initialized = true;
  }

  // ── Document load ─────────────────────────────────────────────────────────

  /**
   * @param {ArrayBuffer} data
   * @param {{ onProgress?: (progress: { loaded: number, total: number }) => void }} [options]
   * @returns {Promise<{ numPages: number, outline: any[], fingerprint: string|null }>}
   */
  async loadDocument(data, options) {
    if (!this._initialized) {
      throw new Error('PdfJsAdapter is not initialised. Call initialize() first.');
    }

    // Replace any prior document to prevent leaked PDF.js workers.
    if (this._pdfDoc) {
      await this.destroy();
    }

    const onProgress = options && typeof options.onProgress === 'function'
      ? options.onProgress
      : undefined;

    let pdfDoc;
    try {
      const params = { data };
      if (onProgress) params.onProgress = onProgress;
      pdfDoc = await window.pdfjsLib.getDocument(params).promise;
    } catch (err) {
      const message = err && err.message ? err.message : 'Failed to load PDF';
      // Emit and rethrow — core will also emit DOCUMENT_ERROR on its own
      // catch; subscribers that are idempotent tolerate the duplicate.
      try {
        this._core.getBus().emit(Events.DOCUMENT_ERROR, {
          message,
          name: err && err.name ? err.name : 'Error',
          stack: err && err.stack ? err.stack : '',
        });
      } catch { /* ignore */ }
      throw err;
    }

    this._pdfDoc = pdfDoc;

    const numPages = typeof pdfDoc.numPages === 'number' ? pdfDoc.numPages : 0;

    let outline = [];
    try {
      const raw = await pdfDoc.getOutline();
      if (Array.isArray(raw)) outline = raw;
    } catch {
      outline = [];
    }

    // PDF.js 2.16+ exposes fingerprints as an array (a PDF may be augmented
    // with incremental updates, each contributing a fingerprint). The legacy
    // singular `pdfDoc.fingerprint` getter still exists but emits a
    // deprecation warning every time it is read — even for a `typeof` check.
    // We use only the modern API and leave `fingerprint` null on older
    // versions, where it is a non-essential cache key.
    let fingerprint = null;
    try {
      const fps = pdfDoc.fingerprints;
      if (Array.isArray(fps) && fps.length > 0) {
        fingerprint = String(fps[0]);
      }
    } catch { /* ignore */ }
    
    try {
      this._core.getBus().emit(Events.DOCUMENT_LOADED, {
        numPages,
        outline,
        fingerprint,
      });
    } catch { /* ignore */ }

    return { numPages, outline, fingerprint };
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  /**
   * @param {number} pageNum
   * @returns {Promise<{ pageNum: number, width: number, height: number, rotation: number }>}
   */
  async getPageMetadata(pageNum) {
    const pdfDoc = this._requirePdfDoc();
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) {
      throw new RangeError(
        `getPageMetadata: pageNum ${pageNum} is out of range [1, ${pdfDoc.numPages}]`,
      );
    }
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    return {
      pageNum,
      width: viewport.width,
      height: viewport.height,
      rotation: viewport.rotation,
    };
  }

  /**
   * Returns a shallow proxy over the PDF.js viewport exposing only the fields
   * and one method the viewer actually uses. Prevents consumers from
   * depending on undocumented PDF.js methods.
   *
   * @param {number} pageNum
   * @param {number} scale
   * @returns {Promise<{
   *   width: number, height: number, scale: number, rotation: number,
   *   convertToViewportRectangle: (rect: number[]) => number[],
   * }>}
   */
  async getViewport(pageNum, scale) {
    const pdfDoc = this._requirePdfDoc();
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) {
      throw new RangeError(
        `getViewport: pageNum ${pageNum} is out of range [1, ${pdfDoc.numPages}]`,
      );
    }
    const s = typeof scale === 'number' && scale > 0 ? scale : 1;
    const page = await pdfDoc.getPage(pageNum);
    const raw = page.getViewport({ scale: s });
    return {
      width: raw.width,
      height: raw.height,
      scale: raw.scale,
      rotation: raw.rotation,
      convertToViewportRectangle: (rect) => raw.convertToViewportRectangle(rect),
    };
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * Begin rendering a full page into the provided canvas. Returns a cancelable
   * handle *synchronously*. The underlying page fetch is async but is started
   * immediately; `cancel()` works whether called before or after the page
   * resolves.
   *
   * @param {{
   *   pageNum: number,
   *   canvas: HTMLCanvasElement,
   *   scale: number,
   *   dpr?: number,
   *   transform?: number[],
   * }} params
   * @returns {RenderTaskHandle}
   */
  renderPage(params) {
    const { pageNum, canvas, transform } = params || {};
    const rawScale = (params && typeof params.scale === 'number' && params.scale > 0)
      ? params.scale
      : 1;

    // ── Guard: no document → immediate rejected handle.
    if (!this._pdfDoc) {
      const rejected = Promise.reject(new Error('No document loaded'));
      rejected.catch(() => {});
      return new RenderTaskHandle({
        pageNum: typeof pageNum === 'number' ? pageNum : 0,
        scale: rawScale,
        internalPromise: rejected,
        internalCancel: () => {},
      });
    }

    // ── DPR: clamp to CONFIG.MAX_DPR. `dpr == null` means "use device".
    const rawDpr = (params && typeof params.dpr === 'number')
      ? params.dpr
      : ((typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const effectiveDpr = Math.min(
      Math.max(rawDpr, 1),
      CONFIG.MAX_DPR,
    );

    // ── Mutable task state — captured by the closure so cancel() works even
    //    before the PDF.js render task exists.
    /** @type {{ cancelled: boolean, renderTask: any }} */
    const state = { cancelled: false, renderTask: null };

    const internalCancel = () => {
      state.cancelled = true;
      if (state.renderTask) {
        try { state.renderTask.cancel(); } catch { /* ignore */ }
      }
    };

    const internalPromise = (async () => {
      if (state.cancelled) throw createAbortError('Render cancelled');

      const pdfDoc = this._pdfDoc;
      const page = await pdfDoc.getPage(pageNum);
      if (state.cancelled) throw createAbortError('Render cancelled');

      const renderViewport = page.getViewport({
        scale: rawScale * effectiveDpr,
        rotation: transform && typeof transform.rotation === 'number'
          ? transform.rotation
          : undefined,
      });

      // Backing store dimensions = full physical pixels.
      canvas.width = renderViewport.width;
      canvas.height = renderViewport.height;

      // CSS dimensions = logical pixels (physical / DPR). This preserves the
      // layout size while giving the canvas a hi-DPI backing store.
      canvas.style.width = (renderViewport.width / effectiveDpr) + 'px';
      canvas.style.height = (renderViewport.height / effectiveDpr) + 'px';

      const context = canvas.getContext('2d');
      const renderParams = {
        canvasContext: context,
        viewport: renderViewport,
      };
      if (transform && Array.isArray(transform.transform)) {
        renderParams.transform = transform.transform;
      }

      state.renderTask = page.render(renderParams);
      await state.renderTask.promise;

      if (state.cancelled) throw createAbortError('Render cancelled');

      return { canvas, pageNum, scale: rawScale };
    })();

    return new RenderTaskHandle({
      pageNum,
      scale: rawScale,
      internalPromise,
      internalCancel,
    });
  }

  /**
   * Phase 1: renders the full page and lets `TileManager` crop the result.
   * Phase 5 (post-WASM) will use a clipped transform to render only the tile
   * region — the interface is stable across the swap.
   *
   * @param {{
   *   pageNum: number,
   *   canvas: HTMLCanvasElement,
   *   scale: number,
   *   tileRect: { x: number, y: number, width: number, height: number },
   *   dpr?: number,
   * }} params
   * @returns {RenderTaskHandle}
   */
  renderTile(params) {
    // Phase 1 implementation: delegate to renderPage. The caller (render.js
    // TileManager) is responsible for cropping if it needs only a region.
    return this.renderPage({
      pageNum: params.pageNum,
      canvas: params.canvas,
      scale: params.scale,
      dpr: params.dpr,
    });
  }

  // ── Text ──────────────────────────────────────────────────────────────────

  /**
   * Return the raw PDF.js text content structure. Callers (managers.js,
   * search.worker.js) decide caching and serialisation.
   *
   * @param {number} pageNum
   * @returns {Promise<any>}
   */
  async extractText(pageNum) {
    const pdfDoc = this._requirePdfDoc();
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > pdfDoc.numPages) {
      throw new RangeError(
        `extractText: pageNum ${pageNum} is out of range [1, ${pdfDoc.numPages}]`,
      );
    }
    const page = await pdfDoc.getPage(pageNum);
    return page.getTextContent({ includeMarkedContent: false });
  }

  // ── Outline ───────────────────────────────────────────────────────────────

  /**
   * @returns {Promise<any[]>}
   */
  async getOutline() {
    const pdfDoc = this._requirePdfDoc();
    try {
      const raw = await pdfDoc.getOutline();
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  /**
   * @param {any} dest
   * @returns {Promise<number>}
   */
  async getPageIndex(dest) {
    const pdfDoc = this._requirePdfDoc();
    return pdfDoc.getPageIndex(dest);
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  /**
   * @returns {Promise<void>}
   */
  async destroy() {
    if (!this._pdfDoc) return;
    const doc = this._pdfDoc;
    this._pdfDoc = null;
    try {
      await doc.destroy();
    } catch {
      // Ignore — destroy is best-effort and idempotent.
    }
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * @private
   * @returns {any}
   */
  _requirePdfDoc() {
    if (!this._pdfDoc) throw new Error('No document loaded');
    return this._pdfDoc;
  }
}

// ============================================================================
// 4. WASM PDFIUM ADAPTER — reserved stub
// ============================================================================

/**
 * Reserved adapter for the Phase 5/8 engine swap to a WASM-compiled PDFium
 * core. Not selected in this release — `createEngine` returns it only when
 * `CONFIG.FEATURES.USE_PDFIUM_WASM` is true (a flag that does not yet exist
 * in the flags table, so the adapter is unreachable in production today).
 *
 * ─── Intended implementation strategy (for the future implementer) ──────────
 *
 * 1. Fetch the WASM binary from `CONFIG.WORKER_PATHS.pdfiumWasm` (a path to
 *    be added when the phase begins) and instantiate it inside a dedicated
 *    Web Worker, so that rasterisation never blocks the main thread.
 *
 * 2. Use `OffscreenCanvas` + `postMessage` transferables so that rendered
 *    pixel buffers move between the worker and the main thread with zero
 *    copies.
 *
 * 3. Implement `renderPage` / `renderTile` by delegating to the worker's
 *    rasterisation surface and resolving the `RenderTaskHandle.promise`
 *    with an `ImageBitmap` (transferred) rather than an
 *    `HTMLCanvasElement`. The main thread then blits the bitmap into the
 *    caller-supplied canvas.
 *
 * 4. `extractText` / `getOutline` / `getPageIndex` delegate to the same
 *    worker over the message bus.
 *
 * 5. `initialize` instantiates the worker and resolves once the WASM module
 *    has been compiled. All other methods proxy to the worker.
 *
 * The `EngineAdapter` interface is designed so that this swap requires no
 * changes anywhere else in the viewer — including `render.js`,
 * `managers.js`, `interaction.js`, and `core.js`.
 */
export class WasmPdfiumAdapter extends EngineAdapter {
  /**
   * @param {import('./core.js').ViewerCore} core
   */
  constructor(core) {
    super(core);
  }

  /**
   * Resolves rather than throwing so that a misconfigured flag does not
   * crash the viewer at boot; the first real method call will fail with a
   * descriptive message instead.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    this._initialized = true;
  }

  /** @inheritdoc */
  async loadDocument() {
    throw new Error('WasmPdfiumAdapter is not implemented in this release.');
  }

  /** @inheritdoc */
  async getPageMetadata() {
    throw new Error('WasmPdfiumAdapter is not implemented in this release.');
  }

  /** @inheritdoc */
  async getViewport() {
    throw new Error('WasmPdfiumAdapter is not implemented in this release.');
  }

  /** @inheritdoc */
  renderPage() {
    throw new Error('WasmPdfiumAdapter is not implemented in this release.');
  }

  /** @inheritdoc */
  renderTile() {
    throw new Error('WasmPdfiumAdapter is not implemented in this release.');
  }

  /** @inheritdoc */
  async extractText() {
    throw new Error('WasmPdfiumAdapter is not implemented in this release.');
  }

  /** @inheritdoc */
  async getOutline() {
    throw new Error('WasmPdfiumAdapter is not implemented in this release.');
  }

  /** @inheritdoc */
  async getPageIndex() {
    throw new Error('WasmPdfiumAdapter is not implemented in this release.');
  }

  /** @inheritdoc */
  async destroy() {
    this._initialized = false;
  }
}

// ============================================================================
// 5. FACTORY
// ============================================================================

/**
 * Construct the active engine adapter for the given core.
 *
 * Adapter selection (from the architecture spec § 4.6 and § 8):
 *   • `USE_PDFIUM_WASM` true  → WasmPdfiumAdapter (reserved)
 *   • Otherwise               → PdfJsAdapter
 *
 * The factory always returns a non-null adapter so downstream code never has
 * to null-check `getEngine()`. The `USE_ENGINE_ADAPTER` flag does not change
 * what this factory returns — it changes whether core *routes through* the
 * adapter or bypasses it via a compatibility shim. That distinction lives in
 * `core.js`, not here.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {EngineAdapter}
 */
export function createEngine(core) {
  let useWasmPdfium = false;
  try {
    const state = core.getState();
    const flags = state ? state.get('flags') : null;
    if (flags && flags.USE_PDFIUM_WASM === true) {
      useWasmPdfium = true;
    }
  } catch {
    // Fall through — the state may not yet exist during very early boot; the
    // default PdfJsAdapter is always safe.
  }

  if (useWasmPdfium) {
    return new WasmPdfiumAdapter(core);
  }
  return new PdfJsAdapter(core);
}