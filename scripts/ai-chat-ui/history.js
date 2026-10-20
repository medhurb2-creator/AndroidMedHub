// scripts/ai-chat-ui/history.js
/**
 * Sidebar chat history — the list of the user's conversations.
 *
 * ── Scope ────────────────────────────────────────────────────────────
 * This module owns everything about the chat history panel:
 *
 *   1. RENDERING    — building the `<li>` rows with title, dots menu,
 *                     and the "active" highlight for the currently-
 *                     open chat.
 *
 *   2. SORTING      — pinned chats float to the top, then the rest
 *                     in descending `updatedAt` order. Pinned chats
 *                     also sort internally by `updatedAt` (so the
 *                     most recent pinned chat is at the top of the
 *                     pinned group).
 *
 *   3. FILTERING    — case-insensitive substring match against the
 *                     chat title. Empty filter → show all.
 *
 *   4. MENU ACTIONS — Pin / Delete / Share. Pin and Delete call
 *                     through to `ai.*` and reload the list. Share
 *                     opens the share modal via `chat._openShareModal`
 *                     and does NOT reload the list (the modal is a
 *                     separate layer).
 *
 *   5. EMPTY STATES — "No chats yet" for a new user, and
 *                     "No chats match …" when the filter excludes
 *                     everything.
 *
 *   6. ACCESSIBILITY — every interactive element is keyboard-
 *                     focusable, has an `aria-label`, and responds
 *                     to Enter / Space. The dots button toggles
 *                     `aria-expanded`. Menu items are
 *                     `role="menuitem"` and receive proper keyboard
 *                     handling.
 *
 * ── Interaction with shared view ─────────────────────────────────────
 * Clicking a chat title calls `chat.loadChatUI(id)`, which starts
 * with `chat._ensureNotShared()` — so being in a shared view and
 * clicking one of your own chats silently exits shared view and
 * loads the clicked chat. This module does NOT need to know about
 * shared state; that concern is fully owned by `loadChatUI` and
 * `share.js`.
 *
 * Menu actions (Pin / Delete / Share) also work while in shared
 * view. Being in shared view just means `chat.currentChatId` is
 * `null`, so the "active" highlight doesn't appear and the
 * delete-current-chat reset path doesn't fire.
 *
 * ── Deletion while the deleted chat is current ───────────────────────
 * If the user deletes the chat they're currently viewing
 * (`chat.currentChatId === item.id`), we reset the view to the
 * welcome state so the user doesn't end up staring at a chat that
 * no longer exists in the sidebar.
 *
 * ── Empty-state rendering ────────────────────────────────────────────
 * The empty-state uses an inline-styled `<li>` so it works
 * regardless of whether the page's CSS defines a `.history-empty`
 * rule. This is a deliberate choice — the empty state is a
 * transient one-line message, and its visual consistency with the
 * rest of the sidebar matters less than its guaranteed visibility.
 *
 * ── Public API ───────────────────────────────────────────────────────
 *   renderChatHistory(chat, filterText = '')
 *
 * That's it. Everything else is a private helper.
 */

import * as ui from '../ui.js';
import ai from '../ai.js';
import { escapeHtml } from './markdown.js';

// ==================== PUBLIC API ====================

/**
 * Render the sidebar chat history.
 *
 * Called by `chat.loadChats()` after every data refresh (initial
 * load, pin/unpin, delete, new chat created, active chat changed).
 *
 * Idempotent: clears the list before populating. Safe to call with
 * an empty `chat.chats` array — renders the appropriate empty state.
 *
 * @param {object} chat         the AIChatUI instance
 * @param {string} [filterText] search term; empty → show all chats
 */
export function renderChatHistory(chat, filterText = '') {
    if (!chat || !chat.chatHistoryList) return;

    const list = chat.chatHistoryList;
    const filter = String(filterText || '').trim();
    const filterLower = filter.toLowerCase();

    // ── Filter ──────────────────────────────────────────────────
    const filtered = filterLower
        ? chat.chats.filter((c) =>
            String(c.title || '').toLowerCase().includes(filterLower))
        : chat.chats.slice();

    // ── Sort ────────────────────────────────────────────────────
    // Pinned first, then descending updatedAt. Use a stable sort so
    // that equal updatedAt values preserve the original order.
    filtered.sort((a, b) => {
        const ap = a.pinned ? 1 : 0;
        const bp = b.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    // ── Empty states ────────────────────────────────────────────
    if (filtered.length === 0) {
        list.innerHTML = '';
        const li = document.createElement('li');
        li.className = 'history-empty';
        li.style.cssText = 'padding:20px;text-align:center;color:var(--text-muted);font-size:0.9rem;';
        li.textContent = filter
            ? `No chats match "${filter}"`
            : 'No chats yet';
        list.appendChild(li);
        return;
    }

    // ── Render ──────────────────────────────────────────────────
    list.innerHTML = '';
    for (const item of filtered) {
        list.appendChild(_buildHistoryItem(chat, item));
    }
}

// ==================== PRIVATE HELPERS ====================

/**
 * Build one row of the history list: title + dots menu.
 *
 * @private
 * @param {object} chat
 * @param {object} item  a chat object from `chat.chats`
 * @returns {HTMLLIElement}
 */
function _buildHistoryItem(chat, item) {
    const li = document.createElement('li');
    const isActive = chat.currentChatId === item.id;
    li.className = `history-item${item.pinned ? ' pinned' : ''}${isActive ? ' active' : ''}`;
    li.dataset.id = item.id;

    // ── Title (clickable) ───────────────────────────────────────
    // Wrapped in a `<button>` so keyboard users can Tab to it and
    // press Enter/Space to open the chat. The visual style comes
    // from `.chat-title` (unchanged) — the button wrapper is
    // styled inline to strip the default browser appearance.
    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'chat-title';
    titleBtn.style.cssText = `
        background: transparent;
        border: none;
        padding: 0;
        font: inherit;
        color: inherit;
        text-align: left;
        cursor: pointer;
        width: 100%;
    `.trim().replace(/\s+/g, ' ');
    titleBtn.textContent = item.title || 'Untitled';
    titleBtn.setAttribute('aria-label', `Open chat: ${item.title || 'Untitled'}`);
    titleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        chat.loadChatUI(item.id);
    });

    // ── Menu ────────────────────────────────────────────────────
    const menu = _buildMenu(chat, item);

    li.appendChild(titleBtn);
    li.appendChild(menu);
    return li;
}

/**
 * Build the per-item menu container: dots button + dropdown with
 * Pin / Delete / Share.
 *
 * Accessibility:
 *   • Dots button: `role="button"` (applied via `tabindex` +
 *     `aria-label`), toggles `aria-expanded`, is focusable, and
 *     responds to Enter/Space.
 *   • Menu items: `role="menuitem"` + `tabindex="0"`, respond to
 *     Enter/Space (they're divs — the existing CSS styles divs
 *     inside `.dropdown-menu`, so we keep them as divs to avoid
 *     touching the stylesheet).
 *   • The dropdown itself has `role="menu"`.
 *
 * @private
 * @param {object} chat
 * @param {object} item
 * @returns {HTMLDivElement}
 */
function _buildMenu(chat, item) {
    const menuContainer = document.createElement('div');
    menuContainer.className = 'item-menu';

    // ── Dots button ─────────────────────────────────────────────
    const dots = document.createElement('i');
    dots.className = 'fas fa-ellipsis-v menu-dots';
    dots.setAttribute('role', 'button');
    dots.setAttribute('tabindex', '0');
    dots.setAttribute('aria-label', `Menu for chat: ${item.title || 'Untitled'}`);
    dots.setAttribute('aria-haspopup', 'menu');
    dots.setAttribute('aria-expanded', 'false');

    const toggleMenu = (e) => {
        e.stopPropagation();
        // Close any other open menu first.
        document.querySelectorAll('.dropdown-menu.show').forEach((m) => {
            m.classList.remove('show');
        });
        const isOpen = dropdown.classList.toggle('show');
        dots.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    };

    dots.addEventListener('click', toggleMenu);
    dots.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleMenu(e);
        }
    });

    // ── Dropdown ────────────────────────────────────────────────
    const dropdown = document.createElement('div');
    dropdown.className = 'dropdown-menu';
    dropdown.setAttribute('role', 'menu');

    const pinItem = _buildMenuItem({
        icon: 'fas fa-thumbtack',
        label: item.pinned ? 'Unpin' : 'Pin',
        onActivate: async () => {
            _closeDropdown(dropdown, dots);
            await ai.pinChat(item.id);
            await chat.loadChats();
        },
    });

    const deleteItem = _buildMenuItem({
        icon: 'fas fa-trash',
        label: 'Delete',
        onActivate: async () => {
            _closeDropdown(dropdown, dots);
            const confirmed = await ui.showConfirmationDialog(
                'Delete Chat',
                `Delete "${item.title || 'this chat'}"? This cannot be undone.`,
                'warning'
            );
            if (!confirmed) return;
            if (chat.currentChatId === item.id) {
                chat.resetToWelcome();
                chat.currentChatId = null;
            }
            await ai.deleteChat(item.id);
            await chat.loadChats();
            ui.showToast('Chat deleted', 'success');
        },
    });

    const shareItem = _buildMenuItem({
        icon: 'fas fa-share-alt',
        label: 'Share',
        onActivate: async () => {
            _closeDropdown(dropdown, dots);
            await chat._openShareModal(item.id);
        },
    });

    dropdown.appendChild(pinItem);
    dropdown.appendChild(deleteItem);
    dropdown.appendChild(shareItem);

    menuContainer.appendChild(dots);
    menuContainer.appendChild(dropdown);
    return menuContainer;
}

/**
 * Build one entry in the dropdown menu.
 *
 * Uses `<div>` (not `<button>`) because the existing CSS targets
 * `.dropdown-menu div` — switching to `<button>` would require a
 * CSS change. Keyboard handling is added manually so the div
 * behaves like a button for accessibility purposes.
 *
 * @private
 * @param {{ icon: string, label: string, onActivate: () => void | Promise<void> }} opts
 * @returns {HTMLDivElement}
 */
function _buildMenuItem({ icon, label, onActivate }) {
    const el = document.createElement('div');
    el.setAttribute('role', 'menuitem');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', label);

    const iconEl = document.createElement('i');
    iconEl.className = icon;
    el.appendChild(iconEl);
    el.appendChild(document.createTextNode(' ' + label));

    const activate = (e) => {
        e.stopPropagation();
        Promise.resolve()
            .then(onActivate)
            .catch((err) => {
                console.error(`[history] menu action "${label}" failed:`, err);
                ui.showToast(err?.message || `${label} failed`, 'error');
            });
    };

    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate(e);
        }
    });

    return el;
}

/**
 * Close a dropdown and reset its dots button's `aria-expanded`.
 *
 * @private
 */
function _closeDropdown(dropdown, dots) {
    dropdown.classList.remove('show');
    dots.setAttribute('aria-expanded', 'false');
}