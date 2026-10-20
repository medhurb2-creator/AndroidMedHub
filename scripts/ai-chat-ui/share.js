// scripts/ai-chat-ui/share.js
/**
 * Share + shared-view module.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 * This module owns every piece of behaviour around share links and
 * the read-only "Shared conversation" screen:
 *
 *   1. LINK CREATION — the "Share" menu action. Calls the backend,
 *      normalizes the returned URL to the production SPA form, and
 *      shows it in a modal with Copy + native-share buttons.
 *
 *   2. URL NORMALIZATION — guarantees share URLs always point at
 *      https://app.medvix.co.ke/ai?ref=shared&token=… regardless of
 *      what host the sharer was browsing from (localhost, preview
 *      deploy, Android WebView) or what shape the backend returns
 *      (full URL, path, or bare token).
 *
 *   3. SHARED-VIEW LOADING — the recipient flow. Fetches the shared
 *      conversation from the backend WITHOUT requiring auth (the
 *      token itself is the credential), renders it in the normal
 *      chat view, shows a "View only" banner, and enters read-only
 *      mode.
 *
 *   4. READ-ONLY LIFECYCLE — disables input / send / attach / voice
 *      while the shared view is showing; re-enables (or gates on
 *      subscription) when the user exits.
 *
 *   5. EXIT + STATE CLEANUP — three exit paths with different
 *      semantics:
 *        • User-initiated (banner ×, error "Back to chats") →
 *          exitSharedView. Re-checks subscription and gates or
 *          re-enables controls accordingly.
 *        • Navigation-initiated (sidebar click, New Chat) →
 *          ensureNotShared. Uses cached `hasActiveSubscription`
 *          (accurate thanks to the parallel check in
 *          loadSharedConversation) and gates or re-enables.
 *        • Page teardown → clearSharedState. Pure state cleanup, no
 *          control changes.
 *
 * ── URL contract ─────────────────────────────────────────────────────
 *   Share URL shape (always):
 *     https://app.medvix.co.ke/ai?ref=shared&token=<token>
 *
 *   Backend may return any of:
 *     • "/ai.html?ref=shared&token=<t>"         (relative path)
 *     • "https://host/ai.html?ref=shared&token=<t>" (absolute URL)
 *     • "<t>"                                    (bare token)
 *
 *   `buildShareUrl` normalizes every form to the canonical shape.
 *
 * ── Backend contract ─────────────────────────────────────────────────
 *   • `ai.shareConversation(chatId, expiryHours)` — authenticated.
 *     Returns `{ shareUrl, shareToken, expiry }`. The shareUrl is a
 *     path, not anchored to any origin.
 *   • `ai.getSharedConversation(shareToken)` — NO authentication.
 *     The token is the credential. Returns a normalized conversation
 *     object with a `messages` array. Throws a clean error message
 *     on expired / missing / malformed.
 *
 * ── Subscription interaction ─────────────────────────────────────────
 *   Shared view suppresses the subscription gate (recipients shouldn't
 *   be prompted to subscribe to view someone else's conversation).
 *   `loadSharedConversation` fires a PARALLEL subscription check
 *   alongside the conversation fetch, so `chat.hasActiveSubscription`
 *   is accurate the moment the view is entered. This means exit
 *   decisions ("gate or enable?") are correct immediately — no flash
 *   of enabled input for unsubscribed users, no lockout for
 *   subscribers.
 *
 * ── Public API ───────────────────────────────────────────────────────
 *   setupShareModal(chat)
 *   openShareModal(chat, chatId)
 *   buildShareUrl(backendShareRef)
 *   loadSharedConversation(chat, shareToken)      [called by pages/ai.js]
 *   renderSharedMessages(chat, messages)
 *   showSharedBanner(chat, conv)
 *   enterReadOnlyMode(chat)
 *   exitReadOnlyMode(chat)
 *   showSharedError(chat, message)
 *   exitSharedView(chat)                          [user-initiated]
 *   ensureNotShared(chat)                         [navigation-initiated]
 *   clearSharedState(chat)                        [pure state cleanup]
 */

import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import ai from '../ai.js';
import { escapeHtml } from './markdown.js';
import { showSubscriptionGate } from './chat-states.js';

// ==================== CONSTANTS ====================

// Production origin — share URLs always anchor here regardless of
// where the app is currently served from.
const SHARE_ORIGIN = 'https://app.medvix.co.ke';

// SPA route form — no .html extension.
const SHARE_PATH = '/ai';

// URL parameter names.
const PARAM_REF = 'ref';
const PARAM_TOKEN = 'token';
const REF_SHARED = 'shared';

// Default expiry passed to the backend when creating a link.
const SHARE_EXPIRY_HOURS = 24;

// Page title when not in shared view. Shared view uses
// `Shared · <title>`; this is the reset value on exit.
const DEFAULT_PAGE_TITLE = 'MedVix AI';

// ==================== LINK CREATION ====================

/**
 * Set up the share modal once per chat session.
 *
 * Idempotent on two axes:
 *   1. Reuses an existing `#share-modal` from static HTML if present.
 *   2. Only wires listeners the first time — a `_shareModalWired`
 *      flag on the modal element prevents double-attaching.
 *
 * The modal is created dynamically when the static HTML doesn't
 * provide one (matches the existing chat UI's pattern of self-
 * sufficient rendering).
 *
 * @param {object} chat  the AIChatUI instance
 */
export function setupShareModal(chat) {
    if (!chat) return;

    let modal = document.getElementById('share-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'share-modal';
        modal.className = 'modal-overlay';
        modal.style.display = 'none';
        modal.dataset.dynamic = '1';
        modal.innerHTML = `
            <div class="modal">
                <div class="modal-header">
                    <h3>Share Conversation</h3>
                    <button class="modal-close" id="closeShareModalBtn"
                            type="button" aria-label="Close share dialog">&times;</button>
                </div>
                <div class="modal-body">
                    <p>Anyone with this link can view this conversation.</p>
                    <div style="display:flex; gap:0.5rem; margin:1rem 0;">
                        <input type="text" id="share-link-input" readonly
                            style="flex:1; min-width:0; padding:0.5rem;
                                   background:var(--input-bg); border:1px solid var(--border);
                                   border-radius:8px; color:var(--text-primary);" />
                        <button id="copyShareLinkBtn" class="btn-secondary" type="button">Copy</button>
                        <button id="shareNativeBtn" class="btn-secondary" type="button">📤 Share</button>
                    </div>
                    <p style="font-size:0.8rem; color:var(--text-muted);">Link expires in 24 hours.</p>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    chat.shareModal = modal;
    chat.shareLinkInput = modal.querySelector('#share-link-input');

    // Only wire listeners once per modal element. This makes
    // setupShareModal safe to call multiple times (e.g. on every
    // page re-init) without duplicating handlers.
    if (modal._shareModalWired) return;
    modal._shareModalWired = true;

    const closeBtn = modal.querySelector('#closeShareModalBtn');
    const copyBtn = modal.querySelector('#copyShareLinkBtn');
    const nativeBtn = modal.querySelector('#shareNativeBtn');

    const hide = () => { modal.style.display = 'none'; };

    closeBtn?.addEventListener('click', hide);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hide();
    });

    // Escape closes the modal — matches the expectation set by other
    // dialogs on the page.
    const escHandler = (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') hide();
    };
    window.addEventListener('keydown', escHandler);
    modal._shareEscHandler = escHandler;

    copyBtn?.addEventListener('click', async () => {
        const link = chat.shareLinkInput?.value;
        if (!link) return;
        try {
            await navigator.clipboard.writeText(link);
            ui.showToast('Link copied', 'success');
        } catch {
            // Fallback for older browsers / restricted clipboard APIs.
            chat.shareLinkInput?.select();
            try { document.execCommand('copy'); } catch { /* ignore */ }
            ui.showToast('Link copied', 'success');
        }
    });

    nativeBtn?.addEventListener('click', async () => {
        const link = chat.shareLinkInput?.value;
        if (!link) return;
        if (navigator.share) {
            try {
                await navigator.share({ title: 'Shared conversation', url: link });
            } catch (e) {
                if (e.name !== 'AbortError') {
                    ui.showToast('Could not share', 'warning');
                }
            }
        } else {
            copyBtn?.click();
        }
    });
}

/**
 * Request a fresh share link for `chatId` and show it in the modal.
 *
 * Delegates the backend call to `ai.shareConversation`, which handles
 * auth, action call, and error normalization. `buildShareUrl` then
 * anchors the returned path to the production origin and strips any
 * `.html` extension.
 *
 * @param {object} chat
 * @param {string} chatId
 */
export async function openShareModal(chat, chatId) {
    if (!chat) return;
    try {
        const data = await ai.shareConversation(chatId, SHARE_EXPIRY_HOURS);
        const fullUrl = buildShareUrl(data?.shareUrl);
        if (chat.shareLinkInput) chat.shareLinkInput.value = fullUrl;
        if (chat.shareModal) chat.shareModal.style.display = 'flex';
    } catch (err) {
        console.error('[share] error:', err);
        ui.showToast(err?.message || 'Error sharing conversation', 'error');
    }
}

/**
 * Normalize any backend-returned share reference to the canonical
 * production SPA form.
 *
 * Accepts:
 *   • Full URL   → "https://host/ai.html?ref=shared&token=x"
 *   • Path       → "/ai.html?ref=shared&token=x"
 *   • Bare token → "x"
 *
 * Produces:
 *   https://app.medvix.co.ke/ai?ref=shared&token=x
 *
 * Two transformations happen here:
 *   1. Anchor to SHARE_ORIGIN — so a link created on localhost or a
 *      preview deploy still points at production for the recipient.
 *   2. Strip trailing `.html` — so the URL uses the SPA route form.
 *      Any subdirectory prefix is preserved (`/app/ai.html` →
 *      `/app/ai`).
 *
 * The query string from the backend is preserved verbatim. The
 * backend always emits `?ref=shared&token=…`; if it ever adds a
 * third param it will survive this transformation.
 *
 * @param {string|undefined} backendShareRef
 * @returns {string}
 */
export function buildShareUrl(backendShareRef) {
    let path = SHARE_PATH;
    let query = '';

    if (backendShareRef) {
        try {
            if (/^https?:\/\//i.test(backendShareRef)) {
                // Absolute URL — strip its origin, keep path + query.
                const u = new URL(backendShareRef);
                path = u.pathname || SHARE_PATH;
                query = u.search || '';
            } else if (backendShareRef.startsWith('/')) {
                // Absolute path — parse relative to the share origin.
                const u = new URL(backendShareRef, SHARE_ORIGIN);
                path = u.pathname;
                query = u.search;
            } else {
                // Bare token — construct the expected URL from scratch.
                query = `?${PARAM_REF}=${REF_SHARED}&${PARAM_TOKEN}=${encodeURIComponent(backendShareRef)}`;
            }
        } catch (err) {
            console.warn('[share] could not parse backend share ref:', err);
        }
    }

    // Strip trailing .html / .htm. Guard against an empty path after
    // the strip — fall back to the canonical path.
    path = path.replace(/\.html?$/i, '');
    if (!path || path === '/') path = SHARE_PATH;

    return SHARE_ORIGIN + path + query;
}

// ==================== SHARED-VIEW LOADING ====================

/**
 * Load a conversation from a share token and render it in read-only
 * mode.
 *
 * Called by `pages/ai.js` after `init()` when the URL carries
 * `?ref=shared&token=<token>`.
 *
 * Flow:
 *   1. Mark the chat as shared, cache the token.
 *   2. Clear editing, selection mode, existing messages, welcome block.
 *   3. Clear any existing banner (in case of a shared → shared
 *      transition).
 *   4. Clear any subscription gate from a prior normal-view init
 *      (defensive — shared view should never show the gate).
 *   5. Fetch conversation + subscription status in PARALLEL. The
 *      subscription check is what makes `hasActiveSubscription`
 *      accurate before the user exits — see exitSharedView and
 *      ensureNotShared, which both rely on it.
 *   6. On fetch failure: render error card, return false.
 *   7. On empty conversation: render error card, return false.
 *   8. Render messages, banner, enter read-only mode, update page
 *      title. Return true.
 *
 * @param {object} chat
 * @param {string} shareToken
 * @returns {Promise<boolean>}  true on successful load
 */
export async function loadSharedConversation(chat, shareToken) {
    if (!chat || !shareToken) return false;

    chat.isSharedView = true;
    chat.shareToken = shareToken;

    chat._cancelEditing();
    chat._exitSelectionMode();
    chat.clearMessages();
    chat.removeWelcomeIfExists();
    chat.currentChatId = null;

    // Clear any prior banner (shared → shared transition).
    if (chat._shareBanner) {
        chat._shareBanner.remove();
        chat._shareBanner = null;
    }

    // Clear any subscription gate left over from a prior normal-view
    // init. Shared view must never show the gate.
    const existingGate = document.getElementById('ai-subscription-gate');
    if (existingGate) existingGate.remove();

    chat.showTypingIndicator();

    let conv = null;
    let subActive = false;
    try {
        // Parallel fetch: shared conversation + subscription status.
        // Awaiting both means `hasActiveSubscription` is accurate
        // before the user can click an exit affordance.
        const [fetched, active] = await Promise.all([
            ai.getSharedConversation(shareToken),
            chat._checkSubscription(),
        ]);
        conv = fetched;
        subActive = active;
    } catch (err) {
        chat.hideTypingIndicator();
        console.error('[shared-load] error:', err);
        chat.hasActiveSubscription = false;
        showSharedError(chat, err?.message || 'Failed to load shared conversation.');
        return false;
    }

    chat.hasActiveSubscription = subActive;
    chat.hideTypingIndicator();

    if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) {
        showSharedError(chat, 'Shared conversation is empty.');
        return false;
    }

    renderSharedMessages(chat, conv.messages);
    showSharedBanner(chat, conv);
    enterReadOnlyMode(chat);

    try {
        const pageTitle = document.getElementById('page-title');
        if (pageTitle && conv.title) {
            pageTitle.textContent = `Shared · ${conv.title}`;
        }
    } catch { /* ignore */ }

    return true;
}

/**
 * Render the messages array from a shared conversation into the chat
 * container.
 *
 * Uses the SAME render paths as a live chat so shared messages look
 * identical — but strips all interaction affordances (copy, retry,
 * edit, to-notes, etc.) since this is a read-only view.
 *
 * @param {object} chat
 * @param {Array} messages
 */
export function renderSharedMessages(chat, messages) {
    if (!chat || !Array.isArray(messages)) return;

    messages.forEach((msg) => {
        if (msg.role === 'user') {
            if (msg.fileData) {
                chat.addUserMessageWithFile(msg.content || '', msg.fileData, false);
            } else {
                chat.addUserMessage(msg.content || '', false);
            }
        } else if (msg.role === 'assistant') {
            chat._renderMessageInstant(
                msg.content || '',
                false,
                msg.meta || null,
                msg.richData || null,
            );
        }
    });

    // Strip action bars — meaningless in a read-only view.
    chat.chatContainer.querySelectorAll('.message-actions').forEach((el) => el.remove());
    chat.chatContainer.querySelectorAll('.user-actions').forEach((el) => el.remove());
    chat.chatContainer.querySelectorAll('.retry-btn').forEach((el) => el.remove());
}

// ==================== BANNER ====================

/**
 * Insert the "View only · Shared with you" banner above the input
 * area.
 *
 * Placement matches the subscription gate — the banner becomes the
 * previous sibling of `#inputArea`. Uses the same fallback ladder as
 * `_insertBeforeInput` in chat-states.js: input area parent, then
 * chat container parent, then document.body (last resort).
 *
 * Idempotent: removes any prior banner first.
 *
 * @param {object} chat
 * @param {object} conv  conversation metadata (title)
 */
export function showSharedBanner(chat, conv) {
    if (!chat) return;

    if (chat._shareBanner) chat._shareBanner.remove();

    const banner = document.createElement('div');
    banner.className = 'ai-shared-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Shared conversation');
    banner.innerHTML = `
        <div class="share-banner-icon" aria-hidden="true">📤</div>
        <div class="share-banner-body">
            <div class="share-banner-title">
                ${escapeHtml(conv?.title || 'Shared conversation')}
            </div>
            <div class="share-banner-sub">View only · Shared with you via MedVix</div>
        </div>
        <button class="share-banner-close" type="button"
                title="Close shared view" aria-label="Close shared view">&times;</button>
    `;

    const inputArea = chat.inputArea || chat.normalInput?.parentElement;
    if (inputArea?.parentElement) {
        inputArea.parentElement.insertBefore(banner, inputArea);
    } else if (chat.chatContainer?.parentElement) {
        chat.chatContainer.parentElement.insertBefore(banner, chat.chatContainer);
    } else {
        document.body.appendChild(banner);
    }
    chat._shareBanner = banner;

    banner.querySelector('.share-banner-close')?.addEventListener('click', () => {
        exitSharedView(chat);
    });
}

// ==================== READ-ONLY MODE ====================

/**
 * Disable every send-related control on the chat.
 *
 * Idempotent — setting `disabled = true` twice is a no-op.
 *
 * @param {object} chat
 */
export function enterReadOnlyMode(chat) {
    if (!chat) return;
    if (chat.messageInput) {
        chat.messageInput.disabled = true;
        chat.messageInput.placeholder = 'This is a shared view — start a new chat to reply';
    }
    if (chat.sendBtn) chat.sendBtn.disabled = true;
    if (chat.attachBtn) chat.attachBtn.disabled = true;
    if (chat.voiceBtn) chat.voiceBtn.disabled = true;
}

/**
 * Re-enable every send-related control.
 *
 * Idempotent. Called from exitSharedView and ensureNotShared — but
 * only after confirming the user should have enabled controls (i.e.
 * has an active subscription or is on a free tier). This module
 * never calls it unconditionally.
 *
 * @param {object} chat
 */
export function exitReadOnlyMode(chat) {
    if (!chat) return;
    if (chat.messageInput) {
        chat.messageInput.disabled = false;
        chat.messageInput.placeholder = 'Send a message...';
    }
    if (chat.sendBtn) chat.sendBtn.disabled = false;
    if (chat.attachBtn) chat.attachBtn.disabled = false;
    if (chat.voiceBtn) chat.voiceBtn.disabled = false;
}

// ==================== ERROR STATE ====================

/**
 * Render a full-area error card for the shared view with a "Back to
 * chats" button.
 *
 * Clears existing messages first (mutually exclusive content state).
 * The error message is escaped and displayed in full with newline
 * preservation.
 *
 * @param {object} chat
 * @param {string} message
 */
export function showSharedError(chat, message) {
    if (!chat) return;

    chat.clearMessages();
    chat.removeWelcomeIfExists();

    const errDiv = document.createElement('div');
    errDiv.className = 'shared-error';
    errDiv.setAttribute('role', 'alert');
    const safeMsg = escapeHtml(message || 'Failed to load shared conversation')
        .replace(/\n/g, '<br>');

    errDiv.innerHTML = `
        <div class="shared-error-icon" aria-hidden="true">⚠️</div>
        <div class="shared-error-title">Could not load shared conversation</div>
        <div class="shared-error-message">${safeMsg}</div>
        <button class="shared-error-btn" type="button">Back to chats</button>
    `;
    chat.chatContainer.insertBefore(errDiv, chat.typingIndicator);

    errDiv.querySelector('.shared-error-btn')?.addEventListener('click', () => {
        exitSharedView(chat);
    });
}

// ==================== EXIT PATHS ====================

/**
 * User-initiated exit — clicked the banner × or the error card's
 * "Back to chats" button.
 *
 * Flow:
 *   1. Clear shared state (banner, URL, page title, isSharedView).
 *   2. If not authenticated → toast + navigate to login.
 *   3. Reset to welcome view, clear currentChatId, refresh sidebar.
 *   4. Decide control state based on the CACHED
 *      `hasActiveSubscription` (which loadSharedConversation just
 *      refreshed in parallel with the fetch — accurate).
 *      - Subscribed → re-enable controls.
 *      - Unsubscribed → show gate (which disables controls).
 *
 * The exit decision is synchronous and uses accurate cached state,
 * so there is no flash of enabled-then-disabled controls for
 * unsubscribed users.
 *
 * @param {object} chat
 */
export function exitSharedView(chat) {
    if (!chat || !chat.isSharedView) return;

    // 1. State cleanup (banner, isSharedView, URL params, page title).
    //    Does NOT touch controls — the branch below decides that.
    clearSharedState(chat);

    // 2. Auth gate.
    if (!auth.checkAuth()) {
        ui.showToast('Log in to start your own chats', 'info');
        router.navigateTo('login');
        return;
    }

    // 3. Reset to welcome view.
    chat.currentChatId = null;
    chat.resetToWelcome();
    chat.renderChatHistory(chat.searchChats?.value || '');

    // 4. Control state — accurate because of the parallel check in
    // loadSharedConversation.
    if (chat.hasActiveSubscription) {
        exitReadOnlyMode(chat);
    } else {
        showSubscriptionGate(chat);
    }
}

/**
 * Navigation-initiated exit — the user clicked a sidebar chat or
 * "New Chat" while in shared view. `loadChatUI` and the New Chat
 * handler both call this first, so the shared state is cleared
 * before the target view loads.
 *
 * Semantics are almost identical to exitSharedView, except:
 *   • No toast, no auth-redirect — the caller is about to do
 *     something that may itself need auth, so we don't preempt.
 *   • No welcome reset — the caller will set up whatever view it
 *     needs.
 *
 * Control state is decided from the cached `hasActiveSubscription`,
 * matching exitSharedView. Subscribed → enabled; unsubscribed →
 * gated (disabled).
 *
 * @param {object} chat
 */
export function ensureNotShared(chat) {
    if (!chat || !chat.isSharedView) return;

    clearSharedState(chat);

    if (chat.hasActiveSubscription) {
        exitReadOnlyMode(chat);
    } else {
        showSubscriptionGate(chat);
    }
}

/**
 * Pure state cleanup — no control changes, no navigation, no toasts.
 *
 * Used by:
 *   • exitSharedView (before deciding control state)
 *   • ensureNotShared (before deciding control state)
 *   • destroy (page teardown — controls don't matter)
 *
 * Idempotent: returns immediately if we're not in shared state and
 * have nothing to clean up.
 *
 * @param {object} chat
 */
export function clearSharedState(chat) {
    if (!chat) return;
    if (!chat.isSharedView && !chat.shareToken && !chat._shareBanner) return;

    // 1. Flip state flags.
    chat.isSharedView = false;
    chat.shareToken = null;

    // 2. Remove the banner if present.
    if (chat._shareBanner) {
        chat._shareBanner.remove();
        chat._shareBanner = null;
    }

    // 3. Strip URL params. Uses replaceState so the browser history
    //    is not polluted — the user never sees the intermediate
    //    "no-ref, no-token" URL in their back history.
    try {
        const url = new URL(window.location.href);
        url.searchParams.delete(PARAM_REF);
        url.searchParams.delete(PARAM_TOKEN);
        const qs = url.searchParams.toString();
        const next = url.pathname + (qs ? '?' + qs : '') + url.hash;
        history.replaceState(null, '', next);
    } catch { /* ignore */ }

    // 4. Reset page title.
    try {
        const pageTitle = document.getElementById('page-title');
        if (pageTitle) pageTitle.textContent = DEFAULT_PAGE_TITLE;
    } catch { /* ignore */ }
}