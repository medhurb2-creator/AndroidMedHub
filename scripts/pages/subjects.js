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

const CORE_SUBJECTS = [
  { id: 'anatomy', name: 'Anatomy', icon: '💀', color: '#FF6B6B', questions: 1100 },
  { id: 'physiology', name: 'Physiology', icon: '🧠', color: '#4ECDC4', questions: 1150 },
  { id: 'biochemistry', name: 'Biochemistry', icon: '🧪', color: '#45B7D1', questions: 810 },
  { id: 'histology', name: 'Histology', icon: '🔬', color: '#96CEB4', questions: 900 },
  { id: 'embryology', name: 'Embryology', icon: '🐣', color: '#FFEAA7', questions: 950 },
  { id: 'pathology', name: 'Pathology', icon: '🩸', color: '#DDA0DD', questions: 1050 },
  { id: 'pharmacology', name: 'Pharmacology', icon: '💊', color: '#FDCB6E', questions: 800 },
  { id: 'microbiology', name: 'Microbiology', icon: '🦠', color: '#E17055', questions: 970 }
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

  // 1. Check authentication (app is already initialized)
  if (!auth.checkAuth()) {
    shimmer.classList.add('hidden');
    router.navigateTo('welcome');
    return;
  }

  const user = auth.getUser();

  // ============================================================
  // ✅ Use cached subscription only – no backend calls
  // ============================================================
  let sub = null;
  try {
    sub = await subscription.getSubscription(); // returns cached object
  } catch (err) {
    console.warn('[Subjects] Failed to get subscription:', err);
    sub = null;
  }

  // 2. Render greeting and subscription status
  const greetingEl = $('#user-greeting');
  if (greetingEl) greetingEl.textContent = user?.name ? `Hello, ${user.name.split(' ')[0]}` : 'Hello, Doctor';

  const statusContainer = $('#sub-status');
  if (statusContainer) {
    if (sub && sub.isActive) {
      const remaining = await subscription.formatRemainingTime(); // uses cached expiry
      const expiryStr = utils.formatDate(sub.expiryDate);
      statusContainer.innerHTML = `<span>Expires ${expiryStr} (${remaining})</span>`;
    } else {
      statusContainer.innerHTML = `<button class="status-subscribe-btn" data-route="subscription">Subscribe</button>`;
    }
  }

  // 3. Quick actions (background)
  const continueBtn = $('#continue-last');
  const weakBtn = $('#weak-areas');
  const weakCountSpan = $('#weak-areas-count');
  const quickExamBtn = $('#quickExamBtn');

  db.getLastExam().then(lastExam => {
    if (continueBtn && lastExam) {
      continueBtn.style.display = 'inline-block';
      continueBtn.onclick = () => router.navigateTo(`exam-settings?resume=${lastExam.examId}`);
    }
  });

  analytics.identifyWeakAreas().then(weakAreas => {
    if (weakBtn && weakAreas && weakAreas.length > 0) {
      weakBtn.style.display = 'inline-block';
      if (weakCountSpan) weakCountSpan.textContent = `Weak: ${weakAreas.slice(0,2).map(w => w.topic).join(', ')}`;
    }
  });

  if (quickExamBtn) {
    quickExamBtn.addEventListener('click', () => router.navigateTo('exam-settings?quick=10'));
  }

  // 4. Render core subjects immediately
  progressMap = await analytics.getSubjectProgress() || {};
  renderSubjects();

  // 5. Setup toggle, search, footer, theme, logout
  setupToggleAndSearch(context);
  setupFooterButtons(context);
  setupThemeAndLogout(context);

  // 6. Show real content – hide shimmer NOW
  shimmer.classList.add('hidden');
  realContent.classList.add('visible');

  // 7. Load extra subjects and notification badge in background
  loadExtraSubjectsAndUpdateGrid();
  updateNotificationBadge();
  events.events.on('new-notification', updateNotificationBadge);

  // 8. Online/offline listeners
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
    subjectsToRender = q ? extraSubjects.filter(s => s.name.toLowerCase().includes(q)) : extraSubjects;
  }

  if (subjectsToRender.length === 0) {
    grid.innerHTML = `<p class="no-data" style="grid-column:1/-1;">${
      activeView === 'core' ? 'No core subjects available.' :
      searchQuery ? 'No subjects match your search.' : 'No additional subjects available.'
    }</p>`;
    return;
  }

  const isCore = activeView === 'core';

  grid.innerHTML = subjectsToRender.map(sub => {
    const progress = isCore ? (progressMap[sub.id] || 0) : 0;
    const hasProgress = isCore && typeof progress === 'number';
    const navSubject = isCore ? sub.id : (sub.folder || sub.name);

    return `
    <div class="subject-card" style="border-top: 4px solid ${sub.color || '#666'}">
      <div class="subject-icon" style="background: ${sub.color || '#666'}20">${sub.icon || '📚'}</div>
      <h3>${sub.name}</h3>
      <p>${sub.questions ? `${sub.questions} questions` : ''}</p>
      ${hasProgress ? `
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${progress}%; background: ${sub.color || '#666'}"></div>
        </div>
      ` : ''}
      ${isCore ? `
        <div class="card-actions">
          <button class="action-btn-sm" onclick="window.navigateToVisualAid('${sub.id}')">🖼️ Visual Aid</button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'notes')">📝 Notes</button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'pastpaper')">📄 Past Papers</button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'textbook')">📘 Textbooks</button>
        </div>
        <button onclick="window.studySubject('${sub.id}')" class="btn-study">📖 Study (Exam)</button>
      ` : `
        <div class="card-actions">
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'notes')">📝 Notes</button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'pastpaper')">📄 Past Papers</button>
          <button class="action-btn-sm" onclick="window.navigateToResources('${navSubject}', 'textbook')">📘 Textbooks</button>
        </div>
      `}
    </div>
    `;
  }).join('');
}

// ==================== SETUP TOGGLE & SEARCH ====================
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
      clearSearch.classList.toggle('visible', searchQuery.length > 0);
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

  toggleContainer.style.display = 'none';
  searchBar.classList.remove('visible');
  countEl.style.display = 'none';
}

// ==================== SETUP FOOTER BUTTONS ====================
function setupFooterButtons(context) {
  context.root.querySelectorAll('[data-route]').forEach(el => {
    el.addEventListener('click', () => router.navigateTo(el.dataset.route));
  });
}

// ==================== SETUP THEME & LOGOUT ====================
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

// ==================== LOAD EXTRA SUBJECTS (background) ====================
async function loadExtraSubjectsAndUpdateGrid() {
  try {
    await publicAssets.initPublicAssets();
    const jsonData = await publicAssets.getResourcesUpdateJson();
    if (jsonData && Array.isArray(jsonData.subjects) && jsonData.subjects.length > 0) {
      extraSubjects = jsonData.subjects.map(s => ({
        id: s.id || s.name.toLowerCase().replace(/\s+/g, '-'),
        name: s.name,
        folder: s.folder || s.name,
        icon: s.icon || '📚',
        color: s.color || '#888',
        questions: s.questions || 0,
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
    toggleContainer.style.display = 'flex';
    renderSubjects();
    countEl.style.display = 'none';
  } else {
    toggleContainer.style.display = 'none';
    searchBar.classList.remove('visible');
    countEl.style.display = 'none';
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

// ==================== EXPOSE GLOBALS ====================
window.studySubject = (subjectId) => router.navigateTo(`subject-specific?subject=${subjectId}`);
window.navigateToVisualAid = (subjectId) => router.navigateTo(`resource-browser?subject=${subjectId}&type=visual`);
window.navigateToResources = (subjectId, type) => router.navigateTo(`resource-browser?subject=${subjectId}&type=${type}`);
window.setView = setView;

export function destroy() {
  // Cleanup if needed
}