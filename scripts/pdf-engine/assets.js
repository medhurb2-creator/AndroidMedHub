/**
 * MedVix Unified PDF Engine v7.0
 * File 3 of 8 — Asset Loading & Base64 Management
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Owns every external resource the engine needs:
 *
 *   • Raster images (logo, QR) — small base64 strings embedded into Typst
 *     as data URIs by Files 5 & 6.
 *
 *   • Fonts (Inter, Noto Arabic, Noto Devanagari, Noto Thai) — binary
 *     ArrayBuffers fetched from the app's public directory.
 *
 *   • The font manifest — the single source of truth for which fonts exist,
 *     at what weight and style, and how they map to disk.
 *
 * Public API
 * ──────────
 *   loadAssets()                       → Promise<void>   (idempotent)
 *   getLogoBase64()                    → string          (throws if not loaded)
 *   getQrBase64()                      → string          (throws if not loaded)
 *   getFontManifest()                  → Array<FontSpec> (always available)
 *   getFontBytes(family, weight, style)→ ArrayBuffer|null (throws if not loaded)
 *   getLoadedFontKeys()                → string[]        (diagnostic)
 *   getMissingFontKeys()               → string[]        (diagnostic)
 *   isLoaded()                         → boolean
 *   getDefaultBodyFamily()             → string          (for File 5 tokens)
 *   PLACEHOLDER_PNG_BASE64             → string          (1×1 transparent PNG)
 *   AssetLoadError                     → typed error class
 *   AssetErrorCode                     → frozen enum of codes
 *
 * Guarantees
 * ──────────
 *   • Idempotent     — subsequent calls resolve instantly
 *   • Retryable      — a failed load resets state so the next call retries
 *   • Atomic         — a partial load never becomes visible
 *   • Deterministic  — same bytes on disk → same bytes in memory
 *   • Portable       — works in browser, Capacitor, and Node 18+
 *   • Never throws   — synchronously; only `loadAssets()` can reject
 *
 * Deployment note
 * ───────────────
 *   Asset URLs resolve against `import.meta.env.BASE_URL`, which Vite sets
 *   from the `base` config option. This makes the manifest work unchanged
 *   under:
 *
 *     • Domain-root deploys   (base: '/')
 *     • Subpath deploys       (base: '/medvix/')
 *     • Capacitor Android/iOS (base: './' — the WebView serves from a
 *                              virtual root, so relative resolution is safe)
 *
 *   If you change the deploy layout, change `base` in vite.config.js. Do
 *   not edit the URLs in this file.
 *
 * Font contract with File 8
 * ─────────────────────────
 *   The Typst worker re-fetches fonts from `getFontManifest()` because
 *   workers do not share module state with the main thread. `getFontBytes()`
 *   is therefore not consumed by the current worker — it exists so the main
 *   thread can inspect what was loaded and so future code (a server-side
 *   renderer, a preload path, a font inspector) can access the bytes without
 *   re-implementing the loader.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. Errors
// ═══════════════════════════════════════════════════════════════════════════

export class AssetLoadError extends Error {
  /**
   * @param {string} message  Human-readable summary
   * @param {object} [details] Structured context: { url, status, family, ... }
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'AssetLoadError';
    this.details = details;
  }
}

export const AssetErrorCode = Object.freeze({
  NOT_LOADED:             'NOT_LOADED',
  TIMEOUT:                'TIMEOUT',
  NETWORK:                'NETWORK',
  INVALID_DATA:           'INVALID_DATA',
  REQUIRED_FONT_MISSING:  'REQUIRED_FONT_MISSING'
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Base URL resolution
// ═══════════════════════════════════════════════════════════════════════════
//
// Vite injects `import.meta.env.BASE_URL` into every module it processes.
// The value mirrors the `base` config option (`'/'`, `'/subpath/'`, `'./'`).
// Outside Vite (Node tests, exotic bundlers) the guard below falls back to
// the domain root, which is safe for every browser-only context.

const BASE_URL = (() => {
  try {
    const env = import.meta && import.meta.env;
    if (env && typeof env.BASE_URL === 'string' && env.BASE_URL.length > 0) {
      return env.BASE_URL;
    }
  } catch { /* import.meta not supported in this environment */ }
  return '/';
})();

/**
 * Resolve a path from the public directory into a fetchable URL.
 *   '/assets/fonts/Inter-Regular.ttf'  with base '/'       → '/assets/fonts/Inter-Regular.ttf'
 *   '/assets/fonts/Inter-Regular.ttf'  with base '/medvix/'→ '/medvix/assets/fonts/Inter-Regular.ttf'
 *   '/assets/fonts/Inter-Regular.ttf'  with base './'      → './assets/fonts/Inter-Regular.ttf'
 *
 * The leading slash on the input is stripped so it cannot defeat the base
 * prefix. The base is normalized to end in `/` so simple concatenation
 * produces a valid path.
 */
function resolveAssetUrl(path) {
  const normalizedBase = BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/';
  const cleanPath = String(path).replace(/^\/+/, '');
  return normalizedBase + cleanPath;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Configuration constants
// ═══════════════════════════════════════════════════════════════════════════

// Paths are relative to the public directory. resolveAssetUrl() prefixes
// them with the Vite base URL at fetch time.
const LOGO_PATH = '/assets/images/logo_base64.txt';
const QR_PATH   = '/assets/images/qr_base64.txt';

const FETCH_TIMEOUT_MS = 10_000;

/**
 * A 1×1 fully transparent PNG. Its base64 form is used as the fallback for
 * any raster asset that fails to load. Rendering it produces a blank space
 * exactly where the missing logo or QR would have appeared — no layout
 * shift, no broken image icon, no error.
 *
 * The decoded bytes begin with `\x89PNG\r\n\x1a\n` — the standard PNG magic
 * number. That is what makes this a valid PNG rather than a random blob.
 */
export const PLACEHOLDER_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ═══════════════════════════════════════════════════════════════════════════
// 4. Font manifest
// ═══════════════════════════════════════════════════════════════════════════
//
// Every entry describes one font file. The worker (File 8) reads this
// manifest and registers each font with the Typst WASM compiler. Missing
// entries mean Typst substitutes a fallback font silently — the PDF renders,
// but with the wrong typeface for that text.
//
// Field semantics
// ───────────────
//   family   — the exact string Typst uses in `#set text(font: "...")`.
//              Must match File 4's `font-body` token spelling byte-for-byte.
//   weight   — numeric (400, 700, ...). Matches File 4's `font-weight-*`
//              tokens. Numeric, not string.
//   style    — 'normal' | 'italic'.
//   url      — path from the public directory. resolveAssetUrl() prefixes
//              the Vite base URL at fetch time.
//   scripts  — ISO 15924 script codes covered (documentation only).
//   required — if true and the fetch fails, loadAssets() rejects;
//              if false, the font is silently skipped (Typst falls back).
//
// Format note
// ───────────
//   `.ttf` / `.otf` only. Typst's HarfBuzz reads raw OpenType tables and
//   cannot decode the `.woff2` compressed container without a decompressor
//   step that the WASM build does not include.

const FONT_MANIFEST = Object.freeze([
  Object.freeze({
    family: 'Inter',
    weight: 400,
    style: 'normal',
    url: '/assets/fonts/Inter-Regular.ttf',
    scripts: ['Latn'],
    required: true
  }),
  Object.freeze({
    family: 'Inter',
    weight: 700,
    style: 'normal',
    url: '/assets/fonts/Inter-Bold.ttf',
    scripts: ['Latn'],
    required: false
  }),
  Object.freeze({
    family: 'Inter',
    weight: 400,
    style: 'italic',
    url: '/assets/fonts/Inter-Italic.ttf',
    scripts: ['Latn'],
    required: false
  }),
  Object.freeze({
    family: 'Noto Naskh Arabic',
    weight: 400,
    style: 'normal',
    url: '/assets/fonts/NotoNaskhArabic-Regular.ttf',
    scripts: ['Arab'],
    required: false
  }),
  Object.freeze({
    family: 'Noto Sans Devanagari',
    weight: 400,
    style: 'normal',
    url: '/assets/fonts/NotoSansDevanagari-Regular.ttf',
    scripts: ['Deva'],
    required: false
  }),
  Object.freeze({
    family: 'Noto Sans Thai',
    weight: 400,
    style: 'normal',
    url: '/assets/fonts/NotoSansThai-Regular.ttf',
    scripts: ['Thai'],
    required: false
  })
]);

/**
 * The family name of the required body font. File 4 (tokens) and File 5
 * (base-template) import this to guarantee their `#set text(font: "...")`
 * declarations reference the same string that File 8 registers with WASM.
 * This prevents the "silent font substitution" bug class where a spelling
 * mismatch between any two files makes Typst fall back to a default.
 */
const DEFAULT_BODY_FAMILY =
  (FONT_MANIFEST.find(spec => spec.required) || {}).family || 'Inter';

// ═══════════════════════════════════════════════════════════════════════════
// 5. Module state (private)
// ═══════════════════════════════════════════════════════════════════════════

let loaded      = false;
let loadPromise = null;

let logoBase64 = '';
let qrBase64   = '';

/**
 * Keyed by `${family}|${weight}|${style}`. Only populated after loadAssets()
 * resolves successfully. Immutable for the lifetime of the page.
 */
const fontBytesMap = new Map();

/**
 * Set of keys that failed to load and were non-fatal (optional fonts).
 * Populated during loadAssets(); reset on every retry.
 */
const missingFontKeys = new Set();

// ═══════════════════════════════════════════════════════════════════════════
// 6. Public API: loadAssets
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Load every asset the engine needs. Idempotent, memoized, retryable.
 *
 *   • First call: fetches rasters + fonts in parallel, caches results.
 *   • Subsequent calls (after success): resolve immediately.
 *   • Failure: rejects and resets internal state so the next call retries.
 *
 * @returns {Promise<void>}
 * @throws {AssetLoadError} only when a *required* asset cannot be loaded.
 */
export function loadAssets() {
  if (loaded) return Promise.resolve();
  if (loadPromise) return loadPromise;

  const p = (async () => {
    // ── Phase 1: rasters in parallel ─────────────────────────────────────
    // Raster failures fall back to the transparent placeholder — never throw.
    const [logoResult, qrResult] = await Promise.allSettled([
      fetchRasterAsset(LOGO_PATH),
      fetchRasterAsset(QR_PATH)
    ]);

    logoBase64 = (logoResult.status === 'fulfilled' && logoResult.value)
      ? logoResult.value
      : PLACEHOLDER_PNG_BASE64;

    qrBase64 = (qrResult.status === 'fulfilled' && qrResult.value)
      ? qrResult.value
      : PLACEHOLDER_PNG_BASE64;

    if (logoResult.status === 'rejected') {
      warn(`Logo load failed, using transparent placeholder — ${describeError(logoResult.reason)}`);
    }
    if (qrResult.status === 'rejected') {
      warn(`QR load failed, using transparent placeholder — ${describeError(qrResult.reason)}`);
    }

    // ── Phase 2: fonts in parallel ───────────────────────────────────────
    const fontResults = await Promise.allSettled(
      FONT_MANIFEST.map(spec => fetchFontAsset(spec))
    );

    // ── Phase 3: resolve each font, throw if a required one is missing ──
    for (let i = 0; i < FONT_MANIFEST.length; i++) {
      const spec = FONT_MANIFEST[i];
      const result = fontResults[i];
      const key = fontKey(spec.family, spec.weight, spec.style);

      if (result.status === 'fulfilled' && result.value) {
        fontBytesMap.set(key, result.value);
        continue;
      }

      const reason = result.status === 'rejected'
        ? result.reason
        : new Error('fetch returned empty result');

      if (spec.required) {
        throw new AssetLoadError(
          `Required font "${spec.family}" (${spec.weight} ${spec.style}) failed to load: ${describeError(reason)}`,
          {
            code: AssetErrorCode.REQUIRED_FONT_MISSING,
            family: spec.family,
            weight: spec.weight,
            style: spec.style,
            url: spec.url
          }
        );
      }

      // Optional font — record and continue.
      missingFontKeys.add(key);
      warn(
        `Optional font missing: ${spec.family} ${spec.weight} ${spec.style} ` +
        `(${spec.scripts.join(', ')}) — ${describeError(reason)}`
      );
    }

    // ── Phase 4: atomically mark loaded ──────────────────────────────────
    loaded = true;
  })();

  // Wrap so that on failure, loadPromise is cleared for the next attempt.
  loadPromise = p.catch(err => {
    loadPromise = null;
    // Clear partial state for a clean retry.
    logoBase64 = '';
    qrBase64   = '';
    fontBytesMap.clear();
    missingFontKeys.clear();
    throw err;
  });

  return loadPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Public API: synchronous getters
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Return the logo's base64 payload (no `data:` prefix).
 * Files 5/6 wrap this into a data URI when emitting Typst.
 *
 * @returns {string}
 * @throws {AssetLoadError} if loadAssets() has not resolved yet.
 */
export function getLogoBase64() {
  assertLoaded('getLogoBase64');
  return logoBase64;
}

/**
 * Return the QR code's base64 payload (no `data:` prefix).
 *
 * @returns {string}
 * @throws {AssetLoadError} if loadAssets() has not resolved yet.
 */
export function getQrBase64() {
  assertLoaded('getQrBase64');
  return qrBase64;
}

/**
 * Return the frozen font manifest. Available at any time — the manifest is
 * static metadata and does not depend on loadAssets() having run.
 *
 * @returns {ReadonlyArray<Readonly<FontSpec>>}
 */
export function getFontManifest() {
  return FONT_MANIFEST;
}

/**
 * Return the binary bytes of a specific font, or null if the font was not
 * loaded (because it was optional and its fetch failed).
 *
 * Note: File 8 (the worker) does not call this — workers do not share module
 * state with the main thread, so the worker re-fetches fonts itself using
 * getFontManifest(). This export exists so main-thread code can inspect the
 * loaded bytes and so future non-worker renderers can access them without
 * re-implementing the loader.
 *
 * @param {string} family
 * @param {number} [weight=400]
 * @param {string} [style='normal']
 * @returns {ArrayBuffer|null}
 * @throws {AssetLoadError} if loadAssets() has not resolved yet.
 */
export function getFontBytes(family, weight = 400, style = 'normal') {
  assertLoaded('getFontBytes');
  return fontBytesMap.get(fontKey(family, weight, style)) || null;
}

/**
 * Return the set of font keys that were successfully loaded.
 * Keys are in the form `${family}|${weight}|${style}`.
 *
 * Diagnostic only — intended for tests, health checks, and support tooling.
 *
 * @returns {string[]}
 * @throws {AssetLoadError} if loadAssets() has not resolved yet.
 */
export function getLoadedFontKeys() {
  assertLoaded('getLoadedFontKeys');
  return Array.from(fontBytesMap.keys()).sort();
}

/**
 * Return the set of font keys that failed to load and were non-fatal
 * (i.e. marked `required: false` in the manifest). An empty array means
 * every optional font was available.
 *
 * Diagnostic only — intended for tests, health checks, and support tooling.
 *
 * @returns {string[]}
 * @throws {AssetLoadError} if loadAssets() has not resolved yet.
 */
export function getMissingFontKeys() {
  assertLoaded('getMissingFontKeys');
  return Array.from(missingFontKeys).sort();
}

/**
 * Diagnostic: has loadAssets() completed successfully?
 * @returns {boolean}
 */
export function isLoaded() {
  return loaded;
}

/**
 * The family name of the required body font. Files 4 and 5 import this to
 * guarantee their `#set text(font: "...")` declarations match what File 8
 * registers with WASM.
 *
 * @returns {string}
 */
export function getDefaultBodyFamily() {
  return DEFAULT_BODY_FAMILY;
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Internal: key builder & assertion
// ═══════════════════════════════════════════════════════════════════════════

function fontKey(family, weight, style) {
  return `${family}|${weight}|${style}`;
}

function assertLoaded(caller) {
  if (!loaded) {
    throw new AssetLoadError(
      `${caller}() called before loadAssets() resolved`,
      { code: AssetErrorCode.NOT_LOADED, caller }
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Internal: fetchers
// ═══════════════════════════════════════════════════════════════════════════

async function fetchRasterAsset(path) {
  const text = await fetchText(path, FETCH_TIMEOUT_MS);
  const cleaned = cleanBase64(text);

  if (!cleaned) {
    throw new AssetLoadError(
      `Base64 payload from ${path} is empty after cleaning`,
      { code: AssetErrorCode.INVALID_DATA, path }
    );
  }

  const detected = detectImageType(cleaned);
  if (!detected) {
    throw new AssetLoadError(
      `Base64 payload from ${path} is not a valid PNG, JPEG, or WebP image`,
      { code: AssetErrorCode.INVALID_DATA, path }
    );
  }

  return cleaned;
}

async function fetchFontAsset(spec) {
  // fetchArrayBuffer already rejects with AssetLoadError on any failure.
  // Let the caller decide whether the failure is fatal.
  return fetchArrayBuffer(spec.url, FETCH_TIMEOUT_MS);
}

async function fetchText(path, timeoutMs) {
  const url = resolveAssetUrl(path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });

    if (!resp.ok) {
      throw new AssetLoadError(
        `HTTP ${resp.status} fetching ${url}`,
        { code: AssetErrorCode.NETWORK, url, status: resp.status }
      );
    }

    return await resp.text();
  } catch (err) {
    if (err instanceof AssetLoadError) throw err;
    if (err && err.name === 'AbortError') {
      throw new AssetLoadError(
        `Timeout after ${timeoutMs}ms fetching ${url}`,
        { code: AssetErrorCode.TIMEOUT, url, timeoutMs }
      );
    }
    throw new AssetLoadError(
      `Network error fetching ${url}: ${describeError(err)}`,
      { code: AssetErrorCode.NETWORK, url }
    );
  } finally {
    clearTimeout(timer);
  }
}

async function fetchArrayBuffer(path, timeoutMs) {
  const url = resolveAssetUrl(path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: ctrl.signal });

    if (!resp.ok) {
      throw new AssetLoadError(
        `HTTP ${resp.status} fetching ${url}`,
        { code: AssetErrorCode.NETWORK, url, status: resp.status }
      );
    }

    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength === 0) {
      throw new AssetLoadError(
        `Empty response body from ${url}`,
        { code: AssetErrorCode.INVALID_DATA, url }
      );
    }

    return buf;
  } catch (err) {
    if (err instanceof AssetLoadError) throw err;
    if (err && err.name === 'AbortError') {
      throw new AssetLoadError(
        `Timeout after ${timeoutMs}ms fetching ${url}`,
        { code: AssetErrorCode.TIMEOUT, url, timeoutMs }
      );
    }
    throw new AssetLoadError(
      `Network error fetching ${url}: ${describeError(err)}`,
      { code: AssetErrorCode.NETWORK, url }
    );
  } finally {
    clearTimeout(timer);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Internal: base64 cleaning & image detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize a raw base64 string:
 *   • Strip a leading BOM (some editors add one when saving text files).
 *   • Strip PEM headers/footers if present (harmless when absent).
 *   • Remove every whitespace character (base64 files often wrap at 76 cols).
 *   • Drop any character not in the base64 alphabet (defensive).
 */
function cleanBase64(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return '';

  let s = raw;

  // Strip UTF-8 BOM.
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

  // Strip PEM envelopes if present.
  s = s.replace(/-----BEGIN [^-]+-----/g, '');
  s = s.replace(/-----END [^-]+-----/g, '');

  // Remove all whitespace.
  s = s.replace(/\s+/g, '');

  // If any non-base64 characters remain, drop them.
  if (!/^[A-Za-z0-9+/=]*$/.test(s)) {
    s = s.replace(/[^A-Za-z0-9+/=]/g, '');
  }

  return s;
}

/**
 * Inspect the first bytes of a base64 payload to determine whether it is a
 * valid PNG, JPEG, or WebP image. Returns null if none of those magic
 * numbers match — which is how a 404 HTML page served with a 200 status
 * (and then happily base64-encoded by a broken pipeline) gets rejected
 * instead of being embedded as a corrupt image.
 *
 * @returns {'png'|'jpeg'|'webp'|null}
 */
function detectImageType(b64) {
  if (!b64 || b64.length < 12) return null;

  // Decode just enough to see the first ~18 bytes.
  const headChars = Math.min(24, b64.length);
  let head = '';

  try {
    head = decodeBase64Slice(b64, headChars);
  } catch {
    return null;
  }

  if (head.length < 4) return null;

  const b0 = head.charCodeAt(0);
  const b1 = head.charCodeAt(1);
  const b2 = head.charCodeAt(2);
  const b3 = head.charCodeAt(3);

  // PNG: \x89 P N G
  if (b0 === 0x89 && b1 === 0x50 && b2 === 0x4E && b3 === 0x47) return 'png';

  // JPEG: \xFF \xD8 \xFF
  if (b0 === 0xFF && b1 === 0xD8 && b2 === 0xFF) return 'jpeg';

  // WebP: R I F F ... W E B P
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) {
    if (head.length >= 12) {
      const w0 = head.charCodeAt(8);
      const w1 = head.charCodeAt(9);
      const w2 = head.charCodeAt(10);
      const w3 = head.charCodeAt(11);
      if (w0 === 0x57 && w1 === 0x45 && w2 === 0x42 && w3 === 0x50) return 'webp';
    }
  }

  return null;
}

/**
 * Portable base64 decoder — works in browsers (atob) and Node.js (Buffer).
 * Decodes only the first N base64 characters; the caller only needs the
 * magic-number prefix, so decoding the whole payload is wasteful.
 */
function decodeBase64Slice(b64, charCount) {
  const slice = b64.slice(0, charCount);

  if (typeof atob === 'function') {
    return atob(slice);
  }

  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(slice, 'base64').toString('binary');
  }

  throw new Error('No base64 decoder available in this environment');
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. Internal: logging helpers
// ═══════════════════════════════════════════════════════════════════════════

const WARN_PREFIX = '[pdf-engine/assets]';

function warn(message) {
  // Warnings surface by default because they indicate degraded output
  // (missing logo, missing script font) worth seeing in the console.
  try {
    console.warn(WARN_PREFIX, message);
  } catch {
    // Some exotic environments lack console.warn; ignore.
  }
}

function describeError(err) {
  if (!err) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  try {
    return String(err);
  } catch {
    return 'unprintable error';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. Ready
// ═══════════════════════════════════════════════════════════════════════════

// No side effects on module load — nothing is fetched until loadAssets()
// is explicitly called by File 1. This keeps the module pure and testable.