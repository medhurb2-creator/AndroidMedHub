// scripts/ai-chat-ui.js
/**
 * AIChatUI — the orchestrator.
 *
 * ── What this file is ────────────────────────────────────────────────
 * Everything that requires a piece of DOM, an instance field, or an
 * async orchestration step lives here. Everything that is a pure
 * transformation or an isolated DOM fragment lives in `./ai-chat-ui/*`
 * and is reached through the barrel.
 *
 * ── Responsibilities ─────────────────────────────────────────────────
 *   • Own the AIChatUI instance state (DOM refs, currentChatId,
 *     activeModes, sending/editing flags, subscription cache, shared-
 *     view flags, chat-load generation).
 *   • Wire the page's DOM events to the appropriate behaviour.
 *   • Orchestrate async flows: init, load chat, send message, retry,
 *     regenerate, selection save, share landing, subscription gate.
 *   • Own the message-building pipeline (parse → build element →
 *     attach listeners → stream reveal) that turns a backend message
 *     record into a DOM node.
 *
 * ── What lives in `./ai-chat-ui/*` (via the barrel) ─────────────────
 *   markdown.js         — all text → HTML rendering, escape helpers
 *   rich-data.js        — meta bar + formulas / mnemonics / sources /
 *                         references / images cards
 *   chat-states.js      — loading / empty / error states, subscription
 *                         gate
 *   lightbox.js         — image viewer overlay
 *   share.js            — share modal, URL normalization, shared-view
 *                         load + banner + read-only lifecycle
 *   message-actions.js  — edit / copy / retry, failure flag lifecycle,
 *                         local persistence
 *   notes-selection.js  — multi-select mode + HTML → notes conversion
 *   history.js          — sidebar chat list
 *
 * ── Delegation pattern ──────────────────────────────────────────────
 * Every extracted behaviour is exposed on the class as a thin wrapper
 * of the shape:
 *
 *   _someMethod(args) { return chat.someModuleFunction(this, args); }
 *
 * This keeps the external API of AIChatUI identical to the pre-split
 * version — pages/ai.js, share.js, and message-actions.js all call
 * `chat._someMethod(...)` on the instance and it transparently forwards
 * to the module. No caller changes were required by the extraction.
 *
 * ── Methods that stay in this file ──────────────────────────────────
 * Deliberately kept here because they're tightly coupled to instance
 * state and don't belong in any single extracted module:
 *   • init / destroy
 *   • loadChats / loadChatUI / _renderChatMessages
 *   • sendUserMessage (the whole send pipeline)
 *   • _buildAssistantMessageElement / _attachMessageListeners
 *   • _renderMessageInstant / _renderMessageStreaming
 *   • setupEventListeners
 *   • startRecording / stopRecording
 *   • the state primitives (clearMessages, resetToWelcome, etc.)
 */

import * as ui from './ui.js';
import * as auth from './auth.js';
import * as subscription from './subscription.js';
import ai from './ai.js';
import * as chat from './ai-chat-ui/index.js';

export default class AIChatUI {
    constructor() {
        // ── DOM references ────────────────────────────────────────
        this.sidebar = document.getElementById('sidebar');
        this.menuToggle = document.getElementById('menuToggle');
        this.newChatBtn = document.getElementById('newChatBtn');
        this.settingsBtn = document.getElementById('settingsBtn');
        this.settingsModal = document.getElementById('settingsModal');
        this.closeModalBtn = document.getElementById('closeModalBtn');
        this.themeToggle = document.getElementById('themeToggle');
        this.modelSelect = document.getElementById('modelSelect');
        this.currentModelSpan = document.getElementById('currentModel');
        this.modelSelectorBtn = document.getElementById('modelSelectorBtn');
        this.clearHistoryBtn = document.getElementById('clearHistoryBtn');
        this.sendBtn = document.getElementById('sendBtn');
        this.messageInput = document.getElementById('messageInput');
        this.chatContainer = document.getElementById('chatContainer');
        this.typingIndicator = document.getElementById('typingIndicator');
        this.attachBtn = document.getElementById('attachBtn');
        this.voiceBtn = document.getElementById('voiceBtn');
        this.attachDropdown = document.getElementById('attachDropdown');
        this.searchChats = document.getElementById('searchChats');
        this.chatHistoryList = document.getElementById('chatHistoryList');
        this.activeFunctionsDiv = document.getElementById('activeFunctions');
        this.pendingAttachmentsDiv = document.getElementById('pendingAttachments');
        this.normalInput = document.getElementById('normalInput');
        this.voiceRecordingBar = document.getElementById('voiceRecordingBar');
        this.stopRecordingBtn = document.getElementById('stopRecordingBtn');
        this.imageUpload = document.getElementById('imageUpload');
        this.photoCapture = document.getElementById('photoCapture');
        this.documentUpload = document.getElementById('documentUpload');
        this.inputArea = document.getElementById('inputArea');

        // ── Instance state ───────────────────────────────────────
        this.currentChatId = null;
        this.activeModes = [];
        this.pendingAttachment = null;
        this.isRecording = false;
        this.recordingTimer = null;
        this.chats = [];
        this.imageViewerOverlay = null;

        // Feature flags
        this.hasActiveSubscription = false;
        this._sending = false;
        this._editing = null;
        this.shareModal = null;
        this.shareLinkInput = null;

        // Shared view
        this.isSharedView = false;
        this.shareToken = null;
        this._shareBanner = null;

        // Notes selection
        this._selectionMode = false;
        this._selectedElements = new Set();
        this._selectionBar = null;
        this._selectionBarCountEl = null;

        // Load generation — cancels superseded fetches
        this._chatLoadGeneration = 0;

        // ── Bindings ──────────────────────────────────────────────
        // Only methods whose function identity must survive across
        // `addEventListener` / `setTimeout` boundaries are bound.
        // Everything else is a class method and can be invoked as
        // `this.foo()` without loss.
        this.loadChats = this.loadChats.bind(this);
        this.renderChatHistory = this.renderChatHistory.bind(this);
        this.loadChatUI = this.loadChatUI.bind(this);
        this.sendUserMessage = this.sendUserMessage.bind(this);
        this.addMode = this.addMode.bind(this);
        this.removeMode = this.removeMode.bind(this);
        this.renderChips = this.renderChips.bind(this);
        this.setPendingAttachment = this.setPendingAttachment.bind(this);
        this.clearPendingAttachment = this.clearPendingAttachment.bind(this);
        this.renderPendingAttachment = this.renderPendingAttachment.bind(this);
    }

    // ==================== INIT / TEARDOWN ====================

    /**
     * @param {{sharedMode?: boolean}} [opts]
     *   sharedMode — skip the subscription check + gate, the page is
     *   going to load a shared conversation instead.
     */
    async init(opts = {}) {
        const sharedMode = opts.sharedMode === true;
        if (sharedMode) this.isSharedView = true;

        const [, subActive] = await Promise.all([
            this.loadChats(),
            sharedMode ? Promise.resolve(false) : this._checkSubscription(),
        ]);
        this.hasActiveSubscription = subActive;

        this.setupEventListeners();
        this._setupShareModal();
        this.resetToWelcome();
        this.hideTypingIndicator();
        this._createImageViewer();

        if (!sharedMode && !this.hasActiveSubscription) {
            this._showSubscriptionGate();
        }

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.item-menu')) {
                document.querySelectorAll('.dropdown-menu.show')
                    .forEach((m) => m.classList.remove('show'));
            }
        });
    }

    destroy() {
        try { this._exitSelectionMode(); } catch { /* ignore */ }
        try { this._clearSharedState(); } catch { /* ignore */ }
        try { chat.destroyImageViewer(this); } catch { /* ignore */ }

        // Clean up the share modal's window-level escape handler
        // (registered once by setupShareModal) and remove the element
        // if it was created dynamically.
        if (this.shareModal) {
            if (this.shareModal._shareEscHandler) {
                try {
                    window.removeEventListener('keydown', this.shareModal._shareEscHandler);
                } catch { /* ignore */ }
                delete this.shareModal._shareEscHandler;
            }
            if (this.shareModal.parentElement === document.body
                && this.shareModal.dataset.dynamic === '1') {
                try { this.shareModal.remove(); } catch { /* ignore */ }
            }
        }
    }

    async _checkSubscription() {
        try {
            return (await subscription.hasActiveSubscription()) === true;
        } catch (err) {
            console.warn('[AI] subscription check failed:', err);
            return false;
        }
    }

    // ==================== CHAT LIST ====================

    async loadChats() {
        this.chats = await ai.loadChats();
        this.renderChatHistory(this.searchChats?.value || '');
    }

    renderChatHistory(filterText = '') {
        return chat.renderChatHistory(this, filterText);
    }

    /**
     * Open a chat: load messages (with spinner) and render, or show the
     * error card with a Retry button on failure.
     *
     * Fast path when `chat.messagesLoaded === true` — no network call,
     * renders instantly, works offline.
     */
    async loadChatUI(chatId) {
        this._ensureNotShared();

        const target = this.chats.find((c) => c.id === chatId);
        if (!target) {
            ui.showToast('Chat not found', 'error');
            return;
        }

        this._exitSelectionMode();
        this.currentChatId = chatId;
        this._editing = null;
        this.clearMessages();

        const myGen = ++this._chatLoadGeneration;
        const alreadyLoaded = target.messagesLoaded === true
            && Array.isArray(target.messages);

        if (alreadyLoaded) {
            this._renderChatMessages(target.messages, chatId);
            this.removeWelcomeIfExists();
            if (target.messages.length === 0) this._showEmptyChatState();
            if (window.innerWidth < 768) this.sidebar.classList.remove('open');
            this.renderChatHistory(this.searchChats?.value || '');
            return;
        }

        this._showChatLoading();

        try {
            const messages = await ai.loadConversationMessages(chatId);
            if (myGen !== this._chatLoadGeneration) return;
            this._hideChatLoading();
            this.chats = await ai.loadChats();

            if (!messages || messages.length === 0) {
                this.removeWelcomeIfExists();
                this._showEmptyChatState();
            } else {
                this._renderChatMessages(messages, chatId);
                this.removeWelcomeIfExists();
            }
        } catch (err) {
            if (myGen !== this._chatLoadGeneration) return;
            this._hideChatLoading();
            this._showChatError(
                err?.message || 'Failed to load conversation',
                chatId
            );
        }

        if (window.innerWidth < 768) this.sidebar.classList.remove('open');
        this.renderChatHistory(this.searchChats?.value || '');
    }

    /**
     * Render an array of message records into the chat container.
     * Shared between the fast path, the slow path, and the retry
     * re-render helper in message-actions.js.
     */
    _renderChatMessages(messages, chatId) {
        messages.forEach((msg) => {
            if (msg.role === 'user') {
                const el = msg.fileData
                    ? this.addUserMessageWithFile(msg.content, msg.fileData, false)
                    : this.addUserMessage(msg.content, false);
                if (el) {
                    el.dataset.timestamp = msg.timestamp;
                    this._attachUserMessageActions(el, msg.content, msg.timestamp, chatId);
                    if (msg.failed) this._attachRetryButton(el, msg.content, msg.timestamp);
                }
            } else {
                this._renderMessageInstant(
                    msg.content, false, msg.meta, msg.richData, msg.timestamp
                );
            }
        });
    }

    // ==================== CHAT STATE DELEGATES ====================
    _showChatLoading()      { return chat.showChatLoading(this); }
    _hideChatLoading()      { return chat.hideChatLoading(this); }
    _showEmptyChatState()   { return chat.showEmptyChatState(this); }
    _showChatError(m, id)   { return chat.showChatError(this, m, id); }
    _showSubscriptionGate() { return chat.showSubscriptionGate(this); }

    // ==================== DOM PRIMITIVES ====================

    clearMessages() {
        Array.from(this.chatContainer.children).forEach((child) => {
            if (child.id !== 'typingIndicator') child.remove();
        });
    }

    resetToWelcome() {
        this.clearMessages();
        this.removeWelcomeIfExists();
        this.chatContainer.insertBefore(this.createWelcomeBlock(), this.typingIndicator);
    }

    createWelcomeBlock() {
        const block = document.createElement('div');
        block.className = 'welcome-block';
        block.id = 'welcomeBlock';
        block.innerHTML = `
            <div class="greeting-bubble">
                Hello doc. <strong>${this.getUserName()}</strong> how should I help you today?
            </div>
            <div class="quick-actions">
                <button class="quick-action-btn" data-prompt="Explain a topic"><i class="fas fa-lightbulb"></i> Explain a topic</button>
                <button class="quick-action-btn" data-prompt="Write an essay"><i class="fas fa-pen"></i> Write an essay</button>
                <button class="quick-action-btn" data-prompt="Make flash cards"><i class="fas fa-card"></i> Make flash cards</button>
                <button class="quick-action-btn" data-prompt="Generate questions"><i class="fas fa-question-circle"></i> Generate questions</button>
            </div>
        `;
        return block;
    }

    getUserName() {
        const user = auth.getUser() || { name: 'Doctor' };
        return user.name?.split(' ')[0] || 'Doctor';
    }

    removeWelcomeIfExists() {
        const w = document.getElementById('welcomeBlock');
        if (w) w.remove();
    }

    scrollToBottom() {
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }

    showTypingIndicator() {
        this.typingIndicator.style.display = 'flex';
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        this.typingIndicator.style.display = 'none';
    }

    // ==================== RENDERING DELEGATES ====================
    escapeHtml(u)            { return chat.escapeHtml(u); }
    escapeHtmlSafe(t)        { return chat.escapeHtmlSafe(t); }
    stripMarkdown(md)        { return chat.stripMarkdown(md); }
    renderLatex(text)        { return chat.renderLatex(text); }
    renderMarkdown(t, s)     { return chat.renderMarkdown(t, s); }
    buildRichMetaBar(rd, m)  { return chat.buildRichMetaBar(rd, m); }
    renderRichDataCards(rd)  { return chat.renderRichDataCards(rd); }

    // ==================== USER MESSAGES ====================

    addUserMessage(text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message user';
        msgDiv.innerHTML = `<div class="bubble">${this.escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
        this.chatContainer.insertBefore(msgDiv, this.typingIndicator);
        this.scrollToBottom();
        return msgDiv;
    }

    addUserMessageWithFile(text, fileData) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message user';
        let html = `<div class="bubble">${this.escapeHtml(text || '')}`;
        if (fileData?.type?.startsWith('image/')) {
            html += `<br><img src="${fileData.data}" class="image-preview" alt="upload" />`;
        } else if (fileData?.name) {
            html += `<br><i class="fas fa-file" style="margin-right:5px;"></i>${this.escapeHtml(fileData.name)}`;
        }
        html += `</div>`;
        msgDiv.innerHTML = html;
        this.chatContainer.insertBefore(msgDiv, this.typingIndicator);
        this.scrollToBottom();
        return msgDiv;
    }

    // ==================== MESSAGE-ACTION DELEGATES ====================
    _attachUserMessageActions(el, text, ts, id) {
        return chat.attachUserMessageActions(this, el, text, ts, id);
    }
    _startEditing(el, text, ts, id) {
        return chat.startEditing(this, el, text, ts, id);
    }
    _cancelEditing() {
        return chat.cancelEditing(this);
    }
    _deleteMessageAndResponse(id, ts) {
        return chat.deleteMessageAndResponse(this, id, ts);
    }
    _attachRetryButton(el, text, ts) {
        return chat.attachRetryButton(this, el, text, ts);
    }
    _retrySend(text, el, ts) {
        return chat.retrySend(this, text, el, ts);
    }
    _markLastUserMessageFailed(id) {
        return chat.markLastUserMessageFailed(this, id);
    }
    _markMessageSuccess(id, ts) {
        return chat.markMessageSuccess(this, id, ts);
    }
    _persistChats(chats) {
        return chat.persistChats(this, chats);
    }

    // ==================== ASSISTANT MESSAGES ====================

    _parseResponse(text, richData) {
        let actualText = text;
        let actualRichData = richData;
        if (typeof text === 'string') {
            const trimmed = text.trim();
            if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                try {
                    const p = JSON.parse(trimmed);
                    if (p.text) {
                        actualText = p.text;
                        if (!actualRichData && p.richData) actualRichData = p.richData;
                    }
                } catch { /* ignore */ }
            }
            if (trimmed.startsWith('```json')) {
                const m = text.match(/```json\s*([\s\S]*?)\s*```/);
                if (m?.[1]) {
                    try {
                        const p = JSON.parse(m[1].trim());
                        if (p.text) {
                            actualText = p.text;
                            if (!actualRichData && p.richData) actualRichData = p.richData;
                        }
                    } catch { /* ignore */ }
                }
            }
        }
        return { actualText, actualRichData };
    }

    _buildAssistantMessageElement(text, meta, richData, enableTyping) {
        const msgDiv = document.createElement('div');
        msgDiv.className = 'message assistant';

        // Meta precedence: backend-supplied `meta` (e.g. "🌐 8 pages ·
        // MedVix AI · 234 in · 567 out") wins over the field-based
        // fallback because it includes token counts and mode labels.
        let metaHtml = this.buildRichMetaBar(richData, meta);
        if (!metaHtml && meta) {
            metaHtml = `<div class="message-meta">${this.escapeHtml(meta)}</div>`;
        }

        // Sources power the inline [N] citation pills rendered by
        // markdown.js. Only present when the websearch mode ran.
        const sources = Array.isArray(richData?.sources) ? richData.sources : [];

        msgDiv.innerHTML = `
            ${metaHtml}
            <div class="assistant-content ${enableTyping ? 'typing-effect' : ''}">${this.renderMarkdown(text, sources)}</div>
            ${this.renderRichDataCards(richData)}
            <div class="message-actions">
                <span class="copy-action"><i class="far fa-copy"></i> Copy</span>
                <span class="notes-action"><i class="fas fa-sticky-note"></i> To Notes</span>
                <span class="regenerate-action"><i class="fas fa-redo-alt"></i> Regenerate</span>
                <span class="thumbs-up"><i class="far fa-thumbs-up"></i></span>
                <span class="thumbs-down"><i class="far fa-thumbs-down"></i></span>
                <span class="speak-action"><i class="fas fa-volume-up"></i></span>
            </div>
        `;
        return msgDiv;
    }

    _attachMessageListeners(msgDiv, text) {
        const plain = this.stripMarkdown(text);
        const copySpan = msgDiv.querySelector('.copy-action');
        const notesSpan = msgDiv.querySelector('.notes-action');
        const regenSpan = msgDiv.querySelector('.regenerate-action');
        const thumbsUp = msgDiv.querySelector('.thumbs-up');
        const thumbsDown = msgDiv.querySelector('.thumbs-down');
        const speakSpan = msgDiv.querySelector('.speak-action');

        copySpan.addEventListener('click', () => {
            navigator.clipboard?.writeText(plain).then(() => {
                ui.showToast('Copied to clipboard', 'success');
            }).catch(() => ui.showToast('Press Ctrl+C to copy', 'warning'));
        });

        notesSpan.addEventListener('click', () => {
            this._enterSelectionMode(msgDiv);
        });

        regenSpan.addEventListener('click', async () => {
            if (!this.hasActiveSubscription) {
                this._showSubscriptionGate();
                ui.showToast('Active subscription required', 'warning');
                return;
            }
            msgDiv.remove();
            this.showTypingIndicator();
            try {
                const response = await ai.regenerateResponse({
                    chatId: this.currentChatId,
                    modes: this.activeModes.map((m) => m.type),
                });
                this.hideTypingIndicator();
                await this.loadChats();
                const last = this.chats
                    .find((c) => c.id === this.currentChatId)
                    ?.messages.filter((m) => m.role === 'assistant').pop();
                this._renderMessageStreaming(
                    response.text, false, response.meta, response.richData,
                    last?.timestamp
                );
            } catch (error) {
                this.hideTypingIndicator();
                ui.showToast(error.message, 'error');
            }
        });

        thumbsUp.addEventListener('click', () => {
            thumbsUp.classList.toggle('active');
            if (thumbsUp.classList.contains('active')) thumbsDown.classList.remove('active');
        });

        thumbsDown.addEventListener('click', () => {
            thumbsDown.classList.toggle('active');
            if (thumbsDown.classList.contains('active')) thumbsUp.classList.remove('active');
        });

        speakSpan.addEventListener('click', () => {
            if (!window.speechSynthesis) {
                ui.showToast('Speech not supported', 'warning');
                return;
            }
            window.speechSynthesis.speak(new SpeechSynthesisUtterance(plain));
        });
    }

    _renderMessageInstant(text, save = true, meta = null, richData = null, timestamp = null) {
        const { actualText, actualRichData } = this._parseResponse(text, richData);
        const msgDiv = this._buildAssistantMessageElement(actualText, meta, actualRichData, false);
        if (timestamp != null) msgDiv.dataset.timestamp = String(timestamp);
        msgDiv.dataset.rawMd = actualText;
        this.chatContainer.insertBefore(msgDiv, this.typingIndicator);
        this.scrollToBottom();
        this._attachMessageListeners(msgDiv, actualText);
        this._setupImageLightbox(msgDiv);
    }

    _renderMessageStreaming(text, save = true, meta = null, richData = null, timestamp = null) {
        const { actualText, actualRichData } = this._parseResponse(text, richData);
        const msgDiv = this._buildAssistantMessageElement(actualText, meta, actualRichData, true);
        if (timestamp != null) msgDiv.dataset.timestamp = String(timestamp);
        msgDiv.dataset.rawMd = actualText;
        this.chatContainer.insertBefore(msgDiv, this.typingIndicator);
        this.scrollToBottom();

        const contentDiv = msgDiv.querySelector('.assistant-content');
        const total = actualText.length;
        let revealed = 0;
        const speed = total > 500 ? 4 : (total > 100 ? 10 : 20);
        const step = Math.max(1, Math.floor(total / 50));

        if (total === 0) {
            this._attachMessageListeners(msgDiv, actualText);
            this._setupImageLightbox(msgDiv);
            return;
        }

        const interval = setInterval(() => {
            revealed += step;
            if (revealed >= total) {
                revealed = total;
                clearInterval(interval);
                contentDiv.classList.remove('typing-effect');
                contentDiv.style.removeProperty('--reveal-percentage');
                this._attachMessageListeners(msgDiv, actualText);
                this._setupImageLightbox(msgDiv);
                return;
            }
            contentDiv.style.setProperty('--reveal-percentage', `${(revealed / total) * 100}%`);
        }, speed);
    }

    // ==================== LIGHTBOX DELEGATES ====================
    _createImageViewer()       { return chat.createImageViewer(this); }
    _setupImageLightbox(el)    { return chat.setupImageLightbox(this, el); }
    _openImageViewer(src, alt) { return chat.openImageViewer(this, src, alt); }
    _closeImageViewer()        { return chat.closeImageViewer(this); }

    // ==================== MODES ====================

    addMode(mode) {
        if (this.activeModes.some((m) => m.type === mode.type)) return;
        this.activeModes.push(mode);
        this.renderChips();
    }

    removeMode(type) {
        this.activeModes = this.activeModes.filter((m) => m.type !== type);
        this.renderChips();
    }

    renderChips() {
        this.activeFunctionsDiv.innerHTML = '';
        this.activeModes.forEach((mode) => {
            const chip = document.createElement('span');
            chip.className = 'function-chip';
            chip.innerHTML = `
                <i class="${mode.icon}"></i>
                <span>${mode.label}</span>
                <i class="fas fa-times remove-chip" data-type="${mode.type}"></i>
            `;
            this.activeFunctionsDiv.appendChild(chip);
        });
        this.activeFunctionsDiv.querySelectorAll('.remove-chip').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.removeMode(btn.dataset.type);
            });
        });
    }

    // ==================== ATTACHMENTS ====================

    setPendingAttachment(fileData) {
        this.pendingAttachment = fileData;
        this.renderPendingAttachment();
    }

    clearPendingAttachment() {
        this.pendingAttachment = null;
        this.renderPendingAttachment();
    }

    renderPendingAttachment() {
        this.pendingAttachmentsDiv.innerHTML = '';
        if (!this.pendingAttachment) return;
        const chip = document.createElement('span');
        chip.className = 'attachment-chip';
        const icon = this.pendingAttachment.type?.startsWith('image/') ? 'fa-image' : 'fa-file';
        chip.innerHTML = `
            <i class="fas ${icon}"></i>
            <span>${this.escapeHtml(this.pendingAttachment.name)}</span>
            <i class="fas fa-times remove-attachment"></i>
        `;
        this.pendingAttachmentsDiv.appendChild(chip);
        chip.querySelector('.remove-attachment')
            .addEventListener('click', this.clearPendingAttachment);
    }

    // ==================== SEND ====================

    async sendUserMessage() {
        if (this._sending) return;

        if (this.isSharedView) {
            ui.showToast('This is a shared view — start a new chat to reply', 'info');
            return;
        }
        if (!this.hasActiveSubscription) {
            this._showSubscriptionGate();
            ui.showToast('Active subscription required', 'warning');
            return;
        }
        if (this._selectionMode) this._exitSelectionMode();

        const rawText = this.messageInput.value.trim();

        // Empty submit while editing = cancel the edit cleanly.
        if (this._editing && !rawText && !this.pendingAttachment) {
            this._cancelEditing();
            this.messageInput.value = '';
            ui.showToast('Edit cancelled', 'info', 1200);
            return;
        }

        if (!rawText && !this.pendingAttachment) return;

        // Edit-submit — remove the old message and its reply before
        // the new content goes through the normal send path.
        if (this._editing) {
            const { msgDiv, timestamp, chatId } = this._editing;
            this._editing = null;
            const next = msgDiv.nextElementSibling;
            msgDiv.remove();
            if (next?.classList.contains('message') && next.classList.contains('assistant')) {
                next.remove();
            }
            await this._deleteMessageAndResponse(chatId, timestamp);
        }

        if (this.currentChatId === null) {
            const title = rawText
                ? (rawText.length > 30 ? rawText.substring(0, 30) + '…' : rawText)
                : (this.pendingAttachment ? 'File message' : 'New chat');
            const newChat = await ai.createChat(title);
            this.chats.push(newChat);
            this.currentChatId = newChat.id;
            this.renderChatHistory(this.searchChats?.value || '');
        }

        this.removeWelcomeIfExists();

        const fileData = this.pendingAttachment;
        let msgElement;
        if (fileData) {
            msgElement = this.addUserMessageWithFile(
                rawText || `📎 Uploaded ${fileData.name}`, fileData
            );
            this.clearPendingAttachment();
        } else {
            msgElement = this.addUserMessage(rawText);
        }

        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        this.showTypingIndicator();
        this._sending = true;

        try {
            const response = await ai.sendMessageToAI({
                message: rawText,
                chatId: this.currentChatId,
                modes: this.activeModes.map((m) => m.type),
                file: fileData,
            });
            this.hideTypingIndicator();

            // Reload so the just-sent message has its persisted
            // timestamp, then wire edit/copy onto the bubble.
            await this.loadChats();
            const lastUser = this.chats
                .find((c) => c.id === this.currentChatId)
                ?.messages.filter((m) => m.role === 'user').pop();
            if (lastUser && msgElement) {
                msgElement.dataset.timestamp = lastUser.timestamp;
                this._attachUserMessageActions(
                    msgElement, lastUser.content, lastUser.timestamp, this.currentChatId
                );
            }

            const lastAssistant = this.chats
                .find((c) => c.id === this.currentChatId)
                ?.messages.filter((m) => m.role === 'assistant').pop();

            this._renderMessageStreaming(
                response.text, true, response.meta, response.richData,
                lastAssistant?.timestamp
            );
        } catch (error) {
            this.hideTypingIndicator();

            const msg = String(error?.message || '').toLowerCase();
            if (msg.includes('subscription') || msg.includes('plan')) {
                this.hasActiveSubscription = false;
                this._showSubscriptionGate();
            }

            // Persist the failed flag so the Retry button survives a
            // reload — markLastUserMessageFailed is a delegate to the
            // message-actions module.
            const ts = await this._markLastUserMessageFailed(this.currentChatId);
            if (msgElement) {
                if (ts) msgElement.dataset.timestamp = ts;
                const lastUser = this.chats
                    .find((c) => c.id === this.currentChatId)
                    ?.messages.filter((m) => m.role === 'user').pop();
                if (lastUser) {
                    this._attachUserMessageActions(
                        msgElement, lastUser.content, lastUser.timestamp, this.currentChatId
                    );
                }
                this._attachRetryButton(msgElement, rawText, ts || Date.now());
            }

            ui.showToast(error.message || 'AI request failed', 'error');
        } finally {
            this._sending = false;
        }
    }

    // ==================== NOTES SELECTION DELEGATES ====================
    _enterSelectionMode(el)         { return chat.enterSelectionMode(this, el); }
    _exitSelectionMode()            { return chat.exitSelectionMode(this); }
    _toggleMessageSelection(el, f)  { return chat.toggleMessageSelection(this, el, f); }
    _selectAllMessages()            { return chat.selectAllMessages(this); }
    _deselectAllMessages()          { return chat.deselectAllMessages(this); }
    _syncSelectionVisual()          { return chat.syncSelectionVisual(this); }
    _renderSelectionBar()           { return chat.renderSelectionBar(this); }
    _updateSelectionBarCount()      { return chat.updateSelectionBarCount(this); }
    _saveSelectedToNotes()          { return chat.saveSelectedToNotes(this); }

    /**
     * Legacy helper — the old name for what is now
     * `renderedToNotesHtml` in notes-selection.js. Kept for callers
     * that may still hold a reference to the old method (nothing in
     * this file uses it; saveSelectedToNotes goes through the module).
     */
    _renderedHtmlToNotesHtml(contentEl) {
        if (!contentEl) return '';
        const html = typeof contentEl === 'string'
            ? contentEl
            : contentEl.innerHTML;
        return chat.renderedToNotesHtml(html, 'styled');
    }

    stripHtml(html) { return chat.extractPlainText(html); }

    _showNoteSavedToast(note) { return chat.showNoteSavedToast(note); }

    // ==================== SHARE DELEGATES ====================
    _setupShareModal()              { return chat.setupShareModal(this); }
    _openShareModal(id)             { return chat.openShareModal(this, id); }
    _buildShareUrl(ref)             { return chat.buildShareUrl(ref); }
    loadSharedConversation(token)   { return chat.loadSharedConversation(this, token); }
    _renderSharedMessages(messages) { return chat.renderSharedMessages(this, messages); }
    _showSharedBanner(conv)         { return chat.showSharedBanner(this, conv); }
    _enterReadOnlyMode()            { return chat.enterReadOnlyMode(this); }
    _exitReadOnlyMode()             { return chat.exitReadOnlyMode(this); }
    _showSharedError(msg)           { return chat.showSharedError(this, msg); }
    exitSharedView()                { return chat.exitSharedView(this); }
    _clearSharedState()             { return chat.clearSharedState(this); }
    _ensureNotShared()              { return chat.ensureNotShared(this); }

    // ==================== EVENT LISTENERS ====================

    setupEventListeners() {
        // ── Sidebar ────────────────────────────────────────────────
        if (this.menuToggle) {
            this.menuToggle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.sidebar.classList.toggle('open');
            });
        }

        const mainEl = document.querySelector('.main');
        if (mainEl) {
            mainEl.addEventListener('click', () => {
                if (window.innerWidth < 768 && this.sidebar.classList.contains('open')) {
                    this.sidebar.classList.remove('open');
                }
            });
        }

        if (this.newChatBtn) {
            this.newChatBtn.addEventListener('click', () => {
                this._ensureNotShared();
                this._exitSelectionMode();
                this.resetToWelcome();
                this.currentChatId = null;
                this.activeModes = [];
                this._cancelEditing();
                this.clearPendingAttachment();
                this.renderChips();
                this.renderChatHistory(this.searchChats?.value || '');
                if (window.innerWidth < 768) this.sidebar.classList.remove('open');
            });
        }

        // ── Settings modal ─────────────────────────────────────────
        if (this.settingsBtn && this.settingsModal) {
            this.settingsBtn.addEventListener('click', () => {
                this.settingsModal.style.display = 'flex';
            });
        }
        if (this.closeModalBtn && this.settingsModal) {
            this.closeModalBtn.addEventListener('click', () => {
                this.settingsModal.style.display = 'none';
            });
        }
        if (this.settingsModal) {
            this.settingsModal.addEventListener('click', (e) => {
                if (e.target === this.settingsModal) this.settingsModal.style.display = 'none';
            });
        }
        if (this.themeToggle) {
            this.themeToggle.addEventListener('click', () => {
                document.body.classList.toggle('light-mode');
            });
        }
        if (this.modelSelect && this.currentModelSpan) {
            this.modelSelect.addEventListener('change', () => {
                this.currentModelSpan.textContent = this.modelSelect.value;
            });
        }
        if (this.modelSelectorBtn && this.settingsModal) {
            this.modelSelectorBtn.addEventListener('click', () => {
                this.settingsModal.style.display = 'flex';
            });
        }

        // ── Clear history ──────────────────────────────────────────
        if (this.clearHistoryBtn) {
            this.clearHistoryBtn.addEventListener('click', async () => {
                const confirmed = await ui.showConfirmationDialog(
                    'Clear History',
                    'Delete all chats? This cannot be undone.',
                    'warning'
                );
                if (!confirmed) return;
                this._exitSelectionMode();
                await ai.clearAllData();
                this.chats = [];
                this.renderChatHistory('');
                this.resetToWelcome();
                this.currentChatId = null;
                this.activeModes = [];
                this._cancelEditing();
                this.clearPendingAttachment();
                this.renderChips();
                if (this.settingsModal) this.settingsModal.style.display = 'none';
                ui.showToast('Chat history cleared', 'success');
            });
        }

        // ── Composer ───────────────────────────────────────────────
        if (this.sendBtn) this.sendBtn.addEventListener('click', this.sendUserMessage);

        if (this.messageInput) {
            this.messageInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    this.sendUserMessage();
                }
            });
            this.messageInput.addEventListener('input', function () {
                this.style.height = 'auto';
                this.style.height = Math.min(this.scrollHeight, 120) + 'px';
            });
        }

        if (this.searchChats) {
            this.searchChats.addEventListener('input', (e) => {
                this.renderChatHistory(e.target.value);
            });
        }

        // ── Chat container ─────────────────────────────────────────
        if (this.chatContainer) {
            this.chatContainer.addEventListener('click', (e) => {
                // Selection mode — clicking anywhere on an assistant
                // message toggles it (except links, which open normally,
                // and the checkbox itself, which has its own handler).
                if (this._selectionMode) {
                    if (e.target.closest('a')) return;
                    const msgEl = e.target.closest('.message.assistant');
                    if (msgEl && !e.target.closest('.message-select-checkbox')) {
                        e.preventDefault();
                        e.stopPropagation();
                        this._toggleMessageSelection(msgEl);
                    }
                    return;
                }

                const btn = e.target.closest('.quick-action-btn');
                if (btn) {
                    if (this.isSharedView) {
                        ui.showToast('Start a new chat to try this prompt', 'info');
                        return;
                    }
                    const prompt = btn.getAttribute('data-prompt') || btn.innerText.trim();
                    if (this.messageInput) this.messageInput.value = prompt;
                    this.sendUserMessage();
                }
            });
        }

        // ── Attachments ────────────────────────────────────────────
        if (this.attachBtn) {
            this.attachBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.attachDropdown) this.attachDropdown.classList.toggle('show');
            });
        }
        document.addEventListener('click', (e) => {
            if (this.attachBtn && this.attachDropdown) {
                if (!this.attachBtn.contains(e.target) && !this.attachDropdown.contains(e.target)) {
                    this.attachDropdown.classList.remove('show');
                }
            }
        });

        if (this.attachDropdown) {
            document.querySelectorAll('.attach-item').forEach((item) => {
                item.addEventListener('click', () => {
                    const action = item.getAttribute('data-action');
                    if (this.attachDropdown) this.attachDropdown.classList.remove('show');

                    if (action === 'upload image' && this.imageUpload) {
                        this.imageUpload.click();
                        this.imageUpload.onchange = async (e) => {
                            if (e.target.files[0]) {
                                const fileData = await ai.uploadFile(e.target.files[0]);
                                this.setPendingAttachment(fileData);
                            }
                        };
                    } else if (action === 'take photo' && this.photoCapture) {
                        this.photoCapture.click();
                        this.photoCapture.onchange = async (e) => {
                            if (e.target.files[0]) {
                                const fileData = await ai.uploadFile(e.target.files[0]);
                                this.setPendingAttachment(fileData);
                            }
                        };
                    } else if (action === 'upload document' && this.documentUpload) {
                        this.documentUpload.click();
                        this.documentUpload.onchange = async (e) => {
                            if (e.target.files[0]) {
                                const fileData = await ai.uploadFile(e.target.files[0]);
                                this.setPendingAttachment(fileData);
                            }
                        };
                    } else if (action === 'deepthink') {
                        this.addMode({ type: 'deepthink', icon: 'fas fa-brain', label: 'Deepthink' });
                    } else if (action === 'search web') {
                        this.addMode({ type: 'websearch', icon: 'fas fa-globe', label: 'Search Web' });
                    } else if (action === 'references') {
                        this.addMode({ type: 'references', icon: 'fas fa-book', label: 'References' });
                    }
                });
            });
        }

        // ── Voice ──────────────────────────────────────────────────
        if (this.voiceBtn) {
            this.voiceBtn.addEventListener('click', () => {
                if (this.isRecording) this.stopRecording();
                else this.startRecording();
            });
        }
        if (this.stopRecordingBtn) {
            this.stopRecordingBtn.addEventListener('click', this.stopRecording.bind(this));
        }
    }

    // ==================== VOICE (SIMULATED) ====================

    startRecording() {
        this.isRecording = true;
        if (this.normalInput) this.normalInput.style.display = 'none';
        if (this.voiceRecordingBar) this.voiceRecordingBar.style.display = 'flex';
        this.recordingTimer = setTimeout(() => this.stopRecording(), 3000);
    }

    stopRecording() {
        if (!this.isRecording) return;
        clearTimeout(this.recordingTimer);
        this.isRecording = false;
        if (this.voiceRecordingBar) this.voiceRecordingBar.style.display = 'none';
        if (this.normalInput) this.normalInput.style.display = 'flex';
        if (this.messageInput) {
            this.messageInput.value = 'This is a simulated voice transcription.';
            this.messageInput.style.height = 'auto';
            this.messageInput.focus();
        }
    }
}