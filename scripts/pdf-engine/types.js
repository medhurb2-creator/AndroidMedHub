/**
 * MedVix Unified PDF Engine v7.0
 * File 2 of 8 — AST Schemas, Validation, and Typst Sanitization
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The trust boundary of the engine. Every string that reaches the Typst
 * compiler passes through this file first. Everything downstream (File 7)
 * assumes its input is well-shaped, correctly typed, and safe for Typst.
 *
 *   Guarantees
 *   ──────────
 *   • Purity         — no DOM, no fetch, no window, no globals.
 *   • Determinism    — same input → same output, byte for byte.
 *   • Never throws   — malformed markdown / HTML falls back to literal text.
 *   • Frozen output  — recursive Object.freeze prevents downstream mutation.
 *   • Two contexts   — escapeTypstLiteral (markup) vs escapeTypstString (literal)
 *   • Schema-driven  — one generic validator drives every document type.
 *
 *   Public API
 *   ──────────
 *   escapeTypstLiteral(str)          → str safe inside Typst markup
 *   escapeTypstString(str)           → str safe inside Typst string literal
 *   markdownToTypst(md)              → Typst markup from Markdown
 *   htmlToTypst(html)                → Typst markup from a limited HTML subset
 *   validateDocData(raw, type)       → frozen, sanitized, typed AST
 *   ValidationError                  → typed error with .details
 *   DOC_TYPES                        → frozen list of supported type keys
 *   SCHEMAS                          → frozen map of type → schema
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. Errors
// ═══════════════════════════════════════════════════════════════════════════

export class ValidationError extends Error {
  /**
   * @param {string} message  Human-readable summary
   * @param {object} [details] Structured context: { field, expected, received, ... }
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Escaping primitives
// ═══════════════════════════════════════════════════════════════════════════

// Characters that alter Typst's *markup* parsing (inside content blocks).
// Everything from the code / math / raw / reference / label / nbsp families.
const MARKUP_RE = /[\\#$\[\]*_`@~<>]/g;
const MARKUP_MAP = Object.freeze({
  '\\': '\\\\',
  '#':  '\\#',
  '$':  '\\$',
  '[':  '\\[',
  ']':  '\\]',
  '*':  '\\*',
  '_':  '\\_',
  '`':  '\\`',
  '@':  '\\@',
  '~':  '\\~',
  '<':  '\\<',
  '>':  '\\>'
});

/**
 * Escape text for insertion inside a Typst *content block* (markup context).
 * Used for user-visible strings that must render literally.
 */
export function escapeTypstLiteral(input) {
  if (typeof input !== 'string') return '';
  return input.replace(MARKUP_RE, (c) => MARKUP_MAP[c] || c);
}

/**
 * Escape text for insertion inside a Typst *string literal* ("...").
 * Only `"` and `\` are significant here.
 */
export function escapeTypstString(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[\\"]/g, (c) => '\\' + c);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. HTML entity decoding (self-contained, no DOM)
// ═══════════════════════════════════════════════════════════════════════════

const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00A0', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', bull: '•',
  times: '×', divide: '÷', deg: '°', plusmn: '±',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’'
});

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
      try {
        const cp = parseInt(hex, 16);
        return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m;
      } catch { return m; }
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      try {
        const cp = parseInt(dec, 10);
        return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : m;
      } catch { return m; }
    })
    .replace(/&([a-zA-Z]+);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : m
    );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Markdown → Typst
// ═══════════════════════════════════════════════════════════════════════════

// Markdown handles a subset; unknown syntax falls through as literal text.
// Never throws — a malformed input returns escaped literal.

export function markdownToTypst(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  try {
    return renderMarkdownBlocks(input);
  } catch {
    // On any internal error, degrade gracefully to fully escaped literal text.
    return escapeTypstLiteral(input);
  }
}

function renderMarkdownBlocks(src) {
  // Normalize line endings, protect fenced code blocks.
  const normalized = src.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── Blank line → paragraph break
    if (line.trim() === '') { out.push('\n\n'); i++; continue; }

    // ── Fenced code block ``` or ~~~
    const fence = /^\s*(`{3,}|~{3,})\s*(.*)$/.exec(line);
    if (fence) {
      const marker = fence[1][0];      // ` or ~
      const fenceLen = fence[1].length;
      const body = [];
      i++;
      while (i < lines.length) {
        const test = lines[i];
        const close = new RegExp('^\\s*' + (marker === '`' ? '`' : '~') + '{' + fenceLen + ',}\\s*$');
        if (close.test(test)) { i++; break; }
        body.push(test);
        i++;
      }
      const codeText = body.join('\n');
      out.push('```\n' + escapeTypstString(codeText) + '\n```\n\n');
      continue;
    }

    // ── ATX heading # ... ######
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = renderInline(heading[2]);
      out.push('='.repeat(level) + ' ' + text + '\n\n');
      i++;
      continue;
    }

    // ── Horizontal rule
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('#line(length: 100%)\n\n');
      i++;
      continue;
    }

    // ── Blockquote (contiguous > lines)
    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      const quoteText = quote.map(l => renderInline(l)).join('\n');
      out.push('#quote[\n' + quoteText + '\n]\n\n');
      continue;
    }

    // ── Unordered list (- or * or +) — contiguous
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      for (const item of items) out.push('- ' + renderInline(item) + '\n');
      out.push('\n');
      continue;
    }

    // ── Ordered list (1. 2. ...) — contiguous
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      for (const item of items) out.push('+ ' + renderInline(item) + '\n');
      out.push('\n');
      continue;
    }

    // ── Paragraph: gather non-blank, non-block-start lines
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !isMarkdownBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(renderInline(para.join(' ')) + '\n\n');
  }

  // Collapse excessive blank lines (more than 2 consecutive newlines).
  return out.join('').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function isMarkdownBlockStart(line) {
  return /^\s*(`{3,}|~{3,}|#{1,6}\s|>\s?|[-*+]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line);
}

/**
 * Render inline markdown constructs. Everything not recognized is escaped
 * as literal Typst markup. Recursive for nested formatting.
 */
function renderInline(text) {
  const out = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];

    // ── Inline code `...`
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        // Inline code: raw Typst text, escaped only for backtick safety.
        out.push('`' + escapeTypstString(text.slice(i + 1, end)) + '`');
        i = end + 1;
        continue;
      }
    }

    // ── Bold **text** or __text__
    if ((ch === '*' || ch === '_') && text[i + 1] === ch) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end !== -1 && end > i + 2) {
        out.push('*' + renderInline(text.slice(i + 2, end)) + '*');
        i = end + 2;
        continue;
      }
    }

    // ── Italic *text* or _text_
    if (ch === '*' || ch === '_') {
      const end = text.indexOf(ch, i + 1);
      if (end !== -1 && end > i + 1 && text[end + 1] !== ch) {
        out.push('_' + renderInline(text.slice(i + 1, end)) + '_');
        i = end + 1;
        continue;
      }
    }

    // ── Link [text](url)
    if (ch === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const label = text.slice(i + 1, closeBracket);
          const url = sanitizeUrl(text.slice(closeBracket + 2, closeParen));
          out.push('#link("' + escapeTypstString(url) + '")[' + renderInline(label) + ']');
          i = closeParen + 1;
          continue;
        }
      }
    }

    // ── Plain text: accumulate until the next inline-marker character.
    let j = i;
    while (j < n && !'`*_[\\#$@~<>'.includes(text[j])) j++;
    if (j === i) j++;   // guarantee forward progress even on an unmatched marker

    // Strip any raw HTML tags that leaked into the markdown body.
    const segment = text.slice(i, j).replace(/<[^>]*>/g, '');
    out.push(escapeTypstLiteral(segment));
    i = j;
  }

  return out.join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. HTML → Typst
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a limited, known-safe subset of HTML to Typst markup.
 * Handles: p, br, hr, h1–h6, strong/b, em/i, u, s/del, code, pre,
 *          ul, ol, li, blockquote, a, span (unstyled), div (unstyled).
 * Everything else is stripped. Never throws.
 */

const HTML_BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre'
]);

const HTML_VOID_TAGS = new Set(['br', 'hr', 'img', 'input']);

export function htmlToTypst(html) {
  if (typeof html !== 'string' || html.length === 0) return '';
  try {
    return renderHtmlBlocks(html);
  } catch {
    // Degrade to plain text if anything goes wrong.
    return escapeTypstLiteral(stripTags(html));
  }
}

function renderHtmlBlocks(html) {
  // Remove comments, <script>, <style> entirely — never emit their content.
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '');

  const out = [];
  const stack = [];   // open tags
  let i = 0;
  const n = cleaned.length;

  const emitLiteral = (str) => {
    if (!str) return;
    out.push(escapeTypstLiteral(decodeHtmlEntities(str)));
  };

  while (i < n) {
    const lt = cleaned.indexOf('<', i);

    // No more tags — emit remaining text.
    if (lt === -1) {
      emitLiteral(cleaned.slice(i));
      break;
    }

    // Emit text preceding the tag.
    if (lt > i) emitLiteral(cleaned.slice(i, lt));

    const gt = cleaned.indexOf('>', lt);
    if (gt === -1) {
      // Malformed: no closing '>'. Emit remainder as literal.
      emitLiteral(cleaned.slice(lt));
      break;
    }

    const raw = cleaned.slice(lt + 1, gt).trim();
    i = gt + 1;

    const isClose = raw.startsWith('/');
    const isSelfClose = raw.endsWith('/');
    const tagText = isClose ? raw.slice(1).trim() : (isSelfClose ? raw.slice(0, -1).trim() : raw);

    // Split tag name and attributes.
    const spaceIdx = tagText.search(/\s/);
    const tagName = (spaceIdx === -1 ? tagText : tagText.slice(0, spaceIdx)).toLowerCase();
    const attrStr = spaceIdx === -1 ? '' : tagText.slice(spaceIdx + 1);

    if (!tagName) continue;

    if (isClose) {
      handleHtmlCloseTag(tagName, stack, out);
    } else {
      handleHtmlOpenTag(tagName, attrStr, stack, out, isSelfClose);
    }
  }

  // Close any tags left open at end of input.
  while (stack.length > 0) {
    const t = stack.pop();
    closeHtmlTagEffect(t, out);
  }

  // Collapse excessive whitespace / blank lines produced by block breaks.
  return out.join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+|\s+$/g, '')
    + '\n';
}

function handleHtmlOpenTag(tag, attrStr, stack, out, selfClose) {
  // Extract inline formatting tags that affect the *content* rather than layout.
  switch (tag) {
    case 'br':
      out.push('\n');
      return;

    case 'hr':
      out.push('\n#line(length: 100%)\n');
      return;

    case 'strong':
    case 'b':
      out.push('*');
      stack.push({ tag, effect: 'close-strong' });
      break;

    case 'em':
    case 'i':
      out.push('_');
      stack.push({ tag, effect: 'close-em' });
      break;

    case 'u':
      // Typst has no underline primitive inline; render as-is.
      stack.push({ tag, effect: 'noop' });
      break;

    case 's':
    case 'del':
      // Strikethrough: use a small inline style.
      out.push('#strike[');
      stack.push({ tag, effect: 'close-strike' });
      break;

    case 'code':
      if (!selfClose) {
        out.push('`');
        stack.push({ tag, effect: 'close-code' });
      }
      break;

    case 'pre':
      out.push('\n```\n');
      stack.push({ tag, effect: 'close-pre' });
      break;

    case 'a': {
      const href = extractAttr(attrStr, 'href');
      const safeHref = sanitizeUrl(href);
      out.push('#link("' + escapeTypstString(safeHref) + '")[');
      stack.push({ tag, effect: 'close-link' });
      break;
    }

    case 'p':
      out.push('\n\n');
      stack.push({ tag, effect: 'close-p' });
      break;

    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const level = parseInt(tag[1], 10);
      out.push('\n\n' + '='.repeat(level) + ' ');
      stack.push({ tag, effect: 'close-heading' });
      break;
    }

    case 'ul':
    case 'ol':
      out.push('\n');
      stack.push({ tag, effect: 'noop' });
      break;

    case 'li':
      // Approximate ordered lists with `+`, unordered with `-`.
      out.push('\n- ');
      stack.push({ tag, effect: 'noop' });
      break;

    case 'blockquote':
      out.push('\n#quote[\n');
      stack.push({ tag, effect: 'close-quote' });
      break;

    case 'table':
    case 'thead':
    case 'tbody':
      // Tables handled by their own schema fields; inside free HTML they
      // get stripped and their cell text flows as paragraphs.
      stack.push({ tag, effect: 'noop' });
      break;

    case 'tr':
      out.push('\n');
      stack.push({ tag, effect: 'noop' });
      break;

    case 'td':
    case 'th':
      // Separate cells with a middle dot for readability.
      out.push(' · ');
      stack.push({ tag, effect: 'noop' });
      break;

    case 'img': {
      const src = extractAttr(attrStr, 'src');
      const alt = extractAttr(attrStr, 'alt');
      if (src && /^data:image\//i.test(src)) {
        const safeSrc = escapeTypstString(src);
        out.push('\n#image("' + safeSrc + '", width: 100%)\n');
      } else if (alt) {
        // No data URI available — degrade to alt text.
        emitAltFallback(alt, out);
      }
      return;
    }

    case 'span':
    case 'div':
    case 'section':
    case 'article':
    case 'header':
    case 'footer':
    case 'main':
    case 'aside':
    case 'figure':
    case 'figcaption':
    case 'nav':
      // Structural / unstyled wrappers — treat transparently.
      if (HTML_BLOCK_TAGS.has(tag)) out.push('\n');
      stack.push({ tag, effect: 'noop' });
      break;

    default:
      // Unknown tag: strip it but keep the content.
      stack.push({ tag, effect: 'noop' });
      break;
  }
}

function handleHtmlCloseTag(tag, stack, out) {
  // Pop the nearest matching open tag.
  let matchIdx = -1;
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].tag === tag) { matchIdx = k; break; }
  }
  if (matchIdx === -1) return;   // unmatched close — ignore

  // Pop everything from the top down to (and including) the match.
  while (stack.length > matchIdx) {
    const item = stack.pop();
    closeHtmlTagEffect(item, out);
  }
}

function closeHtmlTagEffect(item, out) {
  switch (item.effect) {
    case 'close-strong':  out.push('*'); break;
    case 'close-em':      out.push('_'); break;
    case 'close-strike':  out.push(']'); break;
    case 'close-code':    out.push('`'); break;
    case 'close-pre':     out.push('\n```\n'); break;
    case 'close-link':    out.push(']'); break;
    case 'close-p':       out.push('\n\n'); break;
    case 'close-heading': out.push('\n\n'); break;
    case 'close-quote':   out.push('\n]\n'); break;
    case 'noop':
    default:
      break;
  }
}

function emitAltFallback(alt, out) {
  out.push('_[' + escapeTypstLiteral(alt) + ']_');
}

function extractAttr(attrStr, name) {
  if (!attrStr) return '';
  const re = new RegExp(name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i');
  const m = re.exec(attrStr);
  if (!m) return '';
  return decodeHtmlEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3] || '');
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Field sanitizers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filename-safe identifier. Alphanumeric + . _ - only.
 * Returns null if the input yields no usable characters.
 */
function sanitizeId(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;
  const cleaned = s
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 60);
  return cleaned || null;
}

/** Normalize any date-like input to ISO 8601 (YYYY-MM-DD). */
function sanitizeDate(input) {
  if (!input) return new Date().toISOString().slice(0, 10);
  const d = new Date(input);
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** Only http/https URLs survive. Everything else → '#'. */
function sanitizeUrl(input) {
  if (!input) return '#';
  try {
    const u = new URL(String(input));
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '#';
    return u.toString();
  } catch {
    return '#';
  }
}

/** Force 6-digit lowercase hex. Rejects 8-digit (RGBA) forms. */
function sanitizeColor(input, fallback = '#000000') {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(input || ''));
  return m ? '#' + m[1].toLowerCase() : fallback;
}

/**
 * Normalize an answer's explanation to { overview, highYield, clinicalCorrelation }.
 * Accepts: a plain string, an object with any subset of those keys, or null.
 * Each sub-field is escaped as literal Typst text.
 */
function sanitizeExplanation(value) {
  if (value == null) {
    return { overview: '', highYield: '', clinicalCorrelation: '' };
  }
  if (typeof value === 'string') {
    return {
      overview: escapeTypstLiteral(value),
      highYield: '',
      clinicalCorrelation: ''
    };
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return {
      overview:            escapeTypstLiteral(String(value.overview || '')),
      highYield:           escapeTypstLiteral(String(value.highYield || '')),
      clinicalCorrelation: escapeTypstLiteral(String(value.clinicalCorrelation || ''))
    };
  }
  return { overview: '', highYield: '', clinicalCorrelation: '' };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Schemas
// ═══════════════════════════════════════════════════════════════════════════
//
// A field spec has the shape:
//
//   {
//     type:       'string' | 'number' | 'boolean' | 'enum' | 'array' | 'any'
//     required:   boolean
//     format:     'literal' | 'string' | 'markdown' | 'html' | 'none'
//     default:    value | (() => value)
//     maxLength:  number (strings / arrays)
//     enum:       allowed values for type 'enum'
//     coerce:     'number' | 'boolean' | 'string'
//     sanitize:   (value) => value | null    — runs before format
//     itemSchema: field spec for array elements (type 'array')
//     objectSchema: map of field name → spec (type 'array' of objects)
//   }
//
// Order of operations per field:
//   1. Missing / null / '' → default (or throw if required).
//   2. coerce (optional).
//   3. Type check.
//   4. maxLength truncation (strings, arrays).
//   5. enum membership check.
//   6. custom sanitize.
//   7. format transformation (escape / markdown / html / passthrough).

const END_PAGE_DEFAULTS = {
  endTitle:    'Document Complete',
  endSubtitle: '',
  endMessage:  '',
  endFeatures: () => [
    '📚 Question Bank', '📝 Smart Notes', '🧠 Flashcards', '📅 Study Planner'
  ],
  ctaText:     'Continue on MedVix',
  ctaUrl:      'https://medvix.co.ke',
  disclaimer:  'This PDF was generated by MedVix for educational purposes.'
};

// ── Notes ──────────────────────────────────────────────────────────────────

const NOTES_SCHEMA = {
  id:      { type: 'string', required: false, format: 'literal', sanitize: sanitizeId, default: null },
  title:   { type: 'string', required: false, format: 'literal', default: 'Untitled Notes', maxLength: 200 },
  subject: { type: 'string', required: false, format: 'literal', default: 'General',       maxLength: 100 },
  topic:   { type: 'string', required: false, format: 'literal', default: '',              maxLength: 100 },
  owner:   { type: 'string', required: false, format: 'literal', default: 'Student',       maxLength: 80 },
  date:    { type: 'string', required: false, format: 'literal', sanitize: sanitizeDate },
  content: { type: 'string', required: true,  format: 'html',    default: '' },

  endTitle:    { type: 'string', required: false, format: 'literal', default: 'Continue Your Medical Journey' },
  endSubtitle: { type: 'string', required: false, format: 'literal', default: 'Thank you for creating your notes with MedVix.' },
  endMessage:  { type: 'string', required: false, format: 'literal', default: '' },
  endFeatures: {
    type: 'array', required: false,
    itemSchema: { type: 'string', format: 'literal' },
    default: END_PAGE_DEFAULTS.endFeatures
  },
  ctaText:     { type: 'string', required: false, format: 'literal', default: 'Continue Learning With MedVix' },
  ctaUrl:      { type: 'string', required: false, format: 'string',  sanitize: sanitizeUrl,
                 default: 'https://medvix.co.ke' },
  disclaimer:  { type: 'string', required: false, format: 'literal',
                 default: 'This PDF was generated using MedVix. The notes and content belong to their respective author.' }
};

// ── Exam ───────────────────────────────────────────────────────────────────

const QUESTION_ITEM_SCHEMA = {
  id:      { type: 'string', required: false, format: 'literal', default: '' },
  text:    { type: 'string', required: true,  format: 'literal' },
  options: {
    type: 'array', required: false,
    itemSchema: { type: 'string', format: 'literal' },
    default: []
  }
};

const EXAM_SCHEMA = {
  id:          { type: 'string', required: false, format: 'literal', sanitize: sanitizeId, default: null },
  title:       { type: 'string', required: false, format: 'literal', default: 'Practice Examination', maxLength: 200 },
  subject:     { type: 'string', required: false, format: 'literal', default: 'Medical Science',      maxLength: 100 },
  topics:      { type: 'string', required: false, format: 'literal', default: '',                     maxLength: 200 },
  difficulty:  { type: 'enum',   required: false, format: 'literal',
                 enum: ['Easy', 'Moderate', 'Hard'], default: 'Moderate' },
  duration:    { type: 'string', required: false, format: 'literal', default: '2 Hours',  maxLength: 40 },
  totalMarks:  { type: 'number', required: false, coerce: 'number', default: 0 },
  date:        { type: 'string', required: false, format: 'literal', sanitize: sanitizeDate },
  studentInfo: { type: 'boolean', required: false, coerce: 'boolean', default: false },

  questions: {
    type: 'array', required: true,
    objectSchema: QUESTION_ITEM_SCHEMA,
    default: []
  },

  endTitle:    { type: 'string', required: false, format: 'literal', default: 'Exam Complete!' },
  endSubtitle: { type: 'string', required: false, format: 'literal',
                 default: 'You have reached the end of this practice examination.' },
  endMessage:  { type: 'string', required: false, format: 'literal', default: '' },
  endFeatures: {
    type: 'array', required: false,
    itemSchema: { type: 'string', format: 'literal' },
    default: () => ['📊 Performance Review', '📝 Answer Explanations', '🧠 Targeted Revision', '📅 Next Exam Scheduler']
  },
  ctaText:     { type: 'string', required: false, format: 'literal', default: 'Review Answers on MedVix' },
  ctaUrl:      { type: 'string', required: false, format: 'string',  sanitize: sanitizeUrl,
                 default: 'https://medvix.co.ke' },
  disclaimer:  { type: 'string', required: false, format: 'literal',
                 default: 'This examination was generated by MedVix for revision, practice, and self-assessment.' }
};

// ── MCQ Answer Sheet ───────────────────────────────────────────────────────

const MCQ_SHEET_SCHEMA = {
  id:             { type: 'string', required: false, format: 'literal', sanitize: sanitizeId, default: null },
  title:          { type: 'string', required: false, format: 'literal', default: 'MCQ Answer Sheet', maxLength: 200 },
  totalQuestions: { type: 'number', required: true,  coerce: 'number',   default: 60 },
  studentInfo:    { type: 'boolean', required: false, coerce: 'boolean', default: false },

  endTitle:    { type: 'string', required: false, format: 'literal', default: 'End of Answer Sheet' },
  endSubtitle: { type: 'string', required: false, format: 'literal',
                 default: 'Please check your answers before submission.' },
  endMessage:  { type: 'string', required: false, format: 'literal',
                 default: 'Once submitted, your answer sheet will be scored automatically. View your detailed results and explanations on MedVix.' },
  endFeatures: {
    type: 'array', required: false,
    itemSchema: { type: 'string', format: 'literal' },
    default: () => ['📊 Instant Scoring', '📝 Full Explanations', '🧠 Weakness Analysis', '📅 Retake Scheduler']
  },
  ctaText:     { type: 'string', required: false, format: 'literal', default: 'Submit & View Results on MedVix' },
  ctaUrl:      { type: 'string', required: false, format: 'string',  sanitize: sanitizeUrl,
                 default: 'https://medvix.co.ke' },
  disclaimer:  { type: 'string', required: false, format: 'literal',
                 default: 'This answer sheet is for practice purposes. MedVix is not responsible for official exam administration.' }
};

// ── Answer Key ─────────────────────────────────────────────────────────────

const ANSWER_ITEM_SCHEMA = {
  id:            { type: 'string', required: false, format: 'literal', default: '' },
  question:      { type: 'string', required: false, format: 'literal', default: '' },
  correctOption: { type: 'string', required: false, format: 'literal', default: '' },
  explanation:   { type: 'any',    required: false, default: null, sanitize: sanitizeExplanation }
};

const ANSWER_KEY_SCHEMA = {
  id:       { type: 'string', required: false, format: 'literal', sanitize: sanitizeId, default: null },
  title:    { type: 'string', required: false, format: 'literal', default: 'Answers & Marking Scheme', maxLength: 200 },
  subtitle: { type: 'string', required: false, format: 'literal', default: '' },
  subject:  { type: 'string', required: false, format: 'literal', default: 'General', maxLength: 100 },
  date:     { type: 'string', required: false, format: 'literal', sanitize: sanitizeDate },

  answers: {
    type: 'array', required: true,
    objectSchema: ANSWER_ITEM_SCHEMA,
    default: []
  },

  endTitle:    { type: 'string', required: false, format: 'literal', default: 'Answer Key Complete' },
  endSubtitle: { type: 'string', required: false, format: 'literal',
                 default: 'You have reviewed all answers for this assessment.' },
  endMessage:  { type: 'string', required: false, format: 'literal',
                 default: 'Use these explanations to identify knowledge gaps. Return to MedVix for personalised revision.' },
  endFeatures: {
    type: 'array', required: false,
    itemSchema: { type: 'string', format: 'literal' },
    default: () => ['📊 Performance Review', '📝 Retake Exam', '🧠 Flashcards', '📅 Study Schedule']
  },
  ctaText:     { type: 'string', required: false, format: 'literal', default: 'Continue Learning on MedVix' },
  ctaUrl:      { type: 'string', required: false, format: 'string',  sanitize: sanitizeUrl,
                 default: 'https://medvix.co.ke' },
  disclaimer:  { type: 'string', required: false, format: 'literal',
                 default: 'This document was generated by MedVix for self-assessment.' }
};

// ── Analytics ──────────────────────────────────────────────────────────────

const METRIC_ITEM_SCHEMA = {
  label: { type: 'string', required: true,  format: 'literal' },
  value: { type: 'string', required: true,  format: 'literal' },
  trend: { type: 'string', required: false, format: 'literal', default: '' }
};

const TOPIC_ITEM_SCHEMA = {
  name:      { type: 'string', required: true,  format: 'literal' },
  questions: { type: 'string', required: false, format: 'literal', default: '' },
  accuracy:  { type: 'string', required: false, format: 'literal', default: '' },
  trend:     { type: 'string', required: false, format: 'literal', default: '' }
};

const INSIGHT_ITEM_SCHEMA = {
  label: { type: 'string', required: false, format: 'literal', default: 'Insight' },
  text:  { type: 'string', required: true,  format: 'literal' }
};

const ANALYTICS_SCHEMA = {
  id:    { type: 'string', required: false, format: 'literal', sanitize: sanitizeId, default: null },
  title: { type: 'string', required: false, format: 'literal', default: 'Performance Report', maxLength: 200 },
  owner: { type: 'string', required: false, format: 'literal', default: 'Student', maxLength: 80 },
  date:  { type: 'string', required: false, format: 'literal', sanitize: sanitizeDate },

  metrics: {
    type: 'array', required: false,
    objectSchema: METRIC_ITEM_SCHEMA,
    default: () => []
  },
  topics: {
    type: 'array', required: false,
    objectSchema: TOPIC_ITEM_SCHEMA,
    default: () => []
  },
  insights: {
    type: 'array', required: false,
    objectSchema: INSIGHT_ITEM_SCHEMA,
    default: () => []
  },

  endTitle:    { type: 'string', required: false, format: 'literal', default: 'Your Progress, Tracked' },
  endSubtitle: { type: 'string', required: false, format: 'literal',
                 default: 'See how far you have come and where to focus next.' },
  endMessage:  { type: 'string', required: false, format: 'literal',
                 default: 'Analytics help you turn study time into measurable results.' },
  endFeatures: {
    type: 'array', required: false,
    itemSchema: { type: 'string', format: 'literal' },
    default: () => ['📈 Trend Reports', '📊 Weakness Analysis', '🎯 Goal Setting', '⏱️ Time Management']
  },
  ctaText:     { type: 'string', required: false, format: 'literal', default: 'Open Full Analytics on MedVix' },
  ctaUrl:      { type: 'string', required: false, format: 'string',  sanitize: sanitizeUrl,
                 default: 'https://medvix.co.ke' },
  disclaimer:  { type: 'string', required: false, format: 'literal',
                 default: 'This report was generated automatically by MedVix.' }
};

// ── Registry ───────────────────────────────────────────────────────────────

export const SCHEMAS = Object.freeze({
  notes:        NOTES_SCHEMA,
  exam:         EXAM_SCHEMA,
  'mcq-sheet':  MCQ_SHEET_SCHEMA,
  'answer-key': ANSWER_KEY_SCHEMA,
  analytics:    ANALYTICS_SCHEMA
});

export const DOC_TYPES = Object.freeze(Object.keys(SCHEMAS));

// ═══════════════════════════════════════════════════════════════════════════
// 8. Validation engine
// ═══════════════════════════════════════════════════════════════════════════

function applyFormat(value, format) {
  switch (format) {
    case 'literal':  return escapeTypstLiteral(value);
    case 'string':   return escapeTypstString(value);
    case 'markdown': return markdownToTypst(value);
    case 'html':     return htmlToTypst(value);
    case 'none':
    default:         return value;
  }
}

function coerce(value, kind) {
  switch (kind) {
    case 'number':  return Number(value);
    case 'boolean': return Boolean(value);
    case 'string':  return String(value);
    default:        return value;
  }
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertType(fieldName, value, spec) {
  const t = spec.type;
  if (t === 'any') return;
  if (t === 'string' && typeof value !== 'string') {
    throw new ValidationError(
      `Field "${fieldName}": expected string, got ${typeOf(value)}`,
      { field: fieldName, expected: 'string', received: typeOf(value) }
    );
  }
  if (t === 'number' && typeof value !== 'number') {
    throw new ValidationError(
      `Field "${fieldName}": expected number, got ${typeOf(value)}`,
      { field: fieldName, expected: 'number', received: typeOf(value) }
    );
  }
  if (t === 'boolean' && typeof value !== 'boolean') {
    throw new ValidationError(
      `Field "${fieldName}": expected boolean, got ${typeOf(value)}`,
      { field: fieldName, expected: 'boolean', received: typeOf(value) }
    );
  }
  if (t === 'array' && !Array.isArray(value)) {
    throw new ValidationError(
      `Field "${fieldName}": expected array, got ${typeOf(value)}`,
      { field: fieldName, expected: 'array', received: typeOf(value) }
    );
  }
  if (t === 'enum' && !Array.isArray(spec.enum)) {
    throw new ValidationError(
      `Internal error: enum field "${fieldName}" is missing its enum list`,
      { field: fieldName }
    );
  }
}

function processScalar(fieldName, spec, rawValue) {
  let value = rawValue;

  // 1. Missing value → default or error.
  if (value === undefined || value === null || value === '') {
    if (spec.default !== undefined && spec.default !== null) {
      value = typeof spec.default === 'function' ? spec.default() : spec.default;
      // If the default is an empty string and the field is required, still error.
      if (spec.required && (value === '' || value == null)) {
        throw new ValidationError(`Field "${fieldName}" is required`, { field: fieldName });
      }
    } else if (spec.required) {
      throw new ValidationError(`Field "${fieldName}" is required`, { field: fieldName });
    } else {
      return undefined;
    }
  }

  // 2. Coerce if requested.
  if (spec.coerce) value = coerce(value, spec.coerce);

  // 3. Type check.
  assertType(fieldName, value, spec);

  // 4. Length truncation.
  if (typeof spec.maxLength === 'number') {
    if (typeof value === 'string') value = value.slice(0, spec.maxLength);
    if (Array.isArray(value))      value = value.slice(0, spec.maxLength);
  }

  // 5. Enum check.
  if (spec.type === 'enum') {
    if (!spec.enum.includes(value)) {
      throw new ValidationError(
        `Field "${fieldName}": value not in allowed set`,
        { field: fieldName, allowed: spec.enum.slice(), received: value }
      );
    }
  }

  // 6. Custom sanitize.
  if (typeof spec.sanitize === 'function') {
    const sanitized = spec.sanitize(value);
    if (sanitized === null && spec.required) {
      throw new ValidationError(
        `Field "${fieldName}": sanitizer rejected the value`,
        { field: fieldName, received: value }
      );
    }
    if (sanitized !== null) value = sanitized;
  }

  // 7. Format transformation.
  if (typeof value === 'string') {
    value = applyFormat(value, spec.format);
  }

  return value;
}

function processArray(fieldName, spec, rawValue) {
  let arr = rawValue;

  // Missing → default.
  if (arr === undefined || arr === null) {
    if (spec.default !== undefined && spec.default !== null) {
      arr = typeof spec.default === 'function' ? spec.default() : spec.default;
      // Return a fresh array so freeze doesn't affect the default closure.
      arr = Array.isArray(arr) ? arr.slice() : [];
    } else if (spec.required) {
      throw new ValidationError(`Field "${fieldName}" is required`, { field: fieldName });
    } else {
      return undefined;
    }
  }

  if (!Array.isArray(arr)) {
    throw new ValidationError(
      `Field "${fieldName}": expected array, got ${typeOf(arr)}`,
      { field: fieldName, expected: 'array', received: typeOf(arr) }
    );
  }

  if (typeof spec.maxLength === 'number') arr = arr.slice(0, spec.maxLength);

  // Array of primitives with a spec.
  if (spec.itemSchema) {
    return arr.map((item, idx) => {
      try {
        return processScalar(`${fieldName}[${idx}]`, spec.itemSchema, item);
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw new ValidationError(
          `Field "${fieldName}[${idx}]": ${err && err.message ? err.message : 'invalid item'}`,
          { field: `${fieldName}[${idx}]`, cause: err }
        );
      }
    }).filter(v => v !== undefined);
  }

  // Array of objects with a nested schema.
  if (spec.objectSchema) {
    return arr.map((item, idx) => {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        throw new ValidationError(
          `Field "${fieldName}[${idx}]": expected object, got ${typeOf(item)}`,
          { field: `${fieldName}[${idx}]`, expected: 'object', received: typeOf(item) }
        );
      }
      const out = {};
      for (const [subName, subSpec] of Object.entries(spec.objectSchema)) {
        const subValue = processScalar(`${fieldName}[${idx}].${subName}`, subSpec, item[subName]);
        if (subValue !== undefined) out[subName] = subValue;
      }
      return out;
    });
  }

  // No item shape described — assume array of primitives to pass through as-is.
  return arr.slice();
}

function processField(fieldName, spec, rawValue) {
  if (spec.type === 'array') return processArray(fieldName, spec, rawValue);
  return processScalar(fieldName, spec, rawValue);
}

/**
 * Deep-freeze a value recursively. Safe on primitives, arrays, and plain objects.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;

  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

/**
 * Validate, normalize, sanitize, and freeze a document payload.
 *
 * @param {object} raw   Caller-supplied data (untrusted).
 * @param {string} type  Document type key from DOC_TYPES.
 * @returns {object}     Frozen, Typst-safe document object.
 * @throws {ValidationError} On structural or type errors.
 */
export function validateDocData(raw, type) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(
      'Document data must be a plain object',
      { received: typeOf(raw) }
    );
  }
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(SCHEMAS, type)) {
    throw new ValidationError(
      `Unknown document type: "${type}"`,
      { type, allowed: DOC_TYPES.slice() }
    );
  }

  const schema = SCHEMAS[type];
  const result = {};

  // Iterate schema fields in a fixed, declaration order for determinism.
  for (const [fieldName, spec] of Object.entries(schema)) {
    const value = processField(fieldName, spec, raw[fieldName]);
    if (value !== undefined) result[fieldName] = value;
  }

  // Provide a stable default id when none was supplied and none resolved.
  if (!result.id) {
    result.id = generateDeterministicId(type, raw);
  }

  return deepFreeze(result);
}

// ── Deterministic ID generation ─────────────────────────────────────────────
//
// Same input → same id → byte-identical PDFs across Web and Capacitor.
// Uses FNV-1a on a stable stringified projection of the document.

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function fnv1aHash(str) {
  let h = 0x811C9DC5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

const ID_PREFIX = Object.freeze({
  notes:        'MH-NT',
  exam:         'MH-EX',
  'mcq-sheet':  'MH-MCQ',
  'answer-key': 'MH-AK',
  analytics:    'MH-AN'
});

function generateDeterministicId(type, raw) {
  const prefix = ID_PREFIX[type] || 'MH-DOC';
  const seed = stableStringify({
    type,
    title: raw.title || '',
    subject: raw.subject || '',
    // Exclude any caller-provided date/id fields so the seed is stable
    // across re-validations of the same logical content.
    content: raw.content || raw.contentHTML || '',
    questionsLen: Array.isArray(raw.questions) ? raw.questions.length : 0,
    answersLen:   Array.isArray(raw.answers)   ? raw.answers.length   : 0
  });
  const hash = fnv1aHash(seed).toString(36).toUpperCase().padStart(7, '0');
  return `${prefix}-${hash}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Ready
// ═══════════════════════════════════════════════════════════════════════════

// Intentionally no logging — File 2 is pure and silent by design.