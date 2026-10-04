// frontend-user/scripts/viewer/parser.worker.js

/**
 * Universal Document Viewer — Parser Worker (Phase 5 stub)
 * ============================================================================
 *
 * Reserved slot for the Phase 5+ document pre-parser. Its eventual
 * responsibility is to extract PDF xref, catalogue, page tree, outline, and
 * per-page dimensions BEFORE the PDF.js engine touches the buffer, enabling
 * Time-to-First-Visible-Content targets below 200 ms on remote files served
 * via HTTP byte-range requests.
 *
 * In this release it is a STUB with two jobs:
 *
 *   1. Complete the ready handshake. `WorkerHandle.spawn()` awaits a `ready`
 *      message and times out after CONFIG.WORKER_READY_TIMEOUT_MS. If this
 *      worker never sends `ready`, `ensureParserWorker()` would reject even
 *      when the USE_PARSER_WORKER flag is on. So `init` MUST respond.
 *
 *   2. Respond to every other request with a well-formed
 *      `error { code: 'WORKER_NOT_IMPLEMENTED' }` message. This mirrors the
 *      posture of `WasmPdfiumAdapter` in engine.js: a misconfigured flag or
 *      an unexpected call fails loudly at first use but does not crash the
 *      viewer during boot.
 *
 * ── Wire protocol (identical envelope to search.worker.js) ────────────────
 *
 *   Main → Worker:
 *     {type:'init',           requestId:null, generation, payload:{kind}}
 *     {type:'parse-metadata', requestId,      generation, payload:{buffer}}
 *     {type:'clear',          requestId,      generation, payload:{}}
 *     {type:'cancel',         requestId,      generation, payload:{requestId}}
 *     {type:'shutdown',       requestId,      generation, payload:{}}
 *
 *   Worker → Main:
 *     {type:'ready',          requestId:null, generation, payload:{kind, version}}
 *     {type:'parse-results',  requestId,      generation, payload:{numPages, outline, pageSizes}}
 *     {type:'error',          requestId,      generation, payload:null, error:{code, message}}
 *
 * ── Intended Phase 5 implementation strategy (for the future implementer) ──
 *
 *   1. Receive the PDF bytes as a transferred ArrayBuffer (ownership moves
 *      to this thread with zero copies).
 *
 *   2. Parse the trailer, locate the xref table (or xref stream), and walk
 *      the cross-reference chain without decoding any page content streams.
 *      This yields object offsets in one linear pass.
 *
 *   3. Walk the catalog's /Pages tree to count pages and collect each page's
 *      /MediaBox /CropBox /Rotate into a `pageSizes` array.
 *
 *   4. Read the catalog's /Outlines dictionary (if present) to build the
 *      outline tree in the same shape PDF.js returns — so that downstream
 *      consumers (OutlineManager) need no branching between pre-parse and
 *      engine-provided outlines.
 *
 *   5. Post `parse-results` with `{numPages, outline, pageSizes}`. The main
 *      thread (core.js) then hands the SAME buffer to engine.loadDocument,
 *      which re-parses it via PDF.js. The pre-parse is additive — it warms
 *      the viewer's metadata cache but does not replace PDF.js.
 *
 *   6. For remote files, the main thread uses the pre-parsed page-size list
 *      to render layout placeholders instantly, then begins byte-range
 *      fetches for visible pages. TTFC improvement depends on this handoff.
 *
 * ── Design constraints ─────────────────────────────────────────────────────
 *
 *   • Self-contained ESM. No imports. No dependencies.
 *   • No DOM access (worker scope has none anyway).
 *   • No timers, no event listeners other than the single `message` handler.
 *   • No `console` calls.
 *   • Generation echoing: every outgoing message carries the generation set
 *     by the most recent `init`. Incoming messages with a mismatched
 *     generation are dropped.
 *   • `self.close()` on shutdown so the worker terminates cleanly.
 *
 * @module viewer/parser.worker
 */

'use strict';

// ============================================================================
// MODULE-PRIVATE STATE
// ============================================================================

/** @type {'parser'|null} */
let _kind = null;

/** @type {number} */
let _generation = 0;

/** @type {boolean} */
let _shuttingDown = false;

/** Version reported in the ready handshake payload. @private */
const WORKER_VERSION = '0.1.0-stub';

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

  // init establishes the generation. Every other message must match.
  if (type !== 'init' && generation !== _generation) {
    return;
  }

  switch (type) {
    case 'init':
      _handleInit(generation, payload);
      return;

    case 'shutdown':
      _handleShutdown();
      return;

    case 'clear':
      _handleClear(requestId);
      return;

    case 'cancel':
      // Nothing to cancel in a stub. Silent no-op.
      return;

    case 'parse-metadata':
      _handleParseMetadata(requestId);
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
 * Initialise the worker. Sets the generation, replies with `ready`. Idempotent
 * per generation — a second `init` in the same generation simply re-sends the
 * ready signal (the handle's handshake only accepts the first, but the extra
 * message is harmless and cheap).
 *
 * @private
 * @param {number} generation
 * @param {{ kind?: string }} payload
 */
function _handleInit(generation, payload) {
  _generation = generation;
  _kind = (payload && typeof payload.kind === 'string') ? payload.kind : 'parser';
  _shuttingDown = false;

  _post({
    type: 'ready',
    requestId: null,
    generation: _generation,
    payload: { kind: _kind, version: WORKER_VERSION },
  });
}

/**
 * Reply to `clear` with a well-formed ack. The stub has no internal state to
 * clear beyond what `init` resets, but the protocol benefits from a
 * consistent reply shape so consumers do not branch on worker kind.
 *
 * @private
 * @param {number|null} requestId
 */
function _handleClear(requestId) {
  if (requestId === null) return;
  _post({
    type: 'clear',
    requestId,
    generation: _generation,
    payload: { cleared: true, stub: true },
  });
}

/**
 * Reject `parse-metadata` with a descriptive error. This is the honest
 * behaviour for a stub: a real implementation would parse the buffer and
 * return `{numPages, outline, pageSizes}`; the caller receives a
 * `WORKER_NOT_IMPLEMENTED` code and can fall back to PDF.js-only metadata.
 *
 * @private
 * @param {number|null} requestId
 */
function _handleParseMetadata(requestId) {
  if (requestId === null) return;
  _postError(requestId, {
    code: 'WORKER_NOT_IMPLEMENTED',
    message: 'parser.worker.js is not implemented in this release. ' +
      'See the module doc-comment for the Phase 5 implementation strategy.',
  });
}

/**
 * Stop processing and terminate this worker. Idempotent.
 *
 * @private
 */
function _handleShutdown() {
  _shuttingDown = true;
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
      code: (error && error.code) ? error.code : 'WORKER_ERROR',
      message: (error && error.message) ? error.message : 'Worker error',
    },
  });
}