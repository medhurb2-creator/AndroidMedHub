/**
 * MedVix Unified PDF Engine v7.0 (Patched & Dynamic Timeout Enabled)
 * File 1 of 8 — Root Entry Point & Platform Storage Bridge
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the ONLY file the application calls directly. Everything else in
 * the engine is a private pure function consumed through this file.
 *
 *   public API:
 *     exportDocument(type, data, opts?)  → silently save PDF (Web / Android)
 *     printDocument(type, data, opts?)   → open PDF in viewer, no dialog
 *     preload()                          → warm the WASM engine
 *     cancelAll(reason?)                 → abort all in-flight jobs
 *     shutdown()                         → tear down worker & state
 *     setDebug(on)                       → toggle verbose logging
 *
 *   internal orchestration:
 *     1. loadAssets()                (File 3 — logo, QR, font bytes)
 *     2. validateDocData(raw, type)  (File 2 — sanitize + freeze AST)
 *     3. compileDocumentToTypst()    (File 7 — AST → Typst source)
 *     4. worker.postMessage(markup)  (File 8 — WASM compile → Uint8Array)
 *     5. Filesystem.writeFile / Blob (platform delivery)
 *
 *   guarantees:
 *     • 100% offline — no network calls except asset/font fetches at first use
 *     • No system print dialog is ever shown
 *     • At most one worker exists and at most one compile runs at a time
 *     • Every returned promise settles exactly once
 *     • All errors surface as PdfEngineError with a stable .code
 *     • No timers, listeners, or byte buffers leak between jobs
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { loadAssets }             from './pdf-engine/assets.js';
import { validateDocData }        from './pdf-engine/types.js';
import { compileDocumentToTypst } from './pdf-engine/compiler.js';

// ── Configuration ───────────────────────────────────────────────────────────

const LOG_PREFIX            = '[pdf-engine]';
const WORKER_URL            = new URL('./pdf-engine/worker.js', import.meta.url);
const COMPILE_TIMEOUT_MS    = 60_000;              // Increased baseline to 60 seconds
const PRELOAD_TIMEOUT_MS    = 30_000;
const BLOB_REVOKE_DELAY_MS  = 30_000;
const MAX_FILENAME_LENGTH   = 120;                 // includes ".pdf"
const DEFAULT_FILENAME_STEM = 'MedVix_Document';

// ── Logger (silent in production; toggle via setDebug) ─────────────────────

let debugEnabled = false;

export function setDebug(on) { debugEnabled = !!on; }

const log = {
  info:  (...a) => { if (debugEnabled) console.log(LOG_PREFIX, ...a); },
  warn:  (...a) => { if (debugEnabled) console.warn(LOG_PREFIX, ...a); },
  debug: (...a) => { if (debugEnabled) console.debug(LOG_PREFIX, ...a); },
  error: (...a) => { console.error(LOG_PREFIX, ...a); }   // errors always surface
};

// ── Error taxonomy ──────────────────────────────────────────────────────────

/**
 * Every failure returned from this engine is wrapped in a PdfEngineError.
 * The `.code` field is stable and safe to switch on in the application layer.
 */
export class PdfEngineError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'PdfEngineError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

export const ErrorCode = Object.freeze({
  ASSET_LOAD: 'ASSET_LOAD',   // logo / QR / font fetch failed unrecoverably
  VALIDATION: 'VALIDATION',   // AST shape or Typst emission rejected
  COMPILE:    'COMPILE',      // Typst WASM rejected the markup
  WORKER:     'WORKER',       // worker crashed or could not be spawned
  TIMEOUT:    'TIMEOUT',      // compile exceeded the time budget
  CANCELLED:  'CANCELLED',    // caller aborted via AbortSignal
  STORAGE:    'STORAGE',      // Capacitor Filesystem write failed
  DOWNLOAD:   'DOWNLOAD',     // browser refused to start the download
  UNKNOWN:    'UNKNOWN'       // catch-all — should never fire in practice
});

// ── Progress stages ─────────────────────────────────────────────────────────

export const Progress = Object.freeze({
  LOADING_ASSETS:   'loading-assets',
  VALIDATING:       'validating',
  COMPILING_MARKUP: 'compiling-markup',
  RENDERING_PDF:    'rendering-pdf',
  WRITING:          'writing',
  DONE:             'done'
});

// ── Module state (private) ──────────────────────────────────────────────────

let worker                = null;             // Worker instance | null
let workerGeneration      = 0;                // bumped on respawn — guards stale listeners
let jobCounter            = 0;                // monotonic job id
const pendingJobs         = new Map();        // id → job record
let compileQueueTail      = Promise.resolve();// serializes compiles
let preloadPromise        = null;             // memoized preload

// ── Worker lifecycle ────────────────────────────────────────────────────────

function spawnWorker() {
  const generation = ++workerGeneration;
  let w;

  try {
    w = new Worker(WORKER_URL, { type: 'module' });
  } catch (err) {
    throw new PdfEngineError(
      ErrorCode.WORKER,
      `Failed to spawn PDF worker: ${err && err.message ? err.message : err}`,
      err
    );
  }

  // ── Normal response with robust schema support ──
  w.addEventListener('message', (ev) => {
    if (generation !== workerGeneration) return;   // stale — worker was replaced

    const msg = ev.data;
    if (!msg || typeof msg.id !== 'number') {
      log.warn('Received malformed message from worker:', msg);
      return;
    }

    const job = pendingJobs.get(msg.id);
    if (!job) return;                              // already settled or unknown

    pendingJobs.delete(msg.id);
    if (job.timer) clearTimeout(job.timer);
    if (job.cleanup) job.cleanup();

    if (job.cancelled) {
      job.reject(new PdfEngineError(ErrorCode.CANCELLED, 'Job cancelled'));
      return;
    }

    // Support both success=true and hasError=false/undefined response schemas
    const isSuccess = msg.success === true || (msg.hasError === false || (msg.hasError === undefined && !msg.error));

    if (isSuccess) {
      const raw = msg.pdfBuffer || msg.buffer;
      const src = raw instanceof Uint8Array ? raw : new Uint8Array(raw || 0);
      const out = new Uint8Array(src.byteLength);
      out.set(src);
      job.resolve(out);
    } else {
      const errorMsg = msg.error || (Array.isArray(msg.diagnostics) && msg.diagnostics.length > 0 
        ? JSON.stringify(msg.diagnostics) 
        : 'Typst compile failed');
      job.reject(new PdfEngineError(ErrorCode.COMPILE, errorMsg, msg.diagnostics));
    }
  });

  // ── Worker crashed ──
  w.addEventListener('error', (ev) => {
    if (generation !== workerGeneration) return;
    const message = (ev && ev.message) ? ev.message : 'Worker crashed';
    log.error('Worker crashed:', message);

    const stale = Array.from(pendingJobs.entries());
    pendingJobs.clear();
    for (const [, job] of stale) {
      if (job.timer) clearTimeout(job.timer);
      if (job.cleanup) job.cleanup();
      job.reject(new PdfEngineError(ErrorCode.WORKER, message));
    }

    worker = null;
  });

  // ── Structured-clone failure ──
  w.addEventListener('messageerror', (ev) => {
    if (generation !== workerGeneration) return;
    log.error('Worker message error (structured-clone failed):', ev);

    const stale = Array.from(pendingJobs.entries());
    pendingJobs.clear();
    for (const [, job] of stale) {
      if (job.timer) clearTimeout(job.timer);
      if (job.cleanup) job.cleanup();
      job.reject(new PdfEngineError(ErrorCode.WORKER, 'Worker message serialization failed'));
    }

    worker = null;
  });

  return w;
}

function getWorker() {
  if (!worker) worker = spawnWorker();
  return worker;
}

// ── Compile serialization ───────────────────────────────────────────────────

function serialized(fn) {
  const next = compileQueueTail.then(fn, fn);
  compileQueueTail = next.catch(() => {});
  return next;
}

// ── Dynamic Timeout Calculation ─────────────────────────────────────────────
/**
 * Computes an adaptive compilation timeout budget based on the workload size
 * (e.g., number of questions, sections, items, or raw data size).
 * 
 * @param {object} rawData          The raw document input data
 * @param {object} [options]        Options containing optional manual timeoutMs override
 * @returns {number}                Calculated timeout in milliseconds
 */
function computeDynamicTimeout(rawData, options = {}) {
  if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
    return options.timeoutMs;
  }

  let itemCount = 0;
  if (rawData) {
    const keysToCheck = ['questions', 'items', 'sections', 'chapters', 'topics', 'modules', 'data'];
    for (const key of keysToCheck) {
      if (Array.isArray(rawData[key])) {
        itemCount += rawData[key].length;
      }
    }

    if (Array.isArray(rawData.sections)) {
      for (const sec of rawData.sections) {
        if (sec && typeof sec === 'object') {
          for (const subKey of ['questions', 'items', 'content']) {
            if (Array.isArray(sec[subKey])) itemCount += sec[subKey].length;
          }
        }
      }
    }

    if (itemCount === 0) {
      for (const val of Object.values(rawData)) {
        if (Array.isArray(val)) {
          itemCount += val.length;
        }
      }
    }

    if (itemCount > 0) {
      const calculatedFromItems = COMPILE_TIMEOUT_MS + (itemCount * 400);
      return Math.min(240_000, Math.max(COMPILE_TIMEOUT_MS, calculatedFromItems));
    }

    try {
      const jsonString = JSON.stringify(rawData);
      const sizeKb = jsonString.length / 1024;
      const calculatedFromSize = Math.round(COMPILE_TIMEOUT_MS + (sizeKb * 150));
      return Math.min(180_000, Math.max(COMPILE_TIMEOUT_MS, calculatedFromSize));
    } catch (_) {}
  }

  return COMPILE_TIMEOUT_MS;
}

// ── Compile dispatch ────────────────────────────────────────────────────────

function runCompile(typstMarkup, { signal, timeoutMs = COMPILE_TIMEOUT_MS } = {}) {
  return serialized(() => new Promise((resolve, reject) => {

    if (signal && signal.aborted) {
      return reject(new PdfEngineError(ErrorCode.CANCELLED, 'Aborted before compile started'));
    }

    let w;
    try {
      w = getWorker();
    } catch (err) {
      return reject(err instanceof PdfEngineError
        ? err
        : new PdfEngineError(ErrorCode.WORKER, 'Failed to obtain worker', err));
    }

    const id = ++jobCounter;
    const job = {
      id,
      resolve,
      reject,
      timer: null,
      cancelled: false,
      cleanup: null
    };

    // Hard timeout based on dynamic workload budget
    job.timer = setTimeout(() => {
      if (!pendingJobs.has(id)) return;
      pendingJobs.delete(id);

      log.warn(`Compile job ${id} timed out after ${timeoutMs}ms — recycling worker`);

      try { w.terminate(); } catch (_) { /* ignore */ }

      const stale = Array.from(pendingJobs.entries());
      pendingJobs.clear();
      for (const [, other] of stale) {
        if (other.timer) clearTimeout(other.timer);
        if (other.cleanup) other.cleanup();
        other.reject(new PdfEngineError(ErrorCode.TIMEOUT, 'Worker recycled due to timeout'));
      }

      worker = null;
      reject(new PdfEngineError(ErrorCode.TIMEOUT, `Compile timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (signal) {
      const onAbort = () => { job.cancelled = true; };
      signal.addEventListener('abort', onAbort, { once: true });
      job.cleanup = () => {
        try { signal.removeEventListener('abort', onAbort); } catch (_) { /* ignore */ }
      };
    }

    pendingJobs.set(id, job);

    try {
      w.postMessage({ id, typstMarkup });
    } catch (err) {
      pendingJobs.delete(id);
      if (job.timer) clearTimeout(job.timer);
      if (job.cleanup) job.cleanup();
      reject(new PdfEngineError(
        ErrorCode.WORKER,
        `postMessage failed: ${err && err.message ? err.message : err}`,
        err
      ));
    }
  }));
}

// ── Platform detection ──────────────────────────────────────────────────────

function isCapacitor() {
  return !!(
    typeof window !== 'undefined' &&
    window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform()
  );
}

function getPlatform() {
  if (!isCapacitor()) return 'web';
  try {
    const p = window.Capacitor.getPlatform && window.Capacitor.getPlatform();
    return p === 'ios' ? 'ios' : 'android';
  } catch (_) {
    return 'android';
  }
}

// ── Base64 conversion ───────────────────────────────────────────────────────

function uint8ToBase64(u8) {
  const CHUNK = 0x8000;   // 32 KB
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    const slice = u8.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, slice);
  }
  return btoa(binary);
}

// ── Storage writers ─────────────────────────────────────────────────────────

async function saveViaBrowser(filename, u8) {
  let blob;
  try {
    blob = new Blob([u8], { type: 'application/pdf' });
  } catch (err) {
    throw new PdfEngineError(ErrorCode.DOWNLOAD, `Blob creation failed: ${err.message}`, err);
  }

  const url = URL.createObjectURL(blob);

  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
    throw new PdfEngineError(ErrorCode.DOWNLOAD, `Browser download failed: ${err.message}`, err);
  }

  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
  }, BLOB_REVOKE_DELAY_MS);

  return { uri: null, filename };
}

async function saveViaCapacitor(filename, u8) {
  const Filesystem = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
  if (!Filesystem) {
    throw new PdfEngineError(ErrorCode.STORAGE, 'Capacitor Filesystem plugin is not available');
  }

  let base64;
  try {
    base64 = uint8ToBase64(u8);
  } catch (err) {
    throw new PdfEngineError(ErrorCode.STORAGE, `Base64 encoding failed: ${err.message}`, err);
  }

  try {
    const result = await Filesystem.writeFile({
      path: filename,
      data: base64,
      directory: 'DOCUMENTS',
      recursive: true
    });
    return { uri: result && result.uri ? result.uri : null, filename };
  } catch (err) {
    throw new PdfEngineError(ErrorCode.STORAGE, `Filesystem write failed: ${err.message}`, err);
  }
}

async function deliverPdf(filename, u8) {
  return getPlatform() === 'web'
    ? saveViaBrowser(filename, u8)
    : saveViaCapacitor(filename, u8);
}

// ── Filename hygiene ────────────────────────────────────────────────────────

function safeFilename(stem) {
  const cleaned = String(stem || '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');

  const maxStemLen = MAX_FILENAME_LENGTH - 4;
  return cleaned.slice(0, maxStemLen) || DEFAULT_FILENAME_STEM;
}

// ── Progress dispatch ───────────────────────────────────────────────────────

function emitProgress(onProgress, stage, detail) {
  if (typeof onProgress !== 'function') return;
  try { onProgress(stage, detail); }
  catch (err) {
    log.warn(`onProgress callback threw: ${err && err.message ? err.message : err}`);
  }
}

// ── Internal: prepare a PDF end-to-end ──────────────────────────────────────

async function preparePdf(type, rawData, options = {}) {
  const { signal, onProgress, timeoutMs } = options;

  // 1. Assets
  emitProgress(onProgress, Progress.LOADING_ASSETS);
  await loadAssets();
  if (signal && signal.aborted) {
    throw new PdfEngineError(ErrorCode.CANCELLED, 'Aborted after asset load');
  }

  // 2. Validate + sanitize the AST
  emitProgress(onProgress, Progress.VALIDATING);
  let data;
  try {
    data = validateDocData(rawData, type);
  } catch (err) {
    throw new PdfEngineError(
      ErrorCode.VALIDATION,
      `Document data invalid: ${err && err.message ? err.message : err}`,
      err
    );
  }

  // 3. Compile AST into Typst source
  emitProgress(onProgress, Progress.COMPILING_MARKUP);
  let typstMarkup;
  try {
    typstMarkup = compileDocumentToTypst(type, data);
  } catch (err) {
    throw new PdfEngineError(
      ErrorCode.VALIDATION,
      `Typst markup generation failed: ${err && err.message ? err.message : err}`,
      err
    );
  }
  if (typeof typstMarkup !== 'string' || typstMarkup.length === 0) {
    throw new PdfEngineError(
      ErrorCode.VALIDATION,
      'Internal error: compiler returned empty Typst markup'
    );
  }

  // 4. Determine dynamic timeout budget based on workload magnitude
  const resolvedTimeout = computeDynamicTimeout(rawData, { timeoutMs });
  log.debug(`Assigned dynamic compile timeout of ${resolvedTimeout}ms for type "${type}"`);

  // 5. Render markup to PDF byte stream via worker with dynamic timeout
  emitProgress(onProgress, Progress.RENDERING_PDF);
  const u8 = await runCompile(typstMarkup, { signal, timeoutMs: resolvedTimeout });

  // 6. Derive filename
  const filename = safeFilename(data.id) + '.pdf';

  return { u8, filename, data };
}

// ── Public API: exportDocument ──────────────────────────────────────────────

export async function exportDocument(type, rawData, options = {}) {
  const now = () =>
    (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  const t0 = now();

  try {
    const { u8, filename } = await preparePdf(type, rawData, options);

    emitProgress(options.onProgress, Progress.WRITING);
    const delivered = await deliverPdf(filename, u8);

    const duration = Math.round(now() - t0);

    emitProgress(options.onProgress, Progress.DONE, {
      filename,
      size: u8.byteLength,
      duration
    });

    log.info(`Exported "${filename}" (${u8.byteLength} bytes) in ${duration}ms`);

    return {
      filename: delivered.filename,
      size: u8.byteLength,
      duration,
      uri: delivered.uri
    };
  } catch (err) {
    if (err instanceof PdfEngineError) throw err;
    throw new PdfEngineError(
      ErrorCode.UNKNOWN,
      err && err.message ? err.message : 'Export failed',
      err
    );
  }
}

// ── Public API: printDocument ───────────────────────────────────────────────

export async function printDocument(type, rawData, options = {}) {
  try {
    const { u8, filename } = await preparePdf(type, rawData, options);

    if (getPlatform() === 'web') {
      const blob = new Blob([u8], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const win = window.open(url, '_blank', 'noopener,noreferrer');
      if (!win) {
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
        throw new PdfEngineError(
          ErrorCode.DOWNLOAD,
          'Popup blocked — allow popups for this site to preview the PDF'
        );
      }
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
      }, BLOB_REVOKE_DELAY_MS);
      return { opened: true, uri: null };
    }

    const Filesystem = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem;
    const FileOpener = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FileOpener;

    if (!Filesystem || !FileOpener) {
      throw new PdfEngineError(
        ErrorCode.STORAGE,
        'Capacitor Filesystem/FileOpener plugins are not available'
      );
    }

    let base64;
    try {
      base64 = uint8ToBase64(u8);
    } catch (err) {
      throw new PdfEngineError(ErrorCode.STORAGE, `Base64 encoding failed: ${err.message}`, err);
    }

    const previewName = `preview_${Date.now()}_${filename}`;

    let written;
    try {
      written = await Filesystem.writeFile({
        path: previewName,
        data: base64,
        directory: 'CACHE',
        recursive: true
      });
    } catch (err) {
      throw new PdfEngineError(ErrorCode.STORAGE, `Preview write failed: ${err.message}`, err);
    }

    try {
      await FileOpener.open({
        filePath: written.uri,
        contentType: 'application/pdf'
      });
    } catch (err) {
      throw new PdfEngineError(ErrorCode.STORAGE, `Failed to open PDF preview: ${err.message}`, err);
    }

    return { opened: true, uri: written.uri };
  } catch (err) {
    if (err instanceof PdfEngineError) throw err;
    throw new PdfEngineError(
      ErrorCode.UNKNOWN,
      err && err.message ? err.message : 'Preview failed',
      err
    );
  }
}

// ── Public API: preload ─────────────────────────────────────────────────────

export function preload() {
  if (preloadPromise) return preloadPromise;

  preloadPromise = (async () => {
    const now = () =>
      (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
    const t0 = now();

    try {
      await loadAssets();
      await runCompile('Hello', { timeoutMs: PRELOAD_TIMEOUT_MS });
      log.info(`Preload complete in ${Math.round(now() - t0)}ms`);
      return true;
    } catch (err) {
      log.warn(`Preload failed (non-fatal): ${err && err.message ? err.message : err}`);
      preloadPromise = null;
      return false;
    }
  })();

  return preloadPromise;
}

// ── Public API: cancelAll / shutdown ────────────────────────────────────────

export function cancelAll(reason = 'Cancelled by caller') {
  const entries = Array.from(pendingJobs.entries());
  pendingJobs.clear();
  for (const [, job] of entries) {
    if (job.timer) clearTimeout(job.timer);
    if (job.cleanup) job.cleanup();
    job.reject(new PdfEngineError(ErrorCode.CANCELLED, reason));
  }
}

export function shutdown() {
  cancelAll('Engine shut down');
  if (worker) {
    try { worker.terminate(); } catch (_) { /* ignore */ }
    worker = null;
  }
  preloadPromise   = null;
  compileQueueTail = Promise.resolve();
  log.info('Engine shut down');
}

// ── Legacy window attachments ───────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.exportDocument    = exportDocument;
  window.printDocument     = printDocument;
  window.preloadPdfEngine  = preload;
  window.shutdownPdfEngine = shutdown;
  window.__pdfEngine       = Object.freeze({
    ErrorCode,
    Progress,
    PdfEngineError,
    setDebug
  });
}

// ── Ready ───────────────────────────────────────────────────────────────────

log.info('Module ready — dynamic timeout & robust worker handling attached');