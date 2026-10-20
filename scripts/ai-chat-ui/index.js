// scripts/ai-chat-ui/index.js
/**
 * Barrel re-export of every public function across the AI chat UI
 * modules.
 *
 * ── Purpose ──────────────────────────────────────────────────────────
 * Each module in this folder owns one concern (markdown, chat states,
 * lightbox, share, etc.). This barrel exposes all of them under a
 * single import so `ai-chat-ui.js` doesn't need to know the internal
 * file structure:
 *
 *   import * as chat from './ai-chat-ui/index.js';
 *
 * Then any function is available as `chat.someFunction(chatInstance, ...)`.
 *
 * ── Why explicit named exports (not `export *`) ──────────────────────
 * Explicit re-exports make this file the definitive API surface:
 *
 *   • Adding an internal helper to a module does not accidentally
 *     expose it here.
 *   • Naming conflicts (present or future) surface at parse time,
 *     not as silent shadowing.
 *   • Grepping this file tells you exactly what the folder exports.
 *   • IDE autocomplete is precise.
 *
 * ── escape.js ────────────────────────────────────────────────────────
 * `escapeHtml` and `escapeHtmlSafe` live in markdown.js (which all
 * other modules import from). The standalone `escape.js` file exists
 * as a forwarding module for backward compatibility — it re-exports
 * the same two functions. To avoid duplicate-export errors from this
 * barrel, the escape functions are re-exported from markdown.js only.
 * If you want a single source, delete escape.js and rely on
 * markdown.js.
 */

// ── Content rendering ──────────────────────────────────────────────
// markdown.js owns text → HTML. escapeHtml / escapeHtmlSafe are the
// canonical escape helpers used across every other module.
export {
    escapeHtml,
    escapeHtmlSafe,
    stripMarkdown,
    renderLatex,
    renderMarkdown,
} from './markdown.js';

// ── Rich data cards + meta bar ─────────────────────────────────────
// The meta line under a bubble and every card group (formulas,
// mnemonics, references, sources, images) attached to a message.
export {
    buildRichMetaBar,
    renderRichDataCards,
} from './rich-data.js';

// ── Chat state UI ──────────────────────────────────────────────────
// Loading / empty / error states for the chat container, plus the
// subscription gate banner above the input.
export {
    showChatLoading,
    hideChatLoading,
    showEmptyChatState,
    hideEmptyChatState,
    showChatError,
    hideChatError,
    showSubscriptionGate,
    hideSubscriptionGate,
} from './chat-states.js';

// ── Image viewer ───────────────────────────────────────────────────
// The full-screen lightbox overlay for .rich-image thumbnails.
export {
    createImageViewer,
    destroyImageViewer,
    setupImageLightbox,
    openImageViewer,
    closeImageViewer,
} from './lightbox.js';

// ── Share + shared view ────────────────────────────────────────────
// The share modal, URL normalization, and the read-only shared-
// conversation lifecycle (banner, read-only mode, exit paths).
export {
    setupShareModal,
    openShareModal,
    buildShareUrl,
    loadSharedConversation,
    renderSharedMessages,
    showSharedBanner,
    enterReadOnlyMode,
    exitReadOnlyMode,
    showSharedError,
    exitSharedView,
    ensureNotShared,
    clearSharedState,
} from './share.js';

// ── Message actions ────────────────────────────────────────────────
// Edit / copy / retry actions on user messages, plus the failure-
// flag lifecycle and local persistence.
export {
    attachUserMessageActions,
    startEditing,
    cancelEditing,
    deleteMessageAndResponse,
    attachRetryButton,
    retrySend,
    markLastUserMessageFailed,
    markMessageSuccess,
    persistChats,
} from './message-actions.js';

// ── Notes selection ────────────────────────────────────────────────
// Multi-select mode, floating action bar, HTML → notes HTML
// conversion, plain-text extraction, and the save confirmation toast.
export {
    enterSelectionMode,
    exitSelectionMode,
    toggleMessageSelection,
    selectAllMessages,
    deselectAllMessages,
    syncSelectionVisual,
    renderSelectionBar,
    updateSelectionBarCount,
    saveSelectedToNotes,
    renderedToNotesHtml,
    extractPlainText,
    showNoteSavedToast,
    notesCssHint,
} from './notes-selection.js';

// ── Chat history sidebar ───────────────────────────────────────────
// Renders the list of conversations with sort, filter, and per-item
// menu (pin / delete / share).
export {
    renderChatHistory,
} from './history.js';