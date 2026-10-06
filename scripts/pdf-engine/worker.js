/**
 * MedVix Unified PDF Engine v7.0
 * File 8 of 8 — Isolated Off-Thread WASM Engine
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Uses the manual createTypstCompiler API rather than the $typst snippet.
 *
 * Why manual:
 *   The snippet performs its own WebAssembly.compileStreaming fetch, which
 *   requires an exact Content-Type: application/wasm. That check fails in
 *   environments where Vite serves the file with a different MIME type,
 *   producing an opaque "Failed to fetch".
 *
 *   The manual API lets us:
 *     1. Fetch the WASM bytes ourselves.
 *     2. Compile them with WebAssembly.compile (no MIME check).
 *     3. Hand the pre-compiled Module to the compiler via getModule.
 *     4. Recursively extract the PDF bytes from whatever wrapper shape
 *        the library's compile() returns.
 *
 * Message contract
 * ────────────────
 *   IN   { id: number, typstMarkup: string }
 *   OUT  { id, success: true,  pdfBuffer: Uint8Array }       (transferred)
 *   OUT  { id, success: false, error: string, diagnostics }  (on failure)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createTypstCompiler, loadFonts } from '@myriaddreamin/typst.ts';

import { getFontManifest } from './assets.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Constants
// ═══════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[pdf-engine/worker]';
const MAIN_FILE_PATH = '/main.typ';
const MAX_DIAGNOSTICS = 50;
const MAX_EXTRACT_DEPTH = 6;
const WASM_URL = '/wasm/typst_ts_web_compiler_bg.wasm';
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6D];

// ═══════════════════════════════════════════════════════════════════════════
// 2. Module state
// ═══════════════════════════════════════════════════════════════════════════

let compilerPromise = null;
let cachedFontBytes = null;
let cachedWasmModule = null;

// ═══════════════════════════════════════════════════════════════════════════
// 3. Message handler
// ═══════════════════════════════════════════════════════════════════════════

self.onmessage = async (ev) => {
  const msg = ev && ev.data;

  if (!msg || typeof msg !== 'object') {
    warn('Received a non-object message — dropped');
    return;
  }
  if (typeof msg.id !== 'number') {
    warn('Received a message without a numeric id — cannot correlate; dropped');
    return;
  }
  if (typeof msg.typstMarkup !== 'string') {
    postFailure(msg.id, new Error('typstMarkup must be a string'), []);
    return;
  }

  const { id, typstMarkup } = msg;
  const diagnostics = [];

  try {
    const compiler = await getCompiler();
    const pdfBytes = await runCompile(compiler, typstMarkup, diagnostics);
    postSuccess(id, pdfBytes);
  } catch (err) {
    postFailure(id, err, diagnostics);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 4. Compiler lifecycle
// ═══════════════════════════════════════════════════════════════════════════

function getCompiler() {
  if (compilerPromise) return compilerPromise;
  const init = initializeCompiler();
  compilerPromise = init.catch(err => {
    compilerPromise = null;
    throw err;
  });
  return compilerPromise;
}

async function initializeCompiler() {
  info('Initializing Typst compiler…');

  cachedFontBytes = await fetchAllFonts();
  cachedWasmModule = await loadWasmModule();

  let compiler;
  try {
    compiler = createTypstCompiler();
  } catch (err) {
    throw new Error(
      `createTypstCompiler() failed: ${err && err.message ? err.message : err}`
    );
  }

  // loadFonts() takes ONE argument: an array of UserFont objects.
  //   UserFont = ArrayBuffer | Uint8Array | { font: ArrayBuffer | Uint8Array; name?: string }
  const userFonts = cachedFontBytes.map(bytes => ({ font: bytes }));

  try {
    await compiler.init({
      getModule: () => cachedWasmModule,
      beforeBuild: [
        loadFonts(userFonts)
      ]
    });
  } catch (err) {
    const detail = (err && err.message) ? err.message : String(err);
    throw new Error(
      `Typst compiler init failed: ${detail} ` +
      `(WASM: ${WASM_URL}, ${cachedWasmModule ? 'module ready' : 'module missing'})`
    );
  }

  info('Typst compiler ready.');
  return compiler;
}

async function loadWasmModule() {
  let response;
  try {
    response = await fetch(WASM_URL);
  } catch (err) {
    throw new Error(
      `Failed to fetch WASM from ${WASM_URL}: ${describeError(err)}. ` +
      `Check that public/wasm/typst_ts_web_compiler_bg.wasm exists ` +
      `(run: npm run sync-wasm).`
    );
  }

  if (!response.ok) {
    throw new Error(
      `WASM fetch returned HTTP ${response.status} from ${WASM_URL}. ` +
      `The file is not being served at the expected path.`
    );
  }

  const bytes = await response.arrayBuffer();
  if (!bytes || bytes.byteLength === 0) {
    throw new Error(`WASM response from ${WASM_URL} was empty (0 bytes)`);
  }
  if (bytes.byteLength < 4) {
    throw new Error(`WASM file too small to be valid (${bytes.byteLength} bytes)`);
  }

  const head = new Uint8Array(bytes, 0, 4);
  if (
    head[0] !== WASM_MAGIC[0] || head[1] !== WASM_MAGIC[1] ||
    head[2] !== WASM_MAGIC[2] || head[3] !== WASM_MAGIC[3]
  ) {
    throw new Error(
      `WASM file does not start with the WASM magic number. ` +
      `First 4 bytes: [${head[0]}, ${head[1]}, ${head[2]}, ${head[3]}]. ` +
      `Server may be serving an HTML fallback.`
    );
  }

  try {
    return await WebAssembly.compile(bytes);
  } catch (err) {
    throw new Error(
      `WebAssembly.compile failed (${bytes.byteLength.toLocaleString()} bytes): ` +
      `${describeError(err)}`
    );
  }
}

async function fetchAllFonts() {
  const manifest = getFontManifest();
  const fetched = await Promise.allSettled(
    manifest.map(spec =>
      fetchArrayBuffer(spec.url).then(bytes => ({ spec, bytes }))
    )
  );

  const out = [];
  for (let i = 0; i < manifest.length; i++) {
    const spec = manifest[i];
    const result = fetched[i];
    const label = `${spec.family} ${spec.weight} ${spec.style}`;

    if (result.status === 'fulfilled') {
      out.push(result.value.bytes);
      continue;
    }
    if (spec.required) {
      throw new Error(
        `Required font missing (${label}): ${describeError(result.reason)}`
      );
    }
    warn(`Optional font missing (${label}): ${describeError(result.reason)}`);
  }

  if (out.length === 0) {
    throw new Error('No fonts available — at least one required font is needed');
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Compile execution
// ═══════════════════════════════════════════════════════════════════════════

async function runCompile(compiler, markup, diagnostics) {
  try {
    await compiler.addSource(MAIN_FILE_PATH, markup);
  } catch (err) {
    throw new Error(
      `Failed to register source at ${MAIN_FILE_PATH}: ${err && err.message ? err.message : err}`
    );
  }

  let result;
  try {
    result = await compiler.compile({
      mainFilePath: MAIN_FILE_PATH,
      format: 'pdf'
    });
  } catch (err) {
    const structured = extractDiagnosticsFromError(err);
    if (Array.isArray(diagnostics) && structured.length > 0) {
      for (const d of structured) diagnostics.push(d);
    }
    throw new Error(
      `Typst compile failed: ${err && err.message ? err.message : String(err)}`
    );
  }

  return extractBytes(result);
}

function extractBytes(value, depth = 0) {
  if (depth > MAX_EXTRACT_DEPTH) {
    throw new Error(
      `Compile result nested deeper than ${MAX_EXTRACT_DEPTH} levels`
    );
  }

  if (value === null || value === undefined) {
    throw new Error(`Compiler returned ${value}`);
  }
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'number') {
    return new Uint8Array(value);
  }
  if (typeof value !== 'object') {
    throw new Error(
      `Compiler returned ${typeof value}, expected binary`
    );
  }

  // wasm-bindgen Result pattern: { ok: boolean, value?: T, error?: E }
  if ('ok' in value && typeof value.ok === 'boolean') {
    if (!value.ok) {
      throw new Error(
        `Typst compile error: ${describeError(value.error || value.err || 'compile failed')}`
      );
    }
    if (value.value !== undefined && value.value !== null) {
      return extractBytes(value.value, depth + 1);
    }
    throw new Error('Result is marked ok but contains no value');
  }

  if ('ok' in value && value.ok !== undefined && value.ok !== null) {
    return extractBytes(value.ok, depth + 1);
  }
  if ('err' in value && value.err !== undefined && value.err !== null && value.err !== false) {
    throw new Error(`Typst compile error: ${describeError(value.err)}`);
  }
  if ('error' in value && value.error !== undefined && value.error !== null && value.error !== false) {
    throw new Error(`Typst compile error: ${describeError(value.error)}`);
  }

  const fields = ['result', 'value', 'data', 'pdf', 'artifact', 'bytes', 'buffer', 'output'];
  for (const field of fields) {
    if (field in value && value[field] !== undefined && value[field] !== null) {
      try {
        return extractBytes(value[field], depth + 1);
      } catch (err) {
        if (err && err.message && err.message.startsWith('Typst compile error')) throw err;
      }
    }
  }

  for (const accessor of ['result', 'value', 'data', 'pdf']) {
    if (typeof value[accessor] === 'function') {
      try {
        return extractBytes(value[accessor](), depth + 1);
      } catch (err) {
        if (err && err.message && err.message.startsWith('Typst compile error')) throw err;
      }
    }
  }

  throw new Error(
    `Compiler returned an unrecognized result shape. ${describeShape(value)}`
  );
}

function describeShape(obj) {
  if (obj === null) return 'value=null';
  if (obj === undefined) return 'value=undefined';
  if (typeof obj !== 'object') return `type=${typeof obj}`;
  try {
    const keys = Object.keys(obj).slice(0, 12);
    if (keys.length === 0) {
      const proto = Object.getPrototypeOf(obj);
      return `ctor=${(proto && proto.constructor && proto.constructor.name) || 'Object'}, ownKeys=[]`;
    }
    const parts = keys.map(k => {
      const v = obj[k];
      if (v === null) return `${k}=null`;
      if (v === undefined) return `${k}=undefined`;
      if (v instanceof Uint8Array) return `${k}=Uint8Array(${v.length})`;
      if (v instanceof ArrayBuffer) return `${k}=ArrayBuffer(${v.byteLength})`;
      if (Array.isArray(v)) return `${k}=Array(${v.length})`;
      if (typeof v === 'object') return `${k}=${(v.constructor && v.constructor.name) || 'Object'}`;
      return `${k}=${typeof v}`;
    });
    return `keys=[${parts.join(', ')}]`;
  } catch {
    return 'shape=uninspectable';
  }
}

function extractDiagnosticsFromError(err) {
  if (!err || typeof err !== 'object') return [];
  if (Array.isArray(err.diagnostics)) return err.diagnostics;
  if (Array.isArray(err.diagnostic)) return err.diagnostic;
  if (Array.isArray(err.errors)) return err.errors;
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Message posting
// ═══════════════════════════════════════════════════════════════════════════

function postSuccess(id, u8) {
  const out = new Uint8Array(u8.byteLength);
  out.set(u8);
  self.postMessage({ id, success: true, pdfBuffer: out }, [out.buffer]);
}

function postFailure(id, err, diagnostics) {
  self.postMessage({
    id,
    success: false,
    error: (err && err.message) ? err.message : String(err),
    diagnostics: Array.isArray(diagnostics) ? diagnostics.slice(0, MAX_DIAGNOSTICS) : []
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Utilities
// ═══════════════════════════════════════════════════════════════════════════

async function fetchArrayBuffer(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  const buf = await resp.arrayBuffer();
  if (!buf || buf.byteLength === 0) throw new Error(`Empty response body from ${url}`);
  return buf;
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try { return String(err); } catch { return 'unprintable error'; }
}

function warn(message) {
  try { console.warn(LOG_PREFIX, message); } catch { /* ignore */ }
}

function info(message) {
  if (self.__pdfEngineDebug === true) {
    try { console.log(LOG_PREFIX, message); } catch { /* ignore */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Ready
// ═══════════════════════════════════════════════════════════════════════════