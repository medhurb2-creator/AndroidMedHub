// scripts/ai-chat-ui/markdown.js
/**
 * Markdown + LaTeX rendering — the single source of truth for turning
 * assistant text into safe HTML.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 * This module owns EVERY transformation between "text the AI produced"
 * and "HTML the DOM can render":
 *
 *   • Markdown  — headers, lists (incl. nested + task), bold/italic,
 *                 strikethrough, highlight, sub/sup, blockquotes,
 *                 horizontal rules, definition lists, tables,
 *                 admonitions (!!!), images, links, footnotes,
 *                 abbreviations, backslash escapes, line breaks.
 *
 *   • LaTeX     — inline ($…$, \(…\), ((…))) and block ($$…$$, \[…\]).
 *                 Rendered via KaTeX. Falls back to plain text on
 *                 failure — never throws.
 *
 *   • Code      — fenced blocks (```lang) with language detection,
 *                 Mermaid passthrough, ASCII-diagram auto-detection.
 *                 Inline code (`…`).
 *
 *   • Citations — bare [N] and multi-citation [1,2] / [1, 2] /
 *                 [1,2,3] / [1;2] refs mapped to sources[N-1] when a
 *                 sources array is provided (used by the websearch
 *                 mode). Each number becomes its own pill; a group
 *                 is treated as all-or-nothing — if any number is
 *                 out of range, the whole group stays as plain text.
 *
 *   • Utilities — escapeHtml / escapeHtmlSafe for callers that build
 *                 HTML manually (user bubbles, rich data cards), and
 *                 stripMarkdown for the copy/speak/notes workflow that
 *                 needs plain text.
 *
 * ── Design ───────────────────────────────────────────────────────────
 * All functions are pure — no `this`, no module-level state, no side
 * effects. Inputs are plain strings (or strings + a sources array).
 * Output is a string of safe HTML. Callers never need to pre-escape;
 * every public renderer escapes internally.
 *
 * ── Why placeholder-based ────────────────────────────────────────────
 * The renderer builds the output in stages. Each stage (code blocks,
 * LaTeX, links, etc.) is extracted into a \u0000PREFIX_N\u0000
 * placeholder before the next stage runs. This means:
 *
 *   • Later stages can't accidentally re-parse content that an
 *     earlier stage already claimed (e.g. markdown-link syntax inside
 *     a code block stays literal).
 *   • Order of stages is explicit and documented.
 *   • Adding a new stage is a one-line insertion in the right place.
 *
 * At the end, every placeholder is replaced by its real HTML. The
 * final HTML contains no \u0000 characters by construction — any
 * placeholder that survives to the end was a bug and would be
 * visible in the output (which we'd notice in testing).
 *
 * ── Public API ───────────────────────────────────────────────────────
 *   escapeHtml(unsafe)                 → escape &<>"
 *   escapeHtmlSafe(text)               → null-safe escape &<>"
 *   stripMarkdown(md)                  → markdown → plain text
 *   renderLatex(text)                  → latex only → HTML (escapes first)
 *   renderMarkdown(text, sources = []) → full markdown → HTML
 */

// ==================== ESCAPE ====================

/**
 * Escape HTML special characters. Non-null; coerces to string.
 * Use this for text that will be interpolated into HTML content.
 *
 * @param {any} unsafe
 * @returns {string}
 */
export function escapeHtml(unsafe) {
    return String(unsafe == null ? '' : unsafe).replace(/[&<>"]/g, (m) =>
        m === '&' ? '&amp;'
        : m === '<' ? '&lt;'
        : m === '>' ? '&gt;'
        : '&quot;'
    );
}

/**
 * Alias for `escapeHtml` — kept for the historical name used across
 * the AI chat UI. Both are exported so imports don't break.
 *
 * @param {any} text
 * @returns {string}
 */
export function escapeHtmlSafe(text) {
    return escapeHtml(text);
}

// ==================== PLAIN-TEXT EXTRACTION ====================

/**
 * Convert markdown to plain text — used by the copy, speak, and note-
 * title workflows where a rendered HTML version is undesirable.
 *
 * This is a best-effort strip, not a full parser. It covers:
 *   • Fenced code blocks (keeps content, drops fences + lang)
 *   • Inline code (keeps content)
 *   • Images (dropped entirely — no text to preserve)
 *   • Links (keeps link text, drops URL)
 *   • Bold / italic / strikethrough (keeps inner text)
 *   • Headers (drops leading #'s)
 *   • Lists (drops bullet / numbered prefix, keeps content)
 *   • Task items (drops [ ] or [x] marker)
 *   • Blockquotes (drops leading "> ")
 *   • Horizontal rules (dropped entirely)
 *   • Tables (drops pipe separators, keeps cells joined by spaces)
 *   • Admonitions (drops !!!type title line)
 *   • LaTeX (keeps formula source, drops delimiters)
 *   • Citations (drops [N] and multi-citation groups like [1,2])
 *   • Footnotes (drops both marker and definition)
 *
 * Anything it misses will appear roughly as-is — acceptable given
 * this is for human-readable output, not for re-parsing.
 *
 * @param {string} md
 * @returns {string}
 */
export function stripMarkdown(md) {
    if (md == null) return '';
    let plain = String(md);

    // Fenced code blocks — keep inner code, drop fences
    plain = plain.replace(/```\w*\s*\n?([\s\S]*?)```/g, (_, code) => code);

    // Inline code — keep inner code
    plain = plain.replace(/`([^`]+)`/g, '$1');

    // Images — drop entirely
    plain = plain.replace(/!\[.*?\]\(.*?\)/g, '');

    // Links — keep text
    plain = plain.replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1');

    // Bold / italic / strike / highlight
    plain = plain.replace(/\*\*(.+?)\*\*/g, '$1');
    plain = plain.replace(/__(.+?)__/g, '$1');
    plain = plain.replace(/\*(.+?)\*/g, '$1');
    plain = plain.replace(/_(.+?)_/g, '$1');
    plain = plain.replace(/~~(.+?)~~/g, '$1');
    plain = plain.replace(/==(.+?)==/g, '$1');

    // Sub / sup
    plain = plain.replace(/~(\w+)~/g, '$1');
    plain = plain.replace(/\^(\w+)\^/g, '$1');

    // LaTeX — keep formula source, drop delimiters
    plain = plain.replace(/\$\$([\s\S]*?)\$\$/g, '$1');
    plain = plain.replace(/\\\[([\s\S]*?)\\\]/g, '$1');
    plain = plain.replace(/\$(.+?)\$/g, '$1');
    plain = plain.replace(/\\\(([\s\S]*?)\\\)/g, '$1');
    plain = plain.replace(/\(\(([\s\S]*?)\)\)/g, '$1');

    // Citations — drop [N] and multi-citation groups [1,2], [1; 2], etc.
    // The (?!\() lookahead preserves markdown links like [1](url).
    plain = plain.replace(/\[\d+(?:\s*[,;]\s*\d+)*\](?!\()/g, '');

    // Footnotes — drop markers + definitions
    plain = plain.replace(/\[\^[\w\d]+\]/g, '');
    plain = plain.replace(/^\[\^[\w\d]+\]:\s+(.+)$/gm, '');

    // Admonitions — drop the "!!!type title" line, keep content
    plain = plain.replace(/^!!!\w+\s+.+$/gm, '');

    // Headers — drop leading #'s and space
    plain = plain.replace(/^#{1,6}\s+/gm, '');

    // Blockquotes — drop leading "> "
    plain = plain.replace(/^>\s?/gm, '');

    // Horizontal rules — drop entire line
    plain = plain.replace(/^(---|___|\*\*\*)\s*$/gm, '');

    // Lists — drop bullet / number / task marker
    plain = plain.replace(/^\s*[\*\-+]\s+\[[ xX]\]\s+/gm, '');
    plain = plain.replace(/^\s*[\*\-+]\s+/gm, '');
    plain = plain.replace(/^\s*\d+\.\s+/gm, '');

    // Tables — collapse pipes and separator rows
    plain = plain.replace(/^\|?[\s\-:|]+\|[\s\-:|]*$/gm, '');   // separator
    plain = plain.replace(/\|/g, ' ');
    plain = plain.replace(/[ \t]+/g, ' ');

    // Backslash escapes
    plain = plain.replace(/\\([*_`~\[\]()#+\-.!>])/g, '$1');

    // Collapse blank lines
    plain = plain.replace(/\n{3,}/g, '\n\n');

    return plain.trim();
}

// ==================== LATEX-ONLY RENDERING ====================

/**
 * Render LaTeX in isolation.
 *
 * Intended for callers that only have LaTeX to render (e.g. the
 * formula cards inside richData.formulas). Escapes the surrounding
 * text first, then replaces `$…$` and `$$…$$` with KaTeX output.
 * The KaTeX-rendered HTML is injected directly — no double escaping.
 *
 * Fails gracefully: a malformed formula becomes a `latex-error`
 * span showing the raw source. Never throws.
 *
 * @param {string} text
 * @returns {string}  safe HTML
 */
export function renderLatex(text) {
    if (text == null) return '';
    if (!window.katex) return escapeHtml(text);

    // Escape the whole string first. KaTeX HTML is injected afterwards
    // and does not contain `$`, so no collision with the escaping.
    let html = escapeHtml(text);

    // Block formulas
    html = html.replace(/\$\$([\s\S]*?)\$\$/g, (_match, formula) =>
        `<div class="latex-block">${_latexToHtml(formula, true)}</div>`
    );

    // Inline formulas
    html = html.replace(/\$(.+?)\$/g, (_match, formula) =>
        `<span class="latex-inline">${_latexToHtml(formula, false)}</span>`
    );

    return html;
}

// ==================== FULL MARKDOWN ====================

/**
 * Full markdown renderer.
 *
 * Order of extraction matters — see the top-of-file comment. The
 * stages run in this order:
 *
 *   1. Fenced code blocks     ```lang … ```
 *   2. Inline code            `…`
 *   3. LaTeX (block)          $$…$$  and  \[…\]
 *   4. LaTeX (inline)         $…$    and  \(…\)  and  ((…))
 *   5. Images                 ![](url)
 *   6. Markdown links         [text](url)
 *   7. Safe HTML tags         details / summary / kbd / abbr /
 *                             sup / sub / mark / del / ins /
 *                             video / source
 *   8. Citations              [N]        → sources[N-1]
 *                             [1,2]      → sources[0] + sources[1]
 *                             [1, 2]     → same (spaces tolerated)
 *                             [1;2]      → same (semicolon tolerated)
 *                             [1,2,3]    → three pills
 *   ↓
 *   9. HTML escape            & < > "
 *  10. ASCII diagram wrap
 *  11. Tables                 | h | h |
 *  12. Admonitions            !!!type Title
 *  13. Blockquotes            > …
 *  14. Definition lists       term\n: def
 *  15. Headers                # … ######
 *  16. HR                     --- ___ ***
 *  17. Nested lists           - item  1. item  - [ ] task
 *  18. Inline formatting      ** **  * *  ~~ ~~  == ==  ~ ~  ^ ^
 *  19. Abbreviations          *[ABBR]: expansion
 *  20. Backslash escapes
 *  21. Line breaks \n → <br>
 *  22. Footnote refs + defs
 *   ↓
 *   23. Restore all placeholders
 *  24. Auto-linkify remaining URLs
 *  25. Collapse <br><br>
 *
 * @param {string} text
 * @param {string[]} [sources=[]]  URLs used to resolve bare [N] citations
 * @returns {string}  safe HTML
 */
export function renderMarkdown(text, sources = []) {
    if (text == null) return '';
    text = String(text);

    /** @type {{codeBlocks: any[], inlineCodes: string[], latex: any[], images: any[], links: any[], safeHtml: any[], citations: any[]}} */
    const ph = {
        codeBlocks: [],
        inlineCodes: [],
        latex: [],
        images: [],
        links: [],
        safeHtml: [],
        citations: [],
    };

    const uid = (prefix, idx) => `\u0000${prefix}_${idx}\u0000`;

    let html = text;

    // ── 1. Fenced code blocks ────────────────────────────────────
    html = html.replace(/```(\w*)\s*\n([\s\S]*?)```/g, (_m, lang, code) => {
        const idx = ph.codeBlocks.length;
        ph.codeBlocks.push({
            type: lang === 'mermaid' ? 'mermaid' : 'code',
            lang,
            raw: code.replace(/\n$/, ''),
            isAscii: lang !== 'mermaid' && _isAsciiDiagram(code),
        });
        return uid('CB', idx);
    });

    // ── 2. Inline code ───────────────────────────────────────────
    html = html.replace(/`([^`]+)`/g, (_m, code) => {
        const idx = ph.inlineCodes.length;
        ph.inlineCodes.push(code);
        return uid('IC', idx);
    });

    // ── 3. LaTeX block ───────────────────────────────────────────
    html = html.replace(/\$\$([\s\S]*?)\$\$/g, (_m, f) => {
        const idx = ph.latex.length;
        ph.latex.push({ type: 'block', formula: f });
        return uid('LX', idx);
    });
    html = html.replace(/\\\[([\s\S]*?)\\\]/g, (_m, f) => {
        const idx = ph.latex.length;
        ph.latex.push({ type: 'block', formula: f });
        return uid('LX', idx);
    });

    // ── 4. LaTeX inline ──────────────────────────────────────────
    html = html.replace(/\$(.+?)\$/g, (_m, f) => {
        const idx = ph.latex.length;
        ph.latex.push({ type: 'inline', formula: f });
        return uid('LX', idx);
    });
    html = html.replace(/\\\(([\s\S]*?)\\\)/g, (_m, f) => {
        const idx = ph.latex.length;
        ph.latex.push({ type: 'inline', formula: f });
        return uid('LX', idx);
    });
    html = html.replace(/\(\(([\s\S]*?)\)\)/g, (_m, f) => {
        const idx = ph.latex.length;
        ph.latex.push({ type: 'inline', formula: f });
        return uid('LX', idx);
    });

    // ── 5. Images ────────────────────────────────────────────────
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, url) => {
        const idx = ph.images.length;
        ph.images.push({ alt, url });
        return uid('IMG', idx);
    });

    // ── 6. Markdown links ────────────────────────────────────────
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
        const idx = ph.links.length;
        ph.links.push({ text: label, url });
        return uid('LNK', idx);
    });

    // ── 7. Safe HTML tags ────────────────────────────────────────
    html = html.replace(
        /<(\/?)(details|summary|kbd|abbr|sup|sub|mark|del|ins|video|source)([^>]*)>/gi,
        (_m, closing, tag, attrs) => {
            const idx = ph.safeHtml.length;
            ph.safeHtml.push({ closing, tag, attrs });
            return uid('HTML', idx);
        }
    );

    // ── 8. Citations ─────────────────────────────────────────────
    // Runs after markdown links so `[1](url)` is already a LNK
    // placeholder, and after safe-html extraction. Only fires when
    // a sources array is provided.
    //
    // Matches every common citation shape the AI produces:
    //   [1]           → single
    //   [1,2]         → comma-separated, no space
    //   [1, 2]        → comma-separated with space
    //   [1,2,3]       → three or more
    //   [1;2]         → semicolon-separated
    //   [1, 2; 3]     → mixed separators
    //
    // Multi-citations render as adjacent pills so each number gets
    // its own clickable target and matches the source chips below
    // the message:
    //   [1,2]    →  [1][2]
    //   [1,2,3]  →  [1][2][3]
    //
    // All-or-nothing policy: if ANY number in the group is out of
    // range (e.g. [1,7] when there are only 3 sources), the whole
    // group stays as plain text. Half-linking a compound citation
    // is more confusing than linking none of it.
    //
    // The (?!\() lookahead prevents matching markdown-link syntax
    // like `[1,2](url)` — that was already claimed by step 6.
    if (Array.isArray(sources) && sources.length > 0) {
        html = html.replace(
            /\[(\d+(?:\s*[,;]\s*\d+)*)\](?!\()/g,
            (match, group) => {
                const nums = group
                    .split(/[,;]/)
                    .map((s) => parseInt(s.trim(), 10));
                const allValid = nums.every(
                    (n) => Number.isFinite(n) && n >= 1 && n <= sources.length
                );
                if (!allValid) return match;

                // One placeholder per number, joined with no separator.
                // The restore step below turns each into a pill, so the
                // rendered result is `[1][2]` — two adjacent pills,
                // each independently clickable.
                return nums
                    .map((n) => {
                        const idx = ph.citations.length;
                        ph.citations.push({ n, url: sources[n - 1] });
                        return uid('CITE', idx);
                    })
                    .join('');
            }
        );
    }

    // ── 9. Escape the remaining raw text ─────────────────────────
    html = escapeHtml(html);

    // ── 10. Wrap ASCII diagrams ──────────────────────────────────
    html = _wrapAsciiDiagrams(html);

    // ── 11. Tables ───────────────────────────────────────────────
    html = _renderTables(html);

    // ── 12. Admonitions ──────────────────────────────────────────
    html = _renderAdmonitions(html);

    // ── 13. Blockquotes ──────────────────────────────────────────
    html = html.replace(/((?:^&gt;\s+.+\n?)+)/gm, (match) => {
        const lines = match.split('\n').filter(l => l.trim());
        const content = lines.map(l => l.replace(/^&gt;\s+/, '')).join('<br>');
        return `<blockquote>${content}</blockquote>`;
    });

    // ── 14. Definition lists ─────────────────────────────────────
    html = _renderDefinitionLists(html);

    // ── 15. Headers ──────────────────────────────────────────────
    html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

    // ── 16. Horizontal rules ─────────────────────────────────────
    html = html.replace(/^(---|___|\*\*\*)\s*$/gm, '<hr>');

    // ── 17. Nested lists ─────────────────────────────────────────
    html = _renderNestedLists(html);

    // ── 18. Inline formatting ────────────────────────────────────
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/==(.+?)==/g, '<mark>$1</mark>');
    html = html.replace(/~(\w+)~/g, '<sub>$1</sub>');
    html = html.replace(/\^(\w+)\^/g, '<sup>$1</sup>');

    // ── 19. Abbreviations ────────────────────────────────────────
    const abbrDefs = new Map();
    html = html.replace(/^\*\[([^\]]+)\]:\s+(.+)$/gm, (_m, abbr, expansion) => {
        abbrDefs.set(abbr, expansion);
        return '';
    });
    if (abbrDefs.size) {
        const keys = Array.from(abbrDefs.keys())
            .map(k => k.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'));
        const re = new RegExp(`\\b(${keys.join('|')})\\b`, 'g');
        html = html.replace(re, (m) =>
            `<abbr title="${escapeHtml(abbrDefs.get(m))}">${m}</abbr>`
        );
    }

    // ── 20. Backslash escapes ────────────────────────────────────
    html = html.replace(/\\([*_`~\[\]()#+\-.!>])/g, '$1');

    // ── 21. Line breaks ──────────────────────────────────────────
    html = html.replace(/\n/g, '<br>');

    // ── 22. Footnotes ────────────────────────────────────────────
    const fnDefs = new Map();
    let fnCount = 0;
    html = html.replace(/^\[\^(\d+|\w+)\]:\s+(.+)$/gm, (_m, id, def) => {
        fnDefs.set(id, { def: def.trim(), index: ++fnCount });
        return '';
    });
    html = html.replace(/\[\^(\d+|\w+)\](?!\])/g, (_m, id) => {
        const d = fnDefs.get(id);
        if (!d) return _m;
        return `<sup class="footnote-ref" id="fnref:${id}"><a href="#fn:${id}">${d.index}</a></sup>`;
    });
    if (fnDefs.size) {
        let fnHtml = '<hr><ol class="footnotes-list">';
        [...fnDefs.entries()]
            .sort((a, b) => a[1].index - b[1].index)
            .forEach(([id, d]) => {
                fnHtml += `<li id="fn:${id}"><a href="#fnref:${id}">↩</a> ${d.def}</li>`;
            });
        fnHtml += '</ol>';
        html += fnHtml;
    }

    // ── 23. Restore placeholders ─────────────────────────────────
    html = html.replace(/\u0000CB_(\d+)\u0000/g, (_m, i) => {
        const blk = ph.codeBlocks[+i];
        if (blk.type === 'mermaid') {
            return `<div class="mermaid">${blk.raw}</div>`;
        }
        const cls = blk.isAscii ? 'ascii-diagram' : 'code-block';
        return `<pre class="${cls}"><code>${escapeHtml(blk.raw)}</code></pre>`;
    });
    html = html.replace(/\u0000IC_(\d+)\u0000/g, (_m, i) =>
        `<code>${escapeHtml(ph.inlineCodes[+i])}</code>`
    );
    html = html.replace(/\u0000LX_(\d+)\u0000/g, (_m, i) => {
        const lx = ph.latex[+i];
        return lx.type === 'block'
            ? `<div class="latex-block">${_latexToHtml(lx.formula, true)}</div>`
            : `<span class="latex-inline">${_latexToHtml(lx.formula, false)}</span>`;
    });
    html = html.replace(/\u0000IMG_(\d+)\u0000/g, (_m, i) => {
        const img = ph.images[+i];
        const url = escapeHtml(img.url);
        if (/\.(mp4|webm|ogg)$/i.test(url)) {
            return `<video controls style="max-width:100%;border-radius:8px;" preload="metadata">` +
                `<source src="${url}" type="video/mp4">${escapeHtml(img.alt)}</video>`;
        }
        return `<img src="${url}" alt="${escapeHtml(img.alt)}" class="rich-image inline-image" loading="lazy">`;
    });
    html = html.replace(/\u0000LNK_(\d+)\u0000/g, (_m, i) => {
        const l = ph.links[+i];
        return `<a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.text)}</a>`;
    });
    html = html.replace(/\u0000HTML_(\d+)\u0000/g, (_m, i) => {
        const h = ph.safeHtml[+i];
        return `<${h.closing}${h.tag}${h.attrs}>`;
    });
    html = html.replace(/\u0000CITE_(\d+)\u0000/g, (_m, i) => {
        const c = ph.citations[+i];
        const url = escapeHtml(c.url);
        return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="cite-ref" title="${url}">[${c.n}]</a>`;
    });

    // ── 24. Auto-linkify stray URLs ──────────────────────────────
    html = html.replace(
        /(?<!["'>=])(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    // ── 25. Final cleanup ────────────────────────────────────────
    html = html.replace(/<br>\s*<br>/g, '<br>');

    return html;
}

// ==================== PRIVATE HELPERS ====================

/**
 * Render a single LaTeX formula to HTML, gracefully degrading on error.
 * @private
 */
function _latexToHtml(formula, displayMode) {
    if (!window.katex) return escapeHtml(formula);
    try {
        return katex.renderToString(String(formula).trim(), {
            throwOnError: false,
            displayMode,
        });
    } catch {
        return `<span class="latex-error">${escapeHtml(formula)}</span>`;
    }
}

/**
 * Heuristic ASCII-diagram detector.
 * @private
 */
function _isAsciiDiagram(text) {
    const lines = String(text).split('\n').filter(l => l.trim().length > 0);
    if (lines.length < 3) return false;
    let count = 0;
    const patterns = [
        /[|+\-]{3,}/,
        /[─┌┐└┘├┤┬┴┼│─━]+/,
        /v\s*$/,
        />\s*$/,
        /^\s*\+[-+]+\+/,
        /[←→↑↓↔↕↨↲↳]+/,
        /^\s{2,}[|]/,
        /[|]\s{2,}[|]/,
        /^[|\-+\s]+$/,
    ];
    for (const l of lines) if (patterns.some(p => p.test(l))) count++;
    return count >= Math.ceil(lines.length * 0.4);
}

/**
 * Detect runs of ASCII-diagram lines split by <br> and wrap each run
 * in <pre class="ascii-diagram">. Runs of fewer than 2 lines are left
 * untouched.
 * @private
 */
function _wrapAsciiDiagrams(html) {
    const lines = html.split('<br>');
    const out = [];
    let buffer = [];
    let inBlock = false;

    for (const line of lines) {
        const plain = line.replace(/<[^>]+>/g, '');
        const isDiagram = plain.length > 0 && _isAsciiDiagram(plain);

        if (isDiagram && !inBlock) {
            inBlock = true;
            buffer = [line];
        } else if (isDiagram && inBlock) {
            buffer.push(line);
        } else if (!isDiagram && inBlock) {
            if (buffer.length >= 2) {
                out.push(
                    `<pre class="ascii-diagram"><code>${buffer.join('\n')}</code></pre>`
                );
            } else {
                out.push(...buffer);
            }
            out.push(line);
            inBlock = false;
            buffer = [];
        } else {
            out.push(line);
        }
    }

    if (inBlock && buffer.length >= 2) {
        out.push(
            `<pre class="ascii-diagram"><code>${buffer.join('\n')}</code></pre>`
        );
    } else if (inBlock) {
        out.push(...buffer);
    }

    return out.join('<br>');
}

/**
 * Parse GitHub-flavoured pipe tables.
 * @private
 */
function _renderTables(html) {
    const re = /\|(.+)\|\s*\n\|([-:| ]+)\|\s*\n((?:\|.+\|\s*\n?)+)/g;
    return html.replace(re, (_m, headerRow, sepRow, dataRows) => {
        const headers = headerRow.split('|').map(c => c.trim());
        const alignCells = sepRow.split('|').filter(c => c.trim());
        const alignments = alignCells.map(c => {
            if (c.startsWith(':') && c.endsWith(':')) return 'center';
            if (c.endsWith(':')) return 'right';
            return 'left';
        });
        const dataLines = dataRows.trim().split('\n').filter(l => l.trim());

        let table = '<table class="md-table"><thead><tr>';
        headers.forEach((h, i) => {
            table += `<th style="text-align:${alignments[i] || 'left'}">${h}</th>`;
        });
        table += '</tr></thead><tbody>';
        dataLines.forEach(line => {
            const cells = line.split('|').filter(c => c.trim());
            table += '<tr>';
            cells.forEach((c, j) => {
                table += `<td style="text-align:${alignments[j] || 'left'}">${c}</td>`;
            });
            table += '</tr>';
        });
        table += '</tbody></table>';
        return table;
    });
}

/**
 * Render !!!type Title blocks as admonition cards.
 * @private
 */
function _renderAdmonitions(html) {
    const re = /!!!(\w+)\s+(.+?)\n([\s\S]*?)(?=\n(?:!!!|```|$)|$)/g;
    const icons = {
        note: '📝', warning: '⚠️', tip: '💡',
        danger: '🚨', info: 'ℹ️', success: '✅',
    };
    const valid = Object.keys(icons);

    return html.replace(re, (_m, type, title, content) => {
        const clean = valid.includes(type) ? type : 'info';
        return `<div class="admonition admonition-${clean}">` +
            `<div class="admonition-header">` +
            `<span class="admonition-icon">${icons[clean]}</span> ${title}` +
            `</div>` +
            `<div class="admonition-content">${content.trim().replace(/\n/g, '<br>')}</div>` +
            `</div>`;
    });
}

/**
 * Render `term\n: def\n: def` groups as <dl> lists.
 * @private
 */
function _renderDefinitionLists(html) {
    const lines = html.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (
            i + 1 < lines.length &&
            !/^:\s/.test(line) &&
            /^:\s/.test(lines[i + 1])
        ) {
            out.push('<dl>');
            if (line.trim()) out.push(`<dt>${line.trim()}</dt>`);
            i++;
            while (i < lines.length && /^:\s/.test(lines[i])) {
                out.push(`<dd>${lines[i].replace(/^:\s+/, '')}</dd>`);
                i++;
            }
            out.push('</dl>');
        } else {
            out.push(line);
            i++;
        }
    }
    return out.join('\n');
}

/**
 * Convert indented bullet/number/task lines into nested <ul>/<ol>.
 * Handles task items (`- [ ]` / `- [x]`) with a disabled checkbox.
 * @private
 */
function _renderNestedLists(html) {
    const lines = html.split('\n');
    const stack = [];
    const output = [];

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trimStart();
        const indent = raw.length - trimmed.length;

        let match = trimmed.match(/^[*\-+]\s+\[([ xX])\]\s+(.+)$/);
        let isTask = true;
        if (!match) {
            match = trimmed.match(/^[*\-+]\s+(.+)$/);
            isTask = false;
        }
        if (!match) {
            match = trimmed.match(/^(\d+)\.\s+(.+)$/);
            isTask = false;
        }

        if (match) {
            const content = match[2] || match[1];
            const tag = match[2] ? 'ul' : 'ol';
            const isChecked = isTask && /^\[[xX]\]$/.test(match[1]);

            while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
                output.push(`</${stack.pop().tag}>`);
            }
            if (
                stack.length === 0 ||
                stack[stack.length - 1].indent < indent ||
                (stack[stack.length - 1].indent === indent &&
                    stack[stack.length - 1].tag !== tag)
            ) {
                output.push(`<${tag}>`);
                stack.push({ tag, indent });
            }

            if (isTask) {
                output.push(
                    `<li class="task-list-item">` +
                    `<input type="checkbox" disabled ${isChecked ? 'checked' : ''}> ` +
                    `${content}</li>`
                );
            } else {
                output.push(`<li>${content}</li>`);
            }
        } else {
            while (stack.length > 0) output.push(`</${stack.pop().tag}>`);
            output.push(raw);
        }
    }

    while (stack.length > 0) output.push(`</${stack.pop().tag}>`);
    return output.join('\n');
}