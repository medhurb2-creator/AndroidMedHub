// scripts/pages/subjects.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as subscription from '../subscription.js';
import * as analytics from '../analytics.js';
import * as sync from '../sync.js';
import * as db from '../db.js';
import * as utils from '../utils.js';
import * as notifications from '../notifications.js';
import * as publicAssets from '../public-assets.js';
import * as events from '../events.js';

// ==================== ICON HELPERS ====================
// All icons use Font Awesome classes rendered as <i> elements.
// `color` is the subject accent (used for card border, progress, and icon background).

function faIcon(classes, extraStyle = '') {
  return `<i class="${classes}" aria-hidden="true"${extraStyle ? ` style="${extraStyle}"` : ''}></i>`;
}

// Fallback: if a subject comes from JSON with an emoji, map it to FA.
const EMOJI_TO_FA = {
  '💀': 'fa-solid fa-bone',
  '🧠': 'fa-solid fa-brain',
  '🧪': 'fa-solid fa-flask',
  '🔬': 'fa-solid fa-microscope',
  '🐣': 'fa-solid fa-egg',
  '🩸': 'fa-solid fa-disease',
  '💊': 'fa-solid fa-pills',
  '🦠': 'fa-solid fa-bacteria',
  '📚': 'fa-solid fa-book',
  '📖': 'fa-solid fa-book-open',
  '📝': 'fa-solid fa-pen-to-square',
  '📄': 'fa-solid fa-file-lines',
  '📘': 'fa-solid fa-book',
  '🖼': 'fa-solid fa-image',
  '🖼️': 'fa-solid fa-image'
};

function normalizeIcon(icon) {
  if (!icon) return 'fa-solid fa-book';
  if (typeof icon !== 'string') return 'fa-solid fa-book';
  // Already a Font Awesome class
  if (/^fa[srb]?\s/.test(icon) || icon.startsWith('fa-')) return icon;
  // Emoji → FA
  return EMOJI_TO_FA[icon] || 'fa-solid fa-book';
}

// ==================== CORE SUBJECTS ====================
const CORE_SUBJECTS = [
  { id: 'anatomy',      name: 'Anatomy',      icon: 'fa-solid fa-bone',         color: '#FF6B6B', questions: 1245 },
  { id: 'physiology',   name: 'Physiology',   icon: 'fa-solid fa-heart-pulse',  color: '#4ECDC4', questions: 1860 },
  { id: 'biochemistry', name: 'Biochemistry', icon: 'fa-solid fa-flask',        color: '#45B7D1', questions: 1650 },
  { id: 'histology',    name: 'Histology',    icon: 'fa-solid fa-microscope',   color: '#96CEB4', questions: 1365 },
  { id: 'embryology',   name: 'Embryology',   icon: 'fa-solid fa-egg',          color: '#FFEAA7', questions: 1245 },
  { id: 'pathology',    name: 'Pathology',    icon: 'fa-solid fa-disease',      color: '#DDA0DD', questions: 2250 },
  { id: 'pharmacology', name: 'Pharmacology', icon: 'fa-solid fa-pills',        color: '#FDCB6E', questions: 1635 },
  { id: 'microbiology', name: 'Microbiology', icon: 'fa-solid fa-bacteria',     color: '#E17055', questions: 1650 }
];

let extraSubjects = [];
let activeView = 'core';
let searchQuery = '';
let progressMap = {};
let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  const shimmer = $('#shimmer-overlay');
  const realContent = $('#real-content');
  realContent.classList.remove('visible');

  // 1. Check authentication
  if (!auth.checkAuth()) {
    shimmer.classList.add('hidden');
    router.navigateTo('welcome');
    return;
  }

  const user = auth.getUser();

  // 2. Subscription status
  let sub = null;
  let isActive = false;
  try {
    sub = await subscription.getSubscription();
    isActive = await subscription.hasActiveSubscription();
  } catch (err) {
    console.warn('[Subjects] Failed to get subscription:', err);
    sub = null;
    isActive = false;
  }

  const greetingEl = $('#user-greeting');
  if (greetingEl) greetingEl.textContent = user?.name ? `Hello, ${user.name.split(' ')[0]}` : 'Hello, Doctor';

  const statusContainer = $('#sub-status');
  if (statusContainer) {
    if (isActive && sub) {
      const remaining = await subscription.formatRemainingTime();
      const expiryStr = utils.formatDate(sub.expiryDate);
      statusContainer.innerHTML = `<span>Expires ${expiryStr} (${remaining})</span>`;
    } else {
      statusContainer.innerHTML = `<button class="status-subscribe-btn" data-route="subscription">Subscribe</button>`;
    }
  }

  // 3. Quick actions
  const continueBtn = $('#continue-last');
  const weakBtn = $('#weak-areas');
  const weakCountSpan = $('#weak-areas-count');
  const quickExamBtn = $('#quickExamBtn');

  db.getLastExam().then(lastExam => {
    if (continueBtn && lastExam) {
      continueBtn.style.display = 'inline-flex';
      continueBtn.onclick = () => router.navigateTo(`exam-settings?resume=${lastExam.examId}`);
    }
  });

  analytics.identifyWeakAreas().then(weakAreas => {
    if (weakBtn && weakAreas && weakAreas.length > 0) {
      weakBtn.style.display = 'inline-flex';
      if (weakCountSpan) weakCountSpan.textContent = `Weak: ${weakAreas.slice(0, 2).map(w => w.topic).join(', ')}`;
    }
  });

  if (quickExamBtn) {
    quickExamBtn.addEventListener('click', () => router.navigateTo('exam-settings?quick=10'));
  }

  // 4. Render core subjects
  progressMap = (await analytics.getSubjectProgress()) || {};
  renderSubjects();

  // 5. Setup handlers
  setupToggleAndSearch(context);
  setupFooterButtons(context);
  setupThemeAndLogout(context);

  // 6. Hide shimmer
  shimmer.classList.add('hidden');
  realContent.classList.add('visible');

  // 7. Background load
  loadExtraSubjectsAndUpdateGrid();
  updateNotificationBadge();
  events.events.on('new-notification', updateNotificationBadge);

  // 8. Online/offline
  const syncIndicator = $('#sync-indicator');
  window.addEventListener('online', () => {
    if (syncIndicator) syncIndicator.textContent = 'Online';
    ui.showToast('Back online', 'success');
  });
  window.addEventListener('offline', () => {
    if (syncIndicator) syncIndicator.textContent = 'Offline';
    ui.showToast('You are offline', 'warning');
  });

  console.log('[Subjects] Initialization complete.');
}

// ==================== RENDER SUBJECTS ====================
function renderSubjects() {
  const grid = $('#subject-grid');
  if (!grid) return;

  let subjectsToRender = [];
  if (activeView === 'core') {
    subjectsToRender = CORE_SUBJECTS;
  } else {
    const q = searchQuery.toLowerCase().trim();
    subjectsToRender = q
      ? extraSubjects.filter(s => s.name.toLowerCase().includes(q))
      : extraSubjects;
  }

  if (subjectsToRender.length === 0) {
    grid.innerHTML = `<p class="no-data" style="grid-column:1/-1;">${
      activeView === 'core'
        ? 'No core subjects available.'
        : searchQuery
          ? 'No subjects match your search.'
          : 'No additional subjects available.'
    }</p>`;
    return;
  }

  const isCore = activeView === 'core';

  grid.innerHTML = subjectsToRender.map(sub => {
    const progress = isCore ? (progressMap[sub.id] || 0) : 0;
    const hasProgress = isCore && typeof progress === 'number';
    const navSubject = isCore ? sub.id : (sub.folder || sub.name);
    const iconClass = normalizeIcon(sub.icon);
    const color = sub.color || '#666';

    return `
    <div class="subject-card" style="border-top: 4px solid ${color}">
      <div class="subject-icon" style="background: ${color}20; color: ${color};">
        <i class="${iconClass}" aria-hidden="true"></i>
      </div>
      <h3>${sub.name}</h3>
      <p>${sub.questions ? `${sub.questions} questions` : ''}</p>
      ${hasProgress ? `
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${progress}%; background: ${color}"></div>
        </div>
      ` : ''}
      ${isCore ? `
        <div class="card-actions">
          <button class="action-btn-sm" onclick="window.navigateToVisualAid('${sub.id}')">
            ${faIcon('fa-solid fa-image')} <span>Visual Aid</span>
          </button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'notes')">
            ${faIcon('fa-solid fa-pen-to-square')} <span>Notes</span>
          </button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'pastpaper')">
            ${faIcon('fa-solid fa-file-lines')} <span>Past Papers</span>
          </button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'textbook')">
            ${faIcon('fa-solid fa-book')} <span>Textbooks</span>
          </button>
        </div>
        <button onclick="window.studySubject('${sub.id}')" class="btn-study">
          ${faIcon('fa-solid fa-book-open')} <span>Study (Exam)</span>
        </button>
      ` : `
        <div class="card-actions">
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'notes')">
            ${faIcon('fa-solid fa-pen-to-square')} <span>Notes</span>
          </button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'pastpaper')">
            ${faIcon('fa-solid fa-file-lines')} <span>Past Papers</span>
          </button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'textbook')">
            ${faIcon('fa-solid fa-book')} <span>Textbooks</span>
          </button>
        </div>
      `}
    </div>
    `;
  }).join('');
}

// ==================== TOGGLE & SEARCH ====================
function setupToggleAndSearch(context) {
  const toggleContainer = $('#subjectsToggle');
  const searchBar = $('#searchBar');
  const searchInput = $('#searchInput');
  const clearSearch = $('#clearSearch');
  const countEl = $('#subjects-count');

  const toggleButtons = toggleContainer?.querySelectorAll('button');
  if (toggleButtons) {
    toggleButtons.forEach(btn => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      clearSearch?.classList.toggle('visible', searchQuery.length > 0);
      renderSubjects();
    });
  }
  if (clearSearch) {
    clearSearch.addEventListener('click', () => {
      searchInput.value = '';
      searchQuery = '';
      clearSearch.classList.remove('visible');
      renderSubjects();
    });
  }

  if (toggleContainer) toggleContainer.style.display = 'none';
  searchBar?.classList.remove('visible');
  if (countEl) countEl.style.display = 'none';
}

// ==================== FOOTER ====================
function setupFooterButtons(context) {
  context.root.querySelectorAll('[data-route]').forEach(el => {
    el.addEventListener('click', () => router.navigateTo(el.dataset.route));
  });
}

// ==================== THEME / LOGOUT ====================
function setupThemeAndLogout(context) {
  const themeToggle = $('#themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', ui.toggleTheme);

  const logoutBtn = $('#logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      auth.logout();
      router.navigateTo('welcome');
    });
  }

  const notifBtn = $('#notifBtn');
  if (notifBtn) {
    notifBtn.addEventListener('click', () => router.navigateTo('notifications'));
  }
}

// ==================== EXTRA SUBJECTS ====================
async function loadExtraSubjectsAndUpdateGrid() {
  try {
    await publicAssets.initPublicAssets();
    const jsonData = await publicAssets.getResourcesUpdateJson();
    if (jsonData && Array.isArray(jsonData.subjects) && jsonData.subjects.length > 0) {
      extraSubjects = jsonData.subjects.map(s => ({
        id: s.id || s.name.toLowerCase().replace(/\s+/g, '-'),
        name: s.name,
        folder: s.folder || s.name,
        icon: normalizeIcon(s.icon),
        color: s.color || '#888',
        questions: s.questions || 0
      }));
    } else {
      extraSubjects = [];
    }
  } catch (err) {
    console.warn('[Subjects] Failed to load extra subjects:', err);
    extraSubjects = [];
  }

  const toggleContainer = $('#subjectsToggle');
  const searchBar = $('#searchBar');
  const countEl = $('#subjects-count');

  if (extraSubjects.length > 0) {
    if (toggleContainer) toggleContainer.style.display = 'flex';
    renderSubjects();
    if (countEl) countEl.style.display = 'none';
  } else {
    if (toggleContainer) toggleContainer.style.display = 'none';
    searchBar?.classList.remove('visible');
    if (countEl) countEl.style.display = 'none';
    activeView = 'core';
    renderSubjects();
  }
}

// ==================== TOGGLE VIEW ====================
function setView(view) {
  if (view === activeView) return;
  activeView = view;
  const toggleButtons = $('#subjectsToggle')?.querySelectorAll('button');
  if (toggleButtons) {
    toggleButtons.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
  }
  const searchBar = $('#searchBar');
  if (searchBar) searchBar.classList.toggle('visible', view === 'other');
  const countEl = $('#subjects-count');
  if (countEl) countEl.style.display = view === 'other' ? 'block' : 'none';

  if (view === 'core') {
    const searchInput = $('#searchInput');
    if (searchInput) {
      searchInput.value = '';
      searchQuery = '';
      const clearSearch = $('#clearSearch');
      if (clearSearch) clearSearch.classList.remove('visible');
    }
  }
  renderSubjects();
}

// ==================== NOTIFICATION BADGE ====================
function updateNotificationBadge() {
  const badge = $('#notificationBadge');
  if (!badge) return;
  const count = notifications.getUnreadCount ? notifications.getUnreadCount() : 0;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// ==================== GLOBALS ====================
window.studySubject = (subjectId) => router.navigateTo(`subject-specific?subject=${subjectId}`);
window.navigateToVisualAid = (subjectId) => router.navigateTo(`resource-browser?subject=${subjectId}&type=visual`);
window.navigateToResources = (subjectId, type) => router.navigateTo(`resource-browser?subject=${subjectId}&type=${type}`);
window.setView = setView;

export function destroy() {
  // Cleanup if needed
}