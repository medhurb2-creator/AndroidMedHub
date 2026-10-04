// frontend-user/scripts/viewer/search.worker.js

/**
 * Universal Document Viewer — Search Worker
 * ============================================================================
 *
 * Runs on its own thread. Offloads the CPU-heavy regex matching of full-text
 * search from the main thread. Receives pre-extracted page text from the main
 * thread (via `index-page` messages), runs the search pattern against cached
 * text, and returns match positions. Rect computation (character offsets →
 * page-local pixel coordinates) is performed on the main thread, because the
 * worker protocol carries only the joined text, not per-item transform data.
 *
 * ── Wire protocol (from workers.js § 5 and managers.js § 4.4) ──────────────
 *
 *   Main → Worker:
 *     {type:'init',       requestId:null, generation, payload:{kind}}
 *     {type:'index-page', requestId,      generation, payload:{pageNum, fullText, itemCount}}
 *     {type:'search',     requestId,      generation, payload:{query, options, pages}}
 *     {type:'clear',      requestId,      generation, payload:{}}
 *     {type:'cancel',     requestId,      generation, payload:{requestId}}
 *     {type:'shutdown',   requestId,      generation, payload:{}}
 *
 *   Worker → Main:
 *     {type:'ready',          requestId:null, generation, payload:{kind, version}}
 *     {type:'index-page',     requestId,      generation, payload:{pageNum, cached:true}}
 *     {type:'search-progress',requestId,      generation, payload:{scanned, total}}
 *     {type:'search-results', requestId,      generation, payload:{matches, count}}
 *     {type:'error',          requestId,      generation, payload:null, error:{code, message}}
 *
 * ── Cancellation mechanics ─────────────────────────────────────────────────
 *
 * The worker is single-threaded. A `cancel` message arrives as a macrotask and
 * can only be delivered when the current task yields. `_handleSearch` is
 * therefore async and yields to the event loop every 10 pages via
 * `setTimeout(resolve, 0)`. Between yields it checks `_cancelled` for its own
 * requestId; on a hit it stops iterating and returns without posting a
 * response (the main thread already rejected the promise on cancel).
 *
 * ── Design notes ───────────────────────────────────────────────────────────
 *
 *   • No imports. The file is self-contained — importing ./utils.js would
 *     work in modern bundlers but introduces a dependency and a network fetch
 *     on worker boot. The worker implements its own regex builder.
 *   • No DOM access — worker scope has no `document` or `window` anyway.
 *   • Generation echoing: the `init` message carries the current generation;
 *     every outgoing message echoes it. If a message arrives with a different
 *     generation, it is ignored.
 *   • `self.close()` on shutdown — the worker terminates itself cleanly.
 *
 * @module viewer/search.worker
 */

'use strict';

// ============================================================================
// MODULE-PRIVATE STATE
// ============================================================================

/** @type {'search'|'parser'|null} */
let _kind = null;

/** @type {number} */
let _generation = 0;

/**
 * Page text cache. Cleared on `init` and `clear`.
 * @type {Map<number, { fullText: string, itemCount: number, indexedAt: number }>}
 */
const _pageCache = new Map();

/**
 * Request IDs currently marked for cancellation. Populated by `cancel`
 * messages; consumed by `_handleSearch` at each yield boundary.
 * @type {Set<number>}
 */
const _cancelled = new Set();

/** @type {boolean} */
let _shuttingDown = false;

// ============================================================================
// MESSAGE DISPATCH
// ============================================================================

self.addEventListener('message', (event) => {
  const msg = event && event.data;
  if (!msg || typeof msg !== 'object') return;
  if (_shuttingDown) return;

  const type = msg.type;
  const requestId = typeof msg.requestId === 'number' ? msg.requestId : null;
  const generation = typeof msg.generation === 'number' ? msg.generation : 0;
  const payload = msg.payload || {};

  // The init message establishes the generation; every other message must
  // match it. Mismatched-generation messages are dropped silently — the main
  // thread has already moved past this worker.
  if (type !== 'init' && generation !== _generation) {
    return;
  }

  switch (type) {
    case 'init':
      _handleInit(generation, payload);
      return;

    case 'index-page':
      _handleIndexPage(requestId, payload);
      return;

    case 'search':
      // Fire-and-forget: _handleSearch is async and yields to the event loop
      // so that cancel messages can be delivered mid-search.
      _handleSearch(requestId, payload);
      return;

    case 'clear':
      _handleClear(requestId);
      return;

    case 'cancel':
      _handleCancel(payload);
      return;

    case 'shutdown':
      _handleShutdown();
      return;

    default:
      if (requestId !== null) {
        _postError(requestId, {
          code: 'WORKER_UNKNOWN_TYPE',
          message: 'Unknown message type: ' + String(type),
        });
      }
  }
});

// ============================================================================
// HANDLERS
// ============================================================================

/**
 * Initialise the worker. Sets generation, resets state, replies with `ready`.
 *
 * @private
 * @param {number} generation
 * @param {{ kind?: string }} payload
 */
function _handleInit(generation, payload) {
  _generation = generation;
  _kind = (payload && typeof payload.kind === 'string') ? payload.kind : 'search';
  _pageCache.clear();
  _cancelled.clear();
  _shuttingDown = false;

  _post({
    type: 'ready',
    requestId: null,
    generation: _generation,
    payload: { kind: _kind, version: '1.0.0' },
  });
}

/**
 * Cache a page's joined text for later searching.
 *
 * @private
 * @param {number|null} requestId
 * @param {{ pageNum?: number, fullText?: string, itemCount?: number }} payload
 */
function _handleIndexPage(requestId, payload) {
  if (requestId === null) return;

  const pageNum = Number(payload && payload.pageNum);
  if (!Number.isFinite(pageNum) || pageNum < 1) {
    _postError(requestId, {
      code: 'WORKER_INVALID_PAGE',
      message: 'Invalid page number',
    });
    return;
  }

  const fullText = (typeof payload.fullText === 'string') ? payload.fullText : '';
  const itemCount = (typeof payload.itemCount === 'number' && payload.itemCount >= 0)
    ? payload.itemCount
    : 0;

  _pageCache.set(pageNum, {
    fullText,
    itemCount,
    indexedAt: Date.now(),
  });

  _post({
    type: 'index-page',
    requestId,
    generation: _generation,
    payload: { pageNum, cached: true },
  });
}

/**
 * Run a search across the cached pages. Async so it can yield to the event
 * loop every 10 pages — that is the only way a `cancel` message can reach the
 * worker mid-search.
 *
 * @private
 * @param {number|null} requestId
 * @param {{ query?: string, options?: { caseSensitive?: boolean, wholeWord?: boolean }, pages?: number[] }} payload
 * @returns {Promise<void>}
 */
async function _handleSearch(requestId, payload) {
  if (requestId === null) return;

  const query = (typeof payload.query === 'string') ? payload.query : '';
  const options = payload.options || {};
  const caseSensitive = options.caseSensitive === true;
  const wholeWord = options.wholeWord === true;

  // Empty query → empty result immediately.
  if (!query) {
    _post({
      type: 'search-results',
      requestId,
      generation: _generation,
      payload: { matches: [], count: 0 },
    });
    return;
  }

  const pages = Array.isArray(payload.pages) && payload.pages.length > 0
    ? payload.pages
    : Array.from(_pageCache.keys());

  const regex = _buildRegex(query, caseSensitive, wholeWord);
  if (!regex) {
    _postError(requestId, {
      code: 'WORKER_REGEX_ERROR',
      message: 'Invalid search pattern',
    });
    return;
  }

  const total = pages.length;
  /** @type {Array<{ pageNum: number, matchStart: number, matchEnd: number, text: string }>} */
  const matches = [];
  let scanned = 0;

  try {
    for (const rawPage of pages) {
      if (_cancelled.has(requestId)) {
        // The main thread already rejected this request's promise when it
        // sent the cancel. Post nothing; just clean up and exit.
        return;
      }

      const pageNum = Number(rawPage);
      if (!Number.isFinite(pageNum)) {
        scanned++;
        continue;
      }

      const cached = _pageCache.get(pageNum);
      if (!cached || !cached.fullText) {
        scanned++;
        continue;
      }

      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(cached.fullText)) !== null) {
        matches.push({
          pageNum,
          matchStart: match.index,
          matchEnd: match.index + match[0].length,
          text: match[0],
        });

        // Zero-length match guard.
        if (match[0].length === 0) regex.lastIndex++;

        // Sanity cap: never accumulate more than 100k matches in one search.
        if (matches.length >= 100000) break;
      }

      scanned++;

      // Every 10 pages, emit progress and yield to the event loop so that
      // cancel messages can be delivered.
      if (scanned % 10 === 0) {
        _post({
          type: 'search-progress',
          requestId,
          generation: _generation,
          payload: { scanned, total },
        });
        await _yieldToEventLoop();
      }
    }

    // Final cancellation check before posting the terminal response.
    if (_cancelled.has(requestId)) return;

    _post({
      type: 'search-results',
      requestId,
      generation: _generation,
      payload: { matches, count: matches.length },
    });
  } catch (err) {
    _postError(requestId, {
      code: 'WORKER_SEARCH_FAILED',
      message: err && err.message ? String(err.message) : 'Search failed',
    });
  } finally {
    // Safe whether or not the request was cancelled — request IDs are not
    // reused within a generation.
    _cancelled.delete(requestId);
  }
}

/**
 * Clear cached page text and cancel any pending searches.
 *
 * @private
 * @param {number|null} requestId
 */
function _handleClear(requestId) {
  _pageCache.clear();
  _cancelled.clear();

  if (requestId !== null) {
    _post({
      type: 'clear',
      requestId,
      generation: _generation,
      payload: { cleared: true },
    });
  }
}

/**
 * Mark a request as cancelled. The next time `_handleSearch` checks
 * `_cancelled` (at a yield boundary or loop top), it will stop.
 *
 * @private
 * @param {{ requestId?: number }} payload
 */
function _handleCancel(payload) {
  const requestId = Number(payload && payload.requestId);
  if (!Number.isFinite(requestId)) return;
  _cancelled.add(requestId);
}

/**
 * Stop processing and terminate this worker.
 *
 * @private
 */
function _handleShutdown() {
  _shuttingDown = true;
  _pageCache.clear();
  _cancelled.clear();
  try { self.close(); } catch { /* ignore */ }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Post a message to the main thread. Never throws.
 *
 * @private
 * @param {any} message
 */
function _post(message) {
  try { self.postMessage(message); } catch { /* ignore */ }
}

/**
 * Post an error response for a specific request.
 *
 * @private
 * @param {number} requestId
 * @param {{ code?: string, message?: string }} error
 */
function _postError(requestId, error) {
  _post({
    type: 'error',
    requestId,
    generation: _generation,
    payload: null,
    error: {
      code: error && error.code ? error.code : 'WORKER_ERROR',
      message: error && error.message ? error.message : 'Worker error',
    },
  });
}

/**
 * Build a global regex for the given query. Escapes special characters;
 * optionally wraps in word boundaries; optionally case-sensitive.
 *
 * @private
 * @param {string} query
 * @param {boolean} caseSensitive
 * @param {boolean} wholeWord
 * @returns {RegExp|null}
 */
function _buildRegex(query, caseSensitive, wholeWord) {
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
 * Yield to the worker's macrotask queue. Required so that `cancel` (and any
 * other) messages posted during a search are delivered by the worker's event
 * loop.
 *
 * @private
 * @returns {Promise<void>}
 */
function _yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}