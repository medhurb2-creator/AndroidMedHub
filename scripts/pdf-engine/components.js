/**
 * MedVix Unified PDF Engine v7.0
 * File 6 of 8 — Modular Typst UI Primitive Components
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The reusable visual vocabulary of the engine. Every card, notice, table,
 * MCQ bubble, metadata cell, chart placeholder, CTA button, and end-page
 * block that appears in any MedVix PDF is defined here as a pure function.
 *
 * Downstream usage
 * ────────────────
 *   File 5 (base-template) → may reuse `brandBar` for the running header.
 *   File 7 (compiler)      → composes components into full documents.
 *
 * Design contract (enforced by convention and tests)
 * ──────────────────────────────────────────────────
 *   • Pure          — no DOM, no I/O, no mutable module state.
 *   • Deterministic — same input → byte-identical output.
 *   • Trusting      — inputs are assumed already sanitized by File 2.
 *   • Content-only  — never emits #set, #let, or #show declarations.
 *   • Non-mutating  — parameter objects are read, never written.
 *   • String-out    — always returns a string; empty string means "nothing".
 *   • Token-driven  — style parameters reference File 4 token names.
 *
 * Public API
 * ──────────
 *   Layout      divider, spacer, pageBreak
 *   Containers  card, noticeBox, insightBox
 *   Content     docTitle, bulletList, numberedList, imageBlock
 *   Metadata    metaCard, metaGrid, metaTable
 *   Tables      topicTable
 *   Domain      questionBlock, answerBlock, mcqRow, mcqGrid
 *   Analytics   chartPlaceholder
 *   End page    featureCard, featureGrid, ctaBlock, qrBlock, endPage
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { escapeTypstLiteral, escapeTypstString } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// 1. Internal helpers
// ═══════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[pdf-engine/components]';

/** Coerce to string, or '' for nullish. */
function str(v) {
  return v == null ? '' : String(v);
}

/** Coerce to non-negative integer, clamped to a max. */
function intInRange(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/** Detect whether a value looks like a Typst identifier (token name). */
const IDENT_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Emit a style value. If it looks like a token identifier, pass it through
 * verbatim. Otherwise, wrap it as a string literal — this forces callers to
 * either use a token name or explicitly opt into a raw string (which is
 * almost never what they want).
 */
function styleValue(v, fallbackToken) {
  const s = str(v).trim();
  if (!s) return fallbackToken;
  if (IDENT_RE.test(s)) return s;
  return fallbackToken;
}

/** Format a numeric length in points, accepting px input. */
function lenPt(v, fallbackPt) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return `${fallbackPt}pt`;
  // Round to 0.5pt for clean output.
  const rounded = Math.round(n * 2) / 2;
  return `${rounded}pt`;
}

/** Format a numeric length in millimetres. */
function lenMm(v, fallbackMm) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return `${fallbackMm}mm`;
  return `${Math.round(n * 10) / 10}mm`;
}

/** Join non-empty fragments with a separator (default newline). */
function joinFragments(fragments, sep = '\n') {
  return fragments.filter(f => f && f.length > 0).join(sep);
}

/** Indent every non-empty line of a block by the given prefix. */
function indent(str, prefix) {
  if (!str) return '';
  return str.split('\n').map(line => line ? prefix + line : '').join('\n');
}

/** Comma-join a list of Typst expressions, each on its own line. */
function commaJoin(exprs) {
  return exprs.filter(e => e && e.length > 0).join(',\n  ');
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Layout primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A horizontal divider line, styled with the brand divider token by default.
 *
 * @param {object} [opts]
 * @param {string} [opts.stroke]  Typst stroke expression. Default: thick brand divider.
 * @param {number} [opts.vBeforePt=0]  Space above the line.
 * @param {number} [opts.vAfterPt=0]   Space below the line.
 * @returns {string}
 */
export function divider(opts = {}) {
  const stroke = str(opts.stroke) || 'border-width-thick + border-divider';
  const vBefore = Number.isFinite(opts.vBeforePt) ? opts.vBeforePt : 0;
  const vAfter  = Number.isFinite(opts.vAfterPt)  ? opts.vAfterPt  : 0;

  const parts = [];
  if (vBefore > 0) parts.push(`#v(${lenPt(vBefore, 0)})`);
  parts.push(`#line(length: 100%, stroke: ${stroke})`);
  if (vAfter > 0)  parts.push(`#v(${lenPt(vAfter, 0)})`);

  return parts.join('\n');
}

/**
 * A vertical gap.
 *
 * @param {number} heightPt
 * @returns {string}
 */
export function spacer(heightPt) {
  const h = Number(heightPt);
  if (!Number.isFinite(h) || h <= 0) return '';
  return `#v(${lenPt(h, 0)})`;
}

/**
 * An explicit page break. Used by File 7 between body and end-page.
 *
 * @returns {string}
 */
export function pageBreak() {
  return '#pagebreak()';
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Container primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A rounded box with optional fill, stroke, radius, and inner padding.
 * The generic container used by meta cards, notice boxes, and feature cards.
 *
 * @param {object} opts
 * @param {string} opts.content          Typst content (already composed).
 * @param {string} [opts.fill]           Token name or 'none'. Default 'card-bg'.
 * @param {string} [opts.stroke]         Stroke expression or 'none'. Default: standard border.
 * @param {string} [opts.radius]         Token name for the corner radius. Default 'card-radius'.
 * @param {number} [opts.insetPt=12]     Inner padding in points.
 * @param {string} [opts.width='100%']   Typst width expression.
 * @returns {string}
 */
export function card(opts = {}) {
  const content = str(opts.content);
  if (!content) return '';

  const fill   = str(opts.fill)   || 'card-bg';
  const stroke = str(opts.stroke) || 'border-width-standard + card-border';
  const radius = styleValue(opts.radius, 'card-radius');
  const inset  = lenPt(opts.insetPt == null ? 12 : opts.insetPt, 12);
  const width  = str(opts.width) || '100%';

  const fillExpr   = fill   === 'none' ? 'none' : fill;
  const strokeExpr = stroke === 'none' ? 'none' : stroke;

  return [
    `#rect(`,
    `  width: ${width},`,
    `  fill: ${fillExpr},`,
    `  stroke: ${strokeExpr},`,
    `  radius: ${radius},`,
    `  inset: ${inset}`,
    `)[`,
    indent(content, '  '),
    `]`
  ].join('\n');
}

/**
 * A left-accented callout with an optional title and a body paragraph.
 * Used for educational-use notices, instructions, and disclaimers.
 *
 * @param {object} opts
 * @param {string} [opts.title]         Bold title line. Optional.
 * @param {string} opts.body            Body text.
 * @param {string} [opts.accent]        Accent token name. Default 'brand-primary'.
 * @param {string} [opts.fill]          Background token name. Default 'notice-bg'.
 * @param {number} [opts.insetPt=12]    Inner padding.
 * @returns {string}
 */
export function noticeBox(opts = {}) {
  const body = str(opts.body);
  if (!body) return '';

  const title  = str(opts.title);
  const accent = styleValue(opts.accent, 'brand-primary');
  const fill   = str(opts.fill) || 'notice-bg';
  const inset  = lenPt(opts.insetPt == null ? 12 : opts.insetPt, 12);

  const titleBlock = title
    ? `#text(weight: "bold", fill: ${accent}, size: font-size-md)[${title}]\n#v(4pt)\n`
    : '';

  return [
    `#rect(`,
    `  width: 100%,`,
    `  fill: ${fill},`,
    `  stroke: (left: notice-border-left + ${accent}),`,
    `  inset: ${inset}`,
    `)[`,
    `  ${titleBlock}#text(size: font-size-sm, fill: text-body)[${body}]`,
    `]`
  ].join('\n');
}

/**
 * A highlighted insight or recommendation callout, used in analytics.
 *
 * @param {object} opts
 * @param {string} [opts.label]         Bold label, e.g. "Insight" or "Recommendation".
 * @param {string} opts.text            Body text.
 * @returns {string}
 */
export function insightBox(opts = {}) {
  const text = str(opts.text);
  if (!text) return '';

  const label = str(opts.label) || 'Insight';

  return [
    `#rect(`,
    `  width: 100%,`,
    `  fill: brand-primary-light,`,
    `  stroke: (left: notice-border-left + brand-primary),`,
    `  inset: 12pt`,
    `)[`,
    `  #text(weight: "bold", fill: brand-primary-dark)[${label}:] #text(fill: text-body)[${text}]`,
    `]`
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Content primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A document title block: large heading + small subtitle underneath.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @returns {string}
 */
export function docTitle(opts = {}) {
  const title = str(opts.title);
  if (!title) return '';

  const subtitle = str(opts.subtitle);

  const parts = [
    `#text(size: font-size-xl, weight: "bold", fill: text-heading)[${title}]`
  ];
  if (subtitle) {
    parts.push('#v(6pt)');
    parts.push(`#text(size: font-size-base, fill: text-muted)[${subtitle}]`);
  }
  parts.push('#v(16pt)');

  return parts.join('\n');
}

/**
 * A bulleted list. Each item is rendered as a separate Typst list entry.
 *
 * @param {object} opts
 * @param {string[]} opts.items
 * @returns {string}
 */
export function bulletList(opts = {}) {
  const items = Array.isArray(opts.items) ? opts.items : [];
  const filtered = items.map(str).filter(Boolean);
  if (filtered.length === 0) return '';

  const lines = filtered.map(item => `- ${item}`);
  return lines.join('\n') + '\n';
}

/**
 * A numbered list.
 *
 * @param {object} opts
 * @param {string[]} opts.items
 * @returns {string}
 */
export function numberedList(opts = {}) {
  const items = Array.isArray(opts.items) ? opts.items : [];
  const filtered = items.map(str).filter(Boolean);
  if (filtered.length === 0) return '';

  const lines = filtered.map(item => `+ ${item}`);
  return lines.join('\n') + '\n';
}

/**
 * A single embedded image. `src` must be a data URI (e.g. "data:image/png;base64,...").
 *
 * @param {object} opts
 * @param {string} opts.src
 * @param {string} [opts.width='100%']
 * @param {number} [opts.heightPt]     Optional max height.
 * @param {string} [opts.align='center']
 * @returns {string}
 */
export function imageBlock(opts = {}) {
  const src = str(opts.src);
  if (!src) return '';

  const width  = str(opts.width) || '100%';
  const align  = str(opts.align) || 'center';

  const args = [`"${escapeTypstString(src)}"`, `width: ${width}`];
  if (Number.isFinite(opts.heightPt) && opts.heightPt > 0) {
    args.push(`height: ${lenPt(opts.heightPt, 100)}`);
  }

  return `#align(${align})[#image(${args.join(', ')})]`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Metadata primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single label/value card used inside a metadata grid.
 * Emits a `rect(...)` expression suitable for a grid cell.
 *
 * @param {object} opts
 * @param {string} opts.label
 * @param {string} opts.value
 * @returns {string}
 */
export function metaCard(opts = {}) {
  const label = str(opts.label);
  const value = str(opts.value);
  if (!label && !value) return '';

  return [
    `rect(`,
    `  width: 100%,`,
    `  radius: card-radius,`,
    `  fill: card-bg,`,
    `  stroke: border-width-standard + card-border,`,
    `  inset: 10pt`,
    `)[`,
    `  #text(size: font-size-xs, fill: text-light, weight: "bold")[${label.toUpperCase()}]`,
    `  #linebreak()`,
    `  #v(2pt)`,
    `  #text(size: font-size-base, weight: "bold", fill: text-heading)[${value}]`,
    `]`
  ].join('\n');
}

/**
 * A grid of metadata cards. `columns` defaults to the number of cells.
 *
 * @param {object} opts
 * @param {Array<{label:string,value:string}>} opts.cells
 * @param {number} [opts.columns]
 * @param {number} [opts.gutterPt=10]
 * @returns {string}
 */
export function metaGrid(opts = {}) {
  const cells = Array.isArray(opts.cells) ? opts.cells : [];
  if (cells.length === 0) return '';

  const rendered = cells.map(c => metaCard({ label: c.label, value: c.value }))
                        .filter(Boolean);
  if (rendered.length === 0) return '';

  const columns = intInRange(opts.columns, 1, 6, rendered.length);
  const gutter  = lenPt(opts.gutterPt == null ? 10 : opts.gutterPt, 10);

  const columnSpec = `(${Array.from({ length: columns }, () => '1fr').join(', ')})`;

  return [
    `#grid(`,
    `  columns: ${columnSpec},`,
    `  gutter: ${gutter},`,
    `  ${commaJoin(rendered)}`,
    `)`
  ].join('\n');
}

/**
 * A metadata table: rows of label/value pairs rendered as a two-column table.
 * Each row is `[{ label, value }, { label, value }]`.
 *
 * @param {object} opts
 * @param {Array<Array<{label:string,value:string}>>} opts.rows
 * @returns {string}
 */
export function metaTable(opts = {}) {
  const rows = Array.isArray(opts.rows) ? opts.rows : [];
  if (rows.length === 0) return '';

  const cells = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (!cell) continue;
      const label = str(cell.label);
      const value = str(cell.value);
      cells.push([
        `[`,
        `  #text(weight: "bold", fill: text-heading)[${label}]`,
        `  #linebreak()`,
        `  #text(fill: text-body)[${value}]`,
        `]`
      ].join('\n'));
    }
  }
  if (cells.length === 0) return '';

  return [
    `#table(`,
    `  columns: (1fr, 1fr),`,
    `  stroke: (bottom: border-width-standard + border-light),`,
    `  inset: (y: 8pt),`,
    `  ${commaJoin(cells)}`,
    `)`
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Table primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A general-purpose table with a styled header row.
 *
 * @param {object} opts
 * @param {string[]} opts.columns             Column header labels.
 * @param {Array<string[]>} opts.rows         Each row is an array of cell strings.
 * @param {string[]} [opts.widths]            Optional column widths, e.g. ['2fr','1fr'].
 * @returns {string}
 */
export function topicTable(opts = {}) {
  const columns = Array.isArray(opts.columns) ? opts.columns.map(str) : [];
  const rows    = Array.isArray(opts.rows) ? opts.rows : [];
  if (columns.length === 0) return '';

  const widths = Array.isArray(opts.widths) && opts.widths.length === columns.length
    ? opts.widths.map(str)
    : Array.from({ length: columns.length }, () => '1fr');

  const columnSpec = `(${widths.join(', ')})`;

  const cellExprs = [];

  // Header row.
  for (const label of columns) {
    cellExprs.push([
      `[`,
      `  #text(weight: "bold", fill: brand-primary, size: font-size-sm)[${label}]`,
      `]`
    ].join('\n'));
  }

  // Body rows.
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (let i = 0; i < columns.length; i++) {
      cellExprs.push([
        `[`,
        `  #text(size: font-size-sm, fill: text-body)[${str(row[i])}]`,
        `]`
      ].join('\n'));
    }
  }

  return [
    `#table(`,
    `  columns: ${columnSpec},`,
    `  stroke: (bottom: border-width-standard + border-light),`,
    `  inset: 8pt,`,
    `  fill: (_, row) => if row == 0 { bg-light } else { none },`,
    `  ${commaJoin(cellExprs)}`,
    `)`
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Domain primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single exam question with an optional list of options.
 *
 * @param {object} opts
 * @param {string} opts.id         Question number or label, e.g. "1".
 * @param {string} opts.text       Question body.
 * @param {string[]} [opts.options] Optional answer options.
 * @param {number} [opts.marginBottomPt=16]
 * @returns {string}
 */
export function questionBlock(opts = {}) {
  const text = str(opts.text);
  if (!text) return '';

  const id = str(opts.id);
  const options = Array.isArray(opts.options) ? opts.options.map(str).filter(Boolean) : [];
  const marginBottomPt = Number.isFinite(opts.marginBottomPt) ? opts.marginBottomPt : 16;

  const parts = [];

  // Question text: bold id + body.
  const questionLine = id
    ? `#text(weight: "bold", fill: text-heading)[${id}. ${text}]`
    : `#text(weight: "bold", fill: text-heading)[${text}]`;
  parts.push(questionLine);

  // Options list.
  if (options.length > 0) {
    parts.push('#v(4pt)');
    for (const opt of options) {
      parts.push(`- ${opt}`);
    }
  }

  if (marginBottomPt > 0) {
    parts.push(`#v(${lenPt(marginBottomPt, 16)})`);
  }

  return parts.join('\n');
}

/**
 * A single answer-key entry: question text, correct option, and explanation.
 *
 * @param {object} opts
 * @param {string} opts.id                    Question number.
 * @param {string} [opts.question]            Question text.
 * @param {string} [opts.correctOption]       Correct answer label.
 * @param {{overview:string,highYield:string,clinicalCorrelation:string}} [opts.explanation]
 * @returns {string}
 */
export function answerBlock(opts = {}) {
  const id = str(opts.id);
  const question = str(opts.question);
  const correct = str(opts.correctOption);
  const explanation = opts.explanation && typeof opts.explanation === 'object'
    ? opts.explanation
    : { overview: '', highYield: '', clinicalCorrelation: '' };

  if (!id && !question && !correct) return '';

  const parts = [];

  if (id || question) {
    parts.push(
      `#text(weight: "bold", fill: text-heading)[${id}${id && question ? '. ' : ''}${question}]`
    );
  }
  if (correct) {
    parts.push('#v(4pt)');
    parts.push(
      `#text(weight: "bold", fill: brand-primary)[Correct Answer: ${correct}]`
    );
  }

  const expParts = [];
  if (explanation.overview)            expParts.push(`#text(weight: "bold")[Overview:] #text[${explanation.overview}]`);
  if (explanation.highYield)           expParts.push(`#text(weight: "bold")[High Yield:] #text[${explanation.highYield}]`);
  if (explanation.clinicalCorrelation) expParts.push(`#text(weight: "bold")[Clinical Correlation:] #text[${explanation.clinicalCorrelation}]`);

  if (expParts.length > 0) {
    parts.push('#v(4pt)');
    parts.push(`#text(size: font-size-sm, fill: text-muted)[${expParts.join(' #linebreak() ')}]`);
  }

  parts.push('#v(14pt)');
  parts.push('#line(length: 100%, stroke: border-width-hairline + border-light)');
  parts.push('#v(12pt)');

  return parts.join('\n');
}

/**
 * A single MCQ answer-sheet row: a numbered label and a horizontal set of
 * bubbles labelled A, B, C, ...
 *
 * @param {object} opts
 * @param {number} opts.number          Question number.
 * @param {string[]} [opts.optionLabels=['A','B','C','D','E']]
 * @returns {string}
 */
export function mcqRow(opts = {}) {
  const number = Number(opts.number);
  if (!Number.isFinite(number) || number < 1) return '';

  const labels = Array.isArray(opts.optionLabels) && opts.optionLabels.length > 0
    ? opts.optionLabels.map(str)
    : ['A', 'B', 'C', 'D', 'E'];

  const bubbles = labels.map(label => [
    `grid(`,
    `  columns: (12pt, auto),`,
    `  column-gutter: 4pt,`,
    `  align: horizon,`,
    `  circle(radius: 5pt, stroke: border-width-thick + brand-primary),`,
    `  [#text(size: font-size-xs)[${label}]]`,
    `)`
  ].join('\n')).join(',\n      ');

  return [
    `#grid(`,
    `  columns: (24pt, 1fr),`,
    `  column-gutter: 6pt,`,
    `  align: horizon,`,
    `  [#text(weight: "bold", size: font-size-sm)[${number}.]],`,
    `  [`,
    `    #stack(dir: ltr, spacing: 14pt,`,
    `      ${bubbles}`,
    `    )`,
    `  ]`,
    `)`
  ].join('\n');
}

/**
 * A full MCQ answer sheet grid, chunked into pages.
 *
 * The rows are split deterministically: `rowsPerPage` rows per page, with
 * the first half of each page's rows in the left column and the second half
 * in the right column.
 *
 * @param {object} opts
 * @param {number} opts.totalQuestions
 * @param {string[]} [opts.optionLabels=['A','B','C','D','E']]
 * @param {number} [opts.rowsPerPage=40]        Rows per page (across both columns).
 * @param {number} [opts.columns=2]             Columns per page.
 * @param {number} [opts.rowGutterPt=6]
 * @returns {string}
 */
export function mcqGrid(opts = {}) {
  const total = intInRange(opts.totalQuestions, 1, 1000, 0);
  if (total === 0) return '';

  const labels = Array.isArray(opts.optionLabels) && opts.optionLabels.length > 0
    ? opts.optionLabels.map(str)
    : ['A', 'B', 'C', 'D', 'E'];

  const rowsPerPage = intInRange(opts.rowsPerPage, 2, 200, 40);
  const columns     = intInRange(opts.columns, 1, 4, 2);
  const rowGutter   = lenPt(opts.rowGutterPt == null ? 6 : opts.rowGutterPt, 6);

  // Even split between columns; odd remainders go to the left column.
  const rowsPerColumn = Math.ceil(rowsPerPage / columns);
  const totalPages    = Math.ceil(total / rowsPerPage);

  const pages = [];

  for (let page = 0; page < totalPages; page++) {
    const pageStart = page * rowsPerPage + 1;   // 1-based
    const pageEnd   = Math.min(total, pageStart + rowsPerPage - 1);

    // Split this page's range into per-column ranges.
    const columnsContent = [];
    for (let col = 0; col < columns; col++) {
      const colStart = pageStart + col * rowsPerColumn;
      const colEnd   = Math.min(pageEnd, colStart + rowsPerColumn - 1);
      if (colStart > colEnd) continue;

      const rows = [];
      for (let n = colStart; n <= colEnd; n++) {
        const r = mcqRow({ number: n, optionLabels: labels });
        if (r) rows.push(r);
      }
      if (rows.length > 0) {
        columnsContent.push('[\n' + indent(rows.join('\n#v(4pt)\n'), '  ') + '\n]');
      }
    }

    if (columnsContent.length === 0) continue;

    const columnSpec = `(${Array.from({ length: columnsContent.length }, () => '1fr').join(', ')})`;
    const gridExpr = [
      `#grid(`,
      `  columns: ${columnSpec},`,
      `  gutter: (18pt, ${rowGutter}),`,
      `  ${columnsContent.join(',\n  ')}`,
      `)`
    ].join('\n');

    pages.push(gridExpr);
  }

  return pages.join('\n#pagebreak()\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Analytics primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A dashed placeholder box for a chart that is not rendered.
 *
 * @param {object} opts
 * @param {string} [opts.label='[ Chart ]']
 * @param {number} [opts.heightPt=120]
 * @returns {string}
 */
export function chartPlaceholder(opts = {}) {
  const label = str(opts.label) || '[ Chart ]';
  const height = Number.isFinite(opts.heightPt) ? opts.heightPt : 120;

  return [
    `#rect(`,
    `  width: 100%,`,
    `  height: ${lenPt(height, 120)},`,
    `  fill: bg-light-alt,`,
    `  stroke: (paint: text-light, thickness: border-width-thick, dash: "dashed"),`,
    `  radius: card-radius,`,
    `  inset: 12pt`,
    `)[`,
    `  #align(center + horizon)[#text(size: font-size-base, fill: text-light)[${label}]]`,
    `]`
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. End-page primitives
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single feature card for the end page's feature grid.
 * Returns the rect expression suitable for a grid cell.
 *
 * @param {object} opts
 * @param {string} opts.text
 * @returns {string}
 */
export function featureCard(opts = {}) {
  const text = str(opts.text);
  if (!text) return '';

  return [
    `rect(`,
    `  width: 100%,`,
    `  radius: 8pt,`,
    `  fill: bg-light-alt,`,
    `  inset: 12pt`,
    `)[`,
    `  #text(size: font-size-sm, weight: "medium", fill: text-body)[${text}]`,
    `]`
  ].join('\n');
}

/**
 * A two-column grid of feature cards.
 *
 * @param {object} opts
 * @param {string[]} opts.features
 * @param {number} [opts.columns=2]
 * @param {number} [opts.gutterPt=12]
 * @returns {string}
 */
export function featureGrid(opts = {}) {
  const features = Array.isArray(opts.features) ? opts.features.map(str).filter(Boolean) : [];
  if (features.length === 0) return '';

  const rendered = features.map(f => featureCard({ text: f })).filter(Boolean);
  if (rendered.length === 0) return '';

  const columns = intInRange(opts.columns, 1, 4, 2);
  const gutter  = lenPt(opts.gutterPt == null ? 12 : opts.gutterPt, 12);
  const columnSpec = `(${Array.from({ length: columns }, () => '1fr').join(', ')})`;

  return [
    `#grid(`,
    `  columns: ${columnSpec},`,
    `  gutter: ${gutter},`,
    `  ${commaJoin(rendered)}`,
    `)`
  ].join('\n');
}

/**
 * A primary call-to-action block: a colored rounded link with bold text.
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} opts.url
 * @param {number} [opts.widthPt=320]
 * @returns {string}
 */
export function ctaBlock(opts = {}) {
  const text = str(opts.text);
  const url  = str(opts.url);
  if (!text || !url) return '';

  const width = Number.isFinite(opts.widthPt) ? opts.widthPt : 320;

  return [
    `#align(center)[`,
    `  #link("${escapeTypstString(url)}")[`,
    `    #box(`,
    `      fill: brand-primary,`,
    `      inset: (x: 20pt, y: 10pt),`,
    `      radius: 6pt,`,
    `      width: ${lenPt(width, 320)}`,
    `    )[`,
    `      #text(fill: white, weight: "bold", size: font-size-base)[${text}]`,
    `    ]`,
    `  ]`,
    `]`
  ].join('\n');
}

/**
 * A QR code image block, centered.
 *
 * @param {object} opts
 * @param {string} opts.base64               Base64 payload (no data: prefix).
 * @param {number} [opts.sizePt=100]
 * @param {string} [opts.mime='image/png']
 * @returns {string}
 */
export function qrBlock(opts = {}) {
  const base64 = str(opts.base64);
  if (!base64) return '';

  const sizePt = Number.isFinite(opts.sizePt) ? opts.sizePt : 100;
  const mime = str(opts.mime) || 'image/png';

  return [
    `#align(center)[`,
    `  #image(`,
    `    "data:${mime};base64,${base64}",`,
    `    width: ${lenPt(sizePt, 100)},`,
    `    height: ${lenPt(sizePt, 100)}`,
    `  )`,
    `]`
  ].join('\n');
}

/**
 * The complete end page. Emitted after `#pagebreak()` from File 7.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} [opts.subtitle]
 * @param {string} [opts.message]
 * @param {string[]} [opts.features]
 * @param {string} [opts.ctaText]
 * @param {string} [opts.ctaUrl]
 * @param {string} [opts.qrBase64]
 * @param {string} [opts.copyright='© 2026 MedVix']
 * @param {string} [opts.disclaimer]
 * @returns {string}
 */
export function endPage(opts = {}) {
  const title = str(opts.title);
  if (!title) return '';

  const subtitle   = str(opts.subtitle);
  const message    = str(opts.message);
  const features   = Array.isArray(opts.features) ? opts.features.map(str).filter(Boolean) : [];
  const ctaText    = str(opts.ctaText);
  const ctaUrl     = str(opts.ctaUrl);
  const qrBase64   = str(opts.qrBase64);
  const copyright  = str(opts.copyright) || '© 2026 MedVix';
  const disclaimer = str(opts.disclaimer);

  const parts = [];
  parts.push('#pagebreak()');
  parts.push('#align(center)[');

  // Title.
  parts.push(`  #v(24pt)`);
  parts.push(`  #text(size: 24pt, weight: "bold", fill: brand-primary)[${title}]`);

  // Subtitle.
  if (subtitle) {
    parts.push('  #v(8pt)');
    parts.push(`  #text(size: font-size-base, fill: text-muted)[${subtitle}]`);
  }

  // Message.
  if (message) {
    parts.push('  #v(20pt)');
    parts.push(`  #block(width: 400pt)[#align(center)[#text(size: font-size-base, fill: text-body)[${message}]]]`);
  }

  // Feature grid.
  if (features.length > 0) {
    parts.push('  #v(24pt)');
    parts.push('  #block(width: 420pt)[');
    parts.push(indent(featureGrid({ features, columns: 2, gutterPt: 12 }), '    '));
    parts.push('  ]');
  }

  // CTA.
  if (ctaText && ctaUrl) {
    parts.push('  #v(28pt)');
    parts.push(indent(ctaBlock({ text: ctaText, url: ctaUrl, widthPt: 320 }), '  '));
  }

  // QR code.
  if (qrBase64) {
    parts.push('  #v(24pt)');
    parts.push(indent(qrBlock({ base64: qrBase64, sizePt: 100 }), '  '));
  }

  // Copyright.
  parts.push('  #v(20pt)');
  parts.push(`  #text(size: font-size-sm, fill: text-muted)[${copyright}]`);

  // Disclaimer.
  if (disclaimer) {
    parts.push('  #v(8pt)');
    parts.push(`  #block(width: 400pt)[#align(center)[#text(size: font-size-xs, fill: text-light)[${disclaimer}]]]`);
  }

  parts.push(']');

  return parts.join('\n');
}