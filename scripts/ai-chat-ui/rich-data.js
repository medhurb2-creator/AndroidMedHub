// scripts/ai-chat-ui/rich-data.js
/**
 * Rich-data rendering — everything the AI returns alongside its main
 * text.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 * Two responsibilities, one contract:
 *
 *   1. META BAR  — the small muted line under the assistant bubble
 *                  summarising how the answer was produced (model,
 *                  thinking time, pages read, cost, token counts).
 *
 *   2. RICH CARDS — the structured attachments below the message:
 *                     • Formulas    (description + rendered LaTeX)
 *                     • Mnemonics   (markdown-rendered memory aids)
 *                     • References  (plain-text citation list)
 *                     • Sources     (clickable URL chips, [N] prefixed)
 *                     • Images      (thumbnails, lightbox-clickable)
 *
 * ── Design ───────────────────────────────────────────────────────────
 * Pure functions. No `this`, no DOM writes, no state. Every function
 * takes the raw `richData` object (or the `meta` string) and returns
 * a safe HTML string. The caller interpolates it directly.
 *
 * Every function is defensive:
 *   • Wrong types → that field is silently skipped, not thrown on.
 *   • Malformed URLs → rejected unless they're http(s) or (for images
 *     only) data:image/…;base64.
 *   • Duplicate entries → deduped once.
 *   • Oversized arrays → capped so a runaway backend response can't
 *     freeze the UI.
 *   • Empty groups → return '' so the caller never sees an empty
 *     wrapper div.
 *
 * ── Meta precedence ──────────────────────────────────────────────────
 * The backend now sends a `meta` string alongside `richData` for the
 * chat path (e.g. "🌐 8 pages · MedVix AI · 234 in · 567 out"). That
 * string is authoritative — it includes info the richData fields
 * don't (token counts, mode labels). So:
 *
 *   • When `buildRichMetaBar(richData, meta)` is called with BOTH
 *     arguments and `meta` is non-empty, `meta` wins (escaped, wrapped
 *     in .meta-bar).
 *   • When only `richData` is passed (legacy responses, direct AI
 *     action calls), the bar is built from the known fields.
 *   • When neither produces output, '' is returned.
 *
 * ── Source chip ↔ inline citation correlation ────────────────────────
 * When the websearch mode is active, the AI writes `[1]`, `[2]`, `[3]`
 * inline. The renderer in markdown.js turns those into clickable pills
 * that link to `sources[N-1]`. To make the correlation obvious, each
 * source chip here is prefixed with the same `[N]` marker, so the user
 * sees:
 *
 *   …as confirmed by recent meta-analyses [2][3].
 *   ────────────────────────────────────────────────
 *   Sources
 *   [2] pubmed.ncbi.nlm.nih.gov/…
 *   [3] cochrane.org/…
 *
 * ── Public API ───────────────────────────────────────────────────────
 *   buildRichMetaBar(richData, meta?)   → HTML for the meta line
 *   renderRichDataCards(richData)       → HTML for the rich cards
 */

import { escapeHtml, renderLatex, renderMarkdown } from './markdown.js';

// ==================== CONSTANTS ====================

// URLs must be http(s) to be rendered as links or images. Anything else
// (javascript:, file:, data: for non-images) is treated as text.
const SAFE_URL_RE = /^https?:\/\//i;

// Data URIs allowed only for images — needed for inline base64 thumbnails
// the backend sometimes returns.
const SAFE_IMAGE_DATA_URI_RE = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,/i;

// Maximum width of a source-chip label. Longer URLs are truncated in the
// middle so both the origin and the trailing path segment stay visible —
// this keeps two different articles from the same site distinguishable.
const SOURCE_LABEL_MAX = 64;

// Meta bar icons — kept here so the format can change in one place.
const META_ICONS = {
    model: '🧠',
    thinking: '⏱',
    web: '🌐',
    cost: '💰',
};

// Hard caps so a pathological backend response can't freeze the UI.
// These are all well above realistic maximums, so they act purely as
// a safety net, not as a functional limit.
const MAX_FORMULAS = 20;
const MAX_MNEMONICS = 10;
const MAX_REFERENCES = 50;
const MAX_SOURCES = 20;
const MAX_IMAGES = 10;

// ==================== SMALL HELPERS ====================

function isNonEmptyString(x) {
    return typeof x === 'string' && x.trim().length > 0;
}

function isNonEmptyArray(x) {
    return Array.isArray(x) && x.length > 0;
}

function isFiniteNumber(x) {
    return typeof x === 'number' && isFinite(x);
}

function isSafeUrl(url) {
    return isNonEmptyString(url) && SAFE_URL_RE.test(url.trim());
}

function isSafeImageSrc(url) {
    if (!isNonEmptyString(url)) return false;
    const t = url.trim();
    return SAFE_URL_RE.test(t) || SAFE_IMAGE_DATA_URI_RE.test(t);
}

/**
 * Remove duplicates and empty entries from an array of strings.
 * Preserves first-occurrence order.
 */
function dedupeStrings(arr) {
    const seen = new Set();
    const out = [];
    for (const item of arr) {
        if (!isNonEmptyString(item)) continue;
        const t = item.trim();
        if (seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

/**
 * Truncate a long URL in the middle for display.
 *
 *   "https://very-long-domain.com/a/very/long/path/to/article-about-xyz"
 *   → "https://very-long-domain.com/a/very/long/pa…article-about-xyz"
 *
 * Preserves both the origin and the tail so two articles from the same
 * host remain distinguishable. The full URL is always available via the
 * chip's `title` attribute and its `href`.
 */
function shortenUrl(url, maxLen = SOURCE_LABEL_MAX) {
    const u = String(url);
    if (u.length <= maxLen) return u;
    const headLen = Math.floor(maxLen * 0.55);
    const tailLen = maxLen - headLen - 1; // 1 for the ellipsis
    return u.slice(0, headLen) + '…' + u.slice(-tailLen);
}

/**
 * Format a thinking-time value (in seconds) for the meta bar.
 *   < 1 s    → "850ms"
 *   < 10 s   → "3.4s"
 *   >= 10 s  → "12s"
 */
function formatThinkingTime(seconds) {
    if (!isFiniteNumber(seconds) || seconds <= 0) return '';
    if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    return `${Math.round(seconds)}s`;
}

/**
 * Format a cost value (in USD) for the meta bar.
 *   < $0.01  → "$0.0023"
 *   >= $0.01 → "$0.05"
 */
function formatCost(cost) {
    if (!isFiniteNumber(cost) || cost <= 0) return '';
    if (cost < 0.01) return `$${cost.toFixed(4)}`;
    return `$${cost.toFixed(2)}`;
}

// ==================== META BAR ====================

/**
 * Build the small meta line under an assistant bubble.
 *
 * Precedence:
 *   1. If `meta` is a non-empty string (the backend-supplied summary,
 *      e.g. "🌐 8 pages · MedVix AI · 234 in · 567 out") → return it
 *      verbatim, escaped, wrapped in `.meta-bar`. This is the
 *      authoritative source and includes info the richData fields
 *      don't (token counts, mode labels).
 *   2. Otherwise, build from the `richData` fields for backwards
 *      compatibility with older responses that only carried richData.
 *   3. If neither produces output, return ''.
 *
 * @param {any} richData
 * @param {string|null} [meta=null]
 * @returns {string}
 */
export function buildRichMetaBar(richData, meta = null) {
    // 1. Backend-supplied meta string — authoritative, use verbatim.
    if (isNonEmptyString(meta)) {
        return `<div class="meta-bar">${escapeHtml(meta)}</div>`;
    }

    // 2. Construct from richData.
    if (!richData || typeof richData !== 'object') return '';

    const parts = [];

    if (isNonEmptyString(richData.modelUsed)) {
        parts.push(`${META_ICONS.model} ${escapeHtml(richData.modelUsed)}`);
    }

    const time = formatThinkingTime(richData.thinkingTime);
    if (time) parts.push(`${META_ICONS.thinking} ${time}`);

    if (isFiniteNumber(richData.webPagesRead) && richData.webPagesRead > 0) {
        const n = richData.webPagesRead;
        parts.push(`${META_ICONS.web} ${n} page${n === 1 ? '' : 's'}`);
    }

    const cost = formatCost(richData.cost);
    if (cost) parts.push(`${META_ICONS.cost} ${cost}`);

    if (parts.length === 0) return '';
    return `<div class="meta-bar">${parts.join(' · ')}</div>`;
}

// ==================== RICH DATA CARDS ====================

/**
 * Render every card group the richData payload supports.
 *
 * Group order (content → attribution → media):
 *   1. Formulas    — formula cards with description + rendered LaTeX
 *   2. Mnemonics   — markdown-rendered mnemonic cards
 *   3. References  — plain-text reference list
 *   4. Sources     — [N]-prefixed clickable URL chips
 *   5. Images      — thumbnail grid (lightbox-clickable)
 *
 * Returns '' if the payload contains no renderable content — the
 * caller never sees an empty `<div class="rich-data-section">`.
 *
 * @param {any} richData
 * @returns {string}
 */
export function renderRichDataCards(richData) {
    if (!richData || typeof richData !== 'object') return '';

    const groups = [
        _renderFormulasGroup(richData.formulas),
        _renderMnemonicsGroup(richData.mnemonics),
        _renderReferencesGroup(richData.references),
        _renderSourcesGroup(richData.sources),
        _renderImagesGroup(richData.images),
    ].filter(Boolean);

    if (groups.length === 0) return '';
    return `<div class="rich-data-section">${groups.join('')}</div>`;
}

// ==================== PRIVATE GROUP RENDERERS ====================

/**
 * Formulas — one card per entry, description above, rendered LaTeX
 * below. LaTeX goes through `renderLatex` which handles KaTeX fallback
 * internally (malformed formula → latex-error span, never throws).
 *
 * @private
 * @param {any} formulas
 * @returns {string}
 */
function _renderFormulasGroup(formulas) {
    if (!isNonEmptyArray(formulas)) return '';

    const cards = [];
    for (const f of formulas) {
        if (!f || typeof f !== 'object') continue;
        if (cards.length >= MAX_FORMULAS) break;

        const desc = isNonEmptyString(f.description) ? f.description.trim() : '';
        const formula = isNonEmptyString(f.formula) ? f.formula.trim() : '';
        if (!desc && !formula) continue;

        let card = '<div class="formula-card">';
        if (desc) card += `<div class="formula-desc">${escapeHtml(desc)}</div>`;
        if (formula) card += `<div class="formula-equation">${renderLatex(formula)}</div>`;
        card += '</div>';
        cards.push(card);
    }
    if (cards.length === 0) return '';

    return `<div class="formulas-group">` +
        `<h4 class="rich-heading">Formulas</h4>` +
        cards.join('') +
        `</div>`;
}

/**
 * Mnemonics — markdown-rendered so bullet lists and emphasis work.
 * @private
 */
function _renderMnemonicsGroup(mnemonics) {
    if (!isNonEmptyArray(mnemonics)) return '';

    const cards = [];
    for (const m of mnemonics) {
        if (!isNonEmptyString(m)) continue;
        if (cards.length >= MAX_MNEMONICS) break;
        cards.push(`<div class="mnemonic-card">${renderMarkdown(m)}</div>`);
    }
    if (cards.length === 0) return '';

    return `<div class="mnemonics-group">` +
        `<h4 class="rich-heading">Mnemonics</h4>` +
        cards.join('') +
        `</div>`;
}

/**
 * References — plain-text list (not markdown). References are typically
 * one-liners like "Smith et al., NEJM 2023, doi:10.1056/…" so escaping
 * them as text is the correct rendering — we don't want half a citation
 * accidentally italicised because it contains `*`.
 * @private
 */
function _renderReferencesGroup(references) {
    if (!isNonEmptyArray(references)) return '';

    const items = [];
    for (const ref of references) {
        if (!isNonEmptyString(ref)) continue;
        if (items.length >= MAX_REFERENCES) break;
        items.push(`<div class="reference-item">${escapeHtml(ref.trim())}</div>`);
    }
    if (items.length === 0) return '';

    return `<div class="references-group">` +
        `<h4 class="rich-heading">References</h4>` +
        items.join('') +
        `</div>`;
}

/**
 * Sources — clickable URL chips.
 *
 * Each chip is prefixed with `[N]` so it correlates with the inline
 * citation pills the markdown renderer produces. The chip label is a
 * middle-truncated URL (full URL in `title`), so long URLs don't
 * dominate the layout.
 *
 * Only http(s) URLs are accepted. Duplicates are removed. Entries past
 * MAX_SOURCES are dropped.
 *
 * @private
 */
function _renderSourcesGroup(sources) {
    if (!isNonEmptyArray(sources)) return '';

    const cleaned = dedupeStrings(sources)
        .filter(isSafeUrl)
        .slice(0, MAX_SOURCES);
    if (cleaned.length === 0) return '';

    const chips = cleaned.map((url, i) => {
        const n = i + 1;
        const safeUrl = escapeHtml(url);
        const label = escapeHtml(shortenUrl(url));
        return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer"` +
            ` class="source-chip" title="${safeUrl}">[${n}] ${label}</a>`;
    }).join('');

    return `<div class="sources-group">` +
        `<h4 class="rich-heading">Sources</h4>` +
        `<div class="source-chips">${chips}</div>` +
        `</div>`;
}

/**
 * Images — thumbnail grid.
 *
 * Accepts http(s) URLs and `data:image/…;base64,…` URIs. Everything
 * else is dropped. Each image carries the `rich-image` class so the
 * existing lightbox handler picks it up automatically.
 *
 * @private
 */
function _renderImagesGroup(images) {
    if (!isNonEmptyArray(images)) return '';

    const cleaned = dedupeStrings(images)
        .filter(isSafeImageSrc)
        .slice(0, MAX_IMAGES);
    if (cleaned.length === 0) return '';

    const tags = cleaned.map(url => {
        const safeUrl = escapeHtml(url);
        return `<img src="${safeUrl}" alt="Medical Image" ` +
            `class="rich-image" loading="lazy">`;
    }).join('');

    return `<div class="images-group">` +
        `<h4 class="rich-heading">Images</h4>` +
        `<div class="images-row">${tags}</div>` +
        `</div>`;
}