// scripts/pages/notes.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as notesUI from '../notes-ui.js';

let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ── Auth gate ────────────────────────────────────────────────────
  // Round-trip through login. When the user signs in, login pops the
  // return stack and lands them back here with the notes UI rebuilt.
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to view your notes', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  // ── State adapter ────────────────────────────────────────────────
  // Registered before any redirect can fire. Captures the parts of
  // the notes UI that live in memory only:
  //
  //   • whether the editor is open (view mode vs editor mode)
  //   • which note is being edited (so we can re-open it)
  //   • the active filter tab
  //   • the history panel's open/closed state
  //
  // The search input is already covered by the automatic UI snapshot
  // (it has an id). Note *content* is managed by notesUI and persisted
  // on its own — the adapter only restores the shell around it.
  redirect.registerStateAdapter('notes', {
    capture: () => {
      const editorOpen =
        document.body.classList.contains('editor-open') ||
        document.getElementById('noteEditor')?.classList.contains('active') ||
        document.getElementById('editorView')?.style.display === 'block';

      const activeFilterEl =
        document.querySelector('.filter-tab.active') ||
        document.querySelector('.filter-tab[aria-selected="true"]');

      const historyPanel = document.getElementById('historyPanel');

      return {
        editorOpen,
        // The current note id is exposed by notesUI; guard with
        // optional chaining in case the API shape changes.
        currentNoteId:
          notesUI.getCurrentNoteId?.() ||
          notesUI.currentNoteId ||
          null,
        activeFilter: activeFilterEl ? activeFilterEl.dataset.filter : null,
        historyOpen: !!(historyPanel && historyPanel.classList.contains('open')),
      };
    },

    restore: async (data) => {
      if (!data) return;

      // History panel — cheap, restore first so subsequent UI work
      // lands on top of the right chrome.
      if (data.historyOpen) {
        const panel = document.getElementById('historyPanel');
        if (panel) {
          panel.classList.add('open');
          try { notesUI.updateHistoryPanel?.(); } catch { /* ignore */ }
        }
      }

      // Active filter — drive through notesUI so its internal state
      // stays in sync with the DOM.
      if (data.activeFilter) {
        try { notesUI.filterNotes?.(data.activeFilter); } catch { /* ignore */ }
      }

      // Editor state — only reopen if a note was actually being
      // edited. If notesUI exposes an openNoteEditor(id) we call it
      // with the saved id so the right note is rehydrated. If only
      // a generic openNoteEditor() exists, we call that and let it
      // restore the most-recently-edited note.
      if (data.editorOpen) {
        try {
          if (data.currentNoteId && typeof notesUI.openNoteEditor === 'function') {
            // Try the id-aware variant first.
            const result = notesUI.openNoteEditor(data.currentNoteId);
            if (result && typeof result.catch === 'function') await result;
          } else if (typeof notesUI.openNoteEditor === 'function') {
            const result = notesUI.openNoteEditor();
            if (result && typeof result.catch === 'function') await result;
          }
        } catch (err) {
          console.warn('[Notes] Editor restore failed:', err);
        }
      }
    },
  });

  // Initialize notes UI
  await notesUI.initNotesPage();

  // Expose global functions for legacy inline calls
  window.toggleHistory = toggleHistory;
  window.filterNotes = notesUI.filterNotes;
  window.createNewNote = notesUI.openNoteEditor;
  window.closeEditor = notesUI.closeNoteEditor;
  window.saveNote = notesUI.saveCurrentNote;
  window.toggleLock = notesUI.toggleLockCurrent;
  window.shareCurrentNote = notesUI.shareCurrentNote;
  window.exportPDFCurrent = notesUI.exportPDFCurrent;
  window.showEditorMenu = notesUI.showEditorMenu;
  window.closeShareModal = notesUI.closeShareModal;
  window.copyShareLink = notesUI.copyShareLink;
  window.shareViaNative = notesUI.shareViaNative;

  // Attach event listeners
  attachEventListeners(context);

  // Hide shimmer (body.loaded class is added by notesUI)
  document.body.classList.add('loaded');

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a just-completed round
  // trip. Pop the entry so the stack does not grow on subsequent
  // redirects. Covers the case where the returning page used
  // history.back() instead of consumeAndReturn().
  try {
    const hasSnap = redirect.hasSnapshot();
    if (hasSnap) {
      const myUrl =
        window.location.pathname +
        (window.location.search || '') +
        (window.location.hash || '');
      const top = redirect.peekReturn();
      if (top && top.url === myUrl) redirect.popReturn();
    }
  } catch (err) {
    console.warn('[Notes] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Restores search input value + scroll position + (via the adapter
  // above) editor state, filter tab, and history panel. The adapter's
  // restore is async, so we await the snapshot consumption before
  // declaring init complete.
  //
  // Because the adapter's restore may open the editor (which itself
  // takes a beat to render Quill), we let any pending animation
  // settle with a microtask before logging ready.
  try {
    const snap = redirect.consumeSnapshot();
    if (snap && (snap.ui || snap.page)) {
      ui.showToast('Continuing where you left off', 'info', 1800);
      console.log('[Notes] Resumed from redirect:', {
        fields: Object.keys(snap.ui?.fields || {}).length,
        pageState: snap.page,
      });
    }
  } catch (err) {
    console.warn('[Notes] Snapshot consume failed:', err);
  }

  console.log('[Notes] Initialized');
}

function attachEventListeners(context) {
  // Theme toggle
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // Hamburger (toggle history)
  const hamburgerBtn = $('#hamburgerBtn');
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener('click', toggleHistory);
  }

  // Close history
  const closeHistoryBtn = $('#closeHistoryBtn');
  if (closeHistoryBtn) {
    closeHistoryBtn.addEventListener('click', toggleHistory);
  }

  // Back from editor
  const backEditorBtn = $('#backEditorBtn');
  if (backEditorBtn) {
    backEditorBtn.addEventListener('click', notesUI.closeNoteEditor);
  }

  // Save note
  const saveNoteBtn = $('#saveNoteBtn');
  if (saveNoteBtn) {
    saveNoteBtn.addEventListener('click', notesUI.saveCurrentNote);
  }

  // Lock tool
  const lockTool = $('#lockTool');
  if (lockTool) {
    lockTool.addEventListener('click', notesUI.toggleLockCurrent);
  }

  // Share tool
  const shareTool = $('#shareTool');
  if (shareTool) {
    shareTool.addEventListener('click', notesUI.shareCurrentNote);
  }

  // Export PDF tool
  const exportTool = $('#exportTool');
  if (exportTool) {
    exportTool.addEventListener('click', notesUI.exportPDFCurrent);
  }

  // Menu tool
  const menuTool = $('#menuTool');
  if (menuTool) {
    menuTool.addEventListener('click', notesUI.showEditorMenu);
  }

  // Share modal close
  const closeShareModalBtn = $('#closeShareModalBtn');
  if (closeShareModalBtn) {
    closeShareModalBtn.addEventListener('click', notesUI.closeShareModal);
  }

  // Copy share link
  const copyShareLinkBtn = $('#copyShareLinkBtn');
  if (copyShareLinkBtn) {
    copyShareLinkBtn.addEventListener('click', notesUI.copyShareLink);
  }

  // Share via native
  const shareViaNativeBtn = $('#shareViaNativeBtn');
  if (shareViaNativeBtn) {
    shareViaNativeBtn.addEventListener('click', notesUI.shareViaNative);
  }

  // FAB
  const fabBtn = $('#fabBtn');
  if (fabBtn) {
    fabBtn.addEventListener('click', notesUI.openNoteEditor);
  }

  // Filter tabs
  context.root.querySelectorAll('.filter-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      notesUI.filterNotes(btn.dataset.filter);
    });
  });

  // Search input
  const searchNotes = $('#searchNotes');
  if (searchNotes) {
    searchNotes.addEventListener('input', (e) => {
      notesUI.searchNotes(e.target.value);
    });
  }

  // Navigation links
  const performanceLink = $('#performanceLink');
  if (performanceLink) {
    performanceLink.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigateTo('performance');
    });
  }

  const aiLink = $('#aiLink');
  if (aiLink) {
    aiLink.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigateTo('ai');
    });
  }

  const subjectsLink = $('#subjectsLink');
  if (subjectsLink) {
    subjectsLink.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigateTo('subjects');
    });
  }
}

function toggleHistory() {
  const panel = $('#historyPanel');
  if (panel) {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) {
      notesUI.updateHistoryPanel();
    }
  }
}

export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's DOM.
  try { redirect.unregisterStateAdapter('notes'); } catch { /* ignore */ }
}