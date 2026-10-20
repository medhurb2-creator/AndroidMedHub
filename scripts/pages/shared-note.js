// scripts/pages/shared-note.js
import * as ui from '../ui.js';
import * as utils from '../utils.js';
import * as db from '../db.js';
import * as auth from '../auth.js';
import * as notes from '../notes.js';
import * as router from '../router.js';

let $;

// ==================== CONSTANTS ====================

// Canonical production origin for share links. Always used when
// building share URLs, regardless of where the app is running
// (localhost, preview deploy, Android WebView) so a recipient always
// lands on the same host.
const SHARE_BASE_URL = 'https://app.medvix.co.ke';
const SHARE_PATH = '/shared-note';

// ==================== HTML SAFETY ====================

/**
 * Escape HTML-special characters in plain-text fields (title, tags,
 * author). The note CONTENT is HTML from Quill / the AI markdown
 * renderer and is inserted as-is — those sources already escape
 * user-typed text and only emit whitelisted tags.
 *
 * @param {any} unsafe
 * @returns {string}
 */
function escapeHtml(unsafe) {
    return String(unsafe == null ? '' : unsafe).replace(/[&<>"]/g, (m) =>
        m === '&' ? '&amp;'
        : m === '<' ? '&lt;'
        : m === '>' ? '&gt;'
        : '&quot;'
    );
}

// ==================== SHARE URL ====================

/**
 * Build the canonical share URL for a note token. Always points at
 * the production origin — never at `window.location`.
 *
 * @param {string} token
 * @returns {string}
 */
function buildShareUrl(token) {
    if (!token) return SHARE_BASE_URL;
    return `${SHARE_BASE_URL}${SHARE_PATH}?token=${encodeURIComponent(token)}`;
}

// ==================== NATIVE SHARE + FALLBACKS ====================

/**
 * Share via the native plugin, then Web Share API, then clipboard.
 *
 * Order:
 *   1. Capacitor MedvixShare plugin (Android app) — reliable inside
 *      the WebView where navigator.share is inconsistent.
 *   2. navigator.share (modern mobile browsers).
 *   3. Clipboard copy + toast.
 *
 * @param {{title?: string, text?: string, url?: string, dialogTitle?: string}} shareData
 */
function nativeShare(shareData) {
    const data = {
        title: shareData.title || 'MedVix Note',
        text: shareData.text || '',
        url: shareData.url || '',
        dialogTitle: shareData.dialogTitle || 'Share',
    };

    // ── 1. Capacitor MedvixShare plugin ─────────────────────────
    if (
        window.Capacitor &&
        window.Capacitor.Plugins &&
        window.Capacitor.Plugins.MedvixShare
    ) {
        window.Capacitor.Plugins.MedvixShare
            .share(data)
            .catch(() => fallbackShare(data));
        return;
    }

    // ── 2. Web Share API ────────────────────────────────────────
    if (navigator.share) {
        navigator.share(data).catch((err) => {
            if (err && err.name === 'AbortError') return;
            fallbackShare(data);
        });
        return;
    }

    // ── 3. Clipboard ────────────────────────────────────────────
    fallbackShare(data);
}

function fallbackShare(shareData) {
    const url = shareData.url || shareData.text || '';
    if (!url) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard
            .writeText(url)
            .then(() => ui.showToast('Link copied to clipboard!', 'success'))
            .catch(() => fallbackCopy(url));
    } else {
        fallbackCopy(url);
    }
}

function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        const success = document.execCommand('copy');
        ui.showToast(
            success
                ? 'Link copied to clipboard!'
                : 'Failed to copy link. Please copy manually.',
            success ? 'success' : 'error'
        );
    } catch {
        ui.showToast('Failed to copy link. Please copy manually.', 'error');
    }
    document.body.removeChild(textarea);
}

// ==================== FOOTER NAV ====================

/**
 * Wire the fixed-footer navigation.
 *
 * The footer is the same four-button bar the performance / AI pages
 * use. Each button carries a `data-route` attribute; a single
 * delegated loop here wires them all to `router.navigateTo`. The
 * router handles any auth-required redirect on the destination
 * (this page is `data-auth="none"`, but Notes / AI Tutor / etc.
 * still require login — the router pushes the recipient through
 * login first and returns them to the destination afterward).
 */
function wireFooterNav() {
    const footer = document.getElementById('sharedNoteFooter');
    if (!footer) return;

    footer.querySelectorAll('.footer-btn[data-route]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const route = btn.dataset.route;
            if (route) router.navigateTo(route);
        });
    });
}

// ==================== INIT ====================

export async function init(context) {
    $ = (sel) => context.root.querySelector(sel);

    ui.applyTheme();

    // ── Page chrome ─────────────────────────────────────────────
    wireFooterNav();

    const themeToggle = $('#themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', ui.toggleTheme);
    }

    // ── Token + load ────────────────────────────────────────────
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    const container = $('#shared-note-container');
    if (!container) {
        console.error('[SharedNote] #shared-note-container not found');
        return;
    }

    if (!token) {
        container.innerHTML = '<div class="error">No share token provided.</div>';
        return;
    }

    const canonicalUrl = buildShareUrl(token);

    try {
        const note = await db.getNoteByShareToken(token);
        if (!note) {
            container.innerHTML =
                '<div class="error">Note not found or link has expired.</div>';
            return;
        }

        const created = utils.formatDate(note.createdAt, 'full');
        const isLoggedIn = auth.checkAuth();

        // Title and tags come from user-typed text — escape them.
        // The content is HTML (Quill / AI markdown output) and is
        // already sanitized at the source; insert as-is.
        const safeTitle = escapeHtml(note.title || 'Untitled');
        const safeTags =
            Array.isArray(note.tags) && note.tags.length
                ? `<span>Tags: ${escapeHtml(note.tags.join(', '))}</span>`
                : '';

        let html = `
            <div class="note-card">
                <h1>${safeTitle}</h1>
                <div class="note-meta">
                    <span>Created: ${escapeHtml(created)}</span>
                    ${safeTags}
                </div>
                <div class="note-content">${note.content || ''}</div>
                <div class="note-actions">
                    <button id="copyLinkBtn" class="btn-secondary" type="button">🔗 Copy Link</button>
                    <button id="shareNoteBtn" class="btn-secondary" type="button">📤 Share</button>
        `;

        if (isLoggedIn) {
            html += `<button id="saveCopyBtn" class="btn-primary" type="button">📋 Save to My Notes</button>`;
        }

        html += `
                </div>
            </div>
        `;
        container.innerHTML = html;

        // ── Copy link ───────────────────────────────────────────
        // Uses the canonical production URL, never window.location.
        const copyLinkBtn = $('#copyLinkBtn');
        if (copyLinkBtn) {
            copyLinkBtn.addEventListener('click', () => {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard
                        .writeText(canonicalUrl)
                        .then(() => ui.showToast('Link copied!', 'success'))
                        .catch(() => fallbackCopy(canonicalUrl));
                } else {
                    fallbackCopy(canonicalUrl);
                }
            });
        }

        // ── Share ───────────────────────────────────────────────
        const shareNoteBtn = $('#shareNoteBtn');
        if (shareNoteBtn) {
            shareNoteBtn.addEventListener('click', () => {
                nativeShare({
                    title: note.title || 'MedVix Note',
                    text: `Check out this MedVix note: ${note.title || 'Untitled'}`,
                    url: canonicalUrl,
                    dialogTitle: 'Share Note',
                });
            });
        }

        // ── Save copy ───────────────────────────────────────────
        const saveCopyBtn = $('#saveCopyBtn');
        if (saveCopyBtn) {
            saveCopyBtn.addEventListener('click', async () => {
                if (!auth.checkAuth()) {
                    ui.showToast('You must be logged in', 'error');
                    return;
                }
                try {
                    await notes.createNote({
                        title: (note.title || 'Untitled') + ' (shared copy)',
                        content: note.content,
                        plainText: note.plainText || '',
                        subject: note.subject,
                        topic: note.topic,
                        tags: note.tags,
                    });
                    ui.showToast('Note saved to your collection!', 'success');
                } catch (err) {
                    ui.showToast(
                        'Failed to save note: ' + (err?.message || 'unknown error'),
                        'error'
                    );
                }
            });
        }
    } catch (err) {
        console.error('[SharedNote] load failed:', err);
        container.innerHTML = '<div class="error">Error loading note.</div>';
    }

    console.log('[SharedNote] Initialized');
}

// ==================== DESTROY ====================

export function destroy() {
    // Nothing to tear down — event listeners are on elements removed
    // by the router when it swaps out the section. The theme-toggle
    // listener was added to `#themeToggle` (removed with the page)
    // and the footer-button listeners were added to the footer
    // (also removed with the page), so no persistent state leaks.
}