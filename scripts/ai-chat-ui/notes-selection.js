// scripts/ai-chat-ui/notes-selection.js
/**
 * Notes selection — multi-select assistant messages → save as a note.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 * Two responsibilities, one module:
 *
 *   1. SELECTION UI — the multi-select mode that turns every assistant
 *      message into a checkbox-selectable card, shows a floating
 *      action bar (count / Select All / Save / Cancel), and returns
 *      to normal chat mode when the user is done.
 *
 *   2. HTML CONVERSION — the transformation from the rendered
 *      assistant HTML into clean, notes-shaped HTML that looks good
 *      when it lands in the Quill editor.
 *
 * ── Why a dedicated conversion ───────────────────────────────────────
 * The markdown renderer (markdown.js) produces HTML tuned for the CHAT
 * view. Its output is intentionally dense — every `\n` becomes `<br>`,
 * headings get minimal spacing, code blocks carry chat-specific
 * classes, admonitions wrap in multi-div structures, and LaTeX is
 * embedded as KaTeX HTML. That's perfect for a message bubble but
 * terrible for a note.
 *
 * When a user saves a selection to Notes, we want it to look like
 * STUDY NOTES, not like a pasted chat message:
 *
 *   • Paragraph structure       — real <p> blocks, not a wall of <br>
 *   • Readable typography       — reasonable font size, line height,
 *                                 margins between paragraphs
 *   • Clear hierarchy           — headings visibly stand out from body
 *   • Compact lists             — natural list rendering, not one
 *                                 bullet per line with <br>
 *   • Clean code blocks         — no chat-specific classes; monospace
 *                                 preserved; background tinted for
 *                                 contrast
 *   • Readable formulas         — LaTeX renders as code, not as
 *                                 KaTeX-generated span soup
 *   • Callouts preserved        — admonitions become blockquotes with
 *                                 a bold header, so the visual cue
 *                                 survives
 *   • Task lists as text        — ☑ / ☐ instead of input checkboxes
 *                                 (Quill doesn't preserve inputs
 *                                 reliably and disabled checkboxes
 *                                 are semantically wrong here)
 *
 * ── Font strategy ────────────────────────────────────────────────────
 * Notes inherit their font from the Notes page CSS once Quill loads
 * the content — Quill normalizes and re-renders the HTML into its own
 * document model, so arbitrary inline styles do not survive.
 *
 * BUT: the same HTML is used when a note is exported, shared, or
 * rendered outside Quill. For those paths, the inline styles DO
 * apply. So the conversion emits inline styles by default (`styled`
 * mode) to guarantee a good appearance everywhere. When Quill
 * normalizes them away, the Notes page's own CSS takes over — no
 * harm either way.
 *
 * `notesCssHint()` is exported so the Notes page can include the
 * same rules as a `<style>` block if it wants a consistent look
 * across both rendering paths.
 *
 * ── Quill compatibility rules followed ──────────────────────────────
 *   • Every block is a top-level element Quill understands:
 *     <h1-6>, <p>, <ul>, <ol>, <li>, <pre>, <blockquote>, <hr>,
 *     <table>. Nothing depends on a wrapper <div> Quill would strip.
 *   • No custom class names — Quill drops them on parse.
 *   • Inline styles are kept only as graceful-degradation hints; they
 *     do not affect Quill's structural parse.
 *   • `<br>` is used only inside `<pre>` (where it's a real newline)
 *     and never between blocks.
 *   • Task list checkboxes become ☑ / ☐ characters.
 *   • LaTeX becomes inline `<code>` or block `<pre><code>` with the
 *     formula source, not the rendered KaTeX spans.
 *
 * ── Public API ───────────────────────────────────────────────────────
 *   enterSelectionMode(chat, initialEl?)
 *   exitSelectionMode(chat)
 *   toggleMessageSelection(chat, el, force?)
 *   selectAllMessages(chat)
 *   deselectAllMessages(chat)
 *   syncSelectionVisual(chat)
 *   renderSelectionBar(chat)
 *   updateSelectionBarCount(chat)
 *   saveSelectedToNotes(chat, options?)
 *   renderedToNotesHtml(renderedHtml, styleMode?)
 *   extractPlainText(html)
 *   showNoteSavedToast(note)
 *   notesCssHint()
 */

import * as ui from '../ui.js';
import * as router from '../router.js';
import * as notes from '../notes.js';
import { escapeHtml } from './markdown.js';

// ==================== CONSTANTS ====================

// Block-level tags whose children should NOT be broken into individual
// paragraphs. Everything else (text + inline elements) is buffered
// into a paragraph and flushed on the next <br> or block element.
const BLOCK_TAGS = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'UL', 'OL', 'DL',
    'PRE',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR',
    'BLOCKQUOTE',
    'HR',
    'DIV',      // admonitions from markdown.js — handled specially
]);

// Inline tags that stay inline when buffered into a paragraph.
const INLINE_TAGS = new Set([
    'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'INS', 'MARK',
    'CODE', 'A', 'IMG', 'SUB', 'SUP', 'ABBR', 'SMALL', 'SPAN',
]);

// Style presets. Emitted as inline `style` attributes on each block.
// The Notes page CSS can override these when Quill normalizes, and
// they apply directly to raw HTML rendering (export, share preview).
const STYLE_MODES = {
    plain: {
        p: 'margin:0.5em 0;line-height:1.55;',
        h1: 'margin:1em 0 0.4em;',
        h2: 'margin:0.9em 0 0.35em;',
        h3: 'margin:0.8em 0 0.3em;',
        h4: 'margin:0.7em 0 0.25em;',
        h5: 'margin:0.6em 0 0.2em;',
        h6: 'margin:0.5em 0 0.2em;',
        ul: 'margin:0.3em 0;padding-left:1.3em;',
        ol: 'margin:0.3em 0;padding-left:1.3em;',
        li: 'margin:0.1em 0;line-height:1.5;',
        pre: 'background:#f4f4f5;padding:0.6em 0.8em;border-radius:4px;overflow-x:auto;font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:0.9em;margin:0.5em 0;line-height:1.4;',
        code: 'font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:0.9em;background:#f4f4f5;padding:1px 4px;border-radius:3px;',
        blockquote: 'border-left:3px solid #cbd5e0;padding:0.3em 0.8em;margin:0.5em 0;color:#4a5568;font-size:0.95em;',
        table: 'border-collapse:collapse;margin:0.5em 0;font-size:0.92em;',
        th: 'border:1px solid #cbd5e0;padding:0.35em 0.5em;background:#edf2f7;text-align:left;font-weight:600;',
        td: 'border:1px solid #cbd5e0;padding:0.3em 0.5em;',
        hr: 'border:none;border-top:1px solid #e2e8f0;margin:1em 0;',
    },
    styled: {
        p: 'margin:0.6em 0;line-height:1.6;font-size:15px;color:#1a202c;',
        h1: 'margin:1.2em 0 0.5em;font-size:1.6em;font-weight:700;line-height:1.25;color:#1a202c;',
        h2: 'margin:1.1em 0 0.4em;font-size:1.35em;font-weight:700;line-height:1.3;color:#1a202c;',
        h3: 'margin:1em 0 0.35em;font-size:1.15em;font-weight:600;line-height:1.35;color:#1a202c;',
        h4: 'margin:0.9em 0 0.3em;font-size:1.05em;font-weight:600;line-height:1.4;color:#1a202c;',
        h5: 'margin:0.8em 0 0.25em;font-size:1em;font-weight:600;color:#1a202c;',
        h6: 'margin:0.7em 0 0.2em;font-size:0.95em;font-weight:600;color:#4a5568;',
        ul: 'margin:0.35em 0;padding-left:1.4em;line-height:1.6;font-size:15px;color:#1a202c;',
        ol: 'margin:0.35em 0;padding-left:1.4em;line-height:1.6;font-size:15px;color:#1a202c;',
        li: 'margin:0.15em 0;line-height:1.55;',
        pre: 'background:#f7fafc;border:1px solid #e2e8f0;padding:0.7em 0.9em;border-radius:6px;overflow-x:auto;font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:13px;line-height:1.5;margin:0.6em 0;',
        code: 'font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;font-size:0.9em;background:#edf2f7;color:#c53030;padding:1px 5px;border-radius:3px;',
        blockquote: 'border-left:4px solid #a0aec0;background:#f7fafc;padding:0.5em 0.9em;margin:0.6em 0;color:#2d3748;font-size:0.95em;font-style:normal;',
        table: 'border-collapse:collapse;margin:0.6em 0;font-size:14px;width:100%;',
        th: 'border:1px solid #cbd5e0;padding:0.45em 0.65em;background:#edf2f7;text-align:left;font-weight:600;color:#1a202c;',
        td: 'border:1px solid #cbd5e0;padding:0.4em 0.6em;color:#1a202c;',
        hr: 'border:none;border-top:1px solid #e2e8f0;margin:1.2em 0;',
    },
};

// ==================== SELECTION MODE ====================

/**
 * Enter multi-select mode for saving assistant messages to Notes.
 *
 * Turns every assistant message into a clickable card with a
 * checkbox overlay, adds `.selectable` to each, and shows the
 * floating action bar. If `initialEl` is provided, that message is
 * pre-selected (used when the user clicks the "To Notes" action on
 * a specific message).
 *
 * Also disables the input controls — the user is choosing messages
 * to save, not sending new ones.
 *
 * @param {object} chat
 * @param {HTMLElement} [initialEl]  message to pre-select
 */
export function enterSelectionMode(chat, initialEl = null) {
    if (!chat) return;
    if (chat._selectionMode) {
        if (initialEl) toggleMessageSelection(chat, initialEl, true);
        return;
    }

    const messages = chat.chatContainer?.querySelectorAll('.message.assistant');
    if (!messages || messages.length === 0) {
        ui.showToast('No AI messages to save yet', 'info');
        return;
    }

    chat._selectionMode = true;
    chat._selectedElements.clear();
    if (initialEl && initialEl.classList.contains('message')) {
        chat._selectedElements.add(initialEl);
    }

    messages.forEach((el) => {
        el.classList.add('selectable');
        if (!el.querySelector('.message-select-checkbox')) {
            const cb = document.createElement('div');
            cb.className = 'message-select-checkbox';
            cb.setAttribute('role', 'checkbox');
            cb.setAttribute('tabindex', '0');
            cb.setAttribute('aria-checked', 'false');
            cb.setAttribute('aria-label', 'Select message');
            cb.innerHTML = '<i class="far fa-circle" aria-hidden="true"></i>';

            cb.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleMessageSelection(chat, el);
            });
            cb.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleMessageSelection(chat, el);
                }
            });

            el.insertBefore(cb, el.firstChild);
        }
    });

    syncSelectionVisual(chat);
    renderSelectionBar(chat);

    if (chat.messageInput) chat.messageInput.disabled = true;
    if (chat.sendBtn) chat.sendBtn.disabled = true;
}

/**
 * Exit multi-select mode and restore normal chat interaction.
 *
 * Clears `.selectable` / `.selected` from every message, removes the
 * checkbox overlays, removes the floating bar, and re-enables the
 * input (unless we're in shared view or the user lacks a
 * subscription).
 *
 * @param {object} chat
 */
export function exitSelectionMode(chat) {
    if (!chat || !chat._selectionMode) return;

    chat._selectionMode = false;
    chat._selectedElements.clear();

    chat.chatContainer?.querySelectorAll('.message.assistant').forEach((el) => {
        el.classList.remove('selectable', 'selected');
        const cb = el.querySelector('.message-select-checkbox');
        if (cb) cb.remove();
    });

    if (chat._selectionBar) {
        chat._selectionBar.remove();
        chat._selectionBar = null;
        chat._selectionBarCountEl = null;
    }

    if (!chat.isSharedView) {
        if (chat.messageInput && chat.hasActiveSubscription) chat.messageInput.disabled = false;
        if (chat.sendBtn && chat.hasActiveSubscription) chat.sendBtn.disabled = false;
    }
}

/**
 * Toggle a single message's selection state.
 *
 * @param {object} chat
 * @param {HTMLElement} el
 * @param {boolean} [forceSelect=false]  force-select regardless of current state
 */
export function toggleMessageSelection(chat, el, forceSelect = false) {
    if (!chat || !chat._selectionMode) return;
    if (chat._selectedElements.has(el) && !forceSelect) {
        chat._selectedElements.delete(el);
    } else {
        chat._selectedElements.add(el);
    }
    syncSelectionVisual(chat);
    updateSelectionBarCount(chat);
}

export function selectAllMessages(chat) {
    if (!chat) return;
    chat.chatContainer?.querySelectorAll('.message.assistant').forEach((el) => {
        chat._selectedElements.add(el);
    });
    syncSelectionVisual(chat);
    updateSelectionBarCount(chat);
}

export function deselectAllMessages(chat) {
    if (!chat) return;
    chat._selectedElements.clear();
    syncSelectionVisual(chat);
    updateSelectionBarCount(chat);
}

/**
 * Sync the visual state (selected class + checkbox icon) with the
 * `_selectedElements` set.
 */
export function syncSelectionVisual(chat) {
    if (!chat) return;
    chat.chatContainer?.querySelectorAll('.message.assistant').forEach((el) => {
        const isSelected = chat._selectedElements.has(el);
        el.classList.toggle('selected', isSelected);
        const cb = el.querySelector('.message-select-checkbox');
        if (cb) {
            cb.setAttribute('aria-checked', isSelected ? 'true' : 'false');
            cb.innerHTML = isSelected
                ? '<i class="fas fa-check-circle" aria-hidden="true"></i>'
                : '<i class="far fa-circle" aria-hidden="true"></i>';
        }
    });
}

// ==================== SELECTION BAR ====================

/**
 * Render the floating action bar (cancel / count / select-all / save).
 */
export function renderSelectionBar(chat) {
    if (!chat) return;
    if (chat._selectionBar) chat._selectionBar.remove();

    const bar = document.createElement('div');
    bar.className = 'ai-selection-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Message selection');
    bar.innerHTML = `
        <button class="ai-sel-btn ai-sel-cancel" title="Cancel selection" type="button" aria-label="Cancel selection">
            <i class="fas fa-times" aria-hidden="true"></i>
        </button>
        <div class="ai-sel-info">
            <span class="ai-sel-count" aria-live="polite">0</span>
            <span class="ai-sel-label">selected</span>
        </div>
        <button class="ai-sel-btn ai-sel-toggle" type="button">Select All</button>
        <button class="ai-sel-btn ai-sel-save" type="button" disabled>
            <i class="fas fa-save" aria-hidden="true"></i> Save to Notes
        </button>
    `;
    document.body.appendChild(bar);
    chat._selectionBar = bar;
    chat._selectionBarCountEl = bar.querySelector('.ai-sel-count');

    bar.querySelector('.ai-sel-cancel')?.addEventListener('click', () => exitSelectionMode(chat));
    bar.querySelector('.ai-sel-toggle')?.addEventListener('click', () => {
        const all = chat.chatContainer?.querySelectorAll('.message.assistant');
        if (chat._selectedElements.size === all.length) {
            deselectAllMessages(chat);
        } else {
            selectAllMessages(chat);
        }
    });
    bar.querySelector('.ai-sel-save')?.addEventListener('click', () => saveSelectedToNotes(chat));

    updateSelectionBarCount(chat);
}

export function updateSelectionBarCount(chat) {
    if (!chat || !chat._selectionBar) return;
    const count = chat._selectedElements.size;
    if (chat._selectionBarCountEl) chat._selectionBarCountEl.textContent = String(count);

    const saveBtn = chat._selectionBar.querySelector('.ai-sel-save');
    if (saveBtn) saveBtn.disabled = count === 0;

    const toggleBtn = chat._selectionBar.querySelector('.ai-sel-toggle');
    const all = chat.chatContainer?.querySelectorAll('.message.assistant');
    if (toggleBtn && all) {
        toggleBtn.textContent = (count === all.length && count > 0)
            ? 'Deselect All'
            : 'Select All';
    }
}

// ==================== SAVE ====================

/**
 * Save the current selection as a note.
 *
 * @param {object} chat
 * @param {{ styleMode?: 'plain'|'styled' }} [options]
 * @returns {Promise<void>}
 */
export async function saveSelectedToNotes(chat, options = {}) {
    if (!chat) return;
    const styleMode = options.styleMode || 'styled';

    const selected = [...chat._selectedElements];
    if (selected.length === 0) {
        ui.showToast('Select at least one message', 'warning');
        return;
    }

    const parts = [];
    selected.forEach((el) => {
        const content = el.querySelector('.assistant-content');
        if (content) {
            const html = renderedToNotesHtml(content.innerHTML, styleMode);
            if (html.trim()) parts.push(html);
        }
    });

    if (parts.length === 0) {
        ui.showToast('No content to save', 'error');
        return;
    }

    const combinedHtml = parts.length === 1
        ? parts[0]
        : parts.map((p, i) => `<h2>Response ${i + 1}</h2>${p}`).join('');

    const firstText = extractPlainText(selected[0].innerHTML).trim();
    const dateStr = new Date().toISOString().slice(0, 10);
    const suggestedTitle = parts.length === 1 && firstText
        ? (firstText.length > 50 ? firstText.slice(0, 50) + '…' : firstText)
        : `AI Notes - ${dateStr}`;

    try {
        ui.showLoading('Saving to notes...');

        const plainText = extractPlainText(combinedHtml);
        const created = await notes.createNote({
            title: suggestedTitle,
            content: combinedHtml,
            plainText,
            tags: ['from-ai'],
        });

        ui.hideLoading();
        exitSelectionMode(chat);
        showNoteSavedToast(created);
    } catch (err) {
        ui.hideLoading();
        console.error('[notes-save] failed:', err);
        ui.showToast(
            'Failed to save note: ' + (err?.message || 'unknown error'),
            'error'
        );
    }
}

// ==================== HTML CONVERSION ====================

/**
 * Convert rendered assistant HTML into clean, notes-shaped HTML.
 *
 * The transformation happens in stages:
 *
 *   1. Parse the rendered HTML into a container.
 *   2. Walk top-level children:
 *        • Text + inline elements  → buffer
 *        • <br>                    → flush buffer as <p>
 *        • <div> (admonition)      → convert to <blockquote>, flush
 *        • Any block element       → flush buffer, append cleaned block
 *   3. Post-process each block:
 *        • Strip classes, extraneous attributes
 *        • Simplify special tags (task checkboxes, admonition divs)
 *        • Apply per-tag inline styles (if styleMode = 'styled')
 *   4. Join blocks with nothing (each is already block-level).
 *
 * The result is Quill-compatible: only standard block and inline
 * tags, no custom classes, no <br> between blocks, no wrapper divs.
 *
 * @param {string} renderedHtml
 * @param {'plain'|'styled'} [styleMode='styled']
 * @returns {string}
 */
export function renderedToNotesHtml(renderedHtml, styleMode = 'styled') {
    if (!renderedHtml) return '';
    const styles = STYLE_MODES[styleMode] || STYLE_MODES.styled;

    // ── 1. Parse ────────────────────────────────────────────────
    const container = document.createElement('div');
    container.innerHTML = String(renderedHtml);

    // ── 2. Extract LaTeX before any structural work ─────────────
    // KaTeX output is enormous and unusable in a note. Replace every
    // .latex-inline / .latex-block span with a plain-text formula
    // pulled from the <annotation> tag, wrapped in <code> / <pre>.
    container.querySelectorAll('.latex-inline, .latex-block').forEach((el) => {
        const isBlock = el.classList.contains('latex-block');
        const annotation = el.querySelector('annotation');
        const formula = annotation ? annotation.textContent.trim() : el.textContent.trim();
        if (!formula) { el.remove(); return; }

        const replacement = document.createElement(isBlock ? 'pre' : 'code');
        if (isBlock) {
            const code = document.createElement('code');
            code.textContent = formula;
            replacement.appendChild(code);
        } else {
            replacement.textContent = formula;
        }
        el.replaceWith(replacement);
    });

    // ── 3. Walk and rebuild ─────────────────────────────────────
    const out = [];
    let paraBuffer = '';

    const flushPara = () => {
        const trimmed = paraBuffer.trim();
        paraBuffer = '';
        if (!trimmed) return;
        // Ensure it's a <p> wrapper — Quill expects blocks at top level.
        out.push(`<p style="${styles.p}">${trimmed}</p>`);
    };

    const appendBlock = (el) => {
        flushPara();
        const cleaned = _cleanBlock(el, styles);
        if (cleaned) out.push(cleaned);
    };

    for (const node of Array.from(container.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
            paraBuffer += escapeHtml(node.textContent);
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        const tag = node.tagName;

        if (tag === 'BR') {
            flushPara();
            continue;
        }

        // Admonitions — markdown.js emits <div class="admonition ...">
        if (tag === 'DIV' && node.classList.contains('admonition')) {
            appendBlock(_convertAdmonition(node, styles));
            continue;
        }

        // Any block element — flush and append.
        if (BLOCK_TAGS.has(tag)) {
            appendBlock(node);
            continue;
        }

        // Inline element — buffer with its outerHTML (already escaped).
        if (INLINE_TAGS.has(tag)) {
            paraBuffer += _cleanInline(node);
            continue;
        }

        // Unknown element — treat as inline.
        paraBuffer += _cleanInline(node);
    }
    flushPara();

    // ── 4. Final compact join ───────────────────────────────────
    return out.join('');
}

/**
 * Clean a block element: strip classes, apply inline styles, and
 * recurse into nested blocks that need special handling (lists,
 * tables, code blocks).
 *
 * @private
 */
function _cleanBlock(el, styles) {
    const tag = el.tagName;
    const clone = el.cloneNode(true);

    // Strip classes from the wrapper AND every descendant.
    _stripClasses(clone);

    // Special-case task lists: replace inputs with ☑ / ☐.
    _convertTaskCheckboxes(clone);

    // Apply the style for this specific tag.
    const styleKey = _styleKeyForBlock(tag);
    const style = styles[styleKey];
    if (style) clone.setAttribute('style', style);

    // Per-child styling for tables and lists — each cell / item
    // gets its own style so it renders sensibly without the parent
    // table style cascading onto text.
    if (tag === 'TABLE') {
        clone.querySelectorAll('th').forEach((th) => th.setAttribute('style', styles.th));
        clone.querySelectorAll('td').forEach((td) => td.setAttribute('style', styles.td));
    }
    if (tag === 'UL' || tag === 'OL') {
        clone.querySelectorAll('li').forEach((li) => li.setAttribute('style', styles.li));
    }
    if (tag === 'PRE') {
        clone.querySelectorAll('code').forEach((code) => {
            code.setAttribute('style', 'font-family:inherit;background:none;padding:0;color:inherit;');
        });
    }

    return clone.outerHTML;
}

/**
 * Clean an inline element — strip classes, keep attributes that
 * Quill understands (href, src, alt).
 *
 * @private
 */
function _cleanInline(el) {
    const tag = el.tagName;
    const clone = el.cloneNode(true);
    _stripClasses(clone);

    // Inline <code> — no wrapper style needed; the notes CSS handles it.
    // Anchors keep target + rel. Images keep loading=lazy.
    if (tag === 'A') {
        clone.setAttribute('target', '_blank');
        clone.setAttribute('rel', 'noopener noreferrer');
    }
    if (tag === 'IMG') {
        clone.setAttribute('loading', 'lazy');
    }

    return clone.outerHTML;
}

/**
 * Convert an admonition div into a blockquote with a bold header.
 *
 * Input (from markdown.js):
 *   <div class="admonition admonition-note">
 *     <div class="admonition-header">📝 Title</div>
 *     <div class="admonition-content">content...</div>
 *   </div>
 *
 * Output:
 *   <blockquote style="...">
 *     <p style="..."><strong>📝 Title</strong></p>
 *     <p style="...">content...</p>
 *   </blockquote>
 *
 * @private
 */
function _convertAdmonition(admonitionEl, styles) {
    const header = admonitionEl.querySelector('.admonition-header');
    const content = admonitionEl.querySelector('.admonition-content');

    const bq = document.createElement('blockquote');
    bq.setAttribute('style', styles.blockquote);

    if (header) {
        const titleText = header.textContent.trim();
        if (titleText) {
            const p = document.createElement('p');
            p.setAttribute('style', 'margin:0 0 0.3em;font-weight:600;');
            const strong = document.createElement('strong');
            strong.textContent = titleText;
            p.appendChild(strong);
            bq.appendChild(p);
        }
    }

    if (content) {
        // Content may contain its own inline markup — strip the class
        // wrappers but preserve structure.
        content.querySelectorAll('[class]').forEach((el) => el.removeAttribute('class'));
        const p = document.createElement('p');
        p.setAttribute('style', 'margin:0;');
        p.innerHTML = content.innerHTML.replace(/<br\s*\/?>/gi, ' ');
        bq.appendChild(p);
    }

    return bq;
}

/**
 * Replace `<input type="checkbox" disabled checked>` inside task list
 * items with ☑ / ☐ text — Quill doesn't reliably preserve disabled
 * inputs, and even when it does, they look wrong in a static note.
 *
 * @private
 */
function _convertTaskCheckboxes(el) {
    el.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        const checked = input.hasAttribute('checked') || input.checked;
        const replacement = document.createTextNode(checked ? '☑ ' : '☐ ');
        input.replaceWith(replacement);
    });
}

/**
 * Map a block tag to the style preset key.
 * @private
 */
function _styleKeyForBlock(tag) {
    switch (tag) {
        case 'H1': return 'h1';
        case 'H2': return 'h2';
        case 'H3': return 'h3';
        case 'H4': return 'h4';
        case 'H5': return 'h5';
        case 'H6': return 'h6';
        case 'UL': return 'ul';
        case 'OL': return 'ol';
        case 'PRE': return 'pre';
        case 'BLOCKQUOTE': return 'blockquote';
        case 'TABLE': return 'table';
        case 'HR': return 'hr';
        case 'P': return 'p';
        default: return 'p';
    }
}

/**
 * Strip every `class` attribute from an element and its descendants.
 * @private
 */
function _stripClasses(el) {
    if (el.nodeType === Node.ELEMENT_NODE) {
        el.removeAttribute('class');
    }
    el.querySelectorAll?.('[class]').forEach((child) => child.removeAttribute('class'));
}

// ==================== PLAIN-TEXT EXTRACTION ====================

/**
 * Extract plain text from a piece of HTML — used for the note's
 * `plainText` field (search index and card previews).
 *
 * Preserves block structure by inserting newlines at block
 * boundaries so the flat text keeps a readable shape:
 *
 *   "<h1>A</h1><p>B</p><ul><li>C</li><li>D</li></ul>"
 *   →
 *   "A\nB\nC\nD"
 *
 * Consecutive newlines are collapsed; leading / trailing whitespace
 * trimmed.
 *
 * @param {string} html
 * @returns {string}
 */
export function extractPlainText(html) {
    if (!html) return '';
    const container = document.createElement('div');
    container.innerHTML = String(html);

    let result = '';

    const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = node.tagName;
        if (tag === 'BR') { result += '\n'; return; }
        if (tag === 'HR') { result += '\n\n'; return; }

        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock && result.length > 0 && !result.endsWith('\n')) result += '\n';

        for (const child of node.childNodes) walk(child);

        if (isBlock && !result.endsWith('\n')) result += '\n';
    };

    walk(container);

    return result
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ==================== TOAST ====================

/**
 * Show a small "Saved to Notes" toast with an "Open Notes" action.
 *
 * @param {object} note  the created note record
 */
export function showNoteSavedToast(note) {
    const existing = document.querySelector('.note-saved-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'note-saved-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
        <div class="note-saved-toast-body">
            <i class="fas fa-check-circle" aria-hidden="true"></i>
            <span class="note-saved-toast-text">
                Saved to Notes: <strong>${escapeHtml(note?.title || 'Untitled')}</strong>
            </span>
        </div>
        <div class="note-saved-toast-actions">
            <button class="note-saved-open" type="button">
                <i class="fas fa-external-link-alt" aria-hidden="true"></i> Open Notes
            </button>
            <button class="note-saved-dismiss" type="button" title="Dismiss" aria-label="Dismiss">&times;</button>
        </div>
    `;
    document.body.appendChild(toast);

    const remove = () => { if (toast.parentNode) toast.remove(); };
    toast.querySelector('.note-saved-open')?.addEventListener('click', () => {
        remove();
        router.navigateTo('notes');
    });
    toast.querySelector('.note-saved-dismiss')?.addEventListener('click', remove);

    setTimeout(() => {
        if (toast.parentNode) {
            toast.classList.add('fade-out');
            setTimeout(remove, 300);
        }
    }, 8000);
}

// ==================== CSS HINT ====================

/**
 * Return a CSS block that mirrors the inline styles used by the
 * conversion. The Notes page can drop this into a `<style>` tag to
 * ensure the raw-HTML rendering and the Quill-editor rendering look
 * consistent.
 *
 * Usage (Notes page HTML):
 *   <style>${notesCssHint()}</style>
 *
 * Or import and inject dynamically:
 *   const style = document.createElement('style');
 *   style.textContent = notesCssHint();
 *   document.head.appendChild(style);
 *
 * @returns {string}
 */
export function notesCssHint() {
    return `
        /* Notes content — matches the inline styles produced by the
           AI → Notes conversion so a note looks the same whether it's
           viewed in Quill or rendered as raw HTML. */
        .ql-editor h1, .note-content h1 { font-size: 1.6em; font-weight: 700; margin: 1.2em 0 0.5em; line-height: 1.25; }
        .ql-editor h2, .note-content h2 { font-size: 1.35em; font-weight: 700; margin: 1.1em 0 0.4em; line-height: 1.3; }
        .ql-editor h3, .note-content h3 { font-size: 1.15em; font-weight: 600; margin: 1em 0 0.35em; line-height: 1.35; }
        .ql-editor h4, .note-content h4 { font-size: 1.05em; font-weight: 600; margin: 0.9em 0 0.3em; }
        .ql-editor h5, .note-content h5 { font-size: 1em; font-weight: 600; margin: 0.8em 0 0.25em; }
        .ql-editor h6, .note-content h6 { font-size: 0.95em; font-weight: 600; margin: 0.7em 0 0.2em; }
        .ql-editor p, .note-content p { margin: 0.6em 0; line-height: 1.6; }
        .ql-editor ul, .ql-editor ol, .note-content ul, .note-content ol { margin: 0.35em 0; padding-left: 1.4em; }
        .ql-editor li, .note-content li { margin: 0.15em 0; line-height: 1.55; }
        .ql-editor pre, .note-content pre { background: #f7fafc; border: 1px solid #e2e8f0; padding: 0.7em 0.9em; border-radius: 6px; overflow-x: auto; font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 13px; line-height: 1.5; margin: 0.6em 0; }
        .ql-editor code, .note-content code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; font-size: 0.9em; background: #edf2f7; color: #c53030; padding: 1px 5px; border-radius: 3px; }
        .ql-editor blockquote, .note-content blockquote { border-left: 4px solid #a0aec0; background: #f7fafc; padding: 0.5em 0.9em; margin: 0.6em 0; color: #2d3748; }
        .ql-editor table, .note-content table { border-collapse: collapse; margin: 0.6em 0; font-size: 14px; width: 100%; }
        .ql-editor th, .note-content th { border: 1px solid #cbd5e0; padding: 0.45em 0.65em; background: #edf2f7; text-align: left; font-weight: 600; }
        .ql-editor td, .note-content td { border: 1px solid #cbd5e0; padding: 0.4em 0.6em; }
        .ql-editor hr, .note-content hr { border: none; border-top: 1px solid #e2e8f0; margin: 1.2em 0; }
    `.trim();
}