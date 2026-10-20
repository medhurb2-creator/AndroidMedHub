// scripts/pages/ai.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as subscription from '../subscription.js';
import AIChatUI from '../ai-chat-ui.js';
import ai from '../ai.js';

let $;
let chatUI;
let updateFooterHeight;

// ==================== THEME BRIDGE ====================
//
// The AI page's stylesheet (`css/ai.css`) is authored with a
// dark-by-default palette and a `body.light-mode` opt-in for the light
// theme. The rest of the app (`ui.js` + `css/common.css`) uses the
// opposite convention: a light default with `html.dark-theme` overrides
// on top.
//
// Both systems describe the same underlying state — "is the UI dark
// right now?" — but they read it from two different DOM elements.
//
// Without a bridge, tapping the AI page's theme toggle flips
// `html.dark-theme` (via `ui.toggleTheme()`), the OS-level theme
// updates correctly, the toast fires, but the AI page's palette does
// NOT change, because nothing in `ai.css` watches `html.dark-theme`.
// The user sees "Switched to dark mode" and an unchanged page.
//
// `syncBodyLightMode()` closes the gap: whenever `html.dark-theme` is
// absent, `body.light-mode` is applied. Whenever it is present,
// `body.light-mode` is removed. The two flags are kept in lockstep and
// the AI page reacts to the app-wide toggle as expected.
//
// All calls to this function are cheap — it's one class toggle. It can
// be called after every theme-changing action without any performance
// concern.

/**
 * Mirror the app-wide `html.dark-theme` flag onto the AI page's
 * `body.light-mode` flag.
 *
 *   html.dark-theme present  →  body.light-mode removed  (dark)
 *   html.dark-theme absent   →  body.light-mode added    (light)
 */
function syncBodyLightMode() {
    const isDark = document.documentElement.classList.contains('dark-theme');
    document.body.classList.toggle('light-mode', !isDark);
}

// ── System preference listener ──────────────────────────────────────
// When the user has chosen "auto" mode, the OS toggling between light
// and dark should update the AI page too. `ui.setTheme('auto')` already
// re-applies on its own matchMedia listener, but we need to re-run the
// bridge after it settles — otherwise `body.light-mode` lags behind
// by one system change.
let _systemThemeMql = null;
let _systemThemeHandler = null;

function attachSystemThemeListener() {
    if (_systemThemeMql) return;
    try {
        _systemThemeMql = window.matchMedia('(prefers-color-scheme: dark)');
        _systemThemeHandler = () => {
            // Only act on OS-level changes when the user's stored
            // preference is "auto". A manual light/dark choice must
            // not be overridden by the OS.
            if (ui.getTheme() === 'auto') {
                ui.applyTheme();
                syncBodyLightMode();
            }
        };
        _systemThemeMql.addEventListener('change', _systemThemeHandler);
    } catch { /* matchMedia unsupported — ignore */ }
}

function detachSystemThemeListener() {
    if (_systemThemeMql && _systemThemeHandler) {
        try {
            _systemThemeMql.removeEventListener('change', _systemThemeHandler);
        } catch { /* ignore */ }
        _systemThemeMql = null;
        _systemThemeHandler = null;
    }
}

// ==================== INIT ====================

export async function init(context) {
    $ = (sel) => context.root.querySelector(sel);

    // Apply theme
    ui.applyTheme();

    // Bridge the app-wide theme onto the AI page's `body.light-mode`.
    // Must run BEFORE the share-link branch so the shared view — which
    // also uses the AI page's CSS — gets the correct theme on first
    // paint.
    syncBodyLightMode();
    attachSystemThemeListener();

    // ── Dynamic footer offset ─────────────────────────────────────
    // The footer is a flow child of #real-content, so it lays out
    // without any JS help — but --footer-height is still consumed by
    // the floating UI (selection bar, note-saved toast). Kept as-is.
    updateFooterHeight = function () {
        const footer = $('#aiFooter');
        if (!footer) return;

        const footerHeight = footer.offsetHeight;

        // Skip 0: this runs during init() before #real-content.visible
        // is applied; offsetHeight is 0 while display:none, and writing
        // 0 here would break the floating UI's bottom offset.
        if (!footerHeight || footerHeight <= 0) return;

        const next = footerHeight + 'px';
        const current = document.documentElement.style.getPropertyValue(
            '--footer-height'
        );
        if (current === next) return;

        document.documentElement.style.setProperty('--footer-height', next);
    };

    window.addEventListener('resize', updateFooterHeight);
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', updateFooterHeight);
        window.visualViewport.addEventListener('scroll', updateFooterHeight);
    }

    // ── State adapter ────────────────────────────────────────────
    // Registered before any redirect can fire, so a login/subscription
    // round-trip never loses which drawer or modal was open.
    redirect.registerStateAdapter('ai', {
        capture: () => ({
            sidebarOpen: !!document
                .getElementById('sidebar')
                ?.classList.contains('open'),
            settingsOpen:
                document.getElementById('settingsModal')?.style.display ===
                'flex',
            model: document.getElementById('modelSelect')?.value || null,
            currentModel:
                document.getElementById('currentModel')?.textContent || null,
        }),
        restore: (data) => {
            if (!data) return;

            const sidebar = document.getElementById('sidebar');
            if (sidebar && data.sidebarOpen) sidebar.classList.add('open');

            const settingsModal = document.getElementById('settingsModal');
            if (settingsModal && data.settingsOpen) {
                settingsModal.style.display = 'flex';
            }

            const modelSelect = document.getElementById('modelSelect');
            if (modelSelect && data.model) modelSelect.value = data.model;

            const currentModelSpan = document.getElementById('currentModel');
            if (currentModelSpan && data.currentModel) {
                currentModelSpan.textContent = data.currentModel;
            }
        },
    });

    // ── SHARE-LINK BRANCH ────────────────────────────────────────
    // A share URL lands as:
    //   https://app.medvix.co.ke/ai?ref=shared&token=<shareToken>
    //
    // Detected BEFORE the auth gate because share links are meant to
    // be opened by recipients who may not have a MedVix account — the
    // share token IS the credential. The read-only branch also skips
    // the subscription check: there's nothing to subscribe to when
    // you're only viewing a conversation.
    //
    // Detection happens on every init, so a fresh page load, a hard
    // refresh, and a client-side navigation to the URL all behave the
    // same.
    const shareParams = new URLSearchParams(window.location.search);
    const isShareLink = shareParams.get('ref') === 'shared';
    const shareToken = shareParams.get('token');

    if (isShareLink && shareToken) {
        console.log('[AI] Share link detected — loading in read-only mode');
        await initSharedView(shareToken);
        return;
    }

    // ── Auth gate (normal path only) ─────────────────────────────
    if (!auth.checkAuth()) {
        ui.showToast('Please log in to use the AI assistant', 'warning');
        redirect.navigateWithReturn('login', 'auth_required');
        return;
    }

    // ── Subscription check ───────────────────────────────────────
    // Only purpose in this page: toggle the dynamic 4th footer button.
    // The expiry/plan text that used to live in the header is gone —
    // the subscription page is the authority on plan details. No rate
    // limiting, no gating logic lives here; that is backend work.
    let isActive = false;
    try {
        isActive = (await subscription.hasActiveSubscription()) === true;
    } catch (err) {
        console.warn('[AI] Subscription check failed:', err);
        isActive = false;
    }

    const footerSubscribeBtn = $('#footerSubscribeBtn');
    if (footerSubscribeBtn) {
        footerSubscribeBtn.style.display = isActive ? 'none' : 'flex';
    }

    updateFooterHeight();

    // ── Init chat UI ─────────────────────────────────────────────
    chatUI = new AIChatUI();
    await chatUI.init();

    // ── Reveal real content immediately ──────────────────────────
    // Shimmer hides as soon as init resolves.
    const shimmer = $('#shimmer-content');
    const real = $('#real-content');
    if (shimmer) shimmer.classList.add('hidden');
    if (real) real.classList.add('visible');

    updateFooterHeight();
    requestAnimationFrame(updateFooterHeight);

    attachPageListeners();

    window.aiPage = { updateFooterHeight };

    // ── Self-consume on return ───────────────────────────────────
    try {
        if (redirect.hasSnapshot()) {
            const myUrl =
                window.location.pathname +
                (window.location.search || '') +
                (window.location.hash || '');
            const top = redirect.peekReturn();
            if (top && top.url === myUrl) redirect.popReturn();
        }
    } catch (err) {
        console.warn('[AI] Return-stack cleanup failed:', err);
    }

    // ── Resume snapshot ──────────────────────────────────────────
    const snap = redirect.consumeSnapshot();
    if (snap && (snap.ui || snap.page)) {
        ui.showToast('Continuing where you left off', 'info', 1800);
    }

    console.log('[AI] Initialized');
}

// ==================== SHARED VIEW ====================
/**
 * Read-only initialisation path for a shared conversation.
 *
 * Runs when the URL carries ?ref=shared&token=<shareToken>. The flow:
 *
 *   1. Init the chat UI class so all DOM references and event listeners
 *      are wired up (the same instance is used for the shared view —
 *      the only difference is the read-only flag AIChatUI toggles once
 *      the conversation is loaded).
 *   2. Call `loadSharedConversation(token)`, which fetches the
 *      conversation from the backend, renders the messages through the
 *      normal renderers (so formatting, LaTeX, tables, code blocks all
 *      render identically to a live chat), and shows a banner
 *      explaining this is a shared view.
 *   3. Reveal the content — the shimmer hides AFTER the load resolves,
 *      so the user transitions straight from shimmer to the shared
 *      view, never through an empty welcome block.
 *   4. Attach the page-level listeners (footer nav still works).
 *   5. Hide the Subscribe button — subscribing from a shared view makes
 *      no sense; the recipient just wants to read.
 *
 * The `loadSharedConversation` method itself handles all failure modes
 * (invalid token, expired link, backend error) by rendering an error
 * card with a "Back to chats" button. On success, the banner's close
 * button calls `exitSharedView`, which clears the URL params, re-enables
 * the input, and resets to the welcome block.
 *
 * @param {string} shareToken  the ?token= value from the URL
 */
async function initSharedView(shareToken) {
    // Subscribe button has no meaning in a shared view
    const footerSubscribeBtn = $('#footerSubscribeBtn');
    if (footerSubscribeBtn) footerSubscribeBtn.style.display = 'none';

    updateFooterHeight();

    // Init chat UI (same class, same event wiring)
    chatUI = new AIChatUI();
    await chatUI.init();

    // Load the shared conversation. `loadSharedConversation` renders an
    // error card on failure, so we don't branch on the return value
    // here — the shimmer always hides, and the user always sees either
    // the shared content or a clear "could not load" message.
    try {
        await chatUI.loadSharedConversation(shareToken);
    } catch (err) {
        console.error('[AI] Shared view init failed:', err);
        // `loadSharedConversation` already caught and rendered the
        // error; this catch is a defensive backstop in case the method
        // itself throws.
    }

    // Reveal content
    const shimmer = $('#shimmer-content');
    const real = $('#real-content');
    if (shimmer) shimmer.classList.add('hidden');
    if (real) real.classList.add('visible');

    updateFooterHeight();
    requestAnimationFrame(updateFooterHeight);

    // Footer nav still works in shared view
    attachPageListeners();

    window.aiPage = { updateFooterHeight };

    // Deliberately SKIP:
    //   • auth gate     — share tokens are their own credential
    //   • subscription  — nothing to gate; input is disabled anyway
    //   • self-consume  — no return-stack entry for a share landing
    //   • snapshot      — no prior state to resume into

    console.log('[AI] Shared view initialized');
}

// ==================== PAGE-LEVEL LISTENERS ====================
function attachPageListeners() {
    // Footer navigation — Subjects / Profile / Notes
    const footer = $('#aiFooter');
    if (footer) {
        footer.querySelectorAll('.footer-btn[data-route]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const route = btn.dataset.route;
                if (route) router.navigateTo(route);
            });
        });
    }

    // Footer subscribe — dynamic 4th button (only shown when no sub)
    const footerSubscribeBtn = $('#footerSubscribeBtn');
    if (footerSubscribeBtn) {
        footerSubscribeBtn.addEventListener('click', () => {
            redirect.navigateWithReturn('subscription', 'subscription_required');
        });
    }

    // Performance link in top bar
    const performanceLink = $('#performanceLink');
    if (performanceLink) {
        performanceLink.addEventListener('click', (e) => {
            e.preventDefault();
            router.navigateTo('performance');
        });
    }

    // Theme toggle — settings modal only (header one removed).
    //
    // Both calls are required:
    //   • ui.toggleTheme()   → flips `html.dark-theme`, persists the
    //                          choice, fires the confirmation toast,
    //                          and syncs the native status bar.
    //   • syncBodyLightMode() → mirrors the new state onto
    //                          `body.light-mode` so the AI page's CSS
    //                          reacts.
    //
    // Without the second call, tapping the toggle flips the OS-level
    // theme and the toast, but the AI page itself stays in whatever
    // palette it loaded with.
    const themeToggleModal = $('#themeToggleModal');
    if (themeToggleModal) {
        themeToggleModal.addEventListener('click', () => {
            ui.toggleTheme();
            syncBodyLightMode();
        });
    }
}

// ==================== DESTROY ====================
export function destroy() {
    try {
        redirect.unregisterStateAdapter('ai');
    } catch {
        /* ignore */
    }

    // System-preference listener is per-page. Leaking it would fire
    // against a stale `$`/`chatUI` on the next page; detach first.
    detachSystemThemeListener();

    // If we were in shared view, leave it cleanly before tearing down.
    // `exitSharedView` handles banner removal, read-only re-enable, and
    // URL cleanup — but on destroy the DOM is going away anyway, so
    // only the flag/banner clear matters. Wrapped in try so a missing
    // method (older AIChatUI) doesn't break teardown.
    try {
        if (chatUI && typeof chatUI.exitSharedView === 'function') {
            chatUI.exitSharedView();
        }
    } catch {
        /* ignore */
    }

    if (chatUI && typeof chatUI.destroy === 'function') {
        chatUI.destroy();
    }

    if (updateFooterHeight) {
        window.removeEventListener('resize', updateFooterHeight);
        if (window.visualViewport) {
            window.visualViewport.removeEventListener(
                'resize',
                updateFooterHeight
            );
            window.visualViewport.removeEventListener(
                'scroll',
                updateFooterHeight
            );
        }
    }
}