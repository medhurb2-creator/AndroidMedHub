// scripts/notes-ui.js
import * as notes from './notes.js';
import * as ui from './ui.js';
import * as utils from './utils.js';
import * as auth from './auth.js';
import * as router from './router.js';
import * as db from './db.js';
// --- PDF engine imports ---
import { buildNotesHTML, printDocument } from './pdf-engine.js';

// Fallback – if the module system didn't deliver the function (cache issue), use the global window version
const safePrintDocument = typeof printDocument === 'function' ? printDocument : window.printDocument;
const safeBuildNotesHTML = typeof buildNotesHTML === 'function' ? buildNotesHTML : window.buildNotesHTML;

let quill = null;
let currentNoteId = null;
let pendingPassword = null;
let currentFilter = 'all';

// ==================== CUSTOM PROMPT ====================

function showPromptDialog(title, message, defaultValue = '') {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="modal" style="max-width: 400px;">
                <div class="modal-header">
                    <h3>${title}</h3>
                    <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    ${message ? `<p style="margin-bottom:0.75rem; color:var(--text-secondary);">${message}</p>` : ''}
                    <input type="text" id="prompt-input" value="${defaultValue}" style="width:100%; padding:0.5rem; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-secondary); color:var(--text-primary);">
                </div>
                <div class="modal-footer" style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:1rem;">
                    <button class="btn-secondary" id="prompt-cancel">Cancel</button>
                    <button class="btn-primary" id="prompt-confirm">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = overlay.querySelector('#prompt-input');
        const confirmBtn = overlay.querySelector('#prompt-confirm');
        const cancelBtn = overlay.querySelector('#prompt-cancel');

        const close = (value) => {
            overlay.remove();
            resolve(value);
        };

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                close(input.value);
            }
        });
        confirmBtn.addEventListener('click', () => close(input.value));
        cancelBtn.addEventListener('click', () => close(null));
        overlay.querySelector('.modal-close').addEventListener('click', () => close(null));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(null);
        });
        input.focus();
        input.select();
    });
}

// ==================== CUSTOM ALERT ====================

function showAlertDialog(title, message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="modal" style="max-width: 400px;">
                <div class="modal-header">
                    <h3>${title}</h3>
                    <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <p style="color:var(--text-secondary);">${message}</p>
                </div>
                <div class="modal-footer" style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:1rem;">
                    <button class="btn-primary" id="alert-confirm">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const confirmBtn = overlay.querySelector('#alert-confirm');
        const close = () => {
            overlay.remove();
            resolve();
        };

        confirmBtn.addEventListener('click', close);
        overlay.querySelector('.modal-close').addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
    });
}

// ==================== CUSTOM SHARE LINK DIALOG ====================

function showShareLinkDialog(link) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.style.display = 'flex';
        overlay.innerHTML = `
            <div class="modal" style="max-width: 400px;">
                <div class="modal-header">
                    <h3>🔗 Share Link</h3>
                    <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">&times;</button>
                </div>
                <div class="modal-body">
                    <p style="margin-bottom:0.75rem; color:var(--text-secondary);">Anyone with this link can view the note.</p>
                    <div style="display:flex; gap:0.5rem;">
                        <input type="text" id="share-link-input" value="${link}" readonly style="flex:1; padding:0.5rem; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-secondary); color:var(--text-primary); cursor:default;">
                        <button class="btn-secondary" id="copy-link-btn" style="white-space:nowrap;">📋 Copy</button>
                    </div>
                </div>
                <div class="modal-footer" style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:1rem;">
                    <button class="btn-primary" id="share-close-btn">Done</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const copyBtn = overlay.querySelector('#copy-link-btn');
        const input = overlay.querySelector('#share-link-input');
        const closeBtn = overlay.querySelector('#share-close-btn');
        const closeModal = overlay.querySelector('.modal-close');

        const close = () => {
            overlay.remove();
            resolve();
        };

        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(link);
                copyBtn.textContent = '✅ Copied!';
                setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
            } catch (err) {
                // Fallback: select the text manually
                input.select();
                input.setSelectionRange(0, 99999);
                document.execCommand('copy');
                copyBtn.textContent = '✅ Copied!';
                setTimeout(() => { copyBtn.textContent = '📋 Copy'; }, 2000);
            }
        });

        closeBtn.addEventListener('click', close);
        closeModal.addEventListener('click', close);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        input.focus();
        input.select();
    });
}

// ==================== Initialization ====================

export function initNotesPage() {
    if (!auth.checkAuth()) {
        router.navigateTo('login');
        return;
    }

    if (window.Quill) {
        quill = new Quill('#noteContent', {
            theme: 'snow',
            modules: {
                toolbar: [
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ 'color': [] }, { 'background': [] }],
                    [{ 'font': [] }],
                    [{ 'size': ['small', false, 'large', 'huge'] }],
                    [{ 'list': 'ordered' }, { 'list': 'bullet' }],
                    ['link', 'image', 'video'],
                    ['clean']
                ]
            },
            placeholder: 'Write your note here...'
        });
    }

    setupEventListeners();
    renderNotesList();
    updateHistoryPanel();
}

function setupEventListeners() {
    const searchInput = document.getElementById('searchNotes');
    if (searchInput) {
        searchInput.addEventListener('input', utils.debounce(e => searchNotes(e.target.value), 300));
    }
}

// ==================== History Panel ====================

export async function updateHistoryPanel() {
    const container = document.getElementById('historyList');
    if (!container) return;

    try {
        const userNotes = await notes.getUserNotes();
        const recent = userNotes.slice(0, 10);

        if (recent.length === 0) {
            container.innerHTML = '<div class="history-empty">No notes yet</div>';
            return;
        }

        container.innerHTML = recent.map(note => {
            const date = utils.formatDate(note.updatedAt, 'short');
            const title = note.title || 'Untitled';
            return `
                <div class="history-item" data-id="${note.id}">
                    <div class="date">${date}</div>
                    <div>${title}</div>
                </div>
            `;
        }).join('');

        container.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', () => {
                openNoteForEditing(item.dataset.id);
                document.getElementById('historyPanel').classList.remove('open');
            });
        });
    } catch (err) {
        container.innerHTML = '<div class="history-error">Could not load history</div>';
    }
}

// ==================== Notes Grid ====================

export async function renderNotesList(notesList = null) {
    const container = document.getElementById('notesGrid');
    if (!container) return;

    try {
        const userNotes = notesList || await notes.getUserNotes();

        if (!userNotes || userNotes.length === 0) {
            container.innerHTML = '<div class="no-data">No notes yet. Click + to create one.</div>';
            return;
        }

        container.innerHTML = userNotes.map(note => {
            const date = utils.formatDate(note.updatedAt, 'short');
            const plainText = note.plainText || note.content.replace(/<[^>]*>/g, '');
            const preview = plainText.substring(0, 60) + (plainText.length > 60 ? '…' : '');
            const lockIcon = note.isProtected ? '🔒' : '';
            return `
                <div class="note-card" data-id="${note.id}">
                    <div class="card-title">
                        <span class="note-title-text">${lockIcon} ${note.title || 'Untitled'}</span>
                        <span class="card-menu" data-id="${note.id}">⋮</span>
                    </div>
                    <div class="card-body">${preview}</div>
                    <div class="card-date">${date}</div>
                </div>
            `;
        }).join('');

        document.querySelectorAll('.note-card').forEach(card => {
            card.addEventListener('click', (e) => {
                if (!e.target.classList.contains('card-menu')) openNoteForEditing(card.dataset.id);
            });
        });

        document.querySelectorAll('.card-menu').forEach(menu => {
            menu.addEventListener('click', (e) => {
                e.stopPropagation();
                const rect = menu.getBoundingClientRect();
                showNoteContextMenu(menu.dataset.id, rect.right, rect.bottom);
            });
        });
    } catch (err) {
        container.innerHTML = '<div class="no-data">Failed to load notes.</div>';
    }
}

// ==================== Context Menu ====================

function showNoteContextMenu(noteId, x, y) {
    const old = document.getElementById('note-context-menu');
    if (old) old.remove();

    const menu = document.createElement('div');
    menu.id = 'note-context-menu';
    
    menu.innerHTML = `
        <div class="context-item" data-action="open">📂 Open</div>
        <div class="context-item" data-action="rename">✏️ Rename</div>
        <div class="context-item" data-action="delete">🗑️ Delete</div>
        <div class="context-item" data-action="share">🔗 Share</div>
        <div class="context-item" data-action="export-pdf">📄 Export PDF</div>
        <div class="context-item" data-action="toggle-lock">🔒 Lock/Unlock</div>
        <div class="context-item" data-action="duplicate">📋 Duplicate</div>
        <div class="context-item" data-action="flashcards">🃏 Flashcards</div>
        <div class="context-item" data-action="summarize">✨ Summarize</div>
    `;

    document.body.appendChild(menu);
    menu.style.visibility = 'hidden';
    menu.style.position = 'fixed';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.zIndex = '1000';
    menu.style.minWidth = '180px';
    menu.style.backgroundColor = 'var(--bg-card)';
    menu.style.border = '1px solid var(--border)';
    menu.style.borderRadius = '8px';
    menu.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';

    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width;
    const menuHeight = menuRect.height;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const PADDING = 10;

    if (x + menuWidth + PADDING > viewWidth) {
        x = viewWidth - menuWidth - PADDING;
    }
    if (y + menuHeight + PADDING > viewHeight) {
        y = viewHeight - menuHeight - PADDING;
    }
    if (x < PADDING) x = PADDING;
    if (y < PADDING) y = PADDING;

    menu.style.visibility = 'visible';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    menu.querySelectorAll('.context-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = item.dataset.action;
            switch (action) {
                case 'open': openNoteForEditing(noteId); break;
                case 'rename': await renameNoteHandler(noteId); break;
                case 'delete': await deleteNoteHandler(noteId); break;
                case 'share': await shareNoteHandler(noteId); break;
                case 'export-pdf': await exportPDFHandler(noteId); break;
                case 'toggle-lock': await toggleLockHandler(noteId); break;
                case 'duplicate': await duplicateNoteHandler(noteId); break;
                case 'flashcards': await generateFlashcardsHandler(noteId); break;
                case 'summarize': await summarizeNoteHandler(noteId); break;
            }
            menu.remove();
        });
    });

    setTimeout(() => {
        window.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                window.removeEventListener('click', closeMenu);
            }
        });
    }, 100);
}

// ==================== Action Handlers ====================

async function deleteNoteHandler(noteId) {
    const confirmed = await ui.showConfirmationDialog('Delete Note', 'Delete this note permanently?', 'critical');
    if (confirmed) {
        await notes.deleteNote(noteId);
        await renderNotesList();
        await updateHistoryPanel();
        ui.showToast('Note deleted', 'success');
    }
}

async function renameNoteHandler(noteId) {
    const note = await notes.getNote(noteId);
    const newTitle = await showPromptDialog('Rename Note', 'Enter new title:', note?.title || '');
    if (newTitle !== null && newTitle.trim()) {
        await notes.updateNote(noteId, { title: newTitle.trim() });
        await renderNotesList();
        await updateHistoryPanel();
        ui.showToast('Note renamed', 'success');
    }
}

async function shareNoteHandler(noteId) {
    try {
        const link = await notes.shareNote(noteId);
        await showShareLinkDialog(link);
    } catch (err) {
        ui.showToast('Failed to create share link', 'error');
    }
}

async function toggleLockHandler(noteId) {
    const pwd = await showPromptDialog('Lock Note', 'Enter password (leave empty to remove protection):', '');
    if (pwd !== null) {
        await notes.updateNote(noteId, { password: pwd || null });
        await renderNotesList();
        ui.showToast(pwd ? 'Note locked' : 'Protection removed', 'success');
    }
}

async function duplicateNoteHandler(noteId) {
    try {
        const note = await notes.getNote(noteId);
        if (!note) return;
        const { id, isProtected, passwordHash, sharedPublic, sharedToken, shareWith, ...rest } = note;
        const newNote = {
            ...rest,
            id: 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            title: note.title + ' (copy)',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            isProtected: false,
            passwordHash: null,
            sharedPublic: false,
            sharedToken: null,
            shareWith: []
        };
        await db.saveNote(newNote);
        await renderNotesList();
        await updateHistoryPanel();
        ui.showToast('Note duplicated', 'success');
    } catch (err) {
        ui.showToast('Duplicate failed', 'error');
    }
}

async function generateFlashcardsHandler(noteId) {
    ui.showLoading('Generating flashcards...');
    try {
        const cards = await notes.generateFlashcards(noteId);
        ui.hideLoading();
        if (cards.length) {
            await showAlertDialog('Flashcards Generated', `Generated ${cards.length} flashcards. Check console.`);
            console.log(cards);
        } else {
            await showAlertDialog('No Flashcards', 'Could not generate flashcards.');
        }
    } catch (err) {
        ui.hideLoading();
        ui.showToast('Flashcard generation failed', 'error');
    }
}

async function summarizeNoteHandler(noteId) {
    ui.showLoading('Summarizing...');
    try {
        const summary = await notes.summarizeNote(noteId);
        ui.hideLoading();
        if (summary) {
            const insert = await ui.showConfirmationDialog('AI Summary', 'Insert summary into note?', 'info');
            if (insert) {
                if (quill) quill.insertText(0, '\n\nAI Summary:\n' + summary);
                else document.getElementById('noteContent').value += '\n\nAI Summary:\n' + summary;
            } else {
                await showAlertDialog('AI Summary', summary);
            }
        }
    } catch (err) {
        ui.hideLoading();
        ui.showToast('Summarization failed', 'error');
    }
}

// ==================== PDF Export Handler (Browser Print) ====================

async function exportPDFHandler(noteId = null) {
    const id = noteId || currentNoteId;
    if (!id) {
        ui.showToast('Save the note first to export PDF', 'error');
        return;
    }
    try {
        ui.showLoading('Preparing PDF...');
        // Wait for custom fonts to finish loading before measuring
        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
        }

        const note = await notes.getNote(id);
        if (!note) throw new Error('Note not found');

        const user = auth.getUser();
        const authorName = user?.name || user?.email || 'MedVix User';
        const exportId = 'MH-' + Math.random().toString(36).substr(2, 6).toUpperCase();

        // Build data object exactly as buildNotesHTML expects
        const pdfData = {
            title: note.title || 'Untitled',
            subject: note.tags?.join(', ') || 'General',
            topic: note.tags?.[0] || '',
            owner: authorName,
            date: new Date(note.createdAt).toLocaleDateString('en-GB'),
            id: exportId,
            contentHTML: note.content || ''   // <-- the actual note HTML goes here
        };

        const html = safeBuildNotesHTML(pdfData);
        ui.hideLoading();
        await safePrintDocument(html);   // uses the fallback if import failed

    } catch (err) {
        ui.hideLoading();
        console.error('PDF export failed:', err);
        ui.showToast('PDF export failed: ' + err.message, 'error');
    }
}

// ==================== Editor Functions ====================

export function openNoteEditor() {
    currentNoteId = null;
    pendingPassword = null;
    document.getElementById('dashboard-view').style.display = 'none';
    document.getElementById('editor-view').style.display = 'flex';
    document.getElementById('noteTitle').value = '';
    if (quill) quill.setText('');
    document.getElementById('noteDate').textContent = new Date().toLocaleDateString('en-GB').replace(/\//g, '.');
}

export async function openNoteForEditing(noteId) {
    const storedPwd = sessionStorage.getItem(`note_pwd_${noteId}`);
    try {
        const note = await notes.getNote(noteId, storedPwd);
        showEditor(note);
    } catch (err) {
        if (err.message === 'Password required' || err.message === 'Incorrect password') {
            const pwd = await showPromptDialog('Password Required', 'This note is password protected. Enter password:', '');
            if (pwd) {
                try {
                    const note = await notes.getNote(noteId, pwd);
                    sessionStorage.setItem(`note_pwd_${noteId}`, pwd);
                    showEditor(note);
                } catch (e) { ui.showToast('Incorrect password', 'error'); }
            }
        } else ui.showToast(err.message, 'error');
    }
}

function showEditor(note) {
    currentNoteId = note.id;
    document.getElementById('dashboard-view').style.display = 'none';
    document.getElementById('editor-view').style.display = 'flex';
    document.getElementById('noteTitle').value = note.title || '';
    if (quill) quill.root.innerHTML = note.content || '';
    document.getElementById('noteDate').textContent = note.updatedAt
        ? utils.formatDate(note.updatedAt, 'full')
        : utils.formatDate(new Date());
}

export async function closeNoteEditor() {
    document.getElementById('dashboard-view').style.display = 'flex';
    document.getElementById('editor-view').style.display = 'none';
    currentNoteId = null;
    pendingPassword = null;
    await renderNotesList();
    await updateHistoryPanel();
}

export async function saveCurrentNote() {
    const title = document.getElementById('noteTitle').value.trim();
    let content = '', plainText = '';
    if (quill) {
        content = quill.root.innerHTML;
        plainText = quill.getText().trim();
    } else {
        content = document.getElementById('noteContent')?.value || '';
        plainText = content;
    }
    if (!plainText && !content) {
        ui.showToast('Note content cannot be empty', 'error');
        return;
    }

    ui.showLoading('Saving...');
    try {
        if (currentNoteId) {
            await notes.updateNote(currentNoteId, { title, content, plainText });
        } else {
            const data = { title, content, plainText };
            if (pendingPassword) {
                data.isProtected = true;
                data.password = pendingPassword;
            }
            const saved = await notes.createNote(data);
            currentNoteId = saved.id;
        }
        ui.showToast('Note saved', 'success');
        await closeNoteEditor();
    } catch (err) {
        ui.showToast('Failed to save note: ' + err.message, 'error');
    } finally {
        ui.hideLoading();
    }
}

// ==================== Editor Top Bar Actions ====================

export function toggleLockCurrent() {
    if (currentNoteId) {
        toggleLockHandler(currentNoteId);
    } else {
        showPromptDialog('Lock Note', 'Enter password to protect this note (leave empty to cancel):', '')
            .then(pwd => {
                if (pwd) {
                    pendingPassword = pwd;
                    ui.showToast('Note will be locked upon saving', 'success');
                } else if (pwd === '') {
                    pendingPassword = null;
                    ui.showToast('Protection removed', 'success');
                }
            });
    }
}

export async function shareCurrentNote() {
    if (!currentNoteId) {
        ui.showToast('Save the note first to share it', 'error');
        return;
    }
    await shareNoteHandler(currentNoteId);
}

export async function exportPDFCurrent() {
    if (!currentNoteId) {
        ui.showToast('Save the note first to export PDF', 'error');
        return;
    }
    await exportPDFHandler(currentNoteId);
}

// ==================== Editor Menu ====================

export function showEditorMenu() {
    if (!currentNoteId) {
        ui.showToast('Save the note first to use these options', 'error');
        return;
    }
    const lastIcon = document.querySelector('.edit-header-right .tool-icon:last-child');
    if (!lastIcon) return;
    const rect = lastIcon.getBoundingClientRect();

    let x = rect.left;
    let y = rect.bottom;

    const menu = document.createElement('div');
    menu.id = 'editor-context-menu';
    menu.innerHTML = `
        <div class="context-item" data-action="duplicate">📋 Duplicate</div>
        <div class="context-item" data-action="flashcards">🃏 Flashcards</div>
        <div class="context-item" data-action="summarize">✨ Summarize</div>
    `;

    document.body.appendChild(menu);
    menu.style.visibility = 'hidden';
    menu.style.position = 'fixed';
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.zIndex = '1000';
    menu.style.minWidth = '160px';
    menu.style.backgroundColor = 'var(--bg-card)';
    menu.style.border = '1px solid var(--border)';
    menu.style.borderRadius = '8px';
    menu.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';

    const menuRect = menu.getBoundingClientRect();
    const menuWidth = menuRect.width;
    const menuHeight = menuRect.height;
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    const PADDING = 10;

    if (x + menuWidth + PADDING > viewWidth) {
        x = viewWidth - menuWidth - PADDING;
    }
    if (y + menuHeight + PADDING > viewHeight) {
        y = viewHeight - menuHeight - PADDING;
    }
    if (x < PADDING) x = PADDING;
    if (y < PADDING) y = PADDING;

    menu.style.visibility = 'visible';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';

    menu.querySelectorAll('.context-item').forEach(item => {
        item.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = item.dataset.action;
            switch (action) {
                case 'duplicate': await duplicateNoteHandler(currentNoteId); break;
                case 'flashcards': await generateFlashcardsHandler(currentNoteId); break;
                case 'summarize': await summarizeNoteHandler(currentNoteId); break;
            }
            menu.remove();
        });
    });

    setTimeout(() => {
        window.addEventListener('click', function closeMenu(e) {
            if (!menu.contains(e.target)) {
                menu.remove();
                window.removeEventListener('click', closeMenu);
            }
        });
    }, 100);
}

// ==================== Filtering & Search ====================

export async function filterNotes(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.remove('active');
        if (tab.dataset.filter === filter) tab.classList.add('active');
    });
    let notesList = await notes.getUserNotes();
    if (filter === 'work') notesList = notesList.filter(n => n.tags?.includes('work'));
    else if (filter === 'personal') notesList = notesList.filter(n => n.tags?.includes('personal'));
    await renderNotesList(notesList);
}

export async function searchNotes(query) {
    if (!query.trim()) {
        await filterNotes(currentFilter);
        return;
    }
    let notesList = await notes.getUserNotes();
    if (currentFilter === 'work') notesList = notesList.filter(n => n.tags?.includes('work'));
    else if (currentFilter === 'personal') notesList = notesList.filter(n => n.tags?.includes('personal'));
    const q = query.toLowerCase();
    const results = notesList.filter(n =>
        n.title.toLowerCase().includes(q) ||
        (n.plainText && n.plainText.toLowerCase().includes(q)) ||
        n.tags.some(tag => tag.toLowerCase().includes(q))
    );
    await renderNotesList(results);
}

// ==================== Share Modal Helpers ====================

export function closeShareModal() {
  const modal = document.getElementById('share-modal');
  if (modal) modal.style.display = 'none';
}

export function copyShareLink() {
  const input = document.getElementById('share-link-input');
  if (!input) return;
  try {
    navigator.clipboard.writeText(input.value);
    ui.showToast('Link copied', 'success');
  } catch (err) {
    // fallback
    input.select();
    input.setSelectionRange(0, 99999);
    document.execCommand('copy');
    ui.showToast('Link copied', 'success');
  }
}

export function shareViaNative() {
  const input = document.getElementById('share-link-input');
  if (!input) return;
  const url = input.value;
  if (navigator.share) {
    navigator.share({ title: 'Shared Note', url }).catch(() => {});
  } else {
    copyShareLink();
  }
}