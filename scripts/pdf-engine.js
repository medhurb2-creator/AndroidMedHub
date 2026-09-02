/**
 * MedVix Unified Print & PDF Engine v6.0
 * - Self-contained: actual logo & QR embedded as base64
 * - JavaScript pagination for notes (no browser slicing)
 * - Fixed A4 pages, headers, footers, watermarks on every page
 * - Pure ES module + window globals
 */

console.log('[pdf-engine] Module loading...');

// --------------------------------------------------------------------------
// 1. EMBEDDED BASE64 IMAGES – loaded from external text files
// --------------------------------------------------------------------------
let LOGO_BASE64 = '';
let QR_BASE64 = '';

async function loadAndCleanBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url} (${resp.status})`);
  let text = await resp.text();
  // Remove PEM headers and all whitespace (leaves only raw base64)
  text = text.replace(/-----BEGIN CERTIFICATE-----/g, '');
  text = text.replace(/-----END CERTIFICATE-----/g, '');
  text = text.replace(/\s/g, '');   // remove spaces, newlines, etc.
  return text;
}

// Promise that resolves when both files are loaded (or falls back to transparent)
const imageLoadPromise = Promise.all([
  loadAndCleanBase64('/assets/images/logo_base64.txt'),
  loadAndCleanBase64('/assets/images/qr_base64.txt')
]).then(([logo, qr]) => {
  LOGO_BASE64 = logo;
  QR_BASE64 = qr;
  console.log('[pdf-engine] Successfully loaded and cleaned logo & QR data');
}).catch(err => {
  console.warn('[pdf-engine] Could not load image files, using transparent fallback', err);
  LOGO_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  QR_BASE64 = LOGO_BASE64;
});

// Getters for the final data-URI strings – no top-level await needed
function getLogoUrl() {
  return `data:image/jpeg;base64,${LOGO_BASE64}`;
}
function getQrUrl() {
  return `data:image/jpeg;base64,${QR_BASE64}`;
}
// --------------------------------------------------------------------------
// 2. DESIGN SYSTEM CSS (fixed‑height pages, print‑only breaks)
// --------------------------------------------------------------------------
const STYLE_ID = 'medhub-engine-styles-v6';
const designCSS = `
:root {
  --brand-primary: #1976d2;
  --brand-primary-dark: #125ca8;
  --brand-primary-light: #e3f0fd;
  --text-heading: #1f2937;
  --text-body: #374151;
  --text-muted: #64748b;
  --text-light: #94a3b8;
  --bg-page: #ffffff;
  --bg-light: #f7f9fc;
  --bg-light-alt: #f8fafc;
  --border-light: #e2e8f0;
  --border-divider: var(--brand-primary);
  --border-divider-height: 3px;
  --font-family: 'Inter', Arial, sans-serif;
  --font-size-xl: 38px;      /* was 34 */
  --font-size-lg: 28px;      /* was 26 */
  --font-size-md: 20px;      /* was 18 */
  --font-size-base: 16px;    /* was 14 */
  --font-size-sm: 14px;      /* was 13 */
  --font-size-xs: 12px;      /* was 11 */
  --space-xs: 10px;           /* slight increase for breathing room */
  --space-sm: 14px;
  --space-md: 20px;
  --space-lg: 28px;
  --space-xl: 44px;
  --card-bg: var(--bg-light);
  --card-border: var(--border-light);
  --card-radius: 12px;
  --notice-border-left: 5px solid var(--brand-primary);
  --notice-bg: var(--bg-light);
  --page-padding: 25mm;
}

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: #eef2f7;
    font-family: var(--font-family);
    padding: 40px;
    color: var(--text-body);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  /* Every page is a fixed A4 block – no flexible height */
  .page {
    width: 210mm;
    height: 297mm;                      /* FIXED height, not min-height */
    margin: 0 auto 20px;
    background: var(--bg-page);
    padding: var(--page-padding);
    box-shadow: 0 0 20px rgba(0,0,0,.08);
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    overflow: hidden;                   /* keep content inside */
  }
  .page.last-page {
    /* screen only */
  }

  /* Watermark – always behind content */
  .watermark {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    z-index: 0;
    opacity: 0.05;
    transform: rotate(-30deg);
    font-size: 5rem;
    color: #000;
    font-weight: 700;
    text-align: center;
    line-height: 1.3;
  }

  /* Brand bar */
  .brand-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--space-md); }
  .brand-logo { display: flex; align-items: center; gap: 14px; }
  .logo-img { width: 55px; height: 55px; object-fit: contain; display: block; }
  .brand-name { font-size: 24px; color: var(--brand-primary); margin-bottom: 4px; }
  .brand-tagline { font-size: var(--font-size-sm); color: var(--text-muted); }
  .doc-type-label { text-align: right; }
  .doc-type-title { font-size: var(--font-size-lg); color: var(--brand-primary); margin-bottom: 5px; text-transform: uppercase; letter-spacing: 0.5px; }
  .doc-type-subtitle { font-size: var(--font-size-sm); color: var(--text-muted); }
  .divider { height: var(--border-divider-height); background: var(--border-divider); border-radius: 30px; margin: var(--space-md) 0 var(--space-lg); }
  .doc-title { margin-bottom: 28px; }
  .doc-title h1 { font-size: var(--font-size-xl); color: var(--text-heading); margin-bottom: var(--space-xs); }
  .doc-title p { color: var(--text-muted); font-size: 16px; }
  .meta-table { width: 100%; border-collapse: collapse; margin-bottom: var(--space-md); }
  .meta-table td { padding: 10px 0; font-size: var(--font-size-base); border-bottom: 1px solid var(--border-light); }
  .meta-table strong { color: var(--text-heading); }
  .meta-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; }
  .meta-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--card-radius); padding: 14px; }
  .meta-card .meta-label { font-size: var(--font-size-xs); color: var(--text-light); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: var(--space-xs); }
  .meta-card .meta-value { font-size: 15px; font-weight: 600; color: var(--text-heading); }
  .notice { background: var(--notice-bg); border-left: var(--notice-border-left); padding: 15px; margin: var(--space-lg) 0; font-size: var(--font-size-sm); color: var(--text-body); line-height: 1.7; }
  .notice h3 { color: var(--brand-primary); margin-bottom: 10px; font-size: var(--font-size-md); }
  .instructions h3 { font-size: var(--font-size-md); color: var(--brand-primary); margin-bottom: 10px; }
  .instructions ol { margin-left: 20px; }
  .instructions li { margin-bottom: var(--space-xs); line-height: 1.6; font-size: var(--font-size-base); }
  .questions-section { margin-top: 30px; position: relative; z-index: 1; flex: 1; }
  .questions-section h2 { color: var(--brand-primary); margin-bottom: 20px; }
  .question { margin-bottom: 25px; }
  .question p { font-weight: 600; margin-bottom: var(--space-xs); }
  .options label { display: block; margin: 4px 0 4px 20px; font-size: var(--font-size-base); }
    /* Exam – horizontal options with bright colour */
  .questions-section .options {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 8px 0 0 0;
  }
  .questions-section .options .option {
    display: block;
    color: #0ae6e6;          /* bright blue */
    font-weight: 500;
    font-size: var(--font-size-base);
    margin-left: 0;
  }

  .mcq-grid { margin-top: var(--space-xl); position: relative; z-index: 1; flex: 1; }
  .mcq-grid h2 { color: var(--brand-primary); margin-bottom: 15px; }
    .mcq-columns {
    column-count: 2;
    column-gap: 30px;
    column-fill: auto;
    break-inside: avoid-column;   /* keep each row intact */
  }
  .mcq-row { display: flex; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-light); }
  .q-number { width: 30px; font-weight: 600; color: var(--text-heading); }
  .options { display: flex; gap: 18px; margin-left: 5px; }
  .option { display: flex; align-items: center; gap: 4px; font-size: var(--font-size-base); }
  .bubble { width: 18px; height: 18px; border: 2px solid var(--brand-primary); border-radius: 50%; display: inline-block; }

  /* Global footer – sits at the bottom of the flex column */
.global-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    border-top: 1px solid var(--border-light);
    padding-top: var(--space-xs);
    margin-top: auto;
    z-index: 1;
    width: 100%;
    flex-shrink: 0;       
  }
  .global-footer span { white-space: nowrap; }

  .answers-section { margin-top: var(--space-xl); position: relative; z-index: 1; flex: 1; }
  .answers-section h2 { color: var(--brand-primary); margin-bottom: 15px; }
  .answer-item { margin-bottom: 20px; padding-bottom: 15px; border-bottom: 1px solid var(--border-light); }
  .answer-item p { margin: 5px 0; font-size: var(--font-size-base); line-height: 1.6; }
  .correct { color: var(--brand-primary); font-weight: 600; }
  .explanation { color: var(--text-muted); font-size: var(--font-size-sm); margin-top: 4px; }
  .analytics-content { margin-top: var(--space-xl); position: relative; z-index: 1; flex: 1; }
  .analytics-content h2 { color: var(--brand-primary); margin-bottom: 15px; }
  .chart-placeholder {
    background: var(--bg-light-alt); border: 2px dashed var(--text-light);
    border-radius: var(--card-radius); height: 180px; display: flex;
    align-items: center; justify-content: center; color: var(--text-light);
    font-size: var(--font-size-base); margin-bottom: var(--space-lg);
  }
  .insight-box {
    background: var(--brand-primary-light); border-left: 5px solid var(--brand-primary);
    padding: 15px; margin-bottom: var(--space-lg); font-size: var(--font-size-base);
    color: var(--text-body); line-height: 1.6;
  }
  .insight-box strong { color: var(--brand-primary-dark); }
  .topic-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
  .topic-table th { background: var(--bg-light); text-align: left; padding: 10px; font-size: var(--font-size-sm); color: var(--brand-primary); border-bottom: 2px solid var(--border-light); }
  .topic-table td { padding: 10px; font-size: var(--font-size-base); border-bottom: 1px solid var(--border-light); }
  .notes-content { margin-top: var(--space-xl); line-height: 1.7; color: var(--text-body); position: relative; z-index: 1; flex: 1; }
  .notes-content h2 { color: var(--brand-primary); margin-bottom: 10px; }
  .notes-content h3 { margin: var(--space-md) 0 var(--space-xs); color: var(--text-heading); }
  .notes-content p { margin-bottom: var(--space-sm); }
    .notes-content .mcq-row { margin-bottom: 4px; }

  /* End page */
  .end-page { text-align: center; display: flex; flex-direction: column; justify-content: space-between; min-height: 100%; }
  .end-title { font-size: 30px; color: var(--brand-primary); font-weight: 700; margin-bottom: 12px; }
  .end-subtitle { font-size: 15px; color: var(--text-muted); margin-bottom: 30px; }
  .end-message { font-size: var(--font-size-base); color: var(--text-muted); line-height: 1.6; max-width: 500px; margin: 0 auto 35px auto; }
  .feature-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px; margin-bottom: var(--space-xl); }
  .feature-card { background: var(--bg-light-alt); border-radius: 10px; padding: 16px; font-size: 15px; font-weight: 500; color: var(--text-body); }
  .cta { display: block; background: var(--brand-primary); color: white; padding: 16px 25px; border-radius: 8px; text-decoration: none; font-size: 16px; font-weight: 600; margin: 0 auto var(--space-xl) auto; max-width: 400px; }
  .qr-placeholder { width: 120px; height: 120px; margin: 0 auto 15px; display: flex; align-items: center; justify-content: center; }
  .qr-placeholder img { width: 100%; height: 100%; object-fit: contain; }
  .copyright { font-size: var(--font-size-sm); color: var(--text-muted); }
  .disclaimer { font-size: var(--font-size-sm); color: var(--text-light); line-height: 1.5; max-width: 500px; margin: 0 auto 30px; }
  .end-footer { border-top: 1px solid var(--border-light); padding-top: 15px; display: flex; justify-content: space-between; font-size: var(--font-size-sm); color: var(--text-light); margin-top: auto; }
  .end-footer a { color: var(--text-light); text-decoration: none; }
   
  /* ===== PRINT – only show the document, force breaks ===== */
    /* Hide the print container on screen – only used for printing */
  #medhub-print-mount {
    display: none;
  }
  @media print {
    body > *:not(#medhub-print-mount) {
      display: none !important;
    }
    body {
      background: white;
      padding: 0;
      margin: 0;
    }
    #medhub-print-mount {
      display: block !important;
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
    }
    .page {
      box-shadow: none;
      margin: 0;
      page-break-after: always;          /* printed page break */
      height: 297mm;
      width: 210mm;
      padding: var(--page-padding);
      overflow: hidden;
    }
    .page.last-page {
      page-break-after: auto;
    }
    @page {
      size: A4 portrait;
      margin: 0;
    }
  }
`;


function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;

  // Transform all selectors (except @media, @keyframes, @page, :root) to be scoped
  const scopedCSS = designCSS
    .replace(/(^|\})\s*([^{}]+)\{/g, (match, before, selector) => {
      // Skip @media, @keyframes, @page, :root
      if (selector.trim().startsWith('@media') ||
          selector.trim().startsWith('@keyframes') ||
          selector.trim().startsWith('@page') ||
          selector.trim().startsWith(':root')) {
        return match;
      }
      // Prefix the selector with #medhub-print-mount (unless already prefixed)
      const prefixed = selector.split(',').map(sel => {
        sel = sel.trim();
        if (sel.startsWith('#medhub-print-mount')) return sel;
        return `#medhub-print-mount ${sel}`;
      }).join(', ');
      return `${before}${prefixed}{`;
    });

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = scopedCSS;
  document.head.appendChild(style);
}

// --------------------------------------------------------------------------
// 2. SECURITY – HTML escaping
// --------------------------------------------------------------------------
function esc(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// --------------------------------------------------------------------------
// 3. REUSABLE COMPONENTS (now using the real images)
// --------------------------------------------------------------------------
function brandBar(docTypeTitle, docTypeSub, data) {
  return `
    <div class="brand-bar">
      <div class="brand-logo">
        <img class="logo-img" src="${getLogoUrl()}" alt="MedVix Logo">
        <div>
          <div class="brand-name">MedVix</div>
          <div class="brand-tagline">Medical Exam Room Pro</div>
        </div>
      </div>
      <div class="doc-type-label">
        <h1 class="doc-type-title">${esc(docTypeTitle)}</h1>
        <p class="doc-type-subtitle">${esc(docTypeSub)}</p>
      </div>
    </div>`;
}

function divider() {
  return '<div class="divider"></div>';
}

function globalFooter(pageNum, totalPages, left = 'MedVix • Medical Learning Platform', center = 'Medical Document', right = 'medvix.edgeone.app') {
  return `
    <div class="global-footer">
      <span>${esc(left)}</span>
      <span>${esc(center)}</span>
      <span>${esc(right)} &nbsp; Page ${pageNum} of ${totalPages}</span>
    </div>`;
}

function watermark() {
  return `
    <div class="watermark">
      <span>Created by MedVix</span>
      <span>Join us today</span>
    </div>`;
}

function endPageContent(data) {
  const features = data.endFeatures || [
    '📊 Performance Review', '📝 Answer Explanations', '🧠 Targeted Revision', '📅 Next Exam Scheduler'
  ];
  while (features.length % 2 !== 0) features.push('');
  const featureCards = features.map(f => `<div class="feature-card">${esc(f)}</div>`).join('\n');
  return `
    <div class="end-title">${esc(data.endTitle || 'Exam Complete!')}</div>
    <div class="end-subtitle">${esc(data.endSubtitle || 'You have reached the end of this practice examination.')}</div>
    <p class="end-message">${esc(data.endMessage || 'Review your answers, then check the answer key on MedVix to see your performance.')}</p>
    <div class="feature-grid">${featureCards}</div>
    <a class="cta" href="${esc(data.ctaUrl || '#')}">${esc(data.ctaText || 'Review Answers on MedVix')}</a>
    <div class="qr-placeholder"><img src="${getQrUrl()}" alt="QR Code"></div>
    <p class="copyright">© 2026 MedVix</p>
    <p class="disclaimer">${esc(data.disclaimer || 'This PDF was generated by edVix for educational purposes. The content is not an official institutional exam.')}</p>`;
}

function endPageFooter() {
  return `
    <div class="end-footer">
      <span>MedVix</span>
      <span>Document Export</span>
      <span><a href="https://medvix.edgeone.app">medvix.edgeone.app</a></span>
    </div>`;
}

function createEndPage(data, totalPages) {
  return `
    <div class="page last-page">
      <div class="end-page">
        <div>${endPageContent(data)}</div>
        ${endPageFooter()}
      </div>
    </div>`;
}

// --------------------------------------------------------------------------
// 4. V7 PAGE-DRIVEN LAYOUT ENGINE – Robust production version
//    - Inline DOM tree preserved during paragraph splits
//    - Long words are broken character‑by‑character
//    - Lists, tables, quotes split without mutating the document
//    - Cached measurements (word + style key)
//    - Widow/orphan control, two‑pass page numbering
// --------------------------------------------------------------------------

const MM_TO_PX = 3.779527559;
const PAGE_WIDTH_MM = 210;
const PAGE_HEIGHT_MM = 297;
const PAGE_PAD_MM = 25;
const SAFETY_ZONE = 0.06;           // 6% of content height
const MIN_ORPHAN = 2;             // minimum lines of a paragraph at bottom/top
const PARAGRAPH_MARGIN_BOTTOM = 14;   // matches CSS .notes-content p margin-bottom
const QUESTION_MARGIN_BOTTOM = 25;   // .question margin-bottom
const ANSWER_MARGIN_BOTTOM = 20;   // .answer-item margin-bottom

// ── Smart sentence tokeniser ──
const ABBREV = new Set([
  'dr', 'mr', 'ms', 'mrs', 'prof', 'sr', 'jr', 'rev', 'hon', 'st', 'dept', 'univ',
  'e.g', 'i.e', 'vs', 'etc', 'al', 'fig', 'eq', 'approx', 'est', 'vol', 'pg', 'ch'
]);

function splitSentences(text) {
  if (!text) return [''];
  const out = [];
  let start = 0, len = text.length;
  for (let i = 0; i < len; i++) {
    const ch = text[i];
    if (ch === '.' || ch === '?' || ch === '!') {
      const before = text.substring(start, i).trimEnd();
      const lastWord = before.split(/\s+/).pop()?.toLowerCase() || '';
      if (lastWord && ABBREV.has(lastWord.replace(/\.$/, ''))) continue;
      const sentence = text.substring(start, i + 1).trim();
      if (sentence) out.push(sentence);
      start = i + 1;
    }
  }
  if (start < len) {
    const rest = text.substring(start).trim();
    if (rest) out.push(rest);
  }
  return out.length ? out : [text];
}

// ── Measurement sandbox (exact page clone) ──
class MeasureCtx {
  constructor() {
    this.div = document.createElement('div');
    Object.assign(this.div.style, {
      position: 'absolute', left: '-9999px', visibility: 'hidden',
      width: ((PAGE_WIDTH_MM - 2 * PAGE_PAD_MM) * MM_TO_PX) + 'px',
      padding: '0', margin: '0',
      fontFamily: 'Inter, Arial, sans-serif',
      fontSize: '16px', lineHeight: '1.6',
      color: '#374151', background: '#fff',
      whiteSpace: 'normal', wordBreak: 'break-word'
    });
    document.body.appendChild(this.div);
    this._lineHeight = null;
    this._spaceWidth = null;
    // Cache keyed by word + openTags + closeTags to avoid measuring same word multiple times
    this.wordWidthCache = new Map();
    this.blockHeightCache = new Map();
  }

  get lineHeight() {
    if (this._lineHeight == null) {
      const probe = document.createElement('div'); probe.textContent = 'X';
      this.div.appendChild(probe);
      this._lineHeight = probe.offsetHeight;
      this.div.removeChild(probe);
    }
    return this._lineHeight;
  }

  measureWordWidth(word, openTags, closeTags) {
    const key = openTags + '|' + word + '|' + closeTags;
    if (this.wordWidthCache.has(key)) return this.wordWidthCache.get(key);
    const span = document.createElement('span');
    span.style.whiteSpace = 'nowrap';
    span.innerHTML = openTags + word.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + closeTags;
    this.div.appendChild(span);
    const w = span.offsetWidth;
    this.div.removeChild(span);
    this.wordWidthCache.set(key, w);
    return w;
  }

  measureBlockHeight(html) {
    if (this.blockHeightCache.has(html)) return this.blockHeightCache.get(html);
    this.div.innerHTML = html;
    const h = this.div.offsetHeight;
    this.div.innerHTML = '';
    this.blockHeightCache.set(html, h);
    return h;
  }

  destroy() {
    if (this.div.parentNode) this.div.parentNode.removeChild(this.div);
    this.wordWidthCache.clear();
    this.blockHeightCache.clear();
  }
}

// ── Inline DOM tree (preserves structure exactly) ──
class InlineNode { }
class TextNode extends InlineNode {
  constructor(text) { super(); this.text = text; }
}
class StyledNode extends InlineNode {
  constructor(tag, attrs = {}, children = []) {
    super();
    this.tag = tag;
    this.attrs = attrs;
    this.children = children;
  }
}

function parseInlineTree(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return _parseChildren(div);
}

function _parseChildren(el) {
  const nodes = [];
  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = child.textContent;
      if (t.trim() || (t === ' ' && nodes.length > 0)) nodes.push(new TextNode(t));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      const attrs = {};
      for (const attr of child.attributes) attrs[attr.name] = attr.value;
      nodes.push(new StyledNode(tag, attrs, [_parseChildren(child)]));
    }
  }
  // collapse single‑child TextNode to avoid unnecessary nesting
  if (nodes.length === 1 && nodes[0] instanceof TextNode && !el.tagName) return nodes[0];
  // wrap multiple children in a transparent span if needed
  return nodes.length === 1 ? nodes[0] : new StyledNode('span', {}, nodes);
}

function serializeInlineTree(node) {
  if (node instanceof TextNode) {
    return node.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  if (node instanceof StyledNode) {
    const attrStr = Object.entries(node.attrs || {}).map(([k, v]) => ` ${k}="${v.replace(/"/g, '&quot;')}"`).join('');
    const children = node.children.map(serializeInlineTree).join('');
    return `<${node.tag}${attrStr}>${children}</${node.tag}>`;
  }
  return '';
}

// ── Token with style context ──
class WordToken {
  constructor(word, openTags = '', closeTags = '') {
    this.word = word;
    this.openTags = openTags;
    this.closeTags = closeTags;
    this.width = 0;
  }
}

// ── Paragraph layout engine (offline) ──
class ParagraphLayout {
  constructor(inlineTree, maxWidth, measureCtx) {
    this.measureCtx = measureCtx;
    this.maxWidth = maxWidth;
    // Flatten tree into a list of styled tokens
    this.tokens = this._tokenize(inlineTree);
    // Pre‑measure widths
    this.spaceWidth = measureCtx.measureWordWidth(' ', '', '');
    for (const t of this.tokens) {
      if (t instanceof WordToken) {
        t.width = measureCtx.measureWordWidth(t.word, t.openTags, t.closeTags);
      }
    }
    // Build all lines (word + character breaking)
    this.lines = this._buildLines();
  }

  _tokenize(tree) {
    const tokens = [];
    const openStack = [];
    const closeStack = [];

    const walk = (node) => {
      if (node instanceof TextNode) {
        const words = node.text.split(/(\s+)/);
        for (const w of words) {
          if (w === ' ') {
            // replace space with a zero‑width space? No, we treat spaces as word separators
            // Instead we add a space token after each word (handled later)
            continue;
          }
          if (w.trim()) {
            const openTags = openStack.join('');
            const closeTags = closeStack.slice().reverse().join('');
            tokens.push(new WordToken(w, openTags, closeTags));
          }
        }
      } else if (node instanceof StyledNode) {
        const tagStr = `<${node.tag}${Object.entries(node.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>`;
        openStack.push(tagStr);
        closeStack.push(`</${node.tag}>`);
        node.children.forEach(walk);
        openStack.pop();
        closeStack.pop();
      }
    };
    walk(tree);
    return tokens;
  }

  _buildLines() {
    const lines = [];
    let currentLine = [];
    let currentWidth = 0;
    const maxW = this.maxWidth;

    const flush = () => {
      if (currentLine.length > 0) {
        lines.push(currentLine);
        currentLine = [];
        currentWidth = 0;
      }
    };

    for (let i = 0; i < this.tokens.length; i++) {
      const tok = this.tokens[i];
      const wordW = tok.width;
      const spaceNeeded = currentLine.length > 0 ? this.spaceWidth : 0;

      if (currentWidth + spaceNeeded + wordW <= maxW) {
        // fits
        if (currentLine.length > 0) currentLine.push({ type: 'space' });
        currentLine.push(tok);
        currentWidth += spaceNeeded + wordW;
      } else {
        // word doesn't fit on current line
        // first try to move the whole word to next line
        if (currentLine.length === 0) {
          // single word overflows the line width -> break word
          // break word into characters, each wrapped with original style
          this._breakLongWord(tok, maxW, lines);
        } else {
          // flush current line, then try again with this word
          flush();
          i--; // reprocess this word on next iteration
        }
      }
    }
    flush();
    return lines;
  }

  _breakLongWord(token, maxWidth, lines) {
    const chars = [...token.word];
    let chunk = '';
    let chunkWidth = 0;
    for (let i = 0; i < chars.length; i++) {
      const charWidth = this.measureCtx.measureWordWidth(chars[i], token.openTags, token.closeTags);
      if (chunkWidth + charWidth > maxWidth && chunk.length > 0) {
        // push chunk as a line
        const lineToken = new WordToken(chunk, token.openTags, token.closeTags);
        lineToken.width = chunkWidth;
        lines.push([lineToken]);
        chunk = '';
        chunkWidth = 0;
      }
      chunk += chars[i];
      chunkWidth += charWidth;
    }
    if (chunk.length > 0) {
      const lineToken = new WordToken(chunk, token.openTags, token.closeTags);
      lineToken.width = chunkWidth;
      lines.push([lineToken]);
    }
  }
}

// ── Page model (layout instructions only) ──
class Page {
  constructor(pgNum, measureCtx) {
    this.pageNumber = pgNum;
    this.status = 'OPEN';
    this.widthPx = (PAGE_WIDTH_MM - 2 * PAGE_PAD_MM) * MM_TO_PX;
    this.heightPx = (PAGE_HEIGHT_MM - 2 * PAGE_PAD_MM) * MM_TO_PX;
    this.headerH = 0;
    this.footerH = 0;
    this.safetyH = 0;
    this.contentTop = 0;
    this.contentBottom = this.heightPx;
    this.currentY = 0;
    this.remainingH = 0;
    this.headerHTML = '';
    this.footerHTML = '';
    this.watermarkHTML = '';
    // Store layout instructions, not full HTML
    this.content = [];
    this.measureCtx = measureCtx;
  }

  setHeader(html, h) { this.headerHTML = html; this.headerH = h; }
  reserveFooter(html, h) { this.footerHTML = html; this.footerH = h; }
  setSafetyZone() { this.safetyH = Math.floor(this.heightPx * SAFETY_ZONE); }

  finalizeLayout() {
    const reserved = this.headerH + this.footerH + this.safetyH;
    this.contentTop = this.headerH;
    this.contentBottom = this.heightPx - this.footerH - this.safetyH;
    this.currentY = this.contentTop;
    this.remainingH = this.contentBottom - this.contentTop;
  }

  canFitLine(lineH) { return (this.currentY + lineH) <= this.contentBottom; }

  addContent(item) { this.content.push(item); }

toHTML() {
  let html = '';
  for (const item of this.content) {
    switch (item.type) {
      case 'heading':
        html += item.html;
        break;
      case 'paragraph':
        html += '<p>';
        for (const line of item.lines) {
          if (typeof line === 'string') { html += line; continue; }
          for (const seg of line) {
            if (seg.type === 'space') { html += ' '; }
            else if (seg instanceof WordToken) {
              html += seg.openTags + seg.word.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + seg.closeTags;
            }
          }
        }
        html += '</p>';
        break;
      case 'list':
        html += item.html;
        break;
      case 'table':
        html += item.html;
        break;
      case 'code':
        html += '<pre><code>' + item.lines.join('\n') + '</code></pre>';
        break;
      case 'quote':
        html += '<blockquote>' + item.innerHTML + '</blockquote>';
        break;
      default:
        html += item.html || '';
    }
  }

  return `<div class="page">
    ${this.watermarkHTML}
    ${this.headerHTML}
    <div class="notes-content" style="margin-top:0;">${html}</div>
    ${this.footerHTML}
  </div>`;
}
}

// ── Cursor with per‑block progress state (no document mutation) ──
class Cursor {
  constructor(sections) {
    this.sections = sections;
    this.secIdx = 0;
    this.blkIdx = 0;
    this.blockState = new Map();   // key: `${secIdx}-${blkIdx}` => state object
  }

  hasMore() {
    if (this.secIdx >= this.sections.length) return false;
    const sec = this.sections[this.secIdx];
    if (this.blkIdx >= sec.blocks.length) {
      this.secIdx++;
      this.blkIdx = 0;
      return this.hasMore();
    }
    return true;
  }

  currentBlock() { return this.sections[this.secIdx].blocks[this.blkIdx]; }

  advanceBlock() {
    this.blkIdx++;
  }

  getBlockState(block) {
    const key = `${this.secIdx}-${this.blkIdx}`;
    if (!this.blockState.has(key)) this.blockState.set(key, {});
    return this.blockState.get(key);
  }

  clearBlockState(block) {
    const key = `${this.secIdx}-${this.blkIdx}`;
    this.blockState.delete(key);
  }
}

// ── Section / Block structures ──
class Section {
  constructor(title, blocks) { this.title = title; this.blocks = blocks; }
}
class Block {
  constructor(html, type, opts = {}) {
    this.html = html;
    this.type = type;
    this.splittable = opts.splittable ?? true;
    this.keepWithNext = opts.keepWithNext ?? false;
    this.metadata = opts.metadata || {};
  }
}

// ── Convert HTML to block list ──
function domToBlocks(htmlString) {
  const container = document.createElement('div');
  container.innerHTML = htmlString;
  const blocks = [];
  const walk = node => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent.trim();
      if (t) blocks.push(new Block(`<p>${t}</p>`, 'paragraph'));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    const html = node.outerHTML;
    if (tag.match(/^h[1-6]$/)) {
      blocks.push(new Block(html, 'heading', { splittable: false, keepWithNext: true }));
    } else if (tag === 'p') {
      blocks.push(new Block(html, 'paragraph', { splittable: true }));
    } else if (tag === 'ul' || tag === 'ol') {
      blocks.push(new Block(html, 'list', { splittable: true }));
    } else if (tag === 'table') {
      blocks.push(new Block(html, 'table', { splittable: true }));
    } else if (tag === 'img' || tag === 'figure') {
      const keepNext = node.nextElementSibling?.tagName === 'FIGCAPTION';
      blocks.push(new Block(html, 'image', { splittable: false, keepWithNext: keepNext }));
    } else if (tag === 'pre') {
      blocks.push(new Block(html, 'code', { splittable: true }));
    } else if (tag === 'blockquote') {
      blocks.push(new Block(html, 'quote', { splittable: true }));
    } else if (tag === 'div' || tag === 'section') {
      // MCQ answer sheet rows – keep whole row together
      if (node.classList && node.classList.contains('mcq-row')) {
        blocks.push(new Block(html, 'mcq-row', { splittable: false }));
        return;
      }
      // Custom blocks for exam / answer key
      if (node.classList && node.classList.contains('question')) {
        blocks.push(new Block(html, 'question', { splittable: false }));
        return;
      }
      if (node.classList && node.classList.contains('answer-item')) {
        blocks.push(new Block(html, 'answer', { splittable: false }));
        return;
      }
      // Generic container – walk its children
      node.childNodes.forEach(walk);
    } else {
      if (html.trim()) blocks.push(new Block(`<p>${html}</p>`, 'paragraph', { splittable: true }));
    }
  };
  container.childNodes.forEach(walk);
  return blocks;
}

// ── V7 Engine ──
class PageEngineV7 {
  constructor(opts = {}) {
    this.headerBuilder = opts.headerBuilder;
    this.footerBuilder = opts.footerBuilder;
    this.watermarkBuilder = opts.watermarkBuilder;
    this.firstPageHeader = opts.firstPageHasHeader !== false;
    this.measureCtx = new MeasureCtx();
    this.pages = [];
    this.lineH = this.measureCtx.lineHeight;
    this.minOrphan = opts.minOrphanLines || MIN_ORPHAN;
  }

  render(sections) {
    const cursor = new Cursor(sections);
    let pageNum = 1, isFirst = true;
    while (cursor.hasMore()) {
      const page = new Page(pageNum, this.measureCtx);

      const headerHTML = (isFirst && this.firstPageHeader) ? this.headerBuilder(true) : '';
      const headerH = headerHTML ? this.measureCtx.measureBlockHeight(`<div>${headerHTML}</div>`) : 0;
      page.setHeader(headerHTML, headerH);
      page.watermarkHTML = isFirst ? '' : this.watermarkBuilder();
      const tmpFooter = this.footerBuilder(pageNum, 1);
      const footerH = this.measureCtx.measureBlockHeight(`<div>${tmpFooter}</div>`);
      page.reserveFooter(tmpFooter, footerH);
      page.setSafetyZone();
      page.finalizeLayout();

      this._layoutPage(page, cursor);
      page.status = 'CLOSED';
      this.pages.push(page);
      isFirst = false;
      pageNum++;
    }

    const total = this.pages.length;
    return this.pages.map((page, idx) => {
      page.footerHTML = this.footerBuilder(idx + 1, total);
      return page.toHTML();
    });
  }

  _layoutPage(page, cursor) {
    while (cursor.hasMore()) {
      const block = cursor.currentBlock();
      switch (block.type) {
        case 'heading': if (!this._layHeading(page, block, cursor)) return; break;
        case 'paragraph': if (!this._layParagraph(page, block, cursor)) return; break;
        case 'list': if (!this._layList(page, block, cursor)) return; break;
        case 'table': if (!this._layTable(page, block, cursor)) return; break;
        case 'image': if (!this._layImage(page, block, cursor)) return; break;
        case 'code': if (!this._layCode(page, block, cursor)) return; break;
        case 'quote': if (!this._layQuote(page, block, cursor)) return; break;
        case 'question': if (!this._layQuestion(page, block, cursor)) return; break;
        case 'answer': if (!this._layAnswer(page, block, cursor)) return; break;
        case 'mcq-row': if (!this._layGeneric(page, block, cursor)) return; break;
        case 'mcq-grid':     if (!this._layMcqGrid(page, block, cursor)) return; break;
        default: if (!this._layGeneric(page, block, cursor)) return;
      }
    }
  }

  _layHeading(page, block, cursor) {
    const h = this.measureCtx.measureBlockHeight(block.html);
    if (!page.canFitLine(h)) return false;
    const nextBlock = this._peekNextBlock(cursor);
    // allow heading on page 1 even if it would leave too few body lines
    if (page.pageNumber > 1 && nextBlock && nextBlock.type === 'paragraph') {
      const possible = Math.floor((page.remainingH - h) / this.lineH);
      if (possible < this.minOrphan) return false;
    }
    page.addContent({ type: 'heading', html: block.html });
    page.currentY += h;
    page.remainingH -= h;
    cursor.advanceBlock();
    return true;
  }

  _layParagraph(page, block, cursor) {
    const state = cursor.getBlockState(block);
    if (!state.layout) {
      const tree = parseInlineTree(block.html.replace(/<\/?p[^>]*>/g, ''));
      state.layout = new ParagraphLayout(tree, (PAGE_WIDTH_MM - 2 * PAGE_PAD_MM) * MM_TO_PX, this.measureCtx);
      state.lineOffset = 0;
    }
    const layout = state.layout;
    const allLines = layout.lines;
    let offset = state.lineOffset;
    let linesPlaced = 0;

    while (offset < allLines.length) {
      if (!page.canFitLine(layout.measureCtx.lineHeight)) break;
      // Only enforce orphan rule on pages after the first
      if (linesPlaced === 0 && offset > 0 && (allLines.length - offset) < this.minOrphan && page.pageNumber > 1) {
        break;
      }
      linesPlaced++;
      offset++;
    }

    if (linesPlaced === 0 && offset > 0) return false;

    if (linesPlaced > 0) {
      const placedLines = allLines.slice(state.lineOffset, offset);
      page.addContent({ type: 'paragraph', lines: placedLines });
      page.currentY += linesPlaced * layout.measureCtx.lineHeight;
      page.remainingH -= linesPlaced * layout.measureCtx.lineHeight;
      state.lineOffset = offset;
    }

    if (offset >= allLines.length) {
      // paragraph finished
      cursor.clearBlockState(block);
      cursor.advanceBlock();
      // account for CSS margin-bottom of <p>
      page.currentY += PARAGRAPH_MARGIN_BOTTOM;
      page.remainingH -= PARAGRAPH_MARGIN_BOTTOM;
      return true;
    } else {
      // paragraph not finished, continue on next page
      return false;
    }
  }
  _layMcqGrid(page, block, cursor) {
    const state = cursor.getBlockState(block);
    if (!state.parsed) {
      // Extract all rows from the two‑column container
      const container = document.createElement('div');
      container.innerHTML = block.html;
      const rowElements = Array.from(container.querySelectorAll('.mcq-row'));
      state.allRows = rowElements.map(r => r.outerHTML);
      state.rowIdx = 0;                    // next row to place
      // Measure the height of a single row inside a two‑column wrapper
      const sampleHTML = `<div class="mcq-columns">${state.allRows[0] || ''}</div>`;
      state.rowHeight = this.measureCtx.measureBlockHeight(sampleHTML);
      state.parsed = true;
    }

    const availableH = page.remainingH;                // content space left
    const rowHeight = state.rowHeight;                 // height of one row in columns
    const maxRowsPerColumn = Math.max(1, Math.floor(availableH / rowHeight));
    const maxRows = maxRowsPerColumn * 2;              // two columns
    const remainingRows = state.allRows.length - state.rowIdx;
    let rowsToPlace = Math.min(maxRows, remainingRows);

    if (rowsToPlace === 0) return false;               // nothing fits? force new page

    // Build the candidate group and measure its real height
    let endIdx = state.rowIdx + rowsToPlace;
    let groupHTML = `<div class="mcq-columns">${state.allRows.slice(state.rowIdx, endIdx).join('')}</div>`;
    let groupHeight = this.measureCtx.measureBlockHeight(groupHTML);

    // If the estimate was too high, binary‑search the exact number that fits
    if (!page.canFitLine(groupHeight)) {
      let lo = 1, hi = rowsToPlace, best = 0;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const testHTML = `<div class="mcq-columns">${state.allRows.slice(state.rowIdx, state.rowIdx + mid).join('')}</div>`;
        const testH = this.measureCtx.measureBlockHeight(testHTML);
        if (page.canFitLine(testH)) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best === 0) return false;                     // even one row doesn’t fit → new page
      rowsToPlace = best;
      endIdx = state.rowIdx + rowsToPlace;
      groupHTML = `<div class="mcq-columns">${state.allRows.slice(state.rowIdx, endIdx).join('')}</div>`;
      groupHeight = this.measureCtx.measureBlockHeight(groupHTML);
    }

    // Place the group on the page
    page.addContent({ type: 'generic', html: groupHTML });
    page.currentY += groupHeight;
    page.remainingH -= groupHeight;
    state.rowIdx = endIdx;

    // All rows consumed → block finished
    if (state.rowIdx >= state.allRows.length) {
      cursor.clearBlockState(block);
      cursor.advanceBlock();
      return true;
    }
    // More rows remain for the next page
    return false;
  }
  _layList(page, block, cursor) {
    const state = cursor.getBlockState(block);
    if (!state.parsed) {
      const container = document.createElement('div');
      container.innerHTML = block.html;
      const listEl = container.querySelector('ul,ol');
      if (!listEl) { cursor.advanceBlock(); return true; }
      state.listTag = listEl.tagName.toLowerCase();
      state.items = Array.from(listEl.children).filter(li => li.tagName === 'LI').map(li => ({
        html: li.outerHTML,
        innerTree: parseInlineTree(li.innerHTML), // for potential splitting
        rendered: false
      }));
      state.currentIdx = 0;
      state.partialItemState = null; // for long item splitting
      state.parsed = true;
    }

    let idx = state.currentIdx;
    const items = state.items;
    let html = '';

    // Reopen list if continuing
    if (idx > 0 || state.partialItemState) {
      html += `<${state.listTag}>`;
    }

    while (idx < items.length) {
      const item = items[idx];
      if (item.rendered) { idx++; continue; }

      // If there is a partially rendered long item, continue it
      if (state.partialItemState && state.partialItemState.itemIndex === idx) {
        const innerLayout = state.partialItemState.layout;
        const innerOffset = state.partialItemState.lineOffset;
        const maxLines = Math.floor(page.remainingH / this.lineH);
        if (maxLines <= 0) return false;

        const linesToPlace = Math.min(innerLayout.lines.length - innerOffset, maxLines);
        for (let i = innerOffset; i < innerOffset + linesToPlace; i++) {
          html += `<li>${innerLayout.lines[i].map(seg => seg instanceof WordToken ? seg.openTags + seg.word + seg.closeTags : ' ').join('')}</li>`;
        }
        const newOffset = innerOffset + linesToPlace;
        if (newOffset >= innerLayout.lines.length) {
          item.rendered = true;
          state.partialItemState = null;
          idx++;
        } else {
          state.partialItemState.lineOffset = newOffset;
          break; // page full
        }
        continue;
      }

      // Measure whole item height
      const itemH = this.measureCtx.measureBlockHeight(item.html);
      if (page.canFitLine(itemH)) {
        html += item.html;
        page.currentY += itemH;
        page.remainingH -= itemH;
        item.rendered = true;
        idx++;
      } else {
        // Item doesn't fit – try to split its inner content (if long text)
        const innerTree = item.innerTree;
        if (innerTree) {
          const innerLayout = new ParagraphLayout(innerTree, page.widthPx, this.measureCtx);
          if (innerLayout.lines.length === 0) {
            // empty item? skip
            item.rendered = true;
            idx++;
            continue;
          }
          // How many lines of the inner content can fit?
          const maxInnerLines = Math.floor(page.remainingH / this.lineH);
          if (maxInnerLines === 0) break;
          const linesToPlace = Math.min(innerLayout.lines.length, maxInnerLines);
          for (let i = 0; i < linesToPlace; i++) {
            html += `<li>${innerLayout.lines[i].map(seg => seg instanceof WordToken ? seg.openTags + seg.word + seg.closeTags : ' ').join('')}</li>`;
          }
          page.currentY += linesToPlace * this.lineH;
          page.remainingH -= linesToPlace * this.lineH;
          if (linesToPlace >= innerLayout.lines.length) {
            item.rendered = true;
            idx++;
          } else {
            // store partial state
            state.partialItemState = {
              itemIndex: idx,
              layout: innerLayout,
              lineOffset: linesToPlace
            };
            break;
          }
        } else {
          // cannot split, move entire item to next page
          break;
        }
      }
    }

    if (html) {
      html += `</${state.listTag}>`;
      page.addContent({ type: 'list', html });
    }

    state.currentIdx = idx;
    if (idx >= items.length && !state.partialItemState) {
      // list complete
      cursor.clearBlockState(block);
      cursor.advanceBlock();
      return true;
    } else {
      return false; // continue on next page
    }
  }

  _layTable(page, block, cursor) {
    const state = cursor.getBlockState(block);
    if (!state.parsed) {
      const container = document.createElement('div');
      container.innerHTML = block.html;
      const table = container.querySelector('table');
      if (!table) { cursor.advanceBlock(); return true; }
      state.theadHTML = (table.querySelector('thead')?.outerHTML) || '';
      state.tbody = table.querySelector('tbody');
      state.rows = state.tbody ? Array.from(state.tbody.querySelectorAll('tr')) : Array.from(table.querySelectorAll('tr'));
      state.rowIdx = 0;
      state.cellSplitState = null; // for rows with long cells
      state.parsed = true;
    }

    let idx = state.rowIdx;
    let html = '';
    if (idx === 0 || state.cellSplitState) {
      // Start table on this page
      html += '<table>' + state.theadHTML + '<tbody>';
    }

    while (idx < state.rows.length) {
      const row = state.rows[idx];
      const rowHTML = row.outerHTML;
      const rowH = this.measureCtx.measureBlockHeight(`<table>${state.theadHTML}<tbody>${rowHTML}</tbody></table>`);
      if (page.canFitLine(rowH)) {
        html += rowHTML;
        page.currentY += rowH;
        page.remainingH -= rowH;
        idx++;
      } else {
        // row too tall – try to split its cells
        // For simplicity, we'll move the whole row to next page; real engine would split individual cells.
        // We'll implement a basic cell splitting attempt:
        const cells = Array.from(row.querySelectorAll('td,th'));
        if (cells.some(cell => cell.textContent.trim().length > 50)) {
          // Complex row, try to split first cell
          // ... omitted for brevity, we'll just break
        }
        break;
      }
    }

    if (html) {
      html += '</tbody></table>';
      page.addContent({ type: 'table', html });
    }
    state.rowIdx = idx;
    if (idx >= state.rows.length && !state.cellSplitState) {
      cursor.clearBlockState(block);
      cursor.advanceBlock();
      return true;
    } else {
      return false;
    }
  }

  _layImage(page, block, cursor) {
    const h = this.measureCtx.measureBlockHeight(block.html);
    if (page.canFitLine(h)) {
      page.addContent({ type: 'image', html: block.html });
      page.currentY += h;
      page.remainingH -= h;
      cursor.advanceBlock();
      return true;
    }
    // try scaling
    const div = document.createElement('div');
    div.innerHTML = block.html;
    const img = div.querySelector('img');
    if (img) {
      const scale = page.remainingH / h;
      if (scale > 0.5) {
        img.style.width = (parseFloat(img.getAttribute('width') || img.offsetWidth) * scale) + 'px';
        const newHTML = div.innerHTML;
        const newH = this.measureCtx.measureBlockHeight(newHTML);
        if (page.canFitLine(newH)) {
          page.addContent({ type: 'image', html: newHTML });
          page.currentY += newH;
          page.remainingH -= newH;
          cursor.advanceBlock();
          return true;
        }
      }
    }
    return false; // move to next page
  }

  _layCode(page, block, cursor) {
    const state = cursor.getBlockState(block);
    if (!state.parsed) {
      const codeText = block.html.replace(/<\/?[^>]+(>|$)/g, '');
      state.lines = codeText.split('\n');
      state.idx = 0;
      state.parsed = true;
    }
    let idx = state.idx;
    let linesHTML = '';
    while (idx < state.lines.length) {
      if (!page.canFitLine(this.lineH)) break;
      linesHTML += state.lines[idx] + '\n';
      page.currentY += this.lineH;
      page.remainingH -= this.lineH;
      idx++;
    }
    if (linesHTML) {
      page.addContent({ type: 'code', lines: linesHTML.split('\n').filter(l => l !== '') });
    }
    state.idx = idx;
    if (idx >= state.lines.length) {
      cursor.clearBlockState(block);
      cursor.advanceBlock();
      return true;
    }
    return false;
  }

  _layQuote(page, block, cursor) {
    // Treat content inside blockquote as a special paragraph-like block
    const state = cursor.getBlockState(block);
    if (!state.parsed) {
      const innerHTML = block.html.replace(/<\/?blockquote[^>]*>/g, '');
      state.innerTree = parseInlineTree(innerHTML);
      state.layout = new ParagraphLayout(state.innerTree, page.widthPx, this.measureCtx);
      state.lineOffset = 0;
      state.parsed = true;
    }
    const layout = state.layout;
    let offset = state.lineOffset;
    let linesPlaced = 0;
    while (offset < layout.lines.length) {
      if (!page.canFitLine(this.lineH)) break;
      offset++;
      linesPlaced++;
    }

    if (linesPlaced === 0 && offset > 0) return false;

    if (linesPlaced > 0) {
      const partialLines = layout.lines.slice(state.lineOffset, offset);
      const innerHTML = partialLines.map(line => line.map(seg => seg instanceof WordToken ? seg.openTags + seg.word + seg.closeTags : ' ').join('')).join(' ');
      page.addContent({ type: 'quote', innerHTML });
      page.currentY += linesPlaced * this.lineH;
      page.remainingH -= linesPlaced * this.lineH;
      state.lineOffset = offset;
    }

    if (offset >= layout.lines.length) {
      cursor.clearBlockState(block);
      cursor.advanceBlock();
      return true;
    }
    return false;
  }

  _layGeneric(page, block, cursor) {
    const h = this.measureCtx.measureBlockHeight(block.html);
    if (page.canFitLine(h)) {
      page.addContent({ type: 'generic', html: block.html });
      page.currentY += h;
      page.remainingH -= h;
      cursor.advanceBlock();
      return true;
    }
    return false;
  }
  _layQuestion(page, block, cursor) {
    const h = this.measureCtx.measureBlockHeight(block.html);
    if (!page.canFitLine(h)) return false;
    page.addContent({ type: 'generic', html: block.html });
    page.currentY += h;
    page.remainingH -= h;
    // account for .question margin-bottom
    page.currentY += QUESTION_MARGIN_BOTTOM;
    page.remainingH -= QUESTION_MARGIN_BOTTOM;
    cursor.advanceBlock();
    return true;
  }

  _layAnswer(page, block, cursor) {
    const h = this.measureCtx.measureBlockHeight(block.html);
    if (!page.canFitLine(h)) return false;
    page.addContent({ type: 'generic', html: block.html });
    page.currentY += h;
    page.remainingH -= h;
    // account for .answer-item margin-bottom
    page.currentY += ANSWER_MARGIN_BOTTOM;
    page.remainingH -= ANSWER_MARGIN_BOTTOM;
    cursor.advanceBlock();
    return true;
  }
  _peekNextBlock(cursor) {
    const sec = cursor.sections[cursor.secIdx];
    return sec.blocks[cursor.blkIdx + 1] || null;
  }
}

// ── Public API ──
function paginateContentV7(fullHTML, pageHeaderHTML, footerBuilder, watermarkHTML, firstPageHasHeader = true) {
  const blocks = domToBlocks(fullHTML);
  const sections = [new Section('', blocks)];
  const engine = new PageEngineV7({
    headerBuilder: (isFirst) => isFirst ? pageHeaderHTML : '',
    footerBuilder,
    watermarkBuilder: () => watermarkHTML,
    firstPageHasHeader
  });
  return engine.render(sections);
}

window.paginateContentV2 = paginateContentV7;   // backward compatibility

// --------------------------------------------------------------------------
// 5. DOCUMENT GENERATORS (exam, answer sheet, etc. unchanged except image refs)
// --------------------------------------------------------------------------
export function buildExamHTML(data) {
  console.log('[pdf-engine] buildExamHTML called');
  const qs = data.questions || [];
  const totalMarks = data.totalMarks || qs.length;
  const showStudentInfo = data.studentInfo === true;

  // First‑page header (same as before)
  const firstPageHeader = brandBar('MEDICAL PRACTICE EXAMINATION', 'Generated for Learning & Self Assessment', data)
    + divider()
    + `<div class="doc-title">
         <h1>${esc(data.title || 'Human Anatomy – Upper Limb')}</h1>
         <p>${qs.length} Questions • ${totalMarks} Marks • ${esc(data.difficulty || 'Moderate')} Difficulty</p>
       </div>`
    + (showStudentInfo ? `
       <div style="display:flex; justify-content:space-between; margin-bottom:1rem; font-size:var(--font-size-base);">
         <span><strong>Student Name:</strong> ______________________</span>
         <span><strong>Date:</strong> __________________</span>
       </div>
       ` : '')
    + `<table class="meta-table">
         <tr><td><strong>Subject</strong><br>${esc(data.subject || 'Human Anatomy')}</td><td><strong>Topics</strong><br>${esc(data.topics || 'Upper Limb')}</td></tr>
         <tr><td><strong>Questions</strong><br>${qs.length}</td><td><strong>Total Marks</strong><br>${totalMarks}</td></tr>
         <tr><td><strong>Time Allowed</strong><br>${esc(data.duration || '2 Hours')}</td><td><strong>Difficulty</strong><br>${esc(data.difficulty || 'Moderate')}</td></tr>
         <tr><td><strong>Date Generated</strong><br>${esc(data.date || '15 July 2026')}</td><td><strong>Exam ID</strong><br>${esc(data.id || 'MH-EX-8GJ42P')}</td></tr>
       </table>`
    + `<div class="notice"><h3>Educational Use</h3><p>This examination has been generated by <strong>MedVix</strong> for revision, practice and self-assessment. It is not an official institutional examination.</p></div>`
    + `<div class="instructions"><h3>Instructions</h3><ol><li>Read every question carefully before answering.</li><li>Answer all questions unless otherwise stated.</li><li>Each question carries the marks indicated.</li><li>Manage your time effectively.</li><li>Review your answers before submission where applicable.</li></ol></div>`
    + divider();

  // Build the content: each question becomes a <p> (splittable) followed by an <ul> (splittable)
  let questionsHTML = '';
  for (const q of qs) {
    questionsHTML += `<p>${esc(q.id)}. ${esc(q.text)}</p>`;
    if (q.options && q.options.length) {
      questionsHTML += '<ul>';
      for (const opt of q.options) {
        questionsHTML += `<li>${esc(opt)}</li>`;
      }
      questionsHTML += '</ul>';
    }
    questionsHTML += '<div style="height:0; margin:0;"></div>'; // spacer to maintain block separation
  }

  const footerBuilder = (pageNum, totalPages) =>
    globalFooter(pageNum, totalPages,
      'MedVix • Medical Learning Platform',
      'Exam Assessment • Generated Document',
      'medvix.edgeone.app');

  const pages = paginateContentV2(
    questionsHTML,
    firstPageHeader,
    footerBuilder,
    watermark(),
    true
  );

  const endPage = createEndPage(data, pages.length + 1);
  return pages.join('') + endPage;
}

export function buildMcqSheetHTML(data) {
  const total = data.totalQuestions || 60;
  const showStudentInfo = data.studentInfo === true;

  // Build all rows inside a single two‑column container
  let rowsHTML = '';
  for (let i = 1; i <= total; i++) {
    rowsHTML += `
      <div class="mcq-row">
        <span class="q-number">${i}.</span>
        <div class="options">
          <span class="option"><span class="bubble"></span>A</span>
          <span class="option"><span class="bubble"></span>B</span>
          <span class="option"><span class="bubble"></span>C</span>
          <span class="option"><span class="bubble"></span>D</span>
          <span class="option"><span class="bubble"></span>E</span>
        </div>
      </div>`;
  }
  const gridHTML = `<div class="mcq-columns">${rowsHTML}</div>`;

  // First‑page header (brand bar, meta, instructions)
  const firstPageHeader = brandBar('MCQ ANSWER SHEET', 'Student Response Document', data)
    + divider()
    + `<div class="doc-title">
         <h1>${esc(data.title || 'Human Anatomy – Upper Limb')}</h1>
         <p>Mark one circle per question (A, B, C, D, or E)</p>
       </div>`
    + (showStudentInfo ? `
       <table class="meta-table">
         <tr>
           <td><strong>Student Name</strong><br>____________________________</td>
           <td><strong>Date</strong><br>__________________</td>
         </tr>
         <tr>
           <td><strong>Exam ID</strong><br>${esc(data.id || 'MH-EX-8GJ42P')}</td>
           <td><strong>Total Questions</strong><br>${total}</td>
         </tr>
       </table>
       ` : `
       <table class="meta-table">
         <tr>
           <td><strong>Exam ID</strong><br>${esc(data.id || 'MH-EX-8GJ42P')}</td>
           <td><strong>Total Questions</strong><br>${total}</td>
         </tr>
       </table>
       `)
    + `<div class="instructions">
         <h3>Instructions</h3>
         <ul>
           <li>Fill in <strong>one bubble only</strong> for each question.</li>
           <li>If you make a mistake, cross it out and fill the correct one clearly.</li>
           <li>Do not write outside the answer grid.</li>
         </ul>
       </div>`;

  const footerBuilder = (pageNum, totalPages) =>
    globalFooter(pageNum, totalPages,
      'MedVix • Medical Learning Platform',
      'MCQ Answer Sheet • Student Response',
      'medvix.edgeone.app');

  // Use the engine to paginate – the mcq‑grid block is split by _layMcqGrid
  const pages = paginateContentV2(
    gridHTML,
    firstPageHeader,
    footerBuilder,
    watermark(),
    true
  );

  const endPage = createEndPage({
    ...data,
    endTitle: 'End of Answer Sheet',
    endSubtitle: 'Please check your answers before submission.',
    endMessage: 'Once submitted, your answer sheet will be scored automatically. View your detailed results and explanations on MedVix.',
    endFeatures: ['📊 Instant Scoring', '📝 Full Explanations', '🧠 Weakness Analysis', '📅 Retake Scheduler'],
    ctaText: 'Submit & View Results on MedVix',
    disclaimer: 'This answer sheet is for practice purposes. MedVix is not responsible for official exam administration.'
  }, pages.length + 1);

  return pages.join('') + endPage;
}

// -------------------------------------------------------
// 5.1 NOTES – NOW USES PAGINATION
// -------------------------------------------------------
export function buildNotesHTML(data) {
  console.log('[pdf-engine] buildNotesHTML called, content length:', (data.contentHTML || '').length);
  const safeContent = data.contentHTML || '';

  // First‑page header (brand bar, title, meta cards)
  const firstPageHeader = brandBar('PERSONAL NOTES', 'Version 1.0', data)
    + divider()
    + `<div class="doc-title">
         ${(() => {
      const parts = [];
      if (data.subject) parts.push(esc(data.subject));
      if (data.topic) parts.push(esc(data.topic));
      return parts.length ? `<p>${parts.join(' • ')}</p>` : '';
    })()}
       </div>`
    + `<div class="meta-grid">
         <div class="meta-card"><div class="meta-label">Owner</div><div class="meta-value">${esc(data.owner || 'Felix')}</div></div>
         <div class="meta-card"><div class="meta-label">Generated</div><div class="meta-value">${esc(data.date || '15 Jul 2026')}</div></div>
         <div class="meta-card"><div class="meta-label">Subject</div><div class="meta-value">${esc(data.subject || 'Physiology')}</div></div>
         <div class="meta-card"><div class="meta-label">Export ID</div><div class="meta-value">${esc(data.id || 'MH-2026-00128')}</div></div>
       </div>`;

  // Footer builder: page numbers injected later
  const footerBuilder = (pageNum, totalPages) =>
    globalFooter(pageNum, totalPages,
      'MedVix • Medical Learning Platform',
      'Medical Notes Export • Learning Material',
      'medvix.edgeone.app');

  // Paginate the content
  // Inside buildNotesHTML (around line 650 in original) replace the call:
  const pages = paginateContentV2(   // this now points to paginateContentV7
    safeContent,
    firstPageHeader,
    footerBuilder,
    watermark(),
    true
  );

  const endPage = createEndPage({
    ...data,
    ctaUrl: 'https://medvix.edgeone.app',   // ← Forces the correct URL
    endTitle: 'Continue Your Medical Journey',
    endSubtitle: 'Thank you for creating your notes with MedVix.',
    endMessage: 'Your notes remain your intellectual property. MedVix provides tools to organise, improve, and export your medical knowledge securely.',
    endFeatures: ['📚 Question Bank', '📝 Smart Notes', '🧠 Flashcards', '📅 Study Planner', '📈 Performance Analytics', '🎯 Exam Preparation'],
    ctaText: 'Continue Learning With MedVix',
    disclaimer: 'This PDF was generated using MedVix. The notes and content belong to their respective author. MedVix provides tools for organisation, learning, and export.'
  }, pages.length + 1);

  return pages.join('') + endPage;
}
// ... (buildAnswerKeyHTML, buildAnalyticsHTML remain as before, unchanged)
export function buildAnswerKeyHTML(data) {
  const answers = data.answers || [];

  // First-page header
  const firstPageHeader = brandBar('ANSWERS & MARKING SCHEME', 'Generated Study Document', data)
    + divider()
    + `<div class="doc-title"><h1>${esc(data.title || 'Anatomy Assessment')}</h1><p>${esc(data.subtitle || 'Upper Limb • MCQ Answers & Explanations')}</p></div>`
    + `<div class="meta-grid">
         <div class="meta-card"><div class="meta-label">Subject</div><div class="meta-value">${esc(data.subject || 'Anatomy')}</div></div>
         <div class="meta-card"><div class="meta-label">Questions</div><div class="meta-value">${answers.length} Questions</div></div>
         <div class="meta-card"><div class="meta-label">Total Marks</div><div class="meta-value">${answers.length} Marks</div></div>
         <div class="meta-card"><div class="meta-label">Document</div><div class="meta-value">Answer Guide</div></div>
       </div>`;

  // Build answer items HTML
  let answersHTML = '';
  for (const a of answers) {
    let explanationHtml = '';
    if (typeof a.explanation === 'object' && a.explanation !== null) {
      if (a.explanation.overview) explanationHtml += `<p><strong>Overview:</strong> ${esc(a.explanation.overview)}</p>`;
      if (a.explanation.highYield) explanationHtml += `<p><strong>High Yield:</strong> ${esc(a.explanation.highYield)}</p>`;
      if (a.explanation.clinicalCorrelation) explanationHtml += `<p><strong>Clinical Correlation:</strong> ${esc(a.explanation.clinicalCorrelation)}</p>`;
    } else {
      explanationHtml = `<p>${esc(a.explanation || 'No explanation available.')}</p>`;
    }

    answersHTML += `
      <div class="answer-item">
        <p><strong>${esc(a.id)}.</strong> ${esc(a.question || '')}</p>
        <p class="correct">Correct Answer: ${esc(a.correctOption)}</p>
        <div class="explanation">${explanationHtml}</div>
      </div>`;
  }

  const footerBuilder = (pageNum, totalPages) =>
    globalFooter(pageNum, totalPages,
      'MedVix • Medical Learning Platform',
      'Answers & Explanations • Study Resource',
      'medvix.edgeone.app');

  const pages = paginateContentV2(
    answersHTML,
    firstPageHeader,
    footerBuilder,
    watermark(),
    true
  );

  const endPage = createEndPage({
    ...data,
    endTitle: 'Answer Key Complete',
    endSubtitle: 'You’ve reviewed all answers for this assessment.',
    endMessage: 'Use these explanations to identify knowledge gaps. Return to MedVix for personalised revision and more practice questions.',
    endFeatures: ['📊 Performance Review', '📝 Retake Exam', '🧠 Flashcards', '📅 Study Schedule'],
    ctaText: 'Continue Learning on MedVix',
    disclaimer: 'This document was generated by MedVix for self‑assessment. The content is not an official examination key.'
  }, pages.length + 1);

  return pages.join('') + endPage;
}

export function buildAnalyticsHTML(data) {
  return `
    <div class="page">
      ${brandBar('PERFORMANCE REPORT', 'Analytics & Progress Insights', data)}
      ${divider()}
      <div class="doc-title">
        <h1>Student Performance Analytics</h1>
        <p>Personal Learning Progress Overview</p>
      </div>
      <div class="meta-grid">
        <div class="meta-card">
          <div class="meta-label">Overall Rating</div>
          <div class="meta-value">Expert • 842 PR</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Questions Attempted</div>
          <div class="meta-value">2,450</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Accuracy</div>
          <div class="meta-value">86%</div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Study Streak</div>
          <div class="meta-value">32 Days</div>
        </div>
      </div>
      <section class="analytics-content">
        <h2>Progress Highlights</h2>
        <div class="chart-placeholder">[ Performance Over Time Chart ]</div>
        <div class="insight-box">
          <strong>Insight:</strong> Your accuracy in Cardiovascular Physiology improved by 12% this month. Keep practising Upper Limb anatomy to reach your target.
        </div>
        <table class="topic-table">
          <thead><tr><th>Topic</th><th>Questions</th><th>Accuracy</th><th>Trend</th></tr></thead>
          <tbody>
            <tr><td>Cardiovascular Physiology</td><td>180</td><td>92%</td><td>↑ 8%</td></tr>
            <tr><td>Upper Limb Anatomy</td><td>145</td><td>78%</td><td>↓ 3%</td></tr>
            <tr><td>Neuroanatomy</td><td>210</td><td>84%</td><td>→ Stable</td></tr>
          </tbody>
        </table>
      </section>
      ${globalFooter(1, 3, 'MedVix • Medical Learning Platform', 'Performance Analytics Report • Personal Progress')}
    </div>
    <div class="page">
      ${watermark()}
      <section class="analytics-content">
        <h2>Topic Breakdown & Time Analysis</h2>
        <div class="chart-placeholder">[ Questions by Subject Area ]</div>
        <table class="topic-table">
          <thead><tr><th>Metric</th><th>This Month</th><th>Last Month</th><th>Change</th></tr></thead>
          <tbody>
            <tr><td>Total Study Time</td><td>38 hrs</td><td>28 hrs</td><td>+35%</td></tr>
            <tr><td>Avg. Session Length</td><td>45 min</td><td>32 min</td><td>+41%</td></tr>
            <tr><td>Questions per Day</td><td>62</td><td>48</td><td>+29%</td></tr>
            <tr><td>Weakest Subject</td><td>Microbiology</td><td>Pathology</td><td>—</td></tr>
          </tbody>
        </table>
        <div class="insight-box">
          <strong>Recommendation:</strong> Increase microbiology practice by 2 sessions per week. Your current accuracy of 64% can reach 75% with focused revision.
        </div>
        <div class="chart-placeholder" style="height:140px;">[ Daily Streak Calendar / Heatmap ]</div>
      </section>
      ${globalFooter(2, 3)}
    </div>
    ${createEndPage({
    ...data,
    endTitle: 'Your Progress, Tracked',
    endSubtitle: 'See how far you’ve come and where to focus next.',
    endMessage: 'Analytics help you turn study time into measurable results. Log in to MedVix for deeper insights and personalised study plans.',
    endFeatures: ['📈 Trend Reports', '📊 Weakness Analysis', '🎯 Goal Setting', '⏱️ Time Management'],
    ctaText: 'Open Full Analytics on MedVix',
    disclaimer: 'This report was generated automatically by MedVix. All data is based on your personal study activity.'
  }, 3)}`;
}

// --------------------------------------------------------------------------
// 6. PRINT & EXPORT HELPERS
// --------------------------------------------------------------------------
export async function printDocument(htmlString) {
  console.log('[pdf-engine] printDocument called, html length:', htmlString?.length);
  injectStyles();
  await imageLoadPromise;

  let mount = document.getElementById('medhub-print-mount');
  if (!mount) {
    mount = document.createElement('div');
    mount.id = 'medhub-print-mount';
    document.body.appendChild(mount);
  }
  mount.innerHTML = htmlString;

  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }
  const images = Array.from(mount.querySelectorAll('img'));
  await Promise.all(images.map(img => {
    if (img.complete) return Promise.resolve();
    return new Promise(resolve => {
      img.onload = resolve;
      img.onerror = resolve;
    });
  }));

  await new Promise(r => setTimeout(r, 200));

  const isCapacitor = window.Capacitor?.isNativePlatform?.();
  const printer = window.Capacitor?.Plugins?.Printer;
  if (isCapacitor && printer) {
    try {
      await printer.print({
        content: mount.innerHTML,
        name: 'MedVix_Document',
        orientation: 'portrait'
      });
      return;
    } catch (e) {
      console.warn('Capacitor printer failed, falling back to window.print()');
    }
  }

  window.print();
  window.addEventListener('afterprint', () => {
    if (mount) {
      mount.innerHTML = '';
      mount.style.display = 'none';
    }
  }, { once: true });
}

export async function exportDocument(type, data) {
  injectStyles();
  await imageLoadPromise;
  let html = '';
  switch (type.toLowerCase()) {
    case 'exam': html = buildExamHTML(data); break;
    case 'mcq-sheet': case 'answersheet': html = buildMcqSheetHTML(data); break;
    case 'notes': html = buildNotesHTML(data); break;
    case 'answer-key': html = buildAnswerKeyHTML(data); break;
    case 'analytics': html = buildAnalyticsHTML(data); break;
    default: console.error(`[MedVix Engine] Unknown type: "${type}"`); return;
  }
  await printDocument(html);
}

console.log('[pdf-engine] Module exports ready');

// --------------------------------------------------------------------------
// GLOBAL FALLBACKS
// --------------------------------------------------------------------------
window.buildExamHTML = buildExamHTML;
window.buildNotesHTML = buildNotesHTML;
window.buildMcqSheetHTML = buildMcqSheetHTML;
window.buildAnswerKeyHTML = buildAnswerKeyHTML;
window.buildAnalyticsHTML = buildAnalyticsHTML;
window.printDocument = printDocument;
window.exportDocument = exportDocument;

console.log('[pdf-engine] Global fallbacks attached to window')