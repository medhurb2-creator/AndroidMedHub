// frontend-user/scripts/viewer/render.js

/**
 * Universal Document Viewer — Render Pipeline
 * ============================================================================
 *
 * Owns everything about turning a page (or a tile of a page) into pixels, and
 * deciding when, in what order, at what resolution, and how many at a time.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * INVARIANTS (do not violate — see project spec):
 *
 *   1. This pipeline produces BITMAPS. It never inserts canvases into the
 *      DOM. Core's RENDER_COMPLETE subscriber copies the bitmap into the
 *      slot that belongs to that page — the slot is either an existing
 *      <canvas class="page"> or a <div class="cover"> being promoted.
 *
 *   2. Slot sizing is core's job, not this file's. Core writes
 *      width/height inline on every slot to natural × displayScale. This
 *      file only decides the bitmap's pixel density (renderScale × DPR)
 *      and hands it back.
 *
 *   3. The canvas this file creates is a scratch surface. Its className
 *      ("page") is cosmetic — it never appears in the live DOM, because
 *      core either reuses an existing slot canvas or creates its own. The
 *      name matches so that a future change to a direct-canvas-install
 *      policy would not require touching this file.
 *
 *   4. #viewer-main is a fixed window; this file never touches it. The
 *      only transform target in the whole system is .page-container,
 *      owned by interaction.js.
 *
 *   5. Every page job carries a `ringRes` — the resolution ring the
 *      pyramid assigned this render (1.0, 0.8, 0.6, 0.4, 0.2). This file
 *      forwards it on the RENDER_COMPLETE payload so core can record it as
 *      `data-res` on the slot, which is what lets the pyramid tell which
 *      ring a completed render belongs to and avoid re-enqueuing forever.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Exports (5):
 *   • RenderJob        — typedef (documentation only)
 *   • PageRenderer     — canvas allocation + engine delegation
 *   • TileManager      — hybrid canvas/tile decision + tile grid + pyramid
 *   • RenderScheduler  — priority queue, concurrency, pause/resume, cancel
 *   • createRenderPipeline(core) — factory
 *
 * Boundary rule (from the architecture spec § 2.2):
 *   • This is the ONLY file permitted to call engine.renderPage / renderTile.
 *   • Never inserts canvases into the DOM. Only creates them via
 *     `document.createElement('canvas')` and hands them to the caller.
 *   • Never touches ViewerState. Never reads engine tokens (pdfjsLib, pdfDoc).
 *   • Never schedules timers of its own; uses `utils.nextFrame` for yielding.
 *
 * Import discipline:
 *   • { CONFIG, Events, PRIORITY } from './core.js'
 *   • { clamp, isAbortError, createAbortError, nextFrame,
 *       rectsIntersect, tileGridForViewport } from './utils.js'
 *   • Engine access exclusively via `core.getEngine()`.
 *   • Cache and Memory access exclusively via `core.getCache()` /
 *     `core.getMemory()` (defensive null-checks — those subsystems exist by
 *     the time the pipeline runs, but the code must not assume).
 *
 * @module viewer/render
 */

'use strict';

import { CONFIG, Events, PRIORITY } from './core.js';
import {
  clamp,
  isAbortError,
  createAbortError,
  nextFrame,
  rectsIntersect,
  tileGridForViewport,
} from './utils.js';

// ============================================================================
// 0. TYPES
// ============================================================================

/**
 * @typedef {Object} RenderJob
 * @property {string} id                 Unique per job. Used for deduplication.
 * @property {'page'|'tile'|'thumbnail'|'metadata'} kind
 * @property {number} pageNum            1-based
 * @property {number} scale              Effective render scale (before DPR).
 *                                       For pages this is displayScale × ringRes.
 * @property {number} [ringRes]          Ring resolution the pyramid assigned
 *                                       this page (1.0, 0.8, 0.6, 0.4, 0.2).
 *                                       Only meaningful for kind === 'page'.
 *                                       Forwarded unchanged to the
 *                                       RENDER_COMPLETE payload so core can
 *                                       record it as data-res on the slot.
 * @property {number} [rotation]         0 | 90 | 180 | 270 (mirrors state)
 * @property {{x:number,y:number,width:number,height:number}|null} tileRect
 * @property {number} priority           One of PRIORITY.*
 * @property {AbortSignal} [signal]      Optional external cancellation source
 * @property {(result:any)=>void} [onComplete]
 * @property {(err:Error)=>void} [onError]
 * @property {()=>void} [onCancel]
 */

// ============================================================================
// 1. CONSTANTS
// ============================================================================

/**
 * Upper bound on retained terminal-state entries. Bounded to avoid unbounded
 * growth over a long session.
 * @private
 */
const TERMINAL_HISTORY_CAP = 32;

// ============================================================================
// 2. PAGE RENDERER
// ============================================================================

/**
 * Takes a RenderJob, allocates a canvas, delegates pixel production to the
 * engine adapter, registers the canvas with MemoryManager, and returns a
 * cancelable handle synchronously.
 *
 * The returned handle satisfies the RenderTaskHandle shape (see engine.js §4.5):
 *   { promise, cancel(), isCancelled(), pageNum, scale }
 *
 * The canvas this renderer creates is a SCRATCH SURFACE. It is not inserted
 * into the DOM. Core's RENDER_COMPLETE handler copies its bitmap into the
 * page's slot — either an existing <canvas class="page"> inside
 * .page-container, or a fresh canvas that replaces the page's .cover
 * placeholder.
 */
export class PageRenderer {
  /**
   * @param {import('./core.js').ViewerCore} core
   */
  constructor(core) {
    /** @private */ this._core = core;
    /** @private @type {Map<string, { canvas: HTMLCanvasElement }>} */
    this._pending = new Map();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  /**
   * Allocate an empty canvas. Width/height are set by the engine adapter;
   * className is set to CONFIG.PAGE_CLASS so that a scratch canvas, if it
   * ever did end up in the DOM (future policy change), would be styled
   * identically to a slot canvas.
   *
   * @param {number} pageNum
   * @param {number} scale
   * @param {number} dpr
   * @param {{x:number,y:number,width:number,height:number}} [tileRect]
   * @returns {HTMLCanvasElement}
   */
  createCanvas(pageNum, scale, dpr, tileRect) {
    const canvas = document.createElement('canvas');
    canvas.className = CONFIG.PAGE_CLASS;
    // Dimensions are set by the engine. `tileRect` is passed through to the
    // engine via renderTile in Phase 5; in Phase 1 the engine renders the
    // full page and TileManager crops.
    void pageNum;
    void scale;
    void dpr;
    void tileRect;
    return canvas;
  }

  /**
   * Render a job. Returns a handle synchronously; the promise resolves with
   * the normalised result `{ canvas, pageNum, scale, ringRes, tileRect, kind, jobId }`.
   *
   * Canvas release guarantees:
   *   • On success: canvas is handed to the caller; NOT released here.
   *   • On cancel or error: canvas is released via MemoryManager and cleared.
   *
   * @param {RenderJob} job
   * @param {AbortController} controller
   * @returns {{ promise: Promise<any>, cancel: () => void, isCancelled: () => boolean, pageNum: number, scale: number }}
   */
  renderJob(job, controller) {
    /** @type {{ cancelled: boolean, engineHandle: any }} */
    const state = { cancelled: false, engineHandle: null };

    const canvas = this.createCanvas(job.pageNum, job.scale, this._getDpr(), job.tileRect || undefined);

    const internalCancel = () => {
      state.cancelled = true;
      if (state.engineHandle) {
        try { state.engineHandle.cancel(); } catch { /* ignore */ }
      }
    };

    const internalPromise = (async () => {
      if (state.cancelled) throw createAbortError('Render cancelled');

      // Register with MemoryManager (best-effort — subsystem may not be present).
      const memory = this._core.getMemory();
      if (memory && typeof memory.registerCanvas === 'function') {
        try {
          memory.registerCanvas(canvas, job.pageNum, {
            pinned: job.kind === 'thumbnail',
          });
        } catch { /* ignore */ }
      }
      this._pending.set(job.id, { canvas });

      try {
        const engine = this._core.getEngine();
        if (!engine) throw new Error('Engine adapter not available');

        const dpr = this._getDpr();
        let handle;
        if (job.kind === 'tile' && job.tileRect) {
          handle = engine.renderTile({
            pageNum: job.pageNum,
            canvas,
            scale: job.scale,
            tileRect: job.tileRect,
            dpr,
          });
        } else {
          handle = engine.renderPage({
            pageNum: job.pageNum,
            canvas,
            scale: job.scale,
            dpr,
          });
        }
        state.engineHandle = handle;

        // If cancel() raced ahead of engine handle creation, cancel now.
        if (state.cancelled) {
          try { handle.cancel(); } catch { /* ignore */ }
        }

        const result = await handle.promise;

        if (state.cancelled) throw createAbortError('Render cancelled');

        this._pending.delete(job.id);
        return {
          canvas,
          pageNum: job.pageNum,
          scale: job.scale,
          // Ring resolution carried through unchanged. Core reads this off
          // the RENDER_COMPLETE payload (via RenderScheduler._handleComplete)
          // to record data-res on the slot. Including it here as well keeps
          // the handle's resolve value self-describing for tests and future
          // direct callers.
          ringRes: typeof job.ringRes === 'number' ? job.ringRes : 1.0,
          tileRect: job.tileRect || null,
          kind: job.kind,
          jobId: job.id,
          // Preserve whatever extra fields engine returned.
          engineResult: result,
        };
      } catch (err) {
        this._pending.delete(job.id);
        this.releaseCanvas(canvas);
        throw err;
      }
    })();

    // Prevent unhandled rejection when caller ignores the promise.
    internalPromise.catch(() => { /* swallow for unhandled-rejection safety */ });

    // Link external abort signal.
    if (controller && controller.signal) {
      const onAbort = () => internalCancel();
      if (controller.signal.aborted) {
        onAbort();
      } else {
        try {
          controller.signal.addEventListener('abort', onAbort, { once: true });
        } catch { /* ignore */ }
      }
    }

    return {
      promise: internalPromise,
      cancel: internalCancel,
      isCancelled: () => state.cancelled,
      pageNum: job.pageNum,
      scale: job.scale,
    };
  }

  /**
   * Release a canvas: unregister from MemoryManager, clear its backing store.
   * Idempotent.
   *
   * @param {HTMLCanvasElement} canvas
   * @returns {void}
   */
  releaseCanvas(canvas) {
    if (!canvas) return;
    const memory = this._core.getMemory();
    if (memory && typeof memory.unregisterCanvas === 'function') {
      try { memory.unregisterCanvas(canvas); } catch { /* ignore */ }
    }
    try {
      canvas.width = 0;
      canvas.height = 0;
    } catch { /* ignore */ }
  }

  /**
   * Release every canvas still in flight. Called by core.destroy (via the
   * pipeline getters) and by tests. Idempotent.
   *
   * @returns {void}
   */
  destroy() {
    for (const [, entry] of this._pending) {
      try { this.releaseCanvas(entry.canvas); } catch { /* ignore */ }
    }
    this._pending.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * Read DPR from state, clamped to CONFIG.MAX_DPR.
   * @private
   * @returns {number}
   */
  _getDpr() {
    try {
      const state = this._core.getState();
      const dpr = state ? state.get('dpr') : 1;
      return clamp(typeof dpr === 'number' ? dpr : 1, 1, CONFIG.MAX_DPR);
    } catch {
      return 1;
    }
  }
}

// ============================================================================
// 3. TILE MANAGER
// ============================================================================

/**
 * Decides, per page and per (scale, dpr), whether the page should be rendered
 * as a single canvas or as a grid of tiles; owns the tile grid cache and the
 * thumbnail scale; exposes the tile-visibility query used by the scheduler
 * and interaction layer.
 *
 * The manager is a pure decision module — it does not render, does not store
 * canvases, and does not touch the DOM. It does not know about slots or the
 * page-container; it only knows about pixels.
 */
export class TileManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   * @param {Readonly<{ useTiling: boolean, useLowResPlaceholder: boolean }>} flags
   */
  constructor(core, flags) {
    /** @private */ this._core = core;
    /** @private */ this._flags = flags;
    /** @private @type {Map<number, { key: string, decision: any }>} */
    this._decisions = new Map();
    /** @private */ this._tileSize = CONFIG.TILE_SIZE_PX;
    /** @private */ this._threshold = CONFIG.HYBRID_CANVAS_THRESHOLD_PX;
    /** @private */ this._pyramidScales = Object.freeze([...CONFIG.TILE_PYRAMID_SCALES]);
  }

  // ── Decision ──────────────────────────────────────────────────────────────

  /**
   * Return the render-mode decision for a page at the given (scale, dpr).
   * Result is cached per (page, scale, dpr).
   *
   * @param {{ pageNum: number, width: number, height: number, rotation: number }} pageMetadata
   * @param {number} scale
   * @param {number} dpr
   * @returns {{ mode: 'canvas'|'tile', tileGrid: any[]|null, pyramidScales: number[] }}
   */
  decide(pageMetadata, scale, dpr) {
    if (!this._flags.useTiling) {
      return { mode: 'canvas', tileGrid: null, pyramidScales: [...this._pyramidScales] };
    }

    if (!pageMetadata || typeof pageMetadata.width !== 'number') {
      return { mode: 'canvas', tileGrid: null, pyramidScales: [...this._pyramidScales] };
    }

    const cacheKey = `${scale}:${dpr}`;
    const cached = this._decisions.get(pageMetadata.pageNum);
    if (cached && cached.key === cacheKey) return cached.decision;

    const effectiveWidth = pageMetadata.width * scale * dpr;
    const effectiveHeight = pageMetadata.height * scale * dpr;

    /** @type {{ mode: 'canvas'|'tile', tileGrid: any[]|null, pyramidScales: number[] }} */
    let decision;
    if (effectiveWidth <= this._threshold && effectiveHeight <= this._threshold) {
      decision = { mode: 'canvas', tileGrid: null, pyramidScales: [...this._pyramidScales] };
    } else {
      const grid = tileGridForViewport(effectiveWidth, effectiveHeight, this._tileSize);
      decision = { mode: 'tile', tileGrid: grid, pyramidScales: [...this._pyramidScales] };
    }

    this._decisions.set(pageMetadata.pageNum, { key: cacheKey, decision });
    return decision;
  }

  /**
   * Convenience predicate.
   *
   * @param {{ pageNum: number, width: number, height: number }} pageMetadata
   * @param {number} scale
   * @param {number} dpr
   * @returns {boolean}
   */
  shouldTile(pageMetadata, scale, dpr) {
    return this.decide(pageMetadata, scale, dpr).mode === 'tile';
  }

  // ── Tile grid queries ─────────────────────────────────────────────────────

  /**
   * Return the tiles intersecting `viewportRect` for a page whose decision is
   * `'tile'`. Returns `[]` for canvas-mode pages or unknown pages.
   *
   * `viewportRect` is in effective (post-scale, post-DPR) coordinates.
   *
   * @param {number} pageNum
   * @param {{ x: number, y: number, width: number, height: number }} viewportRect
   * @returns {Array<{ row: number, col: number, x: number, y: number, width: number, height: number }>}
   */
  tilesForViewport(pageNum, viewportRect) {
    const cached = this._decisions.get(pageNum);
    if (!cached || cached.decision.mode !== 'tile' || !cached.decision.tileGrid) {
      return [];
    }
    return cached.decision.tileGrid.filter((tile) => rectsIntersect(viewportRect, tile));
  }

  /**
   * Deterministic key for a tile job ID or cache lookup.
   *
   * @param {number} pageNum
   * @param {number} pyramidScale
   * @param {number} tileRow
   * @param {number} tileCol
   * @returns {string}
   */
  tileKey(pageNum, pyramidScale, tileRow, tileCol) {
    return `${pageNum}:${pyramidScale}:${tileRow}:${tileCol}`;
  }

  /**
   * Scale for thumbnail placeholders. Pinned, never evicted.
   * @returns {number}
   */
  thumbnailScale() {
    return CONFIG.THUMBNAIL_SCALE;
  }

  // ── Invalidation ──────────────────────────────────────────────────────────

  /**
   * Force a re-decision for a page.
   *
   * @param {number} pageNum
   * @returns {void}
   */
  invalidate(pageNum) {
    this._decisions.delete(pageNum);
  }

  /**
   * Reset the decision cache. Called on scale settle, DPR change, and
   * teardown.
   *
   * @returns {void}
   */
  invalidateAll() {
    this._decisions.clear();
  }
}

// ============================================================================
// 4. RENDER SCHEDULER
// ============================================================================

/**
 * Priority queue + bounded concurrency + cancelable execution engine.
 *
 * Bands (ascending numeric = higher priority per PRIORITY enum):
 *   P1 VISIBLE   — current viewport tiles/pages
 *   P2 ADJACENT  — prefetch along scroll vector
 *   P3 MARGIN    — lazy-load margin
 *   P4 IDLE      — thumbnails, background work
 *
 * Concurrency is `clamp(CONFIG.RENDER_CONCURRENCY, 1, 4)`.
 */
export class RenderScheduler {
  /**
   * @param {import('./core.js').ViewerCore} core
   * @param {PageRenderer} renderer
   * @param {Readonly<{ useScheduler: boolean, useRenderPrefetch: boolean }>} flags
   */
  constructor(core, renderer, flags) {
    /** @private */ this._core = core;
    /** @private */ this._renderer = renderer;
    /** @private */ this._flags = flags;

    /** @private @type {Array<RenderJob[]>} indexed by priority − 1 */
    this._queues = [[], [], [], []];
    /** @private @type {Map<string, { job: RenderJob, controller: AbortController, handle: any, cancelled: boolean, externalAbortHandler?: () => void }>} */
    this._running = new Map();
    /** @private @type {Map<string, any>} */
    this._completed = new Map();
    /** @private @type {Map<string, { status: string, timestamp: number }>} */
    this._recentTerminal = new Map();

    /** @private */ this._maxConcurrent = clamp(CONFIG.RENDER_CONCURRENCY, 1, 4);
    /** @private */ this._paused = false;
    /** @private */ this._draining = false;

    /** @private */ this._completedCount = 0;
    /** @private */ this._cancelledCount = 0;
    /** @private */ this._errorCount = 0;
  }

  // ── Enqueue / cancel ──────────────────────────────────────────────────────

  /**
   * Insert or replace a job. Returns synchronously. If `USE_SCHEDULER` is
   * false, calls the renderer directly (bypass mode).
   *
   * @param {RenderJob} job
   * @returns {void}
   */
  enqueue(job) {
    if (!job || typeof job.id !== 'string') return;

    // Bypass mode (rollback path).
    if (!this._flags.useScheduler) {
      this._enqueueBypass(job);
      return;
    }

    // Deduplicate: remove any queued job with the same id.
    this._removeQueuedById(job.id);

    // If a running job has the same id, cancel it and re-queue.
    if (this._running.has(job.id)) {
      const running = this._running.get(job.id);
      if (running) {
        running.cancelled = true;
        try { running.controller.abort(); } catch { /* ignore */ }
        try { running.handle && running.handle.cancel(); } catch { /* ignore */ }
      }
    }

    const band = this._bandIndex(job.priority);
    this._queues[band].push(job);

    try {
      this._core.getBus().emit(Events.RENDER_ENQUEUE, {
        jobId: job.id,
        kind: job.kind,
        pageNum: job.pageNum,
        priority: job.priority,
      });
    } catch { /* ignore */ }

    this._kickDrain();
  }

  /**
   * Cancel a specific job by ID. Returns true if anything was cancelled.
   *
   * @param {string} jobId
   * @returns {boolean}
   */
  cancel(jobId) {
    let cancelled = false;

    // Queued?
    for (let b = 0; b < this._queues.length; b++) {
      const q = this._queues[b];
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].id === jobId) {
          const job = q.splice(i, 1)[0];
          this._handleCancel(job, 'explicit');
          cancelled = true;
        }
      }
    }

    // Running?
    const running = this._running.get(jobId);
    if (running) {
      running.cancelled = true;
      try { running.controller.abort(); } catch { /* ignore */ }
      try { running.handle && running.handle.cancel(); } catch { /* ignore */ }
      cancelled = true;
    }

    return cancelled;
  }

  /**
   * Cancel every job with priority strictly greater than `priority`
   * (i.e. lower priority bands). Returns the number cancelled.
   *
   * Example: `cancelBelow(PRIORITY.ADJACENT)` cancels MARGIN and IDLE but
   * leaves VISIBLE and ADJACENT untouched.
   *
   * @param {number} priority
   * @returns {number}
   */
  cancelBelow(priority) {
    let count = 0;

    // Queued.
    for (let b = 0; b < this._queues.length; b++) {
      const bandPriority = b + 1;
      if (bandPriority > priority) {
        const q = this._queues[b];
        while (q.length > 0) {
          const job = q.shift();
          this._handleCancel(job, 'cancel-below');
          count++;
        }
      }
    }

    // Running.
    for (const [, running] of this._running) {
      if (running.job.priority > priority) {
        running.cancelled = true;
        try { running.controller.abort(); } catch { /* ignore */ }
        try { running.handle && running.handle.cancel(); } catch { /* ignore */ }
        count++;
      }
    }

    return count;
  }

  /**
   * Cancel every job for a page (all kinds, all priorities).
   *
   * @param {number} pageNum
   * @returns {number}
   */
  cancelPage(pageNum) {
    let count = 0;

    for (let b = 0; b < this._queues.length; b++) {
      const q = this._queues[b];
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].pageNum === pageNum) {
          const job = q.splice(i, 1)[0];
          this._handleCancel(job, 'page-cancelled');
          count++;
        }
      }
    }

    for (const [, running] of this._running) {
      if (running.job.pageNum === pageNum) {
        running.cancelled = true;
        try { running.controller.abort(); } catch { /* ignore */ }
        try { running.handle && running.handle.cancel(); } catch { /* ignore */ }
        count++;
      }
    }

    return count;
  }

  /**
   * Cancel every queued and running job. Returns a promise that resolves once
   * every running job's promise has settled (so that PDF.js has fully released
   * its worker before the caller proceeds).
   *
   * @returns {Promise<void>}
   */
  async cancelAll() {
    // Drop queues synchronously.
    for (const q of this._queues) {
      while (q.length > 0) {
        const job = q.shift();
        this._handleCancel(job, 'bulk-cancelled');
      }
    }

    // Abort running jobs and collect their settlement promises.
    const settlements = [];
    for (const [, running] of this._running) {
      running.cancelled = true;
      if (running.handle && running.handle.promise) {
        settlements.push(
          Promise.resolve(running.handle.promise).catch(() => {}),
        );
      }
      try { running.controller.abort(); } catch { /* ignore */ }
      try { running.handle && running.handle.cancel(); } catch { /* ignore */ }
    }

    await Promise.allSettled(settlements);
  }

  // ── Pause / resume ────────────────────────────────────────────────────────

  /**
   * Suspend starting new work. Running jobs continue.
   * @returns {void}
   */
  pause() {
    this._paused = true;
  }

  /**
   * Resume. Idempotent.
   * @returns {void}
   */
  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._kickDrain();
  }

  // ── Prefetch ──────────────────────────────────────────────────────────────

  /**
   * Enqueue prefetch jobs for a set of pages at the given priority. No-op
   * when `USE_RENDER_PREFETCH` is false.
   *
   * The caller is responsible for constructing each job's id, kind, and
   * callbacks. This method exists as a semantic marker so that callers
   * (ScrollManager) do not need to know about the flag.
   *
   * @param {number[]} pageNums
   * @param {number} priority
   * @param {(pageNum: number) => RenderJob} jobFactory
   * @returns {void}
   */
  prefetch(pageNums, priority, jobFactory) {
    if (!this._flags.useRenderPrefetch) return;
    if (!Array.isArray(pageNums)) return;
    if (typeof jobFactory !== 'function') return;
    for (const pageNum of pageNums) {
      try {
        const job = jobFactory(pageNum);
        if (job) this.enqueue(job);
      } catch { /* ignore */ }
    }
  }

  // ── Status / stats ────────────────────────────────────────────────────────

  /**
   * @param {string} jobId
   * @returns {'queued'|'running'|'done'|'cancelled'|'error'|'unknown'}
   */
  status(jobId) {
    if (this._running.has(jobId)) return 'running';
    for (const q of this._queues) {
      for (const job of q) {
        if (job.id === jobId) return 'queued';
      }
    }
    if (this._completed.has(jobId)) return 'done';
    const terminal = this._recentTerminal.get(jobId);
    if (terminal) {
      return terminal.status === 'error' ? 'error' : 'cancelled';
    }
    return 'unknown';
  }

  /**
   * @returns {{ queued: number, running: number, completed: number, cancelled: number, errors: number }}
   */
  getStats() {
    let queued = 0;
    for (const q of this._queues) queued += q.length;
    return {
      queued,
      running: this._running.size,
      completed: this._completedCount,
      cancelled: this._cancelledCount,
      errors: this._errorCount,
    };
  }

  /**
   * Idempotent destroy. Cancels everything and clears internal state.
   * @returns {void}
   */
  destroy() {
    try { this.cancelAll(); } catch { /* ignore */ }
    this._completed.clear();
    this._recentTerminal.clear();
    for (const q of this._queues) q.length = 0;
    this._paused = false;
    this._draining = false;
  }

  // ── Internal: queue management ────────────────────────────────────────────

  /**
   * @private
   * @param {number} priority
   * @returns {number} band index (0-based)
   */
  _bandIndex(priority) {
    const p = typeof priority === 'number' ? priority : PRIORITY.IDLE;
    return clamp(p - 1, 0, this._queues.length - 1);
  }

  /**
   * @private
   * @param {string} id
   */
  _removeQueuedById(id) {
    for (const q of this._queues) {
      for (let i = q.length - 1; i >= 0; i--) {
        if (q[i].id === id) q.splice(i, 1);
      }
    }
  }

  /**
   * @private
   * @returns {RenderJob|null}
   */
  _dequeueNextJob() {
    for (let b = 0; b < this._queues.length; b++) {
      const q = this._queues[b];
      if (q.length > 0) return q.shift();
    }
    return null;
  }

  /**
   * @private
   * @returns {boolean}
   */
  _hasWork() {
    for (const q of this._queues) {
      if (q.length > 0) return true;
    }
    return false;
  }

  // ── Internal: drain loop ──────────────────────────────────────────────────

  /**
   * @private
   */
  _kickDrain() {
    if (this._draining) return;
    // Queue a drain on a microtask so we do not stack-recurse from job
    // completions.
    Promise.resolve().then(() => this._drain());
  }

  /**
   * @private
   */
  async _drain() {
    if (this._draining) return;
    this._draining = true;
    let startedThisBurst = 0;
    try {
      while (!this._paused && this._running.size < this._maxConcurrent) {
        const job = this._dequeueNextJob();
        if (!job) break;

        // Pre-aborted?
        if (job.signal && job.signal.aborted) {
          this._handleCancel(job, 'pre-aborted');
          continue;
        }

        this._startJob(job);
        startedThisBurst++;

        // Yield to the event loop between batches of starts so that the
        // browser has a chance to paint before we saturate the main thread
        // with more PDF.js render calls.
        if (startedThisBurst >= 2 && this._running.size < this._maxConcurrent && this._hasWork()) {
          startedThisBurst = 0;
          await nextFrame();
        }
      }
    } finally {
      this._draining = false;
    }
  }

  /**
   * @private
   * @param {RenderJob} job
   */
  _startJob(job) {
    /** @type {{ job: RenderJob, controller: AbortController, handle: any, cancelled: boolean, externalAbortHandler?: () => void }} */
    const running = {
      job,
      controller: new AbortController(),
      handle: null,
      cancelled: false,
    };

    // Link external signal to internal controller.
    if (job.signal) {
      const onAbort = () => {
        running.cancelled = true;
        try { running.controller.abort(); } catch { /* ignore */ }
      };
      if (job.signal.aborted) {
        onAbort();
      } else {
        try {
          job.signal.addEventListener('abort', onAbort, { once: true });
          running.externalAbortHandler = onAbort;
        } catch { /* ignore */ }
      }
    }

    this._running.set(job.id, running);

    try {
      this._core.getBus().emit(Events.RENDER_START, {
        jobId: job.id,
        pageNum: job.pageNum,
        scale: job.scale,
        kind: job.kind,
      });
    } catch { /* ignore */ }

    let handle;
    try {
      handle = this._renderer.renderJob(job, running.controller);
    } catch (err) {
      // Synchronous failure — mark error, continue the loop.
      this._running.delete(job.id);
      this._handleError(job, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    running.handle = handle;

    // If cancel raced, propagate immediately.
    if (running.cancelled) {
      try { handle.cancel(); } catch { /* ignore */ }
    }

    Promise.resolve(handle.promise).then(
      (result) => this._onJobSettled(job, running, result, null),
      (err) => this._onJobSettled(job, running, null, err),
    );
  }

  /**
   * @private
   * @param {RenderJob} job
   * @param {*} running
   * @param {*} result
   * @param {Error|null} err
   */
  _onJobSettled(job, running, result, err) {
    this._running.delete(job.id);

    // Remove external abort listener (avoid leaks).
    if (running.externalAbortHandler && job.signal) {
      try { job.signal.removeEventListener('abort', running.externalAbortHandler); } catch { /* ignore */ }
      running.externalAbortHandler = undefined;
    }

    const wasCancelled = running.cancelled
      || (running.handle && typeof running.handle.isCancelled === 'function' && running.handle.isCancelled())
      || (err && isAbortError(err));

    if (err && !wasCancelled) {
      this._handleError(job, err instanceof Error ? err : new Error(String(err)));
    } else if (wasCancelled) {
      this._handleCancel(job, 'cancelled');
    } else {
      this._handleComplete(job, result);
    }

    this._kickDrain();
  }

  /**
   * @private
   * @param {RenderJob} job
   * @param {*} result
   */
  _handleComplete(job, result) {
    this._completedCount++;
    this._completed.set(job.id, { ...result, timestamp: Date.now() });
    this._pruneMap(this._completed);

    try {
      this._core.getBus().emit(Events.RENDER_COMPLETE, {
        jobId: job.id,
        pageNum: job.pageNum,
        scale: job.scale,
        // Ring resolution carried through unchanged. Core records it as
        // data-res on the slot so the pyramid knows which ring this
        // completed bitmap belongs to. Without this, the pyramid cannot
        // tell 100% from 80% and will re-enqueue forever.
        ringRes: typeof job.ringRes === 'number' ? job.ringRes : 1.0,
        kind: job.kind,
        // The rendered scratch canvas. Core copies the bitmap into the
        // page's slot; it does NOT insert this canvas into the DOM.
        canvas: result && result.canvas ? result.canvas : null,
      });
    } catch { /* ignore */ }

    try { job.onComplete && job.onComplete(result); } catch { /* ignore */ }
  }

  /**
   * @private
   * @param {RenderJob} job
   * @param {string} reason
   */
  _handleCancel(job, reason) {
    this._cancelledCount++;
    this._recentTerminal.set(job.id, { status: 'cancelled', timestamp: Date.now() });
    this._pruneMap(this._recentTerminal);

    try {
      this._core.getBus().emit(Events.RENDER_CANCELLED, {
        jobId: job.id,
        pageNum: job.pageNum,
        reason,
      });
    } catch { /* ignore */ }

    try { job.onCancel && job.onCancel(); } catch { /* ignore */ }
  }

  /**
   * @private
   * @param {RenderJob} job
   * @param {Error} err
   */
  _handleError(job, err) {
    this._errorCount++;
    this._recentTerminal.set(job.id, { status: 'error', timestamp: Date.now() });
    this._pruneMap(this._recentTerminal);

    try {
      this._core.getBus().emit(Events.RENDER_ERROR, {
        jobId: job.id,
        pageNum: job.pageNum,
        error: err,
      });
    } catch { /* ignore */ }

    try { job.onError && job.onError(err); } catch { /* ignore */ }
  }

  /**
   * @private
   * @param {Map<string, any>} map
   */
  _pruneMap(map) {
    if (map.size <= TERMINAL_HISTORY_CAP) return;
    const excess = map.size - TERMINAL_HISTORY_CAP;
    let removed = 0;
    for (const key of map.keys()) {
      map.delete(key);
      removed++;
      if (removed >= excess) break;
    }
  }

  // ── Internal: bypass mode (USE_SCHEDULER=false) ───────────────────────────

  /**
   * Direct renderer call. Preserves the fallback path's behaviour: no queue,
   * no concurrency bound, no priority.
   *
   * @private
   * @param {RenderJob} job
   */
  _enqueueBypass(job) {
    const controller = new AbortController();
    let handle;
    try {
      handle = this._renderer.renderJob(job, controller);
    } catch (err) {
      this._handleError(job, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    try {
      this._core.getBus().emit(Events.RENDER_START, {
        jobId: job.id,
        pageNum: job.pageNum,
        scale: job.scale,
        kind: job.kind,
      });
    } catch { /* ignore */ }

    Promise.resolve(handle.promise).then(
      (result) => this._handleComplete(job, result),
      (err) => {
        if (isAbortError(err)) this._handleCancel(job, 'aborted');
        else this._handleError(job, err instanceof Error ? err : new Error(String(err)));
      },
    );
  }
}

// ============================================================================
// 5. FACTORY
// ============================================================================

/**
 * Instantiate the render pipeline: PageRenderer → TileManager → RenderScheduler,
 * wired to the memory-pressure and scale-change events.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {{ scheduler: RenderScheduler, tileManager: TileManager, renderer: PageRenderer }}
 */
export function createRenderPipeline(core) {
  // Snapshot feature flags once.
  let rawFlags = {};
  try {
    const state = core.getState();
    rawFlags = (state && state.get('flags')) || {};
  } catch { /* ignore */ }

  const flags = Object.freeze({
    useScheduler: rawFlags.USE_SCHEDULER === true,
    useTiling: rawFlags.USE_TILING === true,
    useLowResPlaceholder: rawFlags.USE_LOW_RES_PLACEHOLDER === true,
    useRenderPrefetch: rawFlags.USE_RENDER_PREFETCH === true,
  });

  // Instantiate in dependency order.
  const renderer = new PageRenderer(core);
  const tileManager = new TileManager(core, flags);
  const scheduler = new RenderScheduler(core, renderer, flags);

  // Wire cross-module events. These subscriptions are viewer-lifetime
  // (survive document switches) and are torn down only when the whole viewer
  // is destroyed. They are safe to leave registered.
  try {
    const bus = core.getBus();
    bus.on(Events.MEMORY_PRESSURE, (payload) => {
      if (payload && payload.level === 'critical') {
        try { scheduler.cancelBelow(PRIORITY.MARGIN); } catch { /* ignore */ }
      }
    });
    bus.on(Events.SCALE_APPLIED, () => {
      try { tileManager.invalidateAll(); } catch { /* ignore */ }
    });
    bus.on(`${Events.STATE_CHANGED}:dpr`, () => {
      try { tileManager.invalidateAll(); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  return { scheduler, tileManager, renderer };
}