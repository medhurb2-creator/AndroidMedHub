// scripts/ai-chat-ui/message-actions.js
/**
 * Message actions — everything you can do to a message after it exists.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 * This module owns five concerns, all centred on message lifecycle:
 *
 *   1. EDIT FLOW      The user taps "Edit" on a user message, the
 *                     input is populated, they modify and send. This
 *                     module owns the edit STATE (`chat._editing`),
 *                     the visual marker, and the graceful-cancel
 *                     behaviour. The actual "delete old message +
 *                     send new content" orchestration lives in
 *                     `sendUserMessage` — this module provides the
 *                     primitives it calls.
 *
 *   2. COPY           One-click clipboard copy of a user message's
 *                     content. Falls back to `execCommand('copy')`
 *                     when the Clipboard API isn't available.
 *
 *   3. RETRY          When a send fails (network, backend error,
 *                     rate limit), the user message is marked
 *                     `failed: true` in the store. This module
 *                     renders the "Retry" button under it, and
 *                     orchestrates the retry: delete the failed
 *                     message, re-send the same content, re-render
 *                     with either the assistant reply or a fresh
 *                     failed state.
 *
 *   4. FLAGS          `markLastUserMessageFailed` and
 *                     `markMessageSuccess` persist the `failed` flag
 *                     for the message CRUD layer. Persistence is
 *                     immediate (IDB + LS) so the flag survives a
 *                     page reload.
 *
 *   5. PERSISTENCE    `persistChats` writes the chats array to both
 *                     IndexedDB (fast, offline) and localStorage
 *                     (fallback). Never throws — a failed write is
 *                     logged and the operation continues with the
 *                     in-memory state intact.
 *
 * ── Retry design ─────────────────────────────────────────────────────
 * Retry is modelled as DELETE-AND-RESEND rather than a partial
 * resend of the existing record. Why:
 *
 *   • `ai.sendMessageToAI` unconditionally saves a new user message
 *     before making the backend call. Calling it on an existing
 *     failed message would create a duplicate user bubble.
 *   • Deleting the failed message first guarantees exactly one user
 *     bubble per attempt — no duplicates, no orphans.
 *   • The user sees their message bubble disappear and reappear
 *     with the reply (or a fresh failed state). This is the correct
 *     UX — it's honest that the previous attempt was discarded.
 *
 * The trade-off: the new message has a NEW timestamp. Any external
 * reference to the old timestamp (bookmark, analytics) becomes
 * stale. This is acceptable — timestamps are local identifiers,
 * not part of any contract.
 *
 * ── Retry and file attachments ───────────────────────────────────────
 * KNOWN LIMITATION: retry does not preserve file attachments. The
 * current `_attachRetryButton(msgDiv, text, timestamp)` signature
 * doesn't carry fileData, and `sendMessageToAI` would need a
 * corresponding `file` param. If retry is attempted on a file
 * message, the resent content is the fallback text (e.g.
 * "📎 Uploaded foo.pdf"), not the original file. Worth improving in
 * a future pass.
 *
 * ── Chat-switch safety ───────────────────────────────────────────────
 * Every async operation captures `chat.currentChatId` at the start
 * and checks it hasn't changed before rendering. If the user
 * navigates to another chat mid-retry, the operation completes
 * against the ORIGINAL chat (correct) but does not touch the new
 * chat's DOM (correct). The user can switch back and see the
 * completed state via normal `loadChatUI`.
 *
 * ── Edit-cancel policy ───────────────────────────────────────────────
 * `cancelEditing` clears the message's `.editing` marker and:
 *
 *   • If the input's current value matches the text being edited,
 *     clears the input — this is a clean "cancel edit" gesture.
 *   • If the input has been modified, leaves it alone — the user
 *     typed something new and shouldn't lose their work just
 *     because they opened another chat.
 *
 * The check is by exact string equality. A smarter check (trimmed,
 * normalised) is unnecessary — the input value is set from the
 * same string the caller supplied to `startEditing`, so an
 * unchanged field is byte-identical.
 *
 * ── Shared-view safety ───────────────────────────────────────────────
 * `attachUserMessageActions` and `attachRetryButton` are no-ops
 * when `chat.isSharedView` is true. The caller already strips these
 * actions in `renderSharedMessages`, but the guard here means even
 * a future code path that forgets to strip won't produce interactive
 * controls in a read-only view.
 *
 * ── Public API ───────────────────────────────────────────────────────
 *   attachUserMessageActions(chat, msgDiv, text, timestamp, chatId)
 *   startEditing(chat, msgDiv, text, timestamp, chatId)
 *   cancelEditing(chat)
 *   deleteMessageAndResponse(chat, chatId, timestamp)
 *   attachRetryButton(chat, msgDiv, text, timestamp)
 *   retrySend(chat, text, msgDiv, timestamp)
 *   markLastUserMessageFailed(chat, chatId)
 *   markMessageSuccess(chat, chatId, timestamp)
 *   persistChats(chat, chats)
 *
 * All functions accept the `AIChatUI` instance as the first arg.
 */

import * as ui from '../ui.js';
import * as db from '../db.js';
import * as utils from '../utils.js';
import ai from '../ai.js';

// ==================== ATTACH ACTION ROW ====================

/**
 * Attach the Edit + Copy action row to a user message bubble.
 *
 * Renders two small buttons below the bubble. Both are visible on
 * hover (CSS `.user-actions { opacity: 0 }` + `.message.user:hover`
 * override) — see the CSS module. On touch devices they're always
 * visible.
 *
 * The action row is idempotent: if `.user-actions` already exists
 * inside `msgDiv`, this function returns without touching anything.
 * This makes it safe to call twice (though in practice each render
 * produces a fresh DOM node so the guard rarely fires).
 *
 * @param {object} chat
 * @param {HTMLElement} msgDiv  the user message wrapper
 * @param {string} text         the message content
 * @param {number} timestamp    the message's timestamp
 * @param {string} chatId       the chat the message belongs to
 */
export function attachUserMessageActions(chat, msgDiv, text, timestamp, chatId) {
    if (!chat || !msgDiv) return;
    // Shared view: never attach interactive controls.
    if (chat.isSharedView) return;
    // Idempotent — don't double-attach.
    if (msgDiv.querySelector('.user-actions')) return;

    const actions = document.createElement('div');
    actions.className = 'user-actions';

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'edit-action';
    editBtn.setAttribute('title', 'Edit message');
    editBtn.setAttribute('aria-label', 'Edit message');
    editBtn.innerHTML = '<i class="fas fa-pen" aria-hidden="true"></i> Edit';
    editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startEditing(chat, msgDiv, text, timestamp, chatId);
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-action-user';
    copyBtn.setAttribute('title', 'Copy');
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.innerHTML = '<i class="far fa-copy" aria-hidden="true"></i> Copy';
    copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await _copyToClipboard(text);
        ui.showToast(
            ok ? 'Copied to clipboard' : 'Press Ctrl+C to copy',
            ok ? 'success' : 'warning'
        );
    });

    actions.appendChild(editBtn);
    actions.appendChild(copyBtn);
    msgDiv.appendChild(actions);
}

// ==================== EDIT ====================

/**
 * Start editing a user message.
 *
 * Sets `chat._editing` to `{ msgDiv, timestamp, chatId, text }` —
 * the state the send handler reads to know that the next send is
 * an edit, not a fresh message. Also:
 *
 *   • Marks the bubble with `.editing` (CSS shows an accent outline).
 *   • Populates the input with the message's content.
 *   • Focuses the input and resizes it to fit the content.
 *   • Shows a brief "Editing…" toast.
 *
 * If another edit is already active, its state is discarded first —
 * only one message can be under edit at a time.
 *
 * @param {object} chat
 * @param {HTMLElement} msgDiv
 * @param {string} text
 * @param {number} timestamp
 * @param {string} chatId
 */
export function startEditing(chat, msgDiv, text, timestamp, chatId) {
    if (!chat || !msgDiv) return;

    // Only one edit at a time — discard any prior edit state.
    if (chat._editing?.msgDiv && chat._editing.msgDiv !== msgDiv) {
        chat._editing.msgDiv.classList.remove('editing');
    }

    chat._editing = { msgDiv, timestamp, chatId, text };
    msgDiv.classList.add('editing');

    if (chat.messageInput) {
        chat.messageInput.value = text;
        chat.messageInput.focus();
        chat.messageInput.style.height = 'auto';
        chat.messageInput.style.height =
            Math.min(chat.messageInput.scrollHeight, 120) + 'px';
    }

    ui.showToast('Editing — modify and send to replace', 'info', 1800);
}

/**
 * Cancel any active edit.
 *
 * Clears `chat._editing` and removes the `.editing` marker from the
 * message DOM. The input is cleared only if its current value
 * exactly matches the text being edited — if the user typed
 * something new, their work is preserved.
 *
 * Called from two places:
 *   • The send handler, when the user submits an empty input while
 *     editing (the standard "cancel edit" gesture).
 *   • `loadChatUI`, when the user navigates to another chat (in-
 *     flight edits shouldn't leak across chats).
 *
 * Idempotent: no-op when there's no active edit.
 *
 * @param {object} chat
 */
export function cancelEditing(chat) {
    if (!chat || !chat._editing) return;

    const { msgDiv, text } = chat._editing;

    if (msgDiv) msgDiv.classList.remove('editing');

    // Clear the input only if it still contains the original text.
    // If the user typed something new, they probably want to send
    // it as a fresh message — don't destroy their work.
    if (chat.messageInput && chat.messageInput.value === text) {
        chat.messageInput.value = '';
        chat.messageInput.style.height = 'auto';
    }

    chat._editing = null;
}

// ==================== DELETE (EDIT PRIMITIVE) ====================

/**
 * Delete a user message and the assistant reply that immediately
 * follows it, if any.
 *
 * Used by the edit-submit flow: the old message and its reply are
 * removed from the store before the edited text is re-sent through
 * `sendMessageToAI`.
 *
 * The chat is marked `synced: false` because this mutation is
 * local — the backend's conversation chunks are not surgically
 * updated. The next send appends the edited message; the stale
 * chunk remains on the backend until a future reconciliation pass.
 *
 * @param {object} chat
 * @param {string} chatId
 * @param {number} timestamp  timestamp of the original user message
 * @returns {Promise<boolean>}  true if a message was removed
 */
export async function deleteMessageAndResponse(chat, chatId, timestamp) {
    if (!chat || !chatId || timestamp == null) return false;

    try {
        const chats = await ai.loadChats();
        const target = chats.find((c) => c.id === chatId);
        if (!target) return false;

        const idx = target.messages.findIndex(
            (m) => m.role === 'user' && m.timestamp === timestamp
        );
        if (idx === -1) return false;

        let deleteCount = 1;
        if (target.messages[idx + 1]?.role === 'assistant') deleteCount = 2;

        target.messages.splice(idx, deleteCount);
        target.updatedAt = Date.now();
        target.synced = false;

        // Mirror the mutation into the ai module's cache so a
        // subsequent `ai.loadChats()` doesn't resurrect the deleted
        // message.
        ai._cache.chats = chats;

        await persistChats(chat, chats);
        return true;
    } catch (err) {
        console.warn('[message-actions] deleteMessageAndResponse failed:', err);
        return false;
    }
}

// ==================== RETRY ====================

/**
 * Attach a "Retry" button under a user message that failed to send.
 *
 * The button is rendered as a `<button>` (keyboard-focusable) with
 * an ARIA label. Clicking it delegates to `retrySend`. Keyboard
 * users get the same behaviour via the native button's Enter/Space.
 *
 * Idempotent: no-op if `.retry-btn` already exists inside `msgDiv`
 * (protects against double-attach after re-renders where the DOM
 * node survives — rare, but defensive).
 *
 * @param {object} chat
 * @param {HTMLElement} msgDiv
 * @param {string} text
 * @param {number} timestamp
 */
export function attachRetryButton(chat, msgDiv, text, timestamp) {
    if (!chat || !msgDiv) return;
    if (chat.isSharedView) return;   // read-only
    if (msgDiv.querySelector('.retry-btn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'retry-btn';
    btn.setAttribute('title', 'Retry sending');
    btn.setAttribute('aria-label', 'Retry sending message');
    btn.innerHTML = '<i class="fas fa-redo-alt" aria-hidden="true"></i> <span>Retry</span>';

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        retrySend(chat, text, msgDiv, timestamp);
    });

    msgDiv.appendChild(btn);
}

/**
 * Retry a failed message.
 *
 * Flow:
 *   1. Guard: no-op if already sending or no active subscription
 *      (subscription failure shows the gate and a toast).
 *   2. Capture `chatId` at the start so a mid-retry chat switch
 *      doesn't confuse the render-target check.
 *   3. Show the typing indicator, disable further sends via
 *      `chat._sending`, remove the retry button.
 *   4. Delete the failed user message and any following assistant
 *      reply (there shouldn't be one, but defensive).
 *   5. Re-send the same content via `ai.sendMessageToAI` with the
 *      same modes. The API saves a fresh user message and (on
 *      success) a fresh assistant message.
 *   6. If the user switched chats mid-retry, bail before rendering
 *      — the retry still completed against the original chat,
 *      which is correct.
 *   7. On success: reload chats, clear the container, re-render
 *      the whole message list so the retry's new user bubble +
 *      reply both appear.
 *   8. On failure: reload, clear, re-render — the freshly-created
 *      failed message will have its own retry button attached
 *      automatically by `_renderChatMessages`. Show a toast with
 *      the backend error.
 *   9. Finally: clear `chat._sending` so the input is re-enabled.
 *
 * The delete-and-resend model means the retried message has a new
 * timestamp. This is the correct trade-off — see the module
 * docblock for the reasoning.
 *
 * @param {object} chat
 * @param {string} text
 * @param {HTMLElement} msgDiv   the failed message element
 * @param {number} timestamp     the failed message's timestamp
 */
export async function retrySend(chat, text, msgDiv, timestamp) {
    if (!chat) return;

    const chatIdAtStart = chat.currentChatId;
    if (!chatIdAtStart) return;

    if (chat._sending) return;

    if (!chat.hasActiveSubscription) {
        chat._showSubscriptionGate?.();
        ui.showToast('Active subscription required', 'warning');
        return;
    }

    chat._sending = true;
    chat.showTypingIndicator();

    // Immediate visual feedback — the button disappears as soon as
    // the click registers, before any async work.
    const retryBtn = msgDiv?.querySelector('.retry-btn');
    if (retryBtn) retryBtn.remove();

    try {
        // Step 1: remove the failed message from the store.
        await deleteMessageAndResponse(chat, chatIdAtStart, timestamp);

        // Step 2: send fresh. The API creates a new user message
        // (with a new timestamp) and, on success, an assistant reply.
        await ai.sendMessageToAI({
            message: text,
            chatId: chatIdAtStart,
            modes: Array.isArray(chat.activeModes)
                ? chat.activeModes.map((m) => m.type)
                : [],
        });

        // Step 3: if the user navigated to another chat mid-retry,
        // don't touch the DOM — the retry already succeeded for the
        // original chat.
        if (chat.currentChatId !== chatIdAtStart) {
            chat.hideTypingIndicator();
            return;
        }

        chat.hideTypingIndicator();

        // Step 4: reload and re-render the whole message list.
        await chat.loadChats();
        _rerenderCurrentChat(chat, chatIdAtStart);
    } catch (error) {
        chat.hideTypingIndicator();

        // Same chat-switch guard as the success path.
        if (chat.currentChatId !== chatIdAtStart) return;

        // Reload and re-render — the fresh failed message will
        // automatically get its own retry button from
        // `_renderChatMessages`'s `if (msg.failed)` branch.
        try {
            await chat.loadChats();
            _rerenderCurrentChat(chat, chatIdAtStart);
        } catch (reloadErr) {
            console.warn('[message-actions] retry reload failed:', reloadErr);
        }

        ui.showToast(error?.message || 'Retry failed', 'error');
    } finally {
        chat._sending = false;
    }
}

// ==================== FLAGS ====================

/**
 * Mark the most recent user message in `chatId` as failed.
 *
 * Called from two places:
 *   • `ai.sendMessageToAI`'s catch block, so a failed send is
 *     persisted the moment it happens.
 *   • `retrySend` indirectly, since the fresh message created by
 *     `ai.sendMessageToAI` is the one that gets marked failed by
 *     the same internal catch.
 *
 * Returns the failed message's timestamp, or `null` when there's
 * nothing to mark.
 *
 * @param {object} chat
 * @param {string} chatId
 * @returns {Promise<number|null>}
 */
export async function markLastUserMessageFailed(chat, chatId) {
    if (!chat || !chatId) return null;

    try {
        const chats = await ai.loadChats();
        const target = chats.find((c) => c.id === chatId);
        if (!target) return null;

        for (let i = target.messages.length - 1; i >= 0; i--) {
            if (target.messages[i].role === 'user') {
                target.messages[i].failed = true;
                target.updatedAt = Date.now();
                ai._cache.chats = chats;
                await persistChats(chat, chats);
                return target.messages[i].timestamp;
            }
        }
        return null;
    } catch (err) {
        console.warn('[message-actions] markLastUserMessageFailed failed:', err);
        return null;
    }
}

/**
 * Clear the failed flag on a specific user message.
 *
 * Called during retry-success to clear the flag on the message that
 * was just successfully re-sent (its new instance, since retry
 * creates a fresh message). Also callable manually to un-mark a
 * message without re-sending.
 *
 * @param {object} chat
 * @param {string} chatId
 * @param {number} timestamp
 * @returns {Promise<boolean>}
 */
export async function markMessageSuccess(chat, chatId, timestamp) {
    if (!chat || !chatId || timestamp == null) return false;

    try {
        const chats = await ai.loadChats();
        const target = chats.find((c) => c.id === chatId);
        if (!target) return false;

        const msg = target.messages.find(
            (m) => m.role === 'user' && m.timestamp === timestamp
        );
        if (!msg) return false;

        msg.failed = false;
        ai._cache.chats = chats;
        await persistChats(chat, chats);
        return true;
    } catch (err) {
        console.warn('[message-actions] markMessageSuccess failed:', err);
        return false;
    }
}

// ==================== PERSISTENCE ====================

/**
 * Persist the chats array to both stores.
 *
 * Writes go to IndexedDB first (fast, the primary store) and then
 * localStorage (fallback for recovery). Failures on either are
 * logged but do NOT throw — the in-memory state stays correct and
 * a future operation can try again.
 *
 * @param {object} chat         (unused but kept for signature symmetry)
 * @param {Array} chats
 */
export async function persistChats(chat, chats) {
    try {
        await db.saveConversations(chats);
    } catch (err) {
        console.warn('[message-actions] IDB persist failed:', err);
    }
    try {
        utils.setLocalStorage('ai_chats', chats);
    } catch (err) {
        console.warn('[message-actions] LS persist failed:', err);
    }
}

// ==================== PRIVATE HELPERS ====================

/**
 * Re-render the currently-active chat's message list.
 *
 * Used by `retrySend` after mutating the store. Clears the container
 * (preserving the typing indicator) and re-populates it from the
 * freshly-loaded chat data.
 *
 * The guard in the caller ensures `chat.currentChatId` still matches
 * `chatId`, so we can safely assume the render target is correct.
 *
 * @private
 * @param {object} chat
 * @param {string} chatId
 */
function _rerenderCurrentChat(chat, chatId) {
    if (!chat || chat.currentChatId !== chatId) return;

    chat.clearMessages();
    const fresh = chat.chats.find((c) => c.id === chatId);
    if (!fresh || !Array.isArray(fresh.messages)) return;

    // `_renderChatMessages` is defined on the chat instance — it
    // wires up user-action rows, retry buttons (for failed
    // messages), and assistant message actions.
    if (typeof chat._renderChatMessages === 'function') {
        chat._renderChatMessages(fresh.messages, chatId);
    }
    chat.removeWelcomeIfExists?.();
}

/**
 * Write `text` to the clipboard, with a document.execCommand
 * fallback for older browsers and insecure contexts.
 *
 * @private
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function _copyToClipboard(text) {
    // Preferred path — modern Clipboard API.
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through */ }

    // Fallback — hidden textarea + execCommand. Works in older
    // browsers and in insecure contexts (http://), where the
    // Clipboard API is unavailable.
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}