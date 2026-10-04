// frontend-user/scripts/viewer/workers.js

/**
 * Universal Document Viewer — Worker Manager
 * ============================================================================
 *
 * The viewer's threading boundary. Owns every Worker instance, exposes a
 * request/response protocol with correlation IDs, transfers ArrayBuffers
 * zero-copy, recovers from crashes with rate-limited respawns, and presents
 * a Promise-based API to consumers (managers.js and, in a future phase,
 * engine.js for PDFium-WASM).
 *
 * Exports (3):
 *   • WorkerHandle     — single worker wrapper
 *   • WorkerManager    — pool owner + high-level API
 *   • createWorkers(core) — factory
 *
 * Boundary rule (architecture spec § 2.3):
 *   • This is the ONLY file permitted to reference `Worker`, `postMessage`,
 *     `onmessage`, `onmessageerror`, `terminate`, `importScripts`.
 *   • Never touches the DOM (except `document.currentScript` for URL
 *     resolution — a documented minimal read).
 *   • Never touches the engine, caches, canvases, or ViewerState.
 *
 * Import discipline:
 *   • { CONFIG, Events } from './core.js'
 *   • { createAbortError, isAbortError } from './utils.js'
 *
 * @module viewer/workers
 */

'use strict';

import { CONFIG, Events } from './core.js';
import { createAbortError } from './utils.js';

// ============================================================================
// MODULE-PRIVATE CONSTANTS
// ============================================================================

/** Maximum in-flight requests per worker handle. @private */
const MAX_PENDING_PER_KIND = 32;

/** Minimum delay between a worker crash and the next respawn attempt. @private */
const MIN_RESPAWN_DELAY_MS = 1000;

/** Maximum depth for transferable detection. @private */
const TRANSFER_WALK_DEPTH = 3;

/** Maximum array length inspected during transferable detection. @private */
const TRANSFER_ARRAY_MAX = 1000;

// ============================================================================
// 1. WORKER HANDLE
// ============================================================================

/**
 * Wraps one `Worker` instance: spawn, ready handshake, request correlation,
 * transferable detection, per-request timeouts, AbortSignal support, crash
 * detection, and terminate-with-generation-increment.
 *
 * Handles are reused across documents within a session until terminated. A
 * terminated handle can be respawned by calling `spawn()` again — the handle
 * is never one-shot.
 */
export class WorkerHandle {
  /**
   * @param {{
   *   kind: 'search' | 'parser',
   *   url: string,
   *   core: import('./core.js').ViewerCore,
   *   readyTimeoutMs: number,
   *   requestTimeoutMs: number,
   * }} options
   */
  constructor(options) {
    /** @private */ this._kind = options.kind;
    /** @private */ this._url = options.url;
    /** @private */ this._core = options.core;
    /** @private */ this._readyTimeoutMs = options.readyTimeoutMs;
    /** @private */ this._requestTimeoutMs = options.requestTimeoutMs;

    /** @private @type {Worker|null} */ this._worker = null;
    /** @private @type {Promise<void>|null} */ this._readyPromise = null;
    /** @private @type {((v: void) => void)|null} */ this._readyResolve = null;
    /** @private @type {((e: Error) => void)|null} */ this._readyReject = null;
    /** @private @type {ReturnType<typeof setTimeout>|null} */ this._readyTimer = null;

    /** @private @type {Map<number, { resolve: (v:any)=>void, reject: (e:Error)=>void, timer: ReturnType<typeof setTimeout>|null, type: string, generation: number, abortCleanup: (()=>void)|null }>} */
    this._pending = new Map();
    /** @private */ this._nextRequestId = 1;
    /** @private */ this._generation = 0;
    /** @private */ this._crashed = false;
    /** @private */ this._lastErrorAt = 0;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Spawn the underlying Worker. Idempotent — subsequent calls while alive
   * return the same ready promise. Safe to call concurrently.
   *
   * @returns {Promise<void>}
   */
  spawn() {
    // Already alive and ready (or in the process of becoming ready).
    if (this._worker && !this._crashed && this._readyPromise) {
      return this._readyPromise;
    }

    // Rate limiting after a crash.
    const now = Date.now();
    const sinceError = now - this._lastErrorAt;
    if (this._lastErrorAt > 0 && sinceError < MIN_RESPAWN_DELAY_MS) {
      const delay = MIN_RESPAWN_DELAY_MS - sinceError;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          this._doSpawn().then(resolve, reject);
        }, delay);
      });
    }

    return this._doSpawn();
  }

  /**
   * Send a request. Resolves with the worker's response payload. Rejects with
   * an AbortError on cancellation, timeout, crash, or termination.
   *
   * @param {string} type
   * @param {any} payload
   * @param {{ transfer?: Transferable[], signal?: AbortSignal, timeout?: number }} [options]
   * @returns {Promise<any>}
   */
  async send(type, payload, options) {
    if (!this._worker || this._crashed) {
      await this.spawn();
    }
    if (!this._worker) {
      const err = new Error('Worker is not available');
      err.code = 'WORKER_ERROR';
      throw err;
    }
    if (this._pending.size >= MAX_PENDING_PER_KIND) {
      const err = new Error('Worker is busy');
      err.code = 'WORKER_BUSY';
      throw err;
    }

    const opts = options || {};
    const signal = opts.signal || null;
    const timeoutMs = typeof opts.timeout === 'number' && opts.timeout > 0
      ? opts.timeout
      : this._requestTimeoutMs;

    // Pre-aborted check.
    if (signal && signal.aborted) {
      throw createAbortError('Request cancelled');
    }

    const requestId = this._nextRequestId++;
    const generation = this._generation;

    // Collect transferables from the payload and (optionally) extra ones.
    const collected = [];
    collectTransferables(payload, collected, 0);
    if (Array.isArray(opts.transfer)) {
      for (const t of opts.transfer) {
        if (t instanceof ArrayBuffer && !collected.includes(t)) collected.push(t);
      }
    }

    const message = {
      type,
      requestId,
      generation,
      payload: payload === undefined ? null : payload,
    };

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        timer: null,
        type,
        generation,
        abortCleanup: null,
      };

      // Timeout.
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this._cancelPending(requestId, 'timeout');
        }, timeoutMs);
      }

      // Abort signal wiring.
      if (signal) {
        const onAbort = () => this._cancelPending(requestId, 'aborted');
        try {
          signal.addEventListener('abort', onAbort, { once: true });
          entry.abortCleanup = () => {
            try { signal.removeEventListener('abort', onAbort); } catch { /* ignore */ }
          };
        } catch { /* ignore */ }
      }

      this._pending.set(requestId, entry);

      try {
        // Pass ArrayBuffers in the transfer list (zero-copy).
        this._worker.postMessage(message, collected);
      } catch (err) {
        this._pending.delete(requestId);
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.abortCleanup) entry.abortCleanup();
        const wrapped = err instanceof Error ? err : new Error(String(err));
        wrapped.code = wrapped.code || 'WORKER_POST_ERROR';
        reject(wrapped);
      }
    });
  }

  /**
   * Terminate the worker. Idempotent. Rejects all pending requests.
   *
   * @param {string} [reason]
   * @returns {void}
   */
  terminate(reason) {
    const r = reason || 'manual';

    // Best-effort graceful shutdown message.
    if (this._worker) {
      try { this._worker.postMessage({ type: 'shutdown', requestId: null, generation: this._generation, payload: null }); } catch { /* ignore */ }
      try { this._worker.terminate(); } catch { /* ignore */ }
    }
    this._worker = null;
    this._crashed = false;
    this._generation++;

    // Reject all pending.
    const pendingIds = Array.from(this._pending.keys());
    for (const id of pendingIds) {
      const entry = this._pending.get(id);
      if (!entry) continue;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.abortCleanup) entry.abortCleanup();
      try { entry.reject(createAbortError('Worker terminated: ' + r)); } catch { /* ignore */ }
      this._pending.delete(id);
    }

    // Reject any in-flight ready promise.
    if (this._readyTimer) {
      clearTimeout(this._readyTimer);
      this._readyTimer = null;
    }
    if (this._readyReject && this._readyPromise) {
      try { this._readyReject(createAbortError('Worker terminated')); } catch { /* ignore */ }
    }
    this._readyResolve = null;
    this._readyReject = null;
    this._readyPromise = null;

    // Notify.
    try {
      this._core.getBus().emit(Events.WORKER_TERMINATED, { kind: this._kind, reason: r });
    } catch { /* ignore */ }
  }

  /**
   * @returns {boolean}
   */
  isAlive() {
    return !!this._worker && !this._crashed;
  }

  /**
   * @returns {'search'|'parser'}
   */
  kind() {
    return this._kind;
  }

  /**
   * @returns {{ kind: string, alive: boolean, pending: number, generation: number, crashed: boolean, lastErrorAt: number }}
   */
  stats() {
    return {
      kind: this._kind,
      alive: this.isAlive(),
      pending: this._pending.size,
      generation: this._generation,
      crashed: this._crashed,
      lastErrorAt: this._lastErrorAt,
    };
  }

  // ── Internal: spawn ───────────────────────────────────────────────────────

  /**
   * @private
   * @returns {Promise<void>}
   */
  _doSpawn() {
    // Create fresh ready promise.
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // Attach a no-op catch to avoid unhandled-rejection warnings when the
    // caller does not observe the ready promise (e.g. terminated early).
    this._readyPromise.catch(() => { /* swallow */ });

    let worker;
    try {
      worker = new Worker(this._url, { type: 'module' });
    } catch (err) {
      this._worker = null;
      this._crashed = true;
      this._lastErrorAt = Date.now();
      const wrapped = err instanceof Error ? err : new Error(String(err));
      wrapped.code = 'WORKER_SPAWN_FAILED';
      this._rejectReady(wrapped);
      return this._readyPromise;
    }

    this._worker = worker;

    // Attach listeners.
    try {
      worker.addEventListener('message', (e) => this._onMessage(e));
      worker.addEventListener('error', (e) => this._onError(e));
      worker.addEventListener('messageerror', (e) => this._onMessageError(e));
    } catch { /* ignore */ }

    // Post init.
    try {
      worker.postMessage({ type: 'init', requestId: null, generation: this._generation, payload: { kind: this._kind } });
    } catch (err) {
      this._crashed = true;
      this._lastErrorAt = Date.now();
      const wrapped = err instanceof Error ? err : new Error(String(err));
      wrapped.code = 'WORKER_INIT_FAILED';
      this._rejectReady(wrapped);
      return this._readyPromise;
    }

    // Ready timeout.
    this._readyTimer = setTimeout(() => {
      this._readyTimer = null;
      this._crashed = true;
      this._lastErrorAt = Date.now();
      const err = new Error('Worker ready timeout');
      err.code = 'WORKER_READY_TIMEOUT';
      this._rejectReady(err);
      try { this._core.getBus().emit(Events.WORKER_ERROR, { kind: this._kind, code: 'WORKER_READY_TIMEOUT', message: err.message }); } catch { /* ignore */ }
      try { worker.terminate(); } catch { /* ignore */ }
      this._worker = null;
    }, this._readyTimeoutMs);

    return this._readyPromise;
  }

  /**
   * @private
   * @param {Error} err
   */
  _rejectReady(err) {
    if (this._readyTimer) {
      clearTimeout(this._readyTimer);
      this._readyTimer = null;
    }
    if (this._readyReject) {
      const reject = this._readyReject;
      this._readyResolve = null;
      this._readyReject = null;
      try { reject(err); } catch { /* ignore */ }
    }
  }

  // ── Internal: message handling ────────────────────────────────────────────

  /**
   * @private
   * @param {MessageEvent} event
   */
  _onMessage(event) {
    const message = event && event.data;
    if (!message || typeof message !== 'object') return;

    // Drop stale-generation messages.
    if (typeof message.generation === 'number' && message.generation !== this._generation) {
      return;
    }

    const type = message.type;

    // Ready handshake has no requestId.
    if (type === 'ready') {
      if (this._readyTimer) {
        clearTimeout(this._readyTimer);
        this._readyTimer = null;
      }
      const resolve = this._readyResolve;
      this._readyResolve = null;
      this._readyReject = null;
      if (resolve) {
        try { resolve(); } catch { /* ignore */ }
      }
      try {
        this._core.getBus().emit(Events.WORKER_READY, {
          kind: this._kind,
          version: (message.payload && message.payload.version) || null,
        });
      } catch { /* ignore */ }
      return;
    }

    // Progress notifications correlate to a requestId but do not resolve it.
    if (type === 'search-progress') {
      try {
        this._core.getBus().emit(Events.WORKER_PROGRESS, {
          kind: this._kind,
          requestId: message.requestId,
          scanned: message.payload && message.payload.scanned,
          total: message.payload && message.payload.total,
        });
      } catch { /* ignore */ }
      return;
    }

    // Request-correlated response.
    const requestId = message.requestId;
    if (typeof requestId !== 'number') {
      // Fatal error without requestId — treat as worker crash.
      if (type === 'error') {
        this._handleFatalError(message.error || { message: 'Unknown worker error' });
      }
      return;
    }

    const entry = this._pending.get(requestId);
    if (!entry) return; // already settled

    if (entry.timer) clearTimeout(entry.timer);
    if (entry.abortCleanup) entry.abortCleanup();
    this._pending.delete(requestId);

    if (type === 'error' || message.error) {
      const raw = message.error || {};
      const err = new Error(raw.message || 'Worker error');
      err.code = raw.code || 'WORKER_ERROR';
      if (raw.stack) err.stack = raw.stack;
      try { entry.reject(err); } catch { /* ignore */ }
      return;
    }

    try { entry.resolve(message.payload); } catch { /* ignore */ }
  }

  /**
   * @private
   * @param {ErrorEvent} _event
   */
  _onError(_event) {
    this._handleFatalError({ message: 'Worker crashed', code: 'WORKER_CRASH' });
  }

  /**
   * @private
   * @param {MessageEvent} _event
   */
  _onMessageError(_event) {
    this._handleFatalError({ message: 'Worker message error', code: 'WORKER_MESSAGE_ERROR' });
  }

  /**
   * @private
   * @param {{ message?: string, code?: string, stack?: string }} raw
   */
  _handleFatalError(raw) {
    this._crashed = true;
    this._lastErrorAt = Date.now();

    // Emit event.
    try {
      this._core.getBus().emit(Events.WORKER_ERROR, {
        kind: this._kind,
        code: raw.code || 'WORKER_ERROR',
        message: raw.message || 'Worker error',
      });
    } catch { /* ignore */ }

    // Reject all pending.
    const ids = Array.from(this._pending.keys());
    for (const id of ids) {
      const entry = this._pending.get(id);
      if (!entry) continue;
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.abortCleanup) entry.abortCleanup();
      try { entry.reject(createAbortError('Worker crashed')); } catch { /* ignore */ }
      this._pending.delete(id);
    }

    // Reject ready if pending.
    this._rejectReady(createAbortError('Worker crashed'));

    // Kill the worker.
    if (this._worker) {
      try { this._worker.terminate(); } catch { /* ignore */ }
      this._worker = null;
    }
    // Increment generation so any late responses are dropped.
    this._generation++;
  }

  // ── Internal: cancellation ────────────────────────────────────────────────

  /**
   * @private
   * @param {number} requestId
   * @param {string} reason
   */
  _cancelPending(requestId, reason) {
    const entry = this._pending.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.abortCleanup) entry.abortCleanup();
    this._pending.delete(requestId);

    // Best-effort notify the worker.
    if (this._worker) {
      try {
        this._worker.postMessage({
          type: 'cancel',
          requestId,
          generation: this._generation,
          payload: null,
        });
      } catch { /* ignore */ }
    }

    const message = reason === 'timeout' ? 'Request timed out' : 'Request cancelled';
    try { entry.reject(createAbortError(message)); } catch { /* ignore */ }
  }
}

// ============================================================================
// 2. TRANSFERABLE DETECTION
// ============================================================================

/**
 * Recursively walk `value` and collect ArrayBuffers into `out`. Depth-limited
 * and array-length-limited for safety. SharedArrayBuffers are excluded (they
 * are not transferable). Never throws.
 *
 * @private
 * @param {any} value
 * @param {Transferable[]} out
 * @param {number} depth
 * @returns {void}
 */
function collectTransferables(value, out, depth) {
  if (value == null) return;
  if (depth > TRANSFER_WALK_DEPTH) return;

  if (value instanceof ArrayBuffer) {
    if (!out.includes(value)) out.push(value);
    return;
  }

  // Do NOT include SharedArrayBuffer — not transferable.
  if (Array.isArray(value)) {
    const len = Math.min(value.length, TRANSFER_ARRAY_MAX);
    for (let i = 0; i < len; i++) {
      collectTransferables(value[i], out, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    // Fast-path: skip typed arrays and Blob/File (they carry ArrayBuffers
    // but transferring the typed array itself is not what we want; callers
    // who need that pass `{ transfer: [...] }` explicitly).
    if (ArrayBuffer.isView(value)) return;
    if (typeof Blob !== 'undefined' && value instanceof Blob) return;

    // Enumerate own enumerable properties.
    try {
      for (const key of Object.keys(value)) {
        collectTransferables(value[key], out, depth + 1);
      }
    } catch { /* ignore */ }
  }
}

// ============================================================================
// 3. WORKER MANAGER
// ============================================================================

/**
 * Owns one WorkerHandle per kind (search, parser). Lazily spawns on first
 * use. Provides convenience methods and a pool-lifetime generation counter
 * that invalidates requests spanning a `terminateAll`.
 */
export class WorkerManager {
  /**
   * @param {import('./core.js').ViewerCore} core
   */
  constructor(core) {
    /** @private */ this._core = core;
    /** @private @type {Map<'search'|'parser', WorkerHandle|null>} */
    this._handles = new Map([['search', null], ['parser', null]]);
    /** @private */ this._generation = 0;
    /** @private @type {Readonly<{ useWorkerSearch: boolean, useParserWorker: boolean }>} */
    this._flags = Object.freeze({ useWorkerSearch: false, useParserWorker: false });
    /** @private @type {{ search: number, parser: number }} */
    this._spawnCounts = { search: 0, parser: 0 };
    /** @private */ this._destroyed = false;

    // Snapshot flags at construction.
    try {
      const state = core.getState();
      const raw = (state && state.get('flags')) || {};
      this._flags = Object.freeze({
        useWorkerSearch: raw.USE_WORKER_SEARCH === true,
        useParserWorker: raw.USE_PARSER_WORKER === true,
      });
    } catch { /* ignore */ }
  }

  // ── Ensure / spawn ────────────────────────────────────────────────────────

  /**
   * Lazily spawn the search worker. Rejects with code `WORKER_DISABLED` when
   * the flag is off.
   *
   * @returns {Promise<WorkerHandle>}
   */
  async ensureSearchWorker() {
    if (!this._flags.useWorkerSearch) {
      const err = new Error('Search worker disabled by feature flag');
      err.code = 'WORKER_DISABLED';
      throw err;
    }
    return this._ensure('search');
  }

  /**
   * Lazily spawn the parser worker. Rejects with code `WORKER_DISABLED` when
   * the flag is off.
   *
   * @returns {Promise<WorkerHandle>}
   */
  async ensureParserWorker() {
    if (!this._flags.useParserWorker) {
      const err = new Error('Parser worker disabled by feature flag');
      err.code = 'WORKER_DISABLED';
      throw err;
    }
    return this._ensure('parser');
  }

  // ── High-level send ───────────────────────────────────────────────────────

  /**
   * @param {string} type
   * @param {any} payload
   * @param {{ transfer?: Transferable[], signal?: AbortSignal, timeout?: number }} [opts]
   * @returns {Promise<any>}
   */
  async postToSearch(type, payload, opts) {
    const handle = await this.ensureSearchWorker();
    return this._sendOnHandle(handle, type, payload, opts);
  }

  /**
   * @param {string} type
   * @param {any} payload
   * @param {{ transfer?: Transferable[], signal?: AbortSignal, timeout?: number }} [opts]
   * @returns {Promise<any>}
   */
  async postToParser(type, payload, opts) {
    const handle = await this.ensureParserWorker();
    return this._sendOnHandle(handle, type, payload, opts);
  }

  /**
   * Generic entry point keyed by kind.
   *
   * @param {'search'|'parser'} kind
   * @param {string} type
   * @param {any} payload
   * @param {{ transfer?: Transferable[], signal?: AbortSignal, timeout?: number }} [opts]
   * @returns {Promise<any>}
   */
  async send(kind, type, payload, opts) {
    const handle = await this._ensure(kind);
    return this._sendOnHandle(handle, type, payload, opts);
  }

  // ── Terminate ─────────────────────────────────────────────────────────────

  /**
   * @param {string} [reason]
   * @returns {void}
   */
  terminateSearch(reason) {
    const handle = this._handles.get('search');
    if (handle) handle.terminate(reason || 'terminate-search');
  }

  /**
   * @param {string} [reason]
   * @returns {void}
   */
  terminateParser(reason) {
    const handle = this._handles.get('parser');
    if (handle) handle.terminate(reason || 'terminate-parser');
  }

  /**
   * @param {string} [reason]
   * @returns {void}
   */
  terminateAll(reason) {
    const r = reason || 'terminate-all';
    this._generation++;
    this.terminateSearch(r);
    this.terminateParser(r);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  /** @returns {boolean} */
  isSearchAlive() {
    const handle = this._handles.get('search');
    return !!(handle && handle.isAlive());
  }

  /** @returns {boolean} */
  isParserAlive() {
    const handle = this._handles.get('parser');
    return !!(handle && handle.isAlive());
  }

  /**
   * @returns {{
   *   spawnCounts: { search: number, parser: number },
   *   search: object|null,
   *   parser: object|null,
   *   generation: number,
   * }}
   */
  stats() {
    const searchHandle = this._handles.get('search');
    const parserHandle = this._handles.get('parser');
    return {
      spawnCounts: { ...this._spawnCounts },
      search: searchHandle ? searchHandle.stats() : null,
      parser: parserHandle ? parserHandle.stats() : null,
      generation: this._generation,
    };
  }

  /**
   * Idempotent destroy. Alias for terminateAll with a stable reason.
   * @returns {void}
   */
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.terminateAll('viewer destroyed');
    this._handles.clear();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /**
   * @private
   * @param {'search'|'parser'} kind
   * @returns {Promise<WorkerHandle>}
   */
  async _ensure(kind) {
    // Flag check for the parser path even when called via `send`.
    if (kind === 'search' && !this._flags.useWorkerSearch) {
      const err = new Error('Search worker disabled by feature flag');
      err.code = 'WORKER_DISABLED';
      throw err;
    }
    if (kind === 'parser' && !this._flags.useParserWorker) {
      const err = new Error('Parser worker disabled by feature flag');
      err.code = 'WORKER_DISABLED';
      throw err;
    }

    let handle = this._handles.get(kind);
    if (!handle) {
      const url = this._resolveWorkerUrl(kind);
      handle = new WorkerHandle({
        kind,
        url,
        core: this._core,
        readyTimeoutMs: CONFIG.WORKER_READY_TIMEOUT_MS,
        requestTimeoutMs: CONFIG.WORKER_REQUEST_TIMEOUT_MS,
      });
      this._handles.set(kind, handle);
      this._spawnCounts[kind]++;
    }
    await handle.spawn();
    return handle;
  }

  /**
   * @private
   * @param {WorkerHandle} handle
   * @param {string} type
   * @param {any} payload
   * @param {{ transfer?: Transferable[], signal?: AbortSignal, timeout?: number }} [opts]
   * @returns {Promise<any>}
   */
  async _sendOnHandle(handle, type, payload, opts) {
    const myGeneration = this._generation;
    const result = await handle.send(type, payload, opts);
    // Invalidate if a terminateAll happened during the request.
    if (this._generation !== myGeneration) {
      throw createAbortError('Manager generation advanced');
    }
    return result;
  }

  /**
   * Resolve the physical URL of a worker script. Four strategies in order:
   *   1. Absolute URL (http(s):// or // or /) in CONFIG.WORKER_PATHS.
   *   2. import.meta.url relative to this module (bundler-aware).
   *   3. document.currentScript.src relative (raw ESM fallback).
   *   4. Literal CONFIG.WORKER_PATHS value verbatim.
   *
   * @private
   * @param {'search'|'parser'} kind
   * @returns {string}
   */
  _resolveWorkerUrl(kind) {
    const raw = (CONFIG.WORKER_PATHS && CONFIG.WORKER_PATHS[kind]) || '';
    if (!raw) return `${kind}.worker.js`;

    // Strategy 1: absolute.
    if (/^(https?:)?\/\//i.test(raw) || raw.startsWith('/')) {
      return raw;
    }

    // Derive the basename from the CONFIG path (strip directory parts).
    const basename = raw.split('/').pop() || `${kind}.worker.js`;

    // Strategy 2: import.meta.url (bundler-aware).
    try {
      // `import.meta` is syntax; guard for environments that pre-process it.
      const meta = /** @type {any} */ (import.meta);
      if (meta && typeof meta.url === 'string') {
        try {
          return new URL('./' + basename, meta.url).href;
        } catch { /* fall through */ }
      }
    } catch { /* import.meta not available */ }

    // Strategy 3: currentScript.src (raw ESM fallback).
    try {
      if (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) {
        try {
          return new URL('./viewer/' + basename, document.currentScript.src).href;
        } catch { /* fall through */ }
      }
    } catch { /* ignore */ }

    // Strategy 4: literal fallback.
    return raw;
  }
}

// ============================================================================
// 4. FACTORY
// ============================================================================

/**
 * Instantiate the WorkerManager, subscribe to document-destroyed so that
 * workers are terminated on document switch, and return the manager.
 *
 * Called first by ViewerCore.init() — before engine, managers, render, and
 * interaction — because those subsystems may call `core.getWorkers()` during
 * their own factories.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {WorkerManager}
 */
export function createWorkers(core) {
  const manager = new WorkerManager(core);

  // Subscribe to document destroyed → terminate all workers.
  try {
    const bus = core.getBus();
    bus.on(Events.DOCUMENT_DESTROYED, () => {
      try { manager.terminateAll('document destroyed'); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  return manager;
}