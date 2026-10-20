// scripts/ai-chat-ui/chat-states.js
/**
 * Chat state UI — the four "non-content" screens the chat view can show.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 * This module owns everything that appears in the chat area or above
 * the input when there are no messages to render, or when the user is
 * blocked from sending:
 *
 *   1. LOADING  — spinner shown while `ai.loadConversationMessages()`
 *                 fetches a chat whose messages haven't been cached.
 *
 *   2. EMPTY    — "No messages yet" placeholder shown when a chat
 *                 exists but genuinely has zero messages.
 *
 *   3. ERROR    — full-area error card with the concrete reason
 *                 ("Chat not found", "You are offline and this
 *                 conversation has not been downloaded yet", or a
 *                 backend-supplied message) and a Retry button that
 *                 re-invokes `chat.loadChatUI(chatId)`.
 *
 *   4. GATE     — the subscription banner shown above the input area
 *                 when the user has no active subscription. Disables
 *                 send / attach / voice / input so nothing looks
 *                 interactive when it isn't.
 *
 * ── Content states are mutually exclusive ────────────────────────────
 * The three in-container states (loading, empty, error) represent
 * alternative views of the same chat. They can never coexist:
 *
 *   • A chat is either loading, showing its messages, showing empty,
 *     or showing error. Never two.
 *   • Each `show*` function starts with `chat.clearMessages()` so
 *     calling any of them wipes the others (and any stale user /
 *     assistant bubbles) before inserting its own element.
 *   • This also makes each `show*` idempotent — calling twice is
 *     safe and produces the same visual result.
 *
 * ── The gate is orthogonal ───────────────────────────────────────────
 * The subscription gate lives OUTSIDE `#chatContainer` — it's a
 * sibling of the input area. So it can coexist with any content
 * state (e.g. a user with no subscription browsing past chats sees
 * the gate alongside the messages). `showSubscriptionGate` is
 * idempotent by checking for the existing gate element by id.
 *
 * ── Naming & IDs ─────────────────────────────────────────────────────
 * Each state element carries a stable id so it can be located /
 * removed / queried by any module in the codebase:
 *
 *   #chatLoading            — the loading spinner
 *   #chatEmpty              — the empty state
 *   #chatError              — the error card
 *   #ai-subscription-gate   — the subscription gate
 *
 * The gate id follows the `ai-` prefix convention used by other AI
 * features (`#ai-sel-*`, `#ai-shared-*`) to keep the AI page's
 * selectors namespaced.
 *
 * ── Accessibility ────────────────────────────────────────────────────
 *   • Loading: `role="status"` + `aria-live="polite"` so screen
 *     readers announce "Loading conversation…" without interrupting
 *     whatever else is going on.
 *   • Error: `role="alert"` so the error and its retry button are
 *     announced immediately.
 *   • Subscription gate: `role="region"` + `aria-label` so it's
 *     discoverable as a landmark.
 *   • Empty state: no role — it's purely informational, not a state
 *     change a user needs to be alerted about.
 *   • Spinner: `aria-hidden="true"` — screen readers should hear the
 *     text, not the decoration.
 *
 * ── Public API ───────────────────────────────────────────────────────
 *   showChatLoading(chat)                       → insert loading spinner
 *   hideChatLoading(chat)                       → remove spinner
 *   showEmptyChatState(chat)                    → insert empty placeholder
 *   hideEmptyChatState(chat)                    → remove placeholder
 *   showChatError(chat, message, chatId)        → insert error card + retry
 *   hideChatError(chat)                         → remove error card
 *   showSubscriptionGate(chat)                  → insert gate + disable input
 *   hideSubscriptionGate(chat)                  → remove gate + re-enable input
 */

import { escapeHtml } from './markdown.js';
import * as router from '../router.js';

// ==================== CONTENT STATES ====================

/**
 * Show the loading state while a conversation is being fetched.
 *
 * Clears any existing messages, empty state, or error card first
 * (they're mutually exclusive with loading). Inserts a centered
 * spinner with a polite accessibility announcement.
 *
 * Idempotent: calling twice is a no-op visually.
 *
 * @param {object} chat  the AIChatUI instance
 */
export function showChatLoading(chat) {
    if (!_validateContainer(chat, 'showChatLoading')) return;

    chat.clearMessages();

    const el = document.createElement('div');
    el.className = 'chat-loading';
    el.id = 'chatLoading';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML = `
        <div class="chat-loading-spinner" aria-hidden="true"></div>
        <div class="chat-loading-text">Loading conversation…</div>
    `;
    _insertIntoContainer(chat, el);
}

/**
 * Remove the loading state.
 *
 * Idempotent: safe to call when the loading state isn't showing.
 *
 * @param {object} chat
 */
export function hideChatLoading(chat) {
    if (!chat) return;
    const el = document.getElementById('chatLoading');
    if (el) el.remove();
}

/**
 * Show the empty state for a chat that has genuinely no messages.
 *
 * Clears any existing content state first, then inserts the
 * placeholder. Uses the standard 3-line layout: emoji icon, bold
 * title, muted description.
 *
 * @param {object} chat
 */
export function showEmptyChatState(chat) {
    if (!_validateContainer(chat, 'showEmptyChatState')) return;

    chat.clearMessages();

    const el = document.createElement('div');
    el.className = 'chat-empty-state';
    el.id = 'chatEmpty';
    el.innerHTML = `
        <div class="chat-empty-icon">💬</div>
        <div class="chat-empty-title">No messages yet</div>
        <div class="chat-empty-desc">Send a message below to get started.</div>
    `;
    _insertIntoContainer(chat, el);
}

/**
 * Remove the empty state.
 *
 * @param {object} chat
 */
export function hideEmptyChatState(chat) {
    if (!chat) return;
    const el = document.getElementById('chatEmpty');
    if (el) el.remove();
}

/**
 * Show the error state after a failed conversation load.
 *
 * Clears any existing content state first. Renders the concrete
 * reason (escaped, with newlines preserved) plus a Retry button that
 * re-invokes `chat.loadChatUI(chatId)`.
 *
 * If `chatId` is falsy, the Retry button is hidden — there's nothing
 * to retry. This can happen if the caller caught an error before
 * `currentChatId` was set (very rare but possible).
 *
 * The error message is displayed in full but with newlines rendered
 * as `<br>`. Long messages are handled by the existing CSS
 * (`max-width: 420px`, `word-wrap: break-word`).
 *
 * @param {object} chat
 * @param {string} message  the concrete reason, e.g. "Chat not found"
 *                          or "You are offline and this conversation
 *                          has not been downloaded yet."
 * @param {string} chatId   the chat to retry loading; empty/falsy to
 *                          hide the Retry button
 */
export function showChatError(chat, message, chatId) {
    if (!_validateContainer(chat, 'showChatError')) return;

    chat.clearMessages();

    const el = document.createElement('div');
    el.className = 'chat-error-state';
    el.id = 'chatError';
    el.setAttribute('role', 'alert');

    const safeMsg = escapeHtml(message || 'Failed to load conversation')
        .replace(/\n/g, '<br>');
    const hasRetry = chatId && String(chatId).length > 0;

    el.innerHTML = `
        <div class="chat-error-icon" aria-hidden="true">⚠️</div>
        <div class="chat-error-title">Could not load conversation</div>
        <div class="chat-error-message">${safeMsg}</div>
        ${hasRetry ? `
            <button class="chat-error-retry" type="button">
                <i class="fas fa-redo-alt" aria-hidden="true"></i> Retry
            </button>
        ` : ''}
    `;
    _insertIntoContainer(chat, el);

    if (hasRetry) {
        el.querySelector('.chat-error-retry')?.addEventListener('click', () => {
            // `loadChatUI` clears the error state at its start (via
            // `chat.clearMessages()`), so the error disappears and the
            // loading state appears synchronously — no flash of the
            // error state during the retry.
            chat.loadChatUI(chatId);
        });
    }
}

/**
 * Remove the error state.
 *
 * @param {object} chat
 */
export function hideChatError(chat) {
    if (!chat) return;
    const el = document.getElementById('chatError');
    if (el) el.remove();
}

// ==================== SUBSCRIPTION GATE ====================

/**
 * Show the subscription gate banner above the input area.
 *
 * The gate is idempotent — if `#ai-subscription-gate` already exists,
 * this is a no-op. It never shows in shared view (a read-only shared
 * conversation shouldn't prompt the viewer to subscribe to reply to
 * someone else's chat).
 *
 * Placement: inserted as a sibling of `#inputArea`, so it appears
 * between the chat container and the input. Falls back to inserting
 * before `#chatContainer` if `#inputArea` isn't found (defensive).
 *
 * Side effects on the chat instance:
 *   • messageInput.disabled = true
 *   • messageInput.placeholder = "Subscribe to continue..."
 *   • sendBtn.disabled = true
 *   • attachBtn.disabled = true
 *   • voiceBtn.disabled = true
 *
 * @param {object} chat
 */
export function showSubscriptionGate(chat) {
    if (!chat) return;

    // Shared view never asks the recipient to subscribe — the
    // conversation belongs to someone else and the input is already
    // disabled by shared.js.
    if (chat.isSharedView) return;

    // Idempotent: if the gate is already on screen, don't double-insert.
    if (document.getElementById('ai-subscription-gate')) return;

    const gate = document.createElement('div');
    gate.id = 'ai-subscription-gate';
    gate.className = 'ai-subscription-gate';
    gate.setAttribute('role', 'region');
    gate.setAttribute('aria-label', 'Active subscription required');
    gate.innerHTML = `
        <div class="sub-gate-icon" aria-hidden="true">🔒</div>
        <div class="sub-gate-body">
            <div class="sub-gate-title">Active subscription required</div>
            <div class="sub-gate-desc">Upgrade your plan to continue using MedVix AI.</div>
        </div>
        <button class="sub-gate-btn" id="aiSubGateBtn" type="button">View Plans</button>
    `;

    _insertBeforeInput(chat, gate);

    gate.querySelector('#aiSubGateBtn')?.addEventListener('click', () => {
        router.navigateTo('subscription');
    });

    // Disable every send-related control so the UI matches the
    // "you can't send anything right now" state the gate communicates.
    _disableInputControls(chat, 'Subscribe to continue...');
}

/**
 * Remove the subscription gate and re-enable the input controls.
 *
 * Idempotent — safe to call when the gate isn't showing.
 *
 * Re-enable rules:
 *   • Shared view → do NOT re-enable. The input is controlled by
 *     shared.js and should remain read-only until the user exits
 *     shared view.
 *   • Selection mode active → do NOT re-enable. The selection bar
 *     manages its own disabled state and will re-enable on exit.
 *   • Otherwise → re-enable input, send, attach, voice.
 *
 * The caller is responsible for updating `chat.hasActiveSubscription`
 * BEFORE calling this — this module only manages DOM state, not the
 * entitlement flag itself.
 *
 * @param {object} chat
 */
export function hideSubscriptionGate(chat) {
    if (!chat) return;

    const gate = document.getElementById('ai-subscription-gate');
    if (gate) gate.remove();

    // Shared view wins — never re-enable while it's active.
    if (chat.isSharedView) return;

    // Selection mode wins — the selection bar will re-enable on exit.
    if (chat._selectionMode) return;

    _enableInputControls(chat);
}

// ==================== PRIVATE HELPERS ====================

/**
 * Defensive check: does the chat instance expose the container we
 * need? Logs a warning (rather than throwing) when it doesn't, so
 * a broken call site can't crash the whole page — the state just
 * silently doesn't render, which is recoverable.
 *
 * @private
 * @param {object} chat
 * @param {string} caller
 * @returns {boolean}
 */
function _validateContainer(chat, caller) {
    if (!chat) {
        console.warn(`[chat-states] ${caller}: no chat instance`);
        return false;
    }
    if (!chat.chatContainer) {
        console.warn(`[chat-states] ${caller}: chat.chatContainer is missing`);
        return false;
    }
    return true;
}

/**
 * Insert `el` into the chat container, before the typing indicator
 * when present, at the end otherwise. The typing indicator must stay
 * as the last child so it appears below all content.
 *
 * @private
 */
function _insertIntoContainer(chat, el) {
    if (chat.typingIndicator && chat.typingIndicator.parentNode === chat.chatContainer) {
        chat.chatContainer.insertBefore(el, chat.typingIndicator);
    } else {
        chat.chatContainer.appendChild(el);
    }
}

/**
 * Insert the gate before the input area. Falls back to inserting
 * before the chat container (if input area isn't found) or at the
 * end of the main column (last resort).
 *
 * @private
 */
function _insertBeforeInput(chat, gate) {
    const inputArea = chat.inputArea || chat.normalInput?.parentElement;

    if (inputArea?.parentElement) {
        inputArea.parentElement.insertBefore(gate, inputArea);
        return;
    }

    // Fallback: put the gate above the chat container instead. This
    // is not the ideal position, but it guarantees the user sees
    // something rather than nothing.
    if (chat.chatContainer?.parentElement) {
        chat.chatContainer.parentElement.insertBefore(gate, chat.chatContainer);
        return;
    }

    // Last resort: attach to the body. Should never happen in practice.
    document.body.appendChild(gate);
    console.warn('[chat-states] insertBeforeInput fell back to document.body');
}

/**
 * Disable every send-related control on the chat instance. Called by
 * `showSubscriptionGate`.
 *
 * @private
 */
function _disableInputControls(chat, placeholder) {
    if (chat.messageInput) {
        chat.messageInput.disabled = true;
        chat.messageInput.placeholder = placeholder;
    }
    if (chat.sendBtn) chat.sendBtn.disabled = true;
    if (chat.attachBtn) chat.attachBtn.disabled = true;
    if (chat.voiceBtn) chat.voiceBtn.disabled = true;
}

/**
 * Re-enable every send-related control on the chat instance. Called
 * by `hideSubscriptionGate` after verifying the caller didn't want
 * them to stay disabled for another reason (shared view, selection
 * mode).
 *
 * @private
 */
function _enableInputControls(chat) {
    if (chat.messageInput) {
        chat.messageInput.disabled = false;
        chat.messageInput.placeholder = 'Send a message...';
    }
    if (chat.sendBtn) chat.sendBtn.disabled = false;
    if (chat.attachBtn) chat.attachBtn.disabled = false;
    if (chat.voiceBtn) chat.voiceBtn.disabled = false;
}