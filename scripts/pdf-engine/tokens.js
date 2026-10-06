/**
 * MedVix Unified PDF Engine v7.0
 * File 4 of 8 — Design System Tokens & Style Variables
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The single source of truth for every visual constant the PDF engine uses:
 * colors, font families, size scale, spacing scale, radii, borders, page
 * geometry, and document metadata. Nothing visual lives outside this file.
 *
 * Downstream usage
 * ────────────────
 *   File 5 (base-template) → references tokens in `#set page(...)`,
 *                            `#set text(...)`, watermark, header, footer.
 *   File 6 (components)    → references tokens in cards, notices, tables,
 *                            MCQ bubbles, dividers, feature grids.
 *   File 7 (compiler)      → prepends renderTypstTokens() to every document.
 *
 * Public API
 * ──────────
 *   TOKENS                          frozen canonical object
 *   TOKEN_GROUPS                    ordered category metadata (for docs + emitter)
 *   renderTypstTokens(theme?)       Typst `#let` declaration block
 *   renderCssTokens(theme?)         CSS `:root` custom-property block
 *   getToken(typstName)             lookup by kebab-case Typst name
 *   getTokenGroups()                frozen category metadata
 *   pxToPt(px)                      px → pt converter (0.75 factor)
 *   hexToRgb(hex)                   '#RRGGBB' → { r, g, b }
 *   formatPt(px)                    px → "12pt" / "28.5pt" formatted string
 *   DEFAULT_THEME                   'light'
 *   SUPPORTED_THEMES                frozen array of theme names
 *
 * Guarantees
 * ──────────
 *   • Pure          — no DOM, no fetch, no side effects after load.
 *   • Deterministic — fixed iteration order → byte-identical emitted Typst.
 *   • Validated     — every color matches /^#[0-9a-f]{6}$/; every numeric
 *                     token is finite; watermark opacity is 0..1. Malformed
 *                     tokens throw at module load (fail-fast at build time).
 *   • Frozen        — the tokens object and all category metadata are frozen.
 *   • Sync-safe     — font family names come from File 3's manifest, so
 *                     File 4 and File 8 can never disagree on the spelling.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getDefaultBodyFamily, getFontManifest } from './assets.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Constants
// ═══════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[pdf-engine/tokens]';

/** CSS pixels to PDF points at 96 DPI (1 in = 96 px = 72 pt). */
const PX_TO_PT = 0.75;

/** Only 'light' ships in v1. The parameter exists so v2 can add 'dark' etc. */
export const DEFAULT_THEME = 'light';
export const SUPPORTED_THEMES = Object.freeze([DEFAULT_THEME]);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Font family resolution (drift-proof)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The family name of the required body font, imported directly from File 3's
 * manifest. Any change to the manifest propagates here automatically, which
 * eliminates the "File 4 says Inter, File 8 registered inter" bug class.
 */
const FONT_BODY_FAMILY = getDefaultBodyFamily();

/**
 * Ordered list of every family registered in File 3's manifest. Used to build
 * the Typst font fallback tuple so scripts not covered by the primary font
 * (Arabic, Devanagari, Thai) resolve to the correct registered font rather
 * than to Typst's built-in default.
 */
function computeFontFallbackList() {
  const families = [];
  const seen = new Set();
  for (const spec of getFontManifest()) {
    if (!seen.has(spec.family)) {
      seen.add(spec.family);
      families.push(spec.family);
    }
  }
  // Guarantee the primary body font is first even if the manifest ordering changes.
  const idx = families.indexOf(FONT_BODY_FAMILY);
  if (idx > 0) {
    families.splice(idx, 1);
    families.unshift(FONT_BODY_FAMILY);
  }
  return Object.freeze(families);
}

const FONT_FALLBACK_LIST = computeFontFallbackList();

// ═══════════════════════════════════════════════════════════════════════════
// 3. Canonical tokens
// ═══════════════════════════════════════════════════════════════════════════
//
// Naming conventions
// ──────────────────
//   • camelCase keys with a unit suffix when the value is numeric:
//       `fontSizeXlPx`  → px
//       `pageWidthMm`   → mm
//       `watermarkRotationDeg` → degrees
//   • Colors are lowercase 6-digit hex strings with a leading '#'. 8-digit
//     RGBA is forbidden (Typst does not parse it).
//   • Line heights are unitless multipliers.
//   • Watermark opacity is a decimal in [0, 1], paired with `watermarkColor`
//     by the emitter to build a single 4-argument `rgb()` call.
//
// The emitter strips the unit suffix and converts camelCase → kebab-case to
// produce the Typst binding name.

export const TOKENS = Object.freeze({

  // ── Colors ──────────────────────────────────────────────────────────────
  // Source: the reference `:root` block. No new colors invented.

  brandPrimary:        '#1976d2',
  brandPrimaryDark:    '#125ca8',
  brandPrimaryLight:   '#e3f0fd',

  textHeading:         '#1f2937',
  textBody:            '#374151',
  textMuted:           '#64748b',
  textLight:           '#94a3b8',

  bgPage:              '#ffffff',
  bgLight:             '#f7f9fc',
  bgLightAlt:          '#f8fafc',

  borderLight:         '#e2e8f0',
  borderDivider:       '#1976d2',   // == brandPrimary in the reference

  cardBg:              '#f7f9fc',   // == bgLight
  cardBorder:          '#e2e8f0',   // == borderLight
  noticeBg:            '#f7f9fc',   // == bgLight

  accentCyan:          '#0ae6e6',   // exam MCQ option markers

  watermarkColor:      '#000000',   // paired with watermarkOpacity below

  // ── Typography ──────────────────────────────────────────────────────────

  fontBody:            FONT_BODY_FAMILY,     // from File 3's manifest
  fontHeading:         FONT_BODY_FAMILY,     // same as body in v1

  fontSizeXlPx:        38,
  fontSizeLgPx:        28,
  fontSizeMdPx:        20,
  fontSizeBasePx:      16,
  fontSizeSmPx:        14,
  fontSizeXsPx:        12,

  fontWeightRegular:   400,
  fontWeightBold:      700,

  lineHeightBody:      1.6,
  lineHeightHeading:   1.3,

  // ── Spacing (px) ────────────────────────────────────────────────────────

  spaceXsPx:           10,
  spaceSmPx:           14,
  spaceMdPx:           20,
  spaceLgPx:           28,
  spaceXlPx:           44,

  // ── Geometry ────────────────────────────────────────────────────────────

  cardRadiusPx:        12,
  dividerHeightPx:     3,

  borderWidthHairlinePx: 0.5,
  borderWidthStandardPx: 1,
  borderWidthThickPx:    2,

  noticeBorderLeftPx:  5,

  watermarkRotationDeg: -30,
  watermarkOpacity:     0.05,

  // ── Layout (page geometry, mm) ──────────────────────────────────────────
  // A4 portrait. Top margin reserves the header; bottom margin reserves the
  // footer. Margins are asymmetric by design so the header/footer cannot
  // collide with body content on any page.

  pageWidthMm:          210,
  pageHeightMm:         297,

  pageMarginXMm:        25,
  pageMarginTopMm:      35,
  pageMarginBottomMm:   25,

  // ── Metadata (PDF /Info dictionary) ─────────────────────────────────────

  producer:             'MedVix PDF Engine v7.0',
  creator:              'MedVix',
  language:             'en-US',
  pageSize:             'a4'
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Token groups (ordered categories)
// ═══════════════════════════════════════════════════════════════════════════
//
// The emitter walks this list. Adding a token requires adding its key to the
// correct group here AND adding the value to TOKENS above. A validation pass
// at module load catches mismatches in either direction.

const TOKEN_GROUPS = Object.freeze([
  Object.freeze({
    label: 'Colors',
    keys: Object.freeze([
      'brandPrimary', 'brandPrimaryDark', 'brandPrimaryLight',
      'textHeading', 'textBody', 'textMuted', 'textLight',
      'bgPage', 'bgLight', 'bgLightAlt',
      'borderLight', 'borderDivider',
      'cardBg', 'cardBorder', 'noticeBg',
      'accentCyan',
      'watermarkColor'
    ])
  }),
  Object.freeze({
    label: 'Typography',
    keys: Object.freeze([
      'fontBody', 'fontHeading',
      'fontSizeXlPx', 'fontSizeLgPx', 'fontSizeMdPx',
      'fontSizeBasePx', 'fontSizeSmPx', 'fontSizeXsPx',
      'fontWeightRegular', 'fontWeightBold',
      'lineHeightBody', 'lineHeightHeading'
    ])
  }),
  Object.freeze({
    label: 'Spacing',
    keys: Object.freeze([
      'spaceXsPx', 'spaceSmPx', 'spaceMdPx', 'spaceLgPx', 'spaceXlPx'
    ])
  }),
  Object.freeze({
    label: 'Geometry',
    keys: Object.freeze([
      'cardRadiusPx', 'dividerHeightPx',
      'borderWidthHairlinePx', 'borderWidthStandardPx', 'borderWidthThickPx',
      'noticeBorderLeftPx',
      'watermarkRotationDeg', 'watermarkOpacity'
    ])
  }),
  Object.freeze({
    label: 'Layout',
    keys: Object.freeze([
      'pageWidthMm', 'pageHeightMm',
      'pageMarginXMm', 'pageMarginTopMm', 'pageMarginBottomMm'
    ])
  }),
  Object.freeze({
    label: 'Metadata',
    keys: Object.freeze([
      'producer', 'creator', 'language', 'pageSize'
    ])
  })
]);

export function getTokenGroups() {
  return TOKEN_GROUPS;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Validation (fail-fast at module load)
// ═══════════════════════════════════════════════════════════════════════════
//
// Every mistake here is a programming error, not a data error. Throwing at
// import time turns "the PDF renders with the wrong blue" (a bug discovered
// weeks later) into "the app refused to start, here is the exact token and
// the exact problem" (a bug discovered on the next `npm run dev`).

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/;
const UNIT_SUFFIX_RE = /(Px|Mm|Deg)$/;

function validateTokens() {
  const errors = [];

  // ── Every key listed in TOKEN_GROUPS exists in TOKENS. ─────────────────
  const groupedKeys = new Set();
  for (const group of TOKEN_GROUPS) {
    for (const key of group.keys) {
      if (groupedKeys.has(key)) {
        errors.push(`duplicate key "${key}" appears in multiple groups`);
      }
      groupedKeys.add(key);
      if (!Object.prototype.hasOwnProperty.call(TOKENS, key)) {
        errors.push(`group "${group.label}" references missing token "${key}"`);
      }
    }
  }

  // ── Every key in TOKENS is listed in exactly one group. ────────────────
  for (const key of Object.keys(TOKENS)) {
    if (!groupedKeys.has(key)) {
      errors.push(`token "${key}" is defined but not assigned to any group`);
    }
  }

  // ── Per-token shape validation. ────────────────────────────────────────
  for (const [key, value] of Object.entries(TOKENS)) {
    if (typeof value === 'string') {
      if (value.startsWith('#')) {
        if (!HEX_COLOR_RE.test(value)) {
          errors.push(`color "${key}" = ${JSON.stringify(value)} must match /^#[0-9a-f]{6}$/`);
        }
      } else if (value === '') {
        errors.push(`string token "${key}" is empty`);
      }
      continue;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        errors.push(`numeric token "${key}" = ${value} must be finite`);
        continue;
      }
      if (UNIT_SUFFIX_RE.test(key)) {
        // Lengths may be negative for the rotation, but 0 or positive for
        // everything else. Only the watermark rotation is allowed negative.
        if (value < 0 && key !== 'watermarkRotationDeg') {
          errors.push(`length token "${key}" = ${value} must be non-negative`);
        }
      }
      // Special-case opacity range.
      if (key === 'watermarkOpacity' && (value < 0 || value > 1)) {
        errors.push(`"watermarkOpacity" = ${value} must be in [0, 1]`);
      }
      continue;
    }

    errors.push(`token "${key}" has unsupported type "${typeof value}"`);
  }

  // ── Font family sanity. ────────────────────────────────────────────────
  if (typeof TOKENS.fontBody !== 'string' || TOKENS.fontBody.trim() === '') {
    errors.push('fontBody must be a non-empty string');
  }
  if (!FONT_FALLBACK_LIST.includes(TOKENS.fontBody)) {
    errors.push(
      `fontBody "${TOKENS.fontBody}" is not present in File 3's font manifest ` +
      `(available: ${FONT_FALLBACK_LIST.join(', ')})`
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `${LOG_PREFIX} Invalid design tokens:\n` +
      errors.map(e => '  • ' + e).join('\n')
    );
  }
}

validateTokens();

// ═══════════════════════════════════════════════════════════════════════════
// 6. Ad-hoc converters (for File 6 components that need them)
// ═══════════════════════════════════════════════════════════════════════════

/** CSS px → PDF pt (0.75 factor, 96 DPI). */
export function pxToPt(px) {
  return Number(px) * PX_TO_PT;
}

/** Format a px value as a Typst length string. Rounds to 0.5pt for cleanliness. */
export function formatPt(px) {
  const pt = Math.round(pxToPt(px) * 2) / 2;
  return `${pt}pt`;
}

/** Parse '#RRGGBB' into { r, g, b }. */
export function hexToRgb(hex) {
  const h = String(hex).replace(/^#/, '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Name derivation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Derive the Typst binding name from a camelCase token key.
 *   `fontSizeXlPx`     → `font-size-xl`
 *   `pageWidthMm`      → `page-width`
 *   `watermarkRotationDeg` → `watermark-rotation`
 *   `brandPrimary`     → `brand-primary`
 */
function typstNameFromKey(key) {
  const stripped = key.replace(UNIT_SUFFIX_RE, '');
  return stripped.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Cache the mapping once for both getToken() and both emitters.
const KEY_TO_TYPST_NAME = Object.freeze(
  Object.keys(TOKENS).reduce((acc, key) => {
    acc[key] = typstNameFromKey(key);
    return acc;
  }, {})
);

const TYPST_NAME_TO_KEY = Object.freeze(
  Object.entries(KEY_TO_TYPST_NAME).reduce((acc, [key, name]) => {
    acc[name] = key;
    return acc;
  }, {})
);

/**
 * Look up a token by its Typst-style kebab-case name.
 * Returns undefined if the name is unknown.
 *
 * @example getToken('brand-primary')  // → '#1976d2'
 */
export function getToken(typstName) {
  const key = TYPST_NAME_TO_KEY[typstName];
  return key ? TOKENS[key] : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Typst emission
// ═══════════════════════════════════════════════════════════════════════════

const TYPST_KEY_PAD = 26;

function formatTypstValue(key, value) {
  // Watermark color + opacity pair → emit as a single 4-argument rgb().
  if (key === 'watermarkColor' && typeof TOKENS.watermarkOpacity === 'number') {
    const { r, g, b } = hexToRgb(value);
    return `rgb(${r}, ${g}, ${b}, ${TOKENS.watermarkOpacity})`;
  }

  // Skip the paired opacity token — it is folded into watermarkColor above.
  if (key === 'watermarkOpacity') {
    return null;
  }

  // Font family → wrap in a tuple with script-specific fallbacks.
  if (key === 'fontBody' || key === 'fontHeading') {
    const quoted = FONT_FALLBACK_LIST.map(f => '"' + f.replace(/"/g, '\\"') + '"');
    return '(' + quoted.join(', ') + ')';
  }

  if (typeof value === 'number') {
    if (key.endsWith('Px'))  return formatPt(value);
    if (key.endsWith('Mm'))  return `${value}mm`;
    if (key.endsWith('Deg')) return `${value}deg`;
    return String(value);
  }

  if (typeof value === 'string') {
    if (value.startsWith('#')) {
      const { r, g, b } = hexToRgb(value);
      return `rgb(${r}, ${g}, ${b})`;
    }
    return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  throw new Error(`${LOG_PREFIX} unsupported token value for "${key}"`);
}

function assertTheme(theme) {
  if (!SUPPORTED_THEMES.includes(theme)) {
    throw new Error(
      `${LOG_PREFIX} unknown theme "${theme}" ` +
      `(supported: ${SUPPORTED_THEMES.join(', ')})`
    );
  }
}

/**
 * Emit the complete Typst `#let` declaration block for the given theme.
 * Files 5–7 prepend the returned string to every generated document.
 *
 * @param {string} [theme='light']
 * @returns {string}
 */
export function renderTypstTokens(theme = DEFAULT_THEME) {
  assertTheme(theme);

  const lines = [];
  lines.push('// ─────────────────────────────────────────────────────────────');
  lines.push('// MedVix Design Tokens — auto-generated from tokens.js');
  lines.push('// Do not edit by hand; the source of truth lives in tokens.js');
  lines.push('// ─────────────────────────────────────────────────────────────');
  lines.push('');

  // Track which keys have already been emitted so the watermark pairing
  // does not emit `watermark-opacity` a second time.
  const emitted = new Set();

  for (const group of TOKEN_GROUPS) {
    lines.push(`// ── ${group.label} ${'─'.repeat(Math.max(0, 46 - group.label.length))}`);

    for (const key of group.keys) {
      if (emitted.has(key)) continue;
      emitted.add(key);

      const value = TOKENS[key];
      const formatted = formatTypstValue(key, value);
      if (formatted === null) continue;

      // Emitting `fontHeading` as an alias when it equals `fontBody`.
      if (key === 'fontHeading' && TOKENS.fontHeading === TOKENS.fontBody) {
        lines.push(`#let ${'font-heading'.padEnd(TYPST_KEY_PAD)} = font-body`);
        continue;
      }

      const name = KEY_TO_TYPST_NAME[key];
      lines.push(`#let ${name.padEnd(TYPST_KEY_PAD)} = ${formatted}`);
    }

    lines.push('');
  }

  lines.push('// ── End of tokens ────────────────────────────────────────────');
  lines.push('');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. CSS emission (for keeping :root in sync)
// ═══════════════════════════════════════════════════════════════════════════
//
// Optional. Generates the `:root` block that a build step (or a runtime
// injector) writes into the app's stylesheet. Because it is derived from
// the same TOKENS object that File 4 emits for Typst, the CSS and PDF
// engine cannot drift.

function formatCssValue(key, value) {
  // Watermark color + opacity pair → a single rgba() declaration.
  if (key === 'watermarkColor' && typeof TOKENS.watermarkOpacity === 'number') {
    const { r, g, b } = hexToRgb(value);
    return `rgba(${r}, ${g}, ${b}, ${TOKENS.watermarkOpacity})`;
  }
  if (key === 'watermarkOpacity') return null;

  if (key === 'fontBody' || key === 'fontHeading') {
    return FONT_FALLBACK_LIST.map(f => `'${f.replace(/'/g, "\\'")}'`).join(', ');
  }

  if (typeof value === 'number') {
    if (key.endsWith('Px'))  return `${value}px`;
    if (key.endsWith('Mm'))  return `${value}mm`;
    if (key.endsWith('Deg')) return `${value}deg`;
    return String(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  throw new Error(`${LOG_PREFIX} unsupported token value for CSS "${key}"`);
}

/**
 * Emit a CSS `:root { --token-name: value; ... }` block for the given theme.
 * Every custom property is prefixed with `--` and uses the same kebab-case
 * name the Typst emitter uses, so CSS authors and Typst authors see the
 * same vocabulary.
 *
 * @param {string} [theme='light']
 * @returns {string}
 */
export function renderCssTokens(theme = DEFAULT_THEME) {
  assertTheme(theme);

  const lines = [];
  lines.push('/* MedVix Design Tokens — auto-generated from tokens.js */');
  lines.push('/* Do not edit by hand; the source of truth lives in tokens.js */');
  lines.push(':root {');

  const emitted = new Set();
  let lastGroupLabel = '';

  for (const group of TOKEN_GROUPS) {
    for (const key of group.keys) {
      if (emitted.has(key)) continue;
      emitted.add(key);

      const value = TOKENS[key];
      const formatted = formatCssValue(key, value);
      if (formatted === null) continue;

      // Group separator comment for readability.
      if (group.label !== lastGroupLabel) {
        lines.push('');
        lines.push(`  /* ── ${group.label} ── */`);
        lastGroupLabel = group.label;
      }

      // Reuse the same padding as the Typst emitter for a familiar look.
      const name = '--' + KEY_TO_TYPST_NAME[key];
      const pad = Math.max(1, 26 - name.length);
      lines.push(`  ${name}:${' '.repeat(pad)}${formatted};`);
    }
  }

  lines.push('}');
  lines.push('');

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Ready
// ═══════════════════════════════════════════════════════════════════════════

// No logging, no side effects beyond the validation pass above. Every getter
// and emitter is pure and deterministic.