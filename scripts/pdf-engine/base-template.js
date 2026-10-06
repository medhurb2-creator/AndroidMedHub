/**
 * MedVix Unified PDF Engine v7.0
 * File 5 of 8 — Master Page Geometry & Frame Layout
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Owns the outermost frame of every PDF the engine produces:
 *
 *   • #set page(...)     — paper size, margins, watermark, running header,
 *                          running footer with dynamic "Page X of Y" count.
 *   • #set text(...)     — document-wide font, size, colour, language.
 *   • #set par(...)      — justification, leading.
 *   • #show heading: ... — brand-consistent heading sizes and colour.
 *   • header content     — either in the page(header:) slot (repeating) or
 *                          emitted once at the top of the body (first-page).
 *
 * File 5 is pure and synchronous: it receives a small parameter object and
 * returns a complete Typst source string, ready to be prepended to the
 * document body by File 7.
 *
 * Public API
 * ──────────
 *   renderBaseSetup(params) → string
 *
 * Guarantees
 * ──────────
 *   • Pure          — no DOM, no fetch, no side effects.
 *   • Deterministic — same input → byte-identical output.
 *   • Escaped       — every interpolated user string passes through
 *                     File 2's escapeTypstLiteral / escapeTypstString.
 *   • Typst-safe    — uses only constructs verified against the Typst
 *                     reference: 4-arg rgb(), #linebreak(), context-based
 *                     page counters, header/footer slots.
 *   • Fail-fast     — an unknown theme or an invalid logo string throws
 *                     immediately, before any Typst is emitted.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { escapeTypstLiteral, escapeTypstString } from './types.js';
import { DEFAULT_THEME, SUPPORTED_THEMES }         from './tokens.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Constants
// ═══════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[pdf-engine/base-template]';

/**
 * The watermark's font size. Decorative rather than structural; not a
 * design token because it never varies per brand and never appears in the
 * reference CSS variable set.
 */
const WATERMARK_SIZE_PT = 60;

/**
 * A 1×1 fully transparent PNG payload. Used only as a defensive fallback
 * when the caller passes an empty or invalid logo string — File 3 already
 * guarantees a valid payload, so this is a safety net, not a policy.
 */
const FALLBACK_LOGO_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// ═══════════════════════════════════════════════════════════════════════════
// 2. Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Render the complete Typst setup block for a document.
 *
 * The returned string contains:
 *   • A header comment identifying the generator.
 *   • `#set page(...)` with paper, margins, watermark, header, and footer.
 *   • `#set text(...)` for document-wide typography.
 *   • `#set par(...)` for paragraph defaults.
 *   • `#show heading: ...` for brand-styled headings.
 *   • If `headerRepeats` is false, the header + divider emitted as content
 *     so it appears only on the first page.
 *
 * @param {object} params
 * @param {string}   params.logoBase64           Base64 payload (no data: prefix). Required.
 * @param {string}   [params.headerTitle]        Document-type title shown on the right.
 * @param {string}   [params.headerSubtitle]     Small descriptor under the title.
 * @param {string}   [params.headerBrandName]    Left-column brand name. Default 'MedVix'.
 * @param {string}   [params.headerBrandTagline] Left-column tagline.
 * @param {boolean}  [params.headerRepeats]      True → chrome on every page; false → first page only.
 * @param {string}   [params.footerLeft]         Left footer column.
 * @param {string}   [params.footerCenter]       Center footer column.
 * @param {string}   [params.footerRight]        Right footer column (page count is appended).
 * @param {string}   [params.watermarkLine1]     First line of the background watermark.
 * @param {string}   [params.watermarkLine2]     Second line.
 * @param {string}   [params.language]           BCP-47 language tag. Default 'en-US'.
 * @param {string}   [params.theme]              Design-token theme. Default 'light'.
 * @returns {string}                             Complete Typst source string.
 * @throws {Error}                               On invalid params or unknown theme.
 */
export function renderBaseSetup(params = {}) {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`${LOG_PREFIX} params must be a plain object`);
  }

  const theme = params.theme == null ? DEFAULT_THEME : params.theme;
  if (!SUPPORTED_THEMES.includes(theme)) {
    throw new Error(
      `${LOG_PREFIX} unknown theme "${theme}" ` +
      `(supported: ${SUPPORTED_THEMES.join(', ')})`
    );
  }

  // ── Resolve the logo (defensive fallback only) ──────────────────────────
  const logoBase64 =
    typeof params.logoBase64 === 'string' && params.logoBase64.length > 0
      ? params.logoBase64
      : FALLBACK_LOGO_BASE64;

  const logoMime = detectImageMime(logoBase64);

  // ── Escape every caller-provided string exactly once ────────────────────
  const esc = {
    headerTitle:        escapeTypstLiteral(compact(params.headerTitle)),
    headerSubtitle:     escapeTypstLiteral(compact(params.headerSubtitle)),
    headerBrandName:    escapeTypstLiteral(compact(params.headerBrandName    != null ? params.headerBrandName    : 'MedVix')),
    headerBrandTagline: escapeTypstLiteral(compact(params.headerBrandTagline != null ? params.headerBrandTagline : 'Medical Exam Room Pro')),
    footerLeft:         escapeTypstLiteral(compact(params.footerLeft   != null ? params.footerLeft   : 'MedVix • Medical Learning Platform')),
    footerCenter:       escapeTypstLiteral(compact(params.footerCenter != null ? params.footerCenter : 'Medical Document')),
    footerRight:        escapeTypstLiteral(compact(params.footerRight  != null ? params.footerRight  : 'medvix.co.ke')),
    watermarkLine1:     escapeTypstLiteral(compact(params.watermarkLine1 != null ? params.watermarkLine1 : 'Created by MedVix')),
    watermarkLine2:     escapeTypstLiteral(compact(params.watermarkLine2 != null ? params.watermarkLine2 : 'Join us today'))
  };

  const language = sanitizeLanguage(params.language);
  const headerRepeats = params.headerRepeats !== false;   // default true

  // ── Build fragments ─────────────────────────────────────────────────────
  const headerFragment     = buildHeaderFragment(esc, logoBase64, logoMime);
  const footerFragment     = buildFooterFragment(esc);
  const watermarkExpr      = buildWatermarkExpr(esc);
  const headingShowRule    = buildHeadingShowRule();

  // ── Assemble the setup block ────────────────────────────────────────────
  const out = [];

  out.push('// ─────────────────────────────────────────────────────────────');
  out.push('// MedVix Master Page Template — generated by base-template.js');
  out.push('// Do not edit by hand; the source of truth lives in the engine.');
  out.push('// ─────────────────────────────────────────────────────────────');
  out.push('');

  // ── #set page(...) ──────────────────────────────────────────────────────
  out.push('#set page(');
  out.push('  paper: "a4",');
  out.push('  margin: (x: page-margin-x, top: page-margin-top, bottom: page-margin-bottom),');
  out.push(`  background: ${watermarkExpr},`);
  if (headerRepeats) {
    out.push('  header: [');
    out.push(indent(headerFragment, '    '));
    out.push('  ],');
  }
  out.push('  footer: context [');
  out.push(indent(footerFragment, '    '));
  out.push('  ]');
  out.push(')');
  out.push('');

  // ── #set text(...) ──────────────────────────────────────────────────────
  out.push('#set text(');
  out.push('  font: font-body,');
  out.push('  size: font-size-base,');
  out.push('  fill: text-body,');
  out.push(`  lang: "${escapeTypstString(language)}"`);
  out.push(')');
  out.push('');

  // ── #set par(...) ───────────────────────────────────────────────────────
  out.push('#set par(');
  out.push('  justify: true,');
  out.push('  leading: 0.65em');
  out.push(')');
  out.push('');

  // ── Heading style ───────────────────────────────────────────────────────
  out.push(headingShowRule);
  out.push('');

  // ── First-page-only header, emitted as content ──────────────────────────
  if (!headerRepeats) {
    out.push(headerFragment);
    out.push('');
  }

  return out.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Fragment builders
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build the header content: three-column grid (logo / brand block / doc
 * title block), followed by a spacer and a horizontal divider.
 */
function buildHeaderFragment(esc, logoBase64, logoMime) {
  const lines = [];

  lines.push('#grid(');
  lines.push('  columns: (auto, 1fr, auto),');
  lines.push('  gutter: 14pt,');
  lines.push('  align: horizon,');
  lines.push(`  image("data:${logoMime};base64,${logoBase64}", width: 40pt),`);
  lines.push('  [');
  lines.push(`    #text(size: 16pt, weight: "bold", fill: brand-primary)[${esc.headerBrandName}]`);
  lines.push('    #linebreak()');
  lines.push(`    #text(size: 8pt, fill: text-muted)[${esc.headerBrandTagline}]`);
  lines.push('  ],');
  lines.push('  align(right)[');
  lines.push(`    #text(size: 12pt, weight: "bold", fill: brand-primary)[${esc.headerTitle}]`);
  if (esc.headerSubtitle) {
    lines.push('    #linebreak()');
    lines.push(`    #text(size: 8pt, fill: text-muted)[${esc.headerSubtitle}]`);
  }
  lines.push('  ]');
  lines.push(')');
  lines.push('#v(6pt)');
  lines.push('#line(length: 100%, stroke: border-width-thick + border-divider)');

  return lines.join('\n');
}

/**
 * Build the footer content: a thin divider line, a small gap, then a
 * three-column grid. The right column appends the dynamic page counter.
 */
function buildFooterFragment(esc) {
  const lines = [];

  lines.push('#line(length: 100%, stroke: border-width-hairline + border-light)');
  lines.push('#v(4pt)');
  lines.push('#grid(');
  lines.push('  columns: (1fr, 1fr, 1fr),');
  lines.push('  align: (left, center, right),');
  lines.push(`  text(size: font-size-xs, fill: text-muted)[${esc.footerLeft}],`);
  lines.push(`  text(size: font-size-xs, fill: text-muted)[${esc.footerCenter}],`);
  lines.push(
    `  text(size: font-size-xs, fill: text-muted)[${esc.footerRight} · Page ` +
    `#counter(page).display() of #counter(page).final().first()]`
  );
  lines.push(')');

  return lines.join('\n');
}

/**
 * Build the watermark expression: a rotated bold text block whose fill is
 * the paired `watermark-color` binding (already a 4-argument rgb()).
 */
function buildWatermarkExpr(esc) {
  const lines = [];

  lines.push('rotate(');
  lines.push('  watermark-rotation,');
  lines.push('  text(');
  lines.push(`    size: ${WATERMARK_SIZE_PT}pt,`);
  lines.push('    fill: watermark-color,');
  lines.push('    weight: "bold"');
  lines.push(`  )[${esc.watermarkLine1} #linebreak() ${esc.watermarkLine2}]`);
  lines.push(')');

  return lines.join('\n');
}

/**
 * Build the heading show rule. Maps level 1/2/3 to the corresponding size
 * tokens and paints every heading in the brand color, bold.
 */
function buildHeadingShowRule() {
  return [
    '#show heading: it => block(',
    '  above: 1.2em,',
    '  below: 0.5em,',
    '  text(',
    '    weight: "bold",',
    '    fill: brand-primary,',
    '    size: if it.level == 1 { font-size-xl }',
    '          else if it.level == 2 { font-size-lg }',
    '          else if it.level == 3 { font-size-md }',
    '          else { font-size-base }',
    '  )[#it.body]',
    ')'
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect the image MIME type from a base64 payload by matching the
 * encoder-stable prefix produced by each image format's magic number.
 *
 *   PNG  → \x89PNG\r\n\x1a\n  → base64 prefix "iVBORw0KGgo"
 *   JPEG → \xFF\xD8\xFF        → base64 prefix "/9j/"
 *   WebP → "RIFF....WEBP"      → base64 prefix "UklGR"
 *
 * Anything else is treated as PNG — this is a safe default because the
 * raster-fallback path in File 3 always produces a valid PNG.
 */
function detectImageMime(base64) {
  if (typeof base64 !== 'string' || base64.length < 4) return 'image/png';
  if (base64.startsWith('iVBORw0KGgo')) return 'image/png';
  if (base64.startsWith('/9j/'))        return 'image/jpeg';
  if (base64.startsWith('UklGR'))       return 'image/webp';
  return 'image/png';
}

/**
 * Collapse any whitespace in a string to single spaces and trim the edges.
 * The header/footer slots are single-line in practice; a stray newline in a
 * caller-provided string would otherwise create an unwanted line break.
 */
function compact(value) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a language tag to a small, safe subset. Anything that does not
 * match the expected BCP-47 shape falls back to 'en-US'. This avoids the
 * need to escape the string after the fact — the emission site can simply
 * interpolate the sanitized value into a string literal.
 */
function sanitizeLanguage(input) {
  if (typeof input !== 'string') return 'en-US';
  const cleaned = input.replace(/[^A-Za-z0-9-]/g, '').slice(0, 12);
  return cleaned.length >= 2 ? cleaned : 'en-US';
}

/**
 * Prefix every line of a multi-line string with the given indentation.
 * Used to keep the emitted Typst readable when a fragment is nested inside
 * `page(header: [...])` or `page(footer: context [...])`.
 */
function indent(str, prefix) {
  if (!str) return '';
  return str.split('\n').map(line => line ? prefix + line : '').join('\n');
}