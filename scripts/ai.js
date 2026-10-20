// scripts/ai.js
/**
 * AI Module – Convex Integration (Memory Chunks)
 * Provides chat, summarization, flashcards, questions, mnemonics, and more.
 * Supports offline persistence via IndexedDB and syncs with backend when online.
 *
 * Automatic conversation handling:
 * - The engine maintains a `_currentChatId` to reuse the same conversation for follow‑up messages.
 * - The UI can optionally pass a `chatId` to override the current one.
 * - New conversations are created on the backend immediately – no local IDs.
 *
 * Rate limiting:
 * - This module does NOT enforce any frontend rate limit. Message count,
 *   hourly caps, abuse detection, and plan-based quotas are all decided
 *   by the backend. The engine only forwards the request (with the caller's
 *   `modes`) and reports whatever the backend decides.
 * - The backend enforces a rolling 24-hour TOKEN quota (2000 input /
 *   2500 output). When either is exhausted, it returns an error with a
 *   specific message naming the counter and the reset time. This module
 *   propagates that message verbatim so the UI can show it.
 *
 * Modes:
 * - Modes are semantic switches the backend understands: `deepthink`,
 *   `websearch`, `references`. They are always forwarded on both
 *   `sendMessageToAI` and `regenerateResponse`. The engine never filters
 *   or mutates the mode list.
 * - The backend returns mode-attached `richData` (e.g. `sources` from
 *   websearch, `references` from the references mode) plus a `meta`
 *   string summarising the response. This module persists both onto the
 *   assistant message and returns them to the UI.
 *
 * Message lifecycle flags:
 * - A user message that was sent but whose reply never arrived is marked
 *   `failed: true` (persisted). The UI reads this on load to render a Retry
 *   affordance and clears it via `markMessageSuccess` on retry.
 * - Editing a message is modelled as delete-then-resend:
 *   `deleteMessageAndResponse(chatId, timestamp)` removes the original user
 *   bubble and any assistant reply that followed it, after which the UI
 *   re-sends the edited text through the normal path.
 *
 * Conversation loading & offline cache:
 *   Every chat object carries a `messagesLoaded` flag:
 *     • true  — we have this chat's messages locally (either fetched from
 *               the backend previously, or created fresh via
 *               `createEmptyChat` / `saveMessage`, which both start or
 *               maintain a genuinely known set).
 *     • false — the chat exists (metadata came from the backend), but its
 *               message contents have not been fetched yet.
 *
 *   `loadConversationMessages(chatId)`:
 *     • true  → return the cached messages immediately (no network).
 *     • false → fetch from the backend, persist the result to IndexedDB
 *               AND localStorage, set `messagesLoaded = true`, return.
 *
 *   Persistence contract:
 *     • Every message pushed via `saveMessage` is written to IDB + LS.
 *     • Every fetched conversation is written to IDB + LS.
 *     • `loadChats()` reads IDB first, so any chat whose messages have
 *       been fetched at least once remains viewable offline.
 *     • A chat that was NEVER fetched and is opened offline throws a clear
 *       error instead of silently returning an empty array, so the UI can
 *       show "You are offline and this conversation has not been downloaded
 *       yet" rather than a blank screen.
 *
 * Sharing:
 * - `shareConversation(chatId, expiryHours)` creates a share link via the
 *   backend and returns the raw data — typically `{ shareUrl, shareToken }`.
 *   The shareUrl is a path (/ai?ref=shared&token=xxx); callers must anchor
 *   it to their own origin. The AI UI layer (ai-chat-ui.js) always anchors
 *   to https://app.medvix.co.ke via its `_buildShareUrl` helper.
 * - `getSharedConversation(shareToken)` fetches a shared conversation by
 *   token. IMPORTANT: this requires NO authentication — the share token
 *   itself is the credential, so unauthenticated recipients can view the
 *   conversation. Only network access is required.
 */

import * as utils from './utils.js';
import * as ui from './ui.js';
import * as db from './db.js';
import * as auth from './auth.js';
import { convexHttpClient } from './convex-client.js';

// ==================== HELPERS ====================

function getToken() {
  const token = auth.getToken();
  if (!token) throw new Error('Not authenticated');
  return token;
}

function requireOnline() {
  if (!navigator.onLine) {
    throw new Error('You need to be online to perform this action.');
  }
}

// ==================== AI CLASS ====================

class AIEngine {
  constructor() {
    this._cache = {
      chats: null,
    };
    this._currentChatId = null; // the last used conversation ID
  }

  // ==================== CHAT CRUD ====================

  async loadChats() {
    if (this._cache.chats) return this._cache.chats;

    // 1. Load from IndexedDB first (fast, offline)
    let localChats = [];
    try {
      localChats = (await db.getConversations()) || [];
    } catch (e) {
      console.warn('[loadChats] Error reading from IndexedDB:', e);
    }
    if (!localChats.length) {
      const stored = utils.getLocalStorage('ai_chats', []);
      if (stored.length) localChats = stored;
    }

    // 2. If online, fetch from backend and merge
    if (navigator.onLine) {
      try {
        const token = getToken();
        const result = await convexHttpClient.action('conversations/actions:getConversations', {
          token,
          limit: 100,
        });
        if (result.success && result.data && result.data.conversations) {
          const merged = this._mergeChats(localChats, result.data.conversations);
          this._cache.chats = merged;
          await db.saveConversations(merged);
          await this._saveChatsToStorage(merged);
          return merged;
        }
      } catch (err) {
        console.warn('[loadChats] Backend fetch failed, using local only:', err);
      }
    }

    this._cache.chats = localChats;
    return localChats;
  }

  /**
   * Merge local chats with backend metadata.
   *
   * `messagesLoaded` policy:
   *   • Existing local chat — preserved as-is; if it's already `true`
   *     OR it has cached messages, we mark it `true` (we have content).
   *   • New from backend — `false`. The chat exists (metadata came from
   *     the backend), but its message contents haven't been fetched yet.
   *     `loadConversationMessages` will fetch them on first open.
   */
  _mergeChats(local, backend) {
    const map = new Map();
    for (const chat of local) {
      map.set(chat.id, { ...chat });
    }
    for (const bChat of backend) {
      if (map.has(bChat._id)) {
        const existing = map.get(bChat._id);
        const hadContent = Array.isArray(existing.messages) && existing.messages.length > 0;
        map.set(bChat._id, {
          ...existing,
          id: bChat._id,
          title: bChat.title,
          messages: existing.messages || [],
          messagesLoaded: existing.messagesLoaded === true || hadContent,
          pinned: existing.pinned || false,
          createdAt: bChat.createdAt || existing.createdAt,
          updatedAt: bChat.updatedAt || existing.updatedAt,
          synced: true,
          serverId: bChat._id,
        });
      } else {
        map.set(bChat._id, {
          id: bChat._id,
          title: bChat.title,
          messages: [],
          messagesLoaded: false,
          pinned: false,
          createdAt: bChat.createdAt,
          updatedAt: bChat.updatedAt,
          synced: true,
          serverId: bChat._id,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * Load messages for a conversation, with persistence and clear errors.
   */
  async loadConversationMessages(chatId) {
    if (!chatId) throw new Error('No chat ID provided');

    const chats = await this.loadChats();
    const chat = chats.find((c) => c.id === chatId);

    if (!chat) {
      throw new Error('Chat not found');
    }

    // Fast path: messages already loaded — works offline, no network.
    if (chat.messagesLoaded === true) {
      return chat.messages || [];
    }

    // Not loaded yet — need the network to fetch them
    if (!navigator.onLine) {
      throw new Error(
        'You are offline and this conversation has not been downloaded yet.'
      );
    }

    let fetchError = null;
    try {
      const token = getToken();
      const result = await convexHttpClient.action('conversations/actions:getConversation', {
        token,
        conversationId: chatId,
        limit: 200,
      });

      if (!result || !result.success) {
        fetchError = new Error(
          (result && result.message) || 'Failed to load conversation'
        );
      } else {
        const messages = (result.data && result.data.messages) || [];
        chat.messages = messages;
        chat.messagesLoaded = true;
        chat.synced = true;
        this._cache.chats = chats;
        // Persist for offline use — every successfully-fetched chat
        // becomes permanently viewable on this device.
        await db.saveConversations(chats);
        await this._saveChatsToStorage(chats);
        return messages;
      }
    } catch (err) {
      fetchError = err;
    }

    throw fetchError || new Error('Failed to load conversation');
  }

  async createEmptyChat(title = 'New Chat') {
    requireOnline();
    const token = getToken();
    const result = await convexHttpClient.action('conversations/actions:saveConversation', {
      token,
      title,
      messages: [],
    });
    if (!result.success) throw new Error(result.message);
    const serverId = result.data.conversationId;

    const newChat = {
      id: serverId,
      title,
      messages: [],
      // Freshly-created chats are genuinely empty. We know the content
      // (nothing), so mark them as loaded. This prevents a needless
      // fetch on first open.
      messagesLoaded: true,
      pinned: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      synced: true,
      serverId,
    };

    const chats = await this.loadChats();
    chats.unshift(newChat);
    this._cache.chats = chats;
    await db.saveConversations(chats);
    await this._saveChatsToStorage(chats);

    this._currentChatId = serverId;
    return newChat;
  }

  async createChat(title = 'New Chat') {
    return await this.createEmptyChat(title);
  }

  async deleteChat(chatId) {
    let chats = await this.loadChats();
    chats = chats.filter((c) => c.id !== chatId);
    this._cache.chats = chats;
    await db.saveConversations(chats);
    await this._saveChatsToStorage(chats);

    if (navigator.onLine) {
      try {
        const token = getToken();
        await convexHttpClient.action('conversations/actions:deleteConversation', {
          token,
          conversationId: chatId,
        });
      } catch (err) {
        console.warn('[deleteChat] Backend delete failed:', err);
        await db.addToSyncQueue('delete_conversation', { conversationId: chatId });
      }
    }
    if (this._currentChatId === chatId) this._currentChatId = null;
    return true;
  }

  async pinChat(chatId) {
    const chats = await this.loadChats();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) throw new Error('Chat not found');
    chat.pinned = !chat.pinned;
    this._cache.chats = chats;
    await db.saveConversations(chats);
    await this._saveChatsToStorage(chats);
    return chat.pinned;
  }

  // ==================== MESSAGE CRUD ====================

  async saveMessage(payload) {
    const chats = await this.loadChats();
    const chat = chats.find((c) => c.id === payload.chatId);
    if (!chat) {
      console.warn('[saveMessage] Chat not found; will create a new one.');
      const newChat = await this.createEmptyChat('Untitled');
      payload.chatId = newChat.id;
      return this.saveMessage(payload);
    }
    chat.messages.push(payload);
    // Pushing a message means we definitively know this chat's content
    // going forward. Also protects against a scenario where the chat was
    // fetched empty from the backend and we've now added content to it.
    if (chat.messagesLoaded !== true) chat.messagesLoaded = true;
    chat.updatedAt = Date.now();
    if (chat.synced !== false) chat.synced = false;
    this._cache.chats = chats;
    await db.saveConversations(chats);
    await this._saveChatsToStorage(chats);
    return true;
  }

  /**
   * Mark the most recent user message in `chatId` as failed.
   */
  async markLastUserMessageFailed(chatId) {
    if (!chatId) return null;
    try {
      const chats = await this.loadChats();
      const chat = chats.find((c) => c.id === chatId);
      if (!chat) return null;
      for (let i = chat.messages.length - 1; i >= 0; i--) {
        if (chat.messages[i].role === 'user') {
          chat.messages[i].failed = true;
          chat.updatedAt = Date.now();
          this._cache.chats = chats;
          await db.saveConversations(chats);
          await this._saveChatsToStorage(chats);
          return chat.messages[i].timestamp;
        }
      }
      return null;
    } catch (err) {
      console.warn('[markLastUserMessageFailed] error:', err);
      return null;
    }
  }

  /**
   * Clear the failed flag on a specific user message.
   */
  async markMessageSuccess(chatId, timestamp) {
    if (!chatId || timestamp == null) return false;
    try {
      const chats = await this.loadChats();
      const chat = chats.find((c) => c.id === chatId);
      if (!chat) return false;
      const msg = chat.messages.find(
        (m) => m.role === 'user' && m.timestamp === timestamp
      );
      if (!msg) return false;
      msg.failed = false;
      this._cache.chats = chats;
      await db.saveConversations(chats);
      await this._saveChatsToStorage(chats);
      return true;
    } catch (err) {
      console.warn('[markMessageSuccess] error:', err);
      return false;
    }
  }

  /**
   * Delete a user message and the assistant reply that immediately
   * follows it, if any.
   */
  async deleteMessageAndResponse(chatId, timestamp) {
    if (!chatId || timestamp == null) return false;
    try {
      const chats = await this.loadChats();
      const chat = chats.find((c) => c.id === chatId);
      if (!chat) return false;
      const idx = chat.messages.findIndex(
        (m) => m.role === 'user' && m.timestamp === timestamp
      );
      if (idx === -1) return false;
      let deleteCount = 1;
      if (chat.messages[idx + 1] && chat.messages[idx + 1].role === 'assistant') {
        deleteCount = 2;
      }
      chat.messages.splice(idx, deleteCount);
      chat.updatedAt = Date.now();
      chat.synced = false;
      this._cache.chats = chats;
      await db.saveConversations(chats);
      await this._saveChatsToStorage(chats);
      return true;
    } catch (err) {
      console.warn('[deleteMessageAndResponse] error:', err);
      return false;
    }
  }

  // ==================== SEND ====================

  /**
   * Send a user message and receive the assistant reply.
   *
   * No rate limiting is performed here. `modes` is forwarded verbatim to
   * the backend. If the backend rejects the request (subscription,
   * backend-side daily token quota, model error), the error is thrown and
   * the just-saved user message is flagged `failed: true` so the UI can
   * offer Retry.
   *
   * The backend may return mode-specific rich data (e.g. `sources` from
   * websearch, `references` from the references mode), a `meta` string
   * summarising the response, and a `usage` object with the input/output
   * token counts for this turn. All three are:
   *   • persisted onto the assistant message for offline display
   *   • returned to the caller so the UI can render the meta bar and
   *     rich-data cards immediately
   */
  async sendMessageToAI({ message, chatId, modes = [], file = null }) {
    let effectiveChatId = chatId || this._currentChatId;
    let chat = null;

    if (effectiveChatId) {
      const chats = await this.loadChats();
      chat = chats.find((c) => c.id === effectiveChatId);
      if (!chat) {
        effectiveChatId = null;
      }
    }

    if (!effectiveChatId) {
      const title =
        message.length > 30 ? message.slice(0, 30) + '...' : message;
      const newChat = await this.createEmptyChat(title);
      effectiveChatId = newChat.id;
      chat = newChat;
      this._currentChatId = effectiveChatId;
    }

    // Save the user message BEFORE the network call so a failure still
    // leaves the user's intent on screen and persisted.
    await this.saveMessage({
      chatId: effectiveChatId,
      role: 'user',
      content: message,
      fileData: file ? { name: file.name, type: file.type } : null,
      timestamp: Date.now(),
    });

    try {
      const token = getToken();
      const result = await convexHttpClient.action('conversations/actions:sendMessage', {
        token,
        conversationId: effectiveChatId,
        message,
        // Modes are forwarded verbatim. The engine never filters them.
        modes: Array.isArray(modes) ? modes : [],
      });

      if (!result.success) {
        if (result.error === 'subscription_required') {
          throw new Error(result.message || 'Active subscription required');
        }
        if (result.error === 'rate_limit_exceeded') {
          // The backend names the exhausted counter and the reset time
          // (e.g. "You've reached your daily input token limit. Resets
          // in 5 hours."). Use that message verbatim — it's far more
          // useful than a generic "too many requests".
          throw new Error(result.message || 'Daily AI quota reached.');
        }
        throw new Error(result.message || 'AI request failed');
      }

      // Pull meta, richData, and usage out of the backend response.
      // These carry the mode-attached cards (sources, references),
      // the meta bar text, and the token counts.
      const backendData = result.data || {};
      const answer = backendData.message;
      const meta = backendData.meta || null;
      const richData = backendData.richData || null;
      const usage = backendData.usage || null;

      // Persist the assistant message WITH its meta/richData/usage so
      // the meta bar and rich cards survive a page reload and remain
      // viewable offline.
      await this.saveMessage({
        chatId: effectiveChatId,
        role: 'assistant',
        content: answer,
        meta,
        richData,
        usage,
        timestamp: Date.now(),
      });

      chat.synced = true;
      const chats = await this.loadChats();
      await db.saveConversations(chats);
      await this._saveChatsToStorage(chats);
      this._cache.chats = chats;
      this._currentChatId = effectiveChatId;

      return {
        text: answer,
        chatId: effectiveChatId,
        meta,
        richData,
        usage,
      };
    } catch (err) {
      console.error('sendMessageToAI error:', err);
      try {
        await this.markLastUserMessageFailed(effectiveChatId);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  // ==================== REGENERATE ====================

  /**
   * Regenerate the assistant reply for the last exchange in `chatId`.
   */
  async regenerateResponse({ chatId, modes }) {
    if (!chatId) throw new Error('No conversation ID provided.');
    const chats = await this.loadChats();
    const chat = chats.find((c) => c.id === chatId);
    if (!chat) throw new Error('Chat not found');

    let lastUserMsg = null;
    let lastAssistantIndex = -1;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      if (chat.messages[i].role === 'assistant' && lastAssistantIndex === -1) {
        lastAssistantIndex = i;
      }
      if (chat.messages[i].role === 'user' && !lastUserMsg) {
        lastUserMsg = chat.messages[i];
        break;
      }
    }
    if (!lastUserMsg) throw new Error('No user message to regenerate from');
    if (lastAssistantIndex !== -1) {
      chat.messages.splice(lastAssistantIndex, 1);
    }
    this._cache.chats = chats;
    await db.saveConversations(chats);
    await this._saveChatsToStorage(chats);

    try {
      const token = getToken();
      const result = await convexHttpClient.action('conversations/actions:sendMessage', {
        token,
        conversationId: chatId,
        message: lastUserMsg.content,
        // Forward modes on regenerate too — parity with sendMessageToAI.
        modes: Array.isArray(modes) ? modes : [],
      });

      if (!result.success) {
        if (result.error === 'subscription_required') {
          throw new Error(result.message || 'Active subscription required');
        }
        if (result.error === 'rate_limit_exceeded') {
          throw new Error(result.message || 'Daily AI quota reached.');
        }
        throw new Error(result.message || 'Regenerate failed');
      }

      // Same passthrough as sendMessageToAI — meta, richData, usage.
      const backendData = result.data || {};
      const answer = backendData.message;
      const meta = backendData.meta || null;
      const richData = backendData.richData || null;
      const usage = backendData.usage || null;

      await this.saveMessage({
        chatId,
        role: 'assistant',
        content: answer,
        meta,
        richData,
        usage,
        timestamp: Date.now(),
      });
      chat.synced = true;
      await db.saveConversations(chats);
      await this._saveChatsToStorage(chats);
      this._cache.chats = chats;

      return { text: answer, chatId, meta, richData, usage };
    } catch (err) {
      console.error('regenerateResponse error:', err);
      throw err;
    }
  }

  // ==================== SHARING ====================

  /**
   * Create a share link for a conversation.
   */
  async shareConversation(chatId, expiryHours = 24) {
    if (!chatId) throw new Error('No conversation ID provided.');
    requireOnline();
    const token = getToken();

    const result = await convexHttpClient.action(
      'conversations/actions:shareConversation',
      {
        token,
        conversationId: chatId,
        expiryHours,
      },
    );

    if (!result || !result.success) {
      throw new Error(
        (result && result.message) || 'Failed to create share link',
      );
    }

    return result.data;
  }

  /**
   * Fetch a conversation from a share token, for read-only display.
   */
  async getSharedConversation(shareToken) {
    if (!shareToken) throw new Error('No share token provided.');
    requireOnline();

    const result = await convexHttpClient.action(
      'conversations/queries:getSharedConversation',
      { shareToken },
    );

    if (!result || !result.success) {
      throw new Error(
        (result && result.message) ||
        'This share link may have expired or been revoked.',
      );
    }

    const data = result.data || {};
    const conversationMeta = data.conversation || {};
    const messages = Array.isArray(data.messages) ? data.messages : [];

    if (messages.length === 0) {
      throw new Error('Shared conversation is empty.');
    }

    return {
      ...conversationMeta,
      messages,
      nextCursor: data.nextCursor || null,
      hasMore: data.hasMore === true,
    };
  }

  // ==================== OTHER AI ACTIONS ====================

  async summarizeText(text) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Summarizing...');
    try {
      const result = await convexHttpClient.action('ai/actions:summarizeText', {
        token,
        text,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.summary;
    } catch (err) {
      console.error('Summarize failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async generateFlashcards(text, count = 5) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Generating flashcards...');
    try {
      const result = await convexHttpClient.action('ai/actions:generateFlashcards', {
        token,
        text,
        count,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.flashcards;
    } catch (err) {
      console.error('Flashcard generation failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async generateQuestions(topic, count = 5) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Generating questions...');
    try {
      const result = await convexHttpClient.action('ai/actions:generateQuestions', {
        token,
        topic,
        count,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.questions;
    } catch (err) {
      console.error('Question generation failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async getMnemonics(medicalTerm) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Generating mnemonic...');
    try {
      const result = await convexHttpClient.action('ai/actions:getMnemonics', {
        token,
        medicalTerm,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.mnemonic;
    } catch (err) {
      console.error('Mnemonic generation failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async suggestTags(text) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Suggesting tags...');
    try {
      const result = await convexHttpClient.action('ai/actions:suggestTags', {
        token,
        text,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.tags;
    } catch (err) {
      console.error('Tag suggestion failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async explainTopic(topic) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Explaining topic...');
    try {
      const result = await convexHttpClient.action('ai/actions:explainTopic', {
        token,
        topic,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.explanation;
    } catch (err) {
      console.error('Topic explanation failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async deepthink(question) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Deep thinking...');
    try {
      const result = await convexHttpClient.action('ai/actions:deepthink', {
        token,
        question,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.answer;
    } catch (err) {
      console.error('DeepThink failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async searchWeb(query) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Searching web...');
    try {
      const result = await convexHttpClient.action('ai/actions:searchWeb', {
        token,
        query,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.result;
    } catch (err) {
      console.error('Web search failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async getReferences(topic) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Fetching references...');
    try {
      const result = await convexHttpClient.action('ai/actions:getReferences', {
        token,
        topic,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.references;
    } catch (err) {
      console.error('References retrieval failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async analyzeImage(imageUrl, prompt = '') {
    requireOnline();
    const token = getToken();
    ui.showLoading('Analyzing image...');
    try {
      const result = await convexHttpClient.action('ai/actions:analyzeImage', {
        token,
        imageUrl,
        prompt,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.analysis;
    } catch (err) {
      console.error('Image analysis failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async analyzeDocument(documentUrl, prompt = '') {
    requireOnline();
    const token = getToken();
    ui.showLoading('Analyzing document...');
    try {
      const result = await convexHttpClient.action('ai/actions:analyzeDocument', {
        token,
        documentUrl,
        prompt,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.analysis;
    } catch (err) {
      console.error('Document analysis failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async transcribeAudio(audioUrl) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Transcribing audio...');
    try {
      const result = await convexHttpClient.action('ai/actions:transcribeAudio', {
        token,
        audioUrl,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.transcript;
    } catch (err) {
      console.error('Audio transcription failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async generateExamQuestions(subject, count = 10) {
    requireOnline();
    const token = getToken();
    ui.showLoading('Generating exam questions...');
    try {
      const result = await convexHttpClient.action('ai/actions:generateExamQuestions', {
        token,
        subject,
        count,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.questions;
    } catch (err) {
      console.error('Exam question generation failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  async autoGradeEssay(essay, rubric = '') {
    requireOnline();
    const token = getToken();
    ui.showLoading('Grading essay...');
    try {
      const result = await convexHttpClient.action('ai/actions:autoGradeEssay', {
        token,
        essay,
        rubric,
      });
      if (!result.success) throw new Error(result.message);
      return result.data.grade;
    } catch (err) {
      console.error('Essay grading failed:', err);
      throw err;
    } finally {
      ui.hideLoading();
    }
  }

  // ==================== PERSISTENCE HELPERS ====================

  async _saveChatsToStorage(chats) {
    utils.setLocalStorage('ai_chats', chats);
  }

  async clearAllData() {
    utils.removeLocalStorage('ai_chats');
    utils.removeLocalStorage('ai_usage_count');
    await db.clearConversations();
    this._cache.chats = null;
    this._currentChatId = null;
  }

  // ==================== FILE UPLOAD (UI-ONLY STUB) ====================

  async uploadFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve({
          name: file.name,
          type: file.type,
          data: reader.result,
          url: null,
        });
      };
      reader.readAsDataURL(file);
    });
  }

  // ==================== MISC ====================

  async refreshChats() {
    this._cache.chats = null;
    return this.loadChats();
  }

  getCurrentChatId() {
    return this._currentChatId;
  }
}

// ==================== SINGLETON EXPORT ====================

const ai = new AIEngine();
export default ai;