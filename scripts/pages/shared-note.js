// scripts/pages/shared-note.js
import * as ui from '../ui.js';
import * as utils from '../utils.js';
import * as db from '../db.js';
import * as auth from '../auth.js';
import * as notes from '../notes.js';
import * as router from '../router.js';

let $;

// ==================== CANONICAL DOMAIN ====================
// Always use the production domain for share links,
// regardless of where the app is currently running.
const SHARE_BASE_URL = 'https://app.medvix.co.ke';

function buildShareUrl(token) {
  if (!token) return SHARE_BASE_URL;
  return `${SHARE_BASE_URL}/shared-note?token=${encodeURIComponent(token)}`;
}

// ==================== NATIVE SHARE + FALLBACKS ====================
function nativeShare(shareData) {
  const data = {
    title: shareData.title || 'MedVix Note',
    text: shareData.text || '',
    url: shareData.url || '',
    dialogTitle: shareData.dialogTitle || 'Share'
  };

  // 1. Prefer custom MedvixShare plugin
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.MedvixShare) {
    window.Capacitor.Plugins.MedvixShare.share(data)
      .catch(() => fallbackShare(data));
  }
  // 2. Web Share API
  else if (navigator.share) {
    navigator.share(data).catch(() => fallbackShare(data));
  }
  // 3. Final fallback: copy to clipboard
  else {
    fallbackShare(data);
  }
}

function fallbackShare(shareData) {
  const url = shareData.url || shareData.text || '';
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      ui.showToast('Link copied to clipboard!', 'success');
    }).catch(() => {
      fallbackCopy(url);
    });
  } else {
    fallbackCopy(url);
  }
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    const success = document.execCommand('copy');
    if (success) {
      ui.showToast('Link copied to clipboard!', 'success');
    } else {
      ui.showToast('Failed to copy link. Please copy manually.', 'error');
    }
  } catch (e) {
    ui.showToast('Failed to copy link. Please copy manually.', 'error');
  }
  document.body.removeChild(textarea);
}

// ==================== INIT ====================
export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // Navigation links (clean URLs)
  const subjectsNav = $('#subjectsNav');
  if (subjectsNav) {
    subjectsNav.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigateTo('subjects');
    });
  }
  const performanceNav = $('#performanceNav');
  if (performanceNav) {
    performanceNav.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigateTo('performance');
    });
  }
  const aiNav = $('#aiNav');
  if (aiNav) {
    aiNav.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigateTo('ai');
    });
  }
  const notesNav = $('#notesNav');
  if (notesNav) {
    notesNav.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigateTo('notes');
    });
  }

  // Theme toggle
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // Get token from URL
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  const container = $('#shared-note-container');

  if (!token) {
    container.innerHTML = '<div class="error">No share token provided.</div>';
    return;
  }

  // Canonical share URL (always app.medvix.co.ke)
  const canonicalUrl = buildShareUrl(token);

  try {
    const note = await db.getNoteByShareToken(token);
    if (!note) {
      container.innerHTML = '<div class="error">Note not found or link has expired.</div>';
      return;
    }

    const created = utils.formatDate(note.createdAt, 'full');
    const isLoggedIn = auth.checkAuth();

    let html = `
      <div class="note-card">
        <h1>${note.title || 'Untitled'}</h1>
        <div class="note-meta">
          <span>Created: ${created}</span>
          ${note.tags && note.tags.length ? `<span>Tags: ${note.tags.join(', ')}</span>` : ''}
        </div>
        <div class="note-content">${note.content}</div>
        <div class="note-actions">
          <button id="copyLinkBtn" class="btn-secondary">🔗 Copy Link</button>
          <button id="shareNoteBtn" class="btn-secondary">📤 Share</button>
    `;

    if (isLoggedIn) {
      html += `<button id="saveCopyBtn" class="btn-primary">📋 Save to My Notes</button>`;
    }

    html += `
        </div>
      </div>
    `;
    container.innerHTML = html;

    // Copy link button — uses canonical URL, not window.location
    const copyLinkBtn = $('#copyLinkBtn');
    if (copyLinkBtn) {
      copyLinkBtn.addEventListener('click', () => {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(canonicalUrl).then(() => {
            ui.showToast('Link copied!', 'success');
          }).catch(() => {
            fallbackCopy(canonicalUrl);
          });
        } else {
          fallbackCopy(canonicalUrl);
        }
      });
    }

    // Share button — uses custom plugin with fallbacks
    const shareNoteBtn = $('#shareNoteBtn');
    if (shareNoteBtn) {
      shareNoteBtn.addEventListener('click', () => {
        nativeShare({
          title: note.title || 'MedVix Note',
          text: `Check out this MedVix note: ${note.title || 'Untitled'}`,
          url: canonicalUrl,
          dialogTitle: 'Share Note'
        });
      });
    }

    // Save copy button
    const saveCopyBtn = $('#saveCopyBtn');
    if (saveCopyBtn) {
      saveCopyBtn.addEventListener('click', async () => {
        if (!auth.checkAuth()) {
          ui.showToast('You must be logged in', 'error');
          return;
        }
        try {
          await notes.createNote({
            title: note.title + ' (shared copy)',
            content: note.content,
            plainText: note.plainText || '',
            subject: note.subject,
            topic: note.topic,
            tags: note.tags
          });
          ui.showToast('Note saved to your collection!', 'success');
        } catch (err) {
          ui.showToast('Failed to save note: ' + err.message, 'error');
        }
      });
    }
  } catch (err) {
    console.error(err);
    container.innerHTML = '<div class="error">Error loading note.</div>';
  }

  console.log('[SharedNote] Initialized');
}

export function destroy() {
  // Cleanup if needed
}