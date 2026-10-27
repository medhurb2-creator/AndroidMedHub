// scripts/pages/subjects.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as subscription from '../subscription.js';
import * as analytics from '../analytics.js';
import * as sync from '../sync.js';
import * as db from '../db.js';
import * as utils from '../utils.js';
import * as notifications from '../notifications.js';
import * as publicAssets from '../public-assets.js';
import * as events from '../events.js';
// ── SLIDE imports
import * as questions from '../questions.js';
import * as slideData from '../slide-data.js';

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
  if (/^fa[srb]?\s/.test(icon) || icon.startsWith('fa-')) return icon;
  return EMOJI_TO_FA[icon] || 'fa-solid fa-book';
}

// ==================== CORE SUBJECTS ====================
const CORE_SUBJECTS = [
  { id: 'anatomy', name: 'Anatomy', icon: 'fa-solid fa-bone', color: '#FF6B6B', questions: 1245 },
  { id: 'physiology', name: 'Physiology', icon: 'fa-solid fa-heart-pulse', color: '#4ECDC4', questions: 1860 },
  { id: 'biochemistry', name: 'Biochemistry', icon: 'fa-solid fa-flask', color: '#45B7D1', questions: 1650 },
  { id: 'histology', name: 'Histology', icon: 'fa-solid fa-microscope', color: '#96CEB4', questions: 1365 },
  // ── SLIDE: card sits between Histology and Embryology, per spec.
  { id: 'slide-view', name: 'Slide View', icon: 'fa-solid fa-images', color: '#6C5CE7', questions: 0, special: 'slide-view' },
  { id: 'embryology', name: 'Embryology', icon: 'fa-solid fa-egg', color: '#FFEAA7', questions: 1245 },
  { id: 'pathology', name: 'Pathology', icon: 'fa-solid fa-disease', color: '#DDA0DD', questions: 2250 },
  { id: 'pharmacology', name: 'Pharmacology', icon: 'fa-solid fa-pills', color: '#FDCB6E', questions: 1635 },
  { id: 'microbiology', name: 'Microbiology', icon: 'fa-solid fa-bacteria', color: '#E17055', questions: 1650 }
];

// ── SLIDE: accent used for the slide card's progress fill so all
//    three phases (download / extract / study) look consistent.
const SLIDE_COLOR = '#6C5CE7';

let extraSubjects = [];
let activeView = 'core';
let searchQuery = '';
let progressMap = {};
let $;

// ── SLIDE: teardown handle for the card's status subscription.
let _slideUnsub = null;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  const shimmer = $('#shimmer-overlay');
  const realContent = $('#real-content');
  realContent.classList.remove('visible');

  // ── State adapter ────────────────────────────────────────────────
  // Registered before the auth gate so a capture-on-redirect is
  // possible the moment we push login. Captures the parts of UI
  // state that live only as class flags or module-scoped variables
  // and are NOT captured by the automatic UI snapshot:
  //
  //   • activeView  — 'core' vs 'other', reflected only as a class
  //                   on toggle buttons.
  //   • searchQuery — mirrored in #searchInput (auto-captured), but
  //                   also lives here and drives the filter logic.
  //
  // extraSubjects is re-fetched from public assets on every init,
  // so it is not captured — the fetch restores it fresh.
  redirect.registerStateAdapter('subjects', {
    capture: () => ({
      activeView,
      searchQuery,
    }),
    restore: (data) => {
      if (!data) return;

      // Restore the view first: setView() sets activeView, updates
      // the toggle button classes, and re-renders the grid.
      if (typeof data.activeView === 'string') {
        try { setView(data.activeView); }
        catch (err) { console.warn('[Subjects] view restore failed:', err); }
      }

      // Restore the search query. The input's value was already
      // set by the module's automatic UI snapshot (it has an id);
      // we just need to sync the module-scoped variable and
      // re-render so the filter actually applies.
      if (typeof data.searchQuery === 'string' && data.searchQuery) {
        searchQuery = data.searchQuery;
        const searchInput = document.getElementById('searchInput');
        const clearSearch = document.getElementById('clearSearch');
        if (searchInput) searchInput.value = data.searchQuery;
        if (clearSearch) clearSearch.classList.toggle('visible', true);
        try { renderSubjects(); }
        catch (err) { console.warn('[Subjects] render on search restore failed:', err); }
      }
    },
  });

  // 1. Check authentication
  //
  // Round-trip through login. The user explicitly reached subjects —
  // via URL, deep link, or a delayed session-expiry redirect — so
  // after login they should land back here, not on welcome.
  if (!auth.checkAuth()) {
    shimmer.classList.add('hidden');
    ui.showToast('Please log in to continue', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
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

  // ── SLIDE: kick off slide-data after render, so the card's
  //    subscriber is already registered when the first status
  //    emission lands. Non-blocking — download state and the
  //    weekly update check run in the background.
  slideData.init().catch(err => console.warn('[Subjects] slide-data init failed:', err));

  // 5. Setup handlers
  setupToggleAndSearch(context);
  setupFooterButtons(context);
  setupUserMenu(); // <--- Replaced setupThemeAndLogout here

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

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a completed round trip.
  // Pop so the stack doesn't grow on subsequent redirects. Covers
  // the case where the returning page used history.back() instead
  // of consumeAndReturn().
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
    console.warn('[Subjects] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Restores view toggle + search query via the adapter. Search input
  // value is restored by the automatic UI snapshot.
  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[Subjects] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

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
    grid.innerHTML = `<p class="no-data" style="grid-column:1/-1;">${activeView === 'core'
        ? 'No core subjects available.'
        : searchQuery
          ? 'No subjects match your search.'
          : 'No additional subjects available.'
      }</p>`;
    return;
  }

  const isCore = activeView === 'core';

  grid.innerHTML = subjectsToRender.map(sub => {
    // ── SLIDE: the special card renders its own markup, but uses
    //    the same .subject-card, .progress-bar, .progress-fill,
    //    and .action-btn-sm classes so it looks identical to the
    //    other core cards.
    if (sub.special === 'slide-view') {
      return _slideViewCardHtml(sub);
    }

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

  // ── SLIDE: hydrate the special card after the grid is in the DOM.
  _hydrateSlideCard();
}

// ==================== SLIDE VIEW CARD ====================
//
// Uses the exact same `.progress-bar` / `.progress-fill` markup as
// regular subject cards. That single bar is reused across three
// phases by _updateSlideCardUi():
//
//   1. Download progress  (0..100 of the zip fetch)
//   2. Extraction progress (0..100 of the JSZip entry loop)
//   3. Aggregate study progress across the slide subjects
//      (progressMap[id], same source other cards use)
//
// Download → Study transition happens on its own as slide-data's
// status object flips. Update available adds a second button.

function _slideViewCardHtml(sub) {
  const color = sub.color || SLIDE_COLOR;
  // Vite serves /public at the app root, so the file at
  // public/assets/images/microscope.jpg is reachable at
  // /assets/images/microscope.jpg. The <i> fallback sits behind
  // the image at z-index 0; if the image 404s, onerror removes it
  // and the Font Awesome icon shows through instead.
  return `
    <div class="subject-card slide-view-card"
         data-card="slide-view"
         style="border-top: 4px solid ${color}">
      <div class="subject-icon slide-icon" style="background:${color}20; color:${color};">
        <i class="fa-solid fa-images slide-icon-fallback" aria-hidden="true"></i>
        <img src="/assets/images/microscope.jpg"
             alt="Slide View"
             class="slide-icon-img"
             loading="lazy"
             onerror="this.remove()">
      </div>
      <h3>${sub.name}</h3>
      <p id="slide-status-text">Checking…</p>
      <div class="progress-bar">
        <div class="progress-fill" id="slide-progress-fill"
             style="width:0%; background:${color}"></div>
      </div>
      <div class="card-actions" id="slide-actions"></div>
    </div>
  `;
}

function _hydrateSlideCard() {
  const card = document.querySelector('[data-card="slide-view"]');
  if (!card) return;

  // Re-render replaces the card node, so the previous listener would
  // point at dead DOM. Drop it first.
  if (_slideUnsub) { _slideUnsub(); _slideUnsub = null; }

  _slideUnsub = slideData.subscribe((status) => {
    _updateSlideCardUi(card, status);
  });
}

function _updateSlideCardUi(card, s) {
  const statusText = card.querySelector('#slide-status-text');
  const fill = card.querySelector('#slide-progress-fill');
  const actions = card.querySelector('#slide-actions');
  if (!actions || !fill) return;

  // ── Phase 1 & 2: downloading / extracting ─────────────────────
  if (s.downloading) {
    if (statusText) {
      statusText.textContent = s.extracting
        ? 'Extracting slides…'
        : 'Downloading slides…';
    }
    const pct = s.extracting ? s.extractProgress : s.progress;
    fill.style.width = pct + '%';
    fill.style.background = SLIDE_COLOR;
    actions.innerHTML = '';
    return;
  }

  // ── Not downloaded ────────────────────────────────────────────
  if (!s.downloaded) {
    if (statusText) {
      statusText.textContent = s.error
        ? 'Error: ' + s.error
        : 'Download study slides';
    }
    fill.style.width = '0%';
    fill.style.background = SLIDE_COLOR;
    actions.innerHTML = `
      <button class="action-btn-sm slide-download-btn" id="slide-download-btn">
        <i class="fa-solid fa-download"></i> <span>Download</span>
      </button>`;
    actions.querySelector('#slide-download-btn')
      ?.addEventListener('click', () => slideData.downloadSlideData());
    return;
  }

  // ── Phase 3: downloaded — fill = aggregate study progress ────
  //    Same metric as the regular cards (progressMap), just averaged
  //    across the slide zip's subjects.
  //    NOTE: uses getAllSlideSubjectIds() — the unified public API.
  //    The old getSlideSubjectIds() name was removed when the slide
  //    manifest was folded into the unified subject/topic getters.
  const slideIds = questions.getAllSlideSubjectIds();
  const aggregate = slideIds.length > 0
    ? Math.round(
      slideIds.reduce((acc, id) => acc + (progressMap[id] || 0), 0) /
      slideIds.length
    )
    : 0;
  fill.style.width = aggregate + '%';
  fill.style.background = SLIDE_COLOR;

  // ── Update available: Study + Update ─────────────────────────
  if (s.updateAvailable) {
    if (statusText) statusText.textContent = 'Update available';
    actions.innerHTML = `
      <button class="action-btn-sm slide-update-btn" id="slide-update-btn">
        <i class="fa-solid fa-rotate"></i> <span>Update</span>
      </button>
      <button class="action-btn-sm slide-study-btn" id="slide-study-btn">
        <i class="fa-solid fa-images"></i> <span>Study</span>
      </button>`;
    actions.querySelector('#slide-update-btn')
      ?.addEventListener('click', () => slideData.downloadSlideData());
    actions.querySelector('#slide-study-btn')
      ?.addEventListener('click', _openSlideView);
    return;
  }

  // ── Up to date: Study only ───────────────────────────────────
  if (statusText) statusText.textContent = 'Ready to study';
  actions.innerHTML = `
    <button class="action-btn-sm slide-study-btn" id="slide-study-btn">
      <i class="fa-solid fa-images"></i> <span>Study Slides</span>
    </button>`;
  actions.querySelector('#slide-study-btn')
    ?.addEventListener('click', _openSlideView);
}

function _openSlideView() {
  // NOTE: getAllSlideSubjectIds() — see _updateSlideCardUi above.
  const ids = questions.getAllSlideSubjectIds();
  if (!ids || ids.length === 0) {
    ui.showToast('No slide subjects available', 'warning');
    return;
  }

  // Multi-subject zips: pick the first deterministically so Study
  // always lands somewhere. The user can switch subject inside the
  // normal topic-selection flow.
  //
  // Route through the *same* helper the regular Study buttons use
  // (window.studySubject → subject-specific). This keeps the slide
  // flow byte-identical to the core-subject flow: subject-specific
  // → exam-settings → exam-engine → results. Anything downstream
  // that keys off the URL `subject=` param (analytics, seen-questions,
  // performance ratings) treats histology-prac exactly like anatomy.
  window.studySubject(ids[0]);
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



// ==================== THEME / USER MENU ====================
function setupUserMenu() {
  const themeToggle = $('#themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', ui.toggleTheme);

  const userMenuBtn = $('#userMenuBtn');
  const userDropdown = $('#userDropdown');
  const logoutBtn = $('#logoutBtn');
  const switchAccountBtn = $('#switchAccountBtn');

  if (!userMenuBtn || !userDropdown) return;

  // --- 1. Populate Avatar (Image or Initial) ---
  const user = auth.getUser();
  const avatarText = $('#userAvatarText');
  const avatarImg = $('#userAvatarImg');

  if (user) {
    const imgUrl = user.picture || user.photoURL || user.avatar || user.avatarUrl;

    if (imgUrl) {
      // Use online image directly, rely on browser caching
      avatarImg.src = imgUrl;
      avatarImg.style.display = 'block';
      avatarText.style.display = 'none';
      
      // If the image fails to load (offline/broken link), revert to initials
      avatarImg.onerror = () => {
        avatarImg.style.display = 'none';
        const nameStr = user.name || user.email || 'User';
        avatarText.textContent = nameStr.charAt(0).toUpperCase();
        avatarText.style.display = 'flex';
      };
    } else {
      // No image URL, use initials
      const nameStr = user.name || user.email || 'User';
      avatarText.textContent = nameStr.charAt(0).toUpperCase();
      avatarText.style.display = 'flex';
      avatarImg.style.display = 'none';
    }
  }

  // --- 2. Toggle Dropdown ---
  userMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent closing immediately
    const isVisible = userDropdown.classList.contains('show');
    userDropdown.classList.toggle('show', !isVisible);
  });

  // Close when clicking outside
  document.addEventListener('click', (e) => {
    if (!userMenuBtn.contains(e.target) && !userDropdown.contains(e.target)) {
      userDropdown.classList.remove('show');
    }
  });

  // --- 3. Dropdown Actions ---
  const performLogout = (redirectUrl) => {
    userDropdown.classList.remove('show');
    auth.logout();
    try { redirect.clearReturns(); } catch { /* ignore */ }
    try { redirect.clearSnapshots(); } catch { /* ignore */ }
    router.navigateTo(redirectUrl);
  };

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => performLogout('welcome'));
  }

  if (switchAccountBtn) {
    switchAccountBtn.addEventListener('click', () => {
      // Force redirect to login, prompting the user to use a different account
      performLogout('login?switch_account=true');
    });
  }

  // Notifications button
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
    // Fall back to core if a restored 'other' view has no data to
    // show. Otherwise the grid would render an empty state even
    // though the toggle button is hidden.
    if (activeView === 'other') activeView = 'core';
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
  // ── SLIDE: drop the card's status subscription so a subsequent
  //    visit doesn't update a dead DOM node.
  if (_slideUnsub) { _slideUnsub(); _slideUnsub = null; }

  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's module state.
  try { redirect.unregisterStateAdapter('subjects'); } catch { /* ignore */ }
}