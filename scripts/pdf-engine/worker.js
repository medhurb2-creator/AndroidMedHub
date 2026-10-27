/**
 * MedVix Unified PDF Engine v7.0
 * File 8 of 8 — Isolated Off-Thread WASM Engine
 */

import * as typst from '@myriaddreamin/typst.ts';
import { getFontManifest } from './assets.js';

// ═══════════════════════════════════════════════════════════════════════════
// 0. GLOBAL FETCH INTERCEPTOR (Monkey-Patch)
// ═══════════════════════════════════════════════════════════════════════════
const originalFetch = globalThis.fetch;

globalThis.fetch = async function(url, options) {
  const urlStr = typeof url === 'string' ? url : (url && url.url ? url.url : '');
  
  if (urlStr.includes('cdn.jsdelivr.net') || urlStr.includes('unpkg.com')) {
    console.warn('[pdf-engine/worker] Blocked external CDN request:', urlStr);
    return new Response(null, { status: 404, statusText: "Not Found" });
  }
  
  return originalFetch.apply(this, arguments);
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. Constants
// ═══════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[pdf-engine/worker]';
const MAIN_FILE_PATH = '/main.typ';
const MAX_DIAGNOSTICS = 50;
const MAX_EXTRACT_DEPTH = 6;

const BASE_URL = (import.meta.env && import.meta.env.BASE_URL) || '/';
const base = BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/';

const WASM_URL = `${base}wasm/typst_ts_web_compiler_bg.wasm`;
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

  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.id !== 'number') return;
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
  console.info(`${LOG_PREFIX} Initializing Typst compiler…`);

  cachedFontBytes = await fetchAllFonts();
  cachedWasmModule = await loadWasmModule();

  let compiler;
  try {
    compiler = typst.createTypstCompiler();
  } catch (err) {
    throw new Error(`createTypstCompiler() failed: ${err.message || err}`);
  }

  const userFonts = cachedFontBytes.map(bytes => ({ font: bytes }));

  try {
    await compiler.init({
      getModule: () => cachedWasmModule,
      disableDefaultFontAssets: true,
      beforeBuild: [
        typst.loadFonts(userFonts)
      ]
    });
  } catch (err) {
    const detail = (err && err.message) ? err.message : String(err);
    throw new Error(
      `Typst compiler init failed: ${detail} ` +
      `(WASM: ${WASM_URL}, ${cachedWasmModule ? 'module ready' : 'module missing'})`
    );
  }

  console.info(`${LOG_PREFIX} Typst compiler ready.`);
  return compiler;
}

async function loadWasmModule() {
  let response;
  try {
    response = await fetch(WASM_URL);
  } catch (err) {
    throw new Error(`Failed to fetch WASM from ${WASM_URL}: ${describeError(err)}.`);
  }

  if (!response.ok) {
    throw new Error(`WASM fetch returned HTTP ${response.status} from ${WASM_URL}.`);
  }

  const bytes = await response.arrayBuffer();
  if (!bytes || bytes.byteLength === 0) {
    throw new Error(`WASM response from ${WASM_URL} was empty (0 bytes)`);
  }

  const head = new Uint8Array(bytes, 0, 4);
  if (
    head[0] !== WASM_MAGIC[0] || head[1] !== WASM_MAGIC[1] ||
    head[2] !== WASM_MAGIC[2] || head[3] !== WASM_MAGIC[3]
  ) {
    throw new Error(`WASM file does not start with the WASM magic number.`);
  }

  try {
    return await WebAssembly.compile(bytes);
  } catch (err) {
    throw new Error(`WebAssembly.compile failed: ${describeError(err)}`);
  }
}

async function fetchAllFonts() {
  const manifest = getFontManifest();
  
  const fetched = await Promise.allSettled(
    manifest.map(spec => {
      const cleanPath = String(spec.url).replace(/^\/+/, '');
      const fontUrl = spec.url.startsWith('http') ? spec.url : base + cleanPath;
      return fetchArrayBuffer(fontUrl).then(bytes => ({ spec, bytes }));
    })
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
      throw new Error(`Required font missing (${label}): ${describeError(result.reason)}`);
    }
    console.warn(`${LOG_PREFIX} Optional font missing (${label})`);
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
    throw new Error(`Failed to register source: ${err.message || err}`);
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
    throw new Error(`Typst compile failed: ${err.message || String(err)}`);
  }

  if (result && result.hasError) {
    if (Array.isArray(result.diagnostics)) {
      for (const d of result.diagnostics) diagnostics.push(d);
    }

    // 🚨 DIAGNOSTIC LOGGING 🚨
    // This will print the exact syntax error and the generated code to the console.
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.error('🚨 TYPST MARKUP ERROR 🚨');
    console.error('Diagnostics:', JSON.stringify(result.diagnostics, null, 2));
    console.error('Generated Markup:', markup);
    console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    throw new Error('Typst compile error: Document contains markup errors. Check browser console.');
  }

  return extractBytes(result);
}

function extractBytes(value, depth = 0) {
  if (depth > MAX_EXTRACT_DEPTH) {
    throw new Error(`Compile result nested deeper than ${MAX_EXTRACT_DEPTH} levels`);
  }

  if (value === null || value === undefined) throw new Error(`Compiler returned ${value}`);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'number') {
    return new Uint8Array(value);
  }
  if (typeof value !== 'object') throw new Error(`Compiler returned ${typeof value}, expected binary`);

  if ('ok' in value && typeof value.ok === 'boolean') {
    if (!value.ok) throw new Error(`Typst compile error: ${describeError(value.error || value.err || 'compile failed')}`);
    if (value.value !== undefined && value.value !== null) return extractBytes(value.value, depth + 1);
    throw new Error('Result is marked ok but contains no value');
  }

  if ('ok' in value && value.ok !== undefined && value.ok !== null) return extractBytes(value.ok, depth + 1);
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

  throw new Error(`Compiler returned an unrecognized result shape. ${describeShape(value)}`);
}

function describeShape(obj) {
  if (obj === null) return 'value=null';
  if (obj === undefined) return 'value=undefined';
  if (typeof obj !== 'object') return `type=${typeof obj}`;
  try {
    const keys = Object.keys(obj).slice(0, 12);
    return `keys=[${keys.join(', ')}]`;
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
// 6. Message posting & Utilities
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