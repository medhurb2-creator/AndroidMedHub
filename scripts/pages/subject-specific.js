// scripts/pages/subject-specific.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as utils from '../utils.js';
import * as questions from '../questions.js';
import * as analytics from '../analytics.js';
import * as db from '../db.js';
import * as subscription from '../subscription.js';
import * as examEngine from '../exam-engine.js';

// State
let currentSubject = null;
let currentUser = null;
let topicsData = [];
let hasActiveSub = false;
let currentMode = 'internal';

// DOM helper
let $;

// ── SLIDE: cached clone template for dynamically-built subject sections.
//    Populated on first dynamic subject; reused for subsequent ones.
let _sectionTemplate = null;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // Show shimmer, hide real content
  const shimmer = $('#shimmer-content');
  const realContent = $('#real-content');
  realContent.style.display = 'none';
  shimmer.style.display = 'block';

  // ── State adapter ────────────────────────────────────────────────
  // Registered before any redirect can fire. The topic selection
  // already lives in sessionStorage (topicSelection_<subjectId>), so
  // it survives a teardown without help. This adapter's job is to
  // capture the pieces of module-scoped state that do NOT have a
  // persistence layer:
  //
  //   • currentMode  — set by setMode(), reflected only as a CSS
  //                    class on .mode-btn; the automatic UI snapshot
  //                    does not capture class-based state.
  //   • currentSubject — redundant with the URL, but captured as a
  //                    safety net in case a caller ever pushes this
  //                    page without preserving the query string.
  //
  // The page currently has no gating redirects of its own — the
  // adapter is primarily insurance for future gates and for
  // downstream flows that might push this page.
  redirect.registerStateAdapter('subject-specific', {
    capture: () => ({
      currentMode,
      currentSubject,
    }),
    restore: (data) => {
      if (!data) return;

      // Defensive: only adopt the restored subject if the URL did
      // not already provide one. The URL is the source of truth.
      if (!currentSubject && data.currentSubject) {
        currentSubject = data.currentSubject;
      }

      if (typeof data.currentMode === 'string') {
        try { setMode(data.currentMode); }
        catch (err) { console.warn('[SubjectSpecific] mode restore failed:', err); }
      }
    },
  });

  // 1. Check auth (app is already initialized)
  currentUser = auth.getUser();
  hasActiveSub = await subscription.hasActiveSubscription();

  const subjectId = utils.getQueryParam('subject');
  if (!subjectId) {
    // Terminal: no subject in the URL, page cannot render. Clear
    // any dangling redirect chain — a stale returnTo would just
    // loop the user back here on every successful auth resolution.
    ui.showToast('No subject specified', 'error');
    try { redirect.clearReturns(); }   catch { /* ignore */ }
    try { redirect.clearSnapshots(); } catch { /* ignore */ }
    router.navigateTo('subjects');
    return;
  }
  currentSubject = subjectId;

  // 2. Show the correct subject section
  //
  // ── SLIDE: static HTML ships one section per *core* subject.
  //    Slide-delivered subjects (histology-prac, …) aren't in the HTML
  //    at build time — they're invented at runtime by the zip's
  //    subject.json — so for any subject whose section is missing, we
  //    build one on the fly by cloning an existing static section and
  //    renaming its IDs. That keeps the DOM shape identical to the
  //    static sections, which is what the rest of this file
  //    (renderTopicTree, select/clear buttons, shared selection
  //    summary) relies on.
  document.querySelectorAll('.subject-section').forEach(el => el.style.display = 'none');

  let targetDiv = $(`#${subjectId}-topics`);
  if (!targetDiv) {
    targetDiv = _buildDynamicSubjectSection(context, subjectId);
    if (!targetDiv) {
      // No template section to clone — genuinely unrecoverable.
      ui.showToast('Subject not found', 'error');
      try { redirect.clearReturns(); }   catch { /* ignore */ }
      try { redirect.clearSnapshots(); } catch { /* ignore */ }
      router.navigateTo('subjects');
      return;
    }
  }
  targetDiv.style.display = 'block';

  // 3. Load subject metadata and update header
  //
  // ── SLIDE: subjectMeta.icon is a Font Awesome class string
  //    ("fa-solid fa-microscope") — either from the static
  //    SUBJECT_META in questions.js or from the slide manifest's
  //    SUBJECT_META. Setting .textContent would paint the literal
  //    class string into the DOM instead of the icon. Rendering an
  //    <i> wrapper keeps the header consistent with the subject cards
  //    on the Subjects grid.
  const subjectMeta = await questions.getSubjectMeta(subjectId);

  const iconEl = $('#header-subject-icon');
  if (iconEl) {
    const iconClass =
      typeof subjectMeta.icon === 'string' &&
      (/^fa[srb]?\s/.test(subjectMeta.icon) || subjectMeta.icon.startsWith('fa-'))
        ? subjectMeta.icon
        : 'fa-solid fa-book';
    iconEl.innerHTML = `<i class="${iconClass}" aria-hidden="true"></i>`;
  }

  const nameEl = $('#header-subject-name');
  if (nameEl) nameEl.textContent = subjectMeta.name;

  const colorEl = $('#header-subject-color');
  if (colorEl) colorEl.style.backgroundColor = subjectMeta.color;

  const totalEl = $('#header-total-questions');
  if (totalEl) totalEl.textContent = `${subjectMeta.questions} questions`;

  // 4. Load topics
  topicsData = await questions.getTopicsBySubject(subjectId);
  renderTopicTree(subjectId, topicsData);

  // 5. Load recent topics
  const recentTopics = currentUser ? await analytics.getRecentTopics(subjectId, 3) : [];
  renderRecentTopics(recentTopics);

  // 6. Restore saved selection
  const savedSelection = sessionStorage.getItem(`topicSelection_${subjectId}`);
  if (savedSelection) {
    try {
      const selectedIds = JSON.parse(savedSelection);
      restoreSelection(selectedIds);
    } catch (e) {}
  }

  // 7. Set default mode: internal
  setMode('internal');

  // 8. Attach all event listeners
  //
  // ── SLIDE: this is *after* step 2, so the .select-all-btn /
  //    .clear-all-btn elements inside a dynamically-built section are
  //    already in the DOM and get their listeners here.
  attachEventListeners(context);

  // 9. Hide shimmer, show real content
  shimmer.style.display = 'none';
  realContent.style.display = 'block';

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a completed round trip.
  // Pop so the stack doesn't grow on subsequent redirects. Covers
  // the case where the returning page used history.back().
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
    console.warn('[SubjectSpecific] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Restores currentMode (via the adapter above) and any auto-
  // captured form state. Topic selection is not affected — it is
  // restored from sessionStorage further up in this function, so
  // it survives regardless of the redirect path.
  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[SubjectSpecific] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

  console.log('[SubjectSpecific] Initialized');
}

// ==================== DYNAMIC SUBJECT SECTION (SLIDE) ====================
//
// Builds a .subject-section block for a subject that isn't in the
// static HTML — every slide-delivered subject, and any future subject
// added without an HTML change. The template is any existing
// .subject-section from the static HTML, cloned and re-IDed so the
// new subject's tree, buttons, and any wrapper elements have the
// expected `${subjectId}-…` IDs and `data-subject="${subjectId}"`
// attributes.
//
// Returns the new section element (already appended to the DOM), or
// null if no template exists to clone from.

function _buildDynamicSubjectSection(context, subjectId) {
  // First-call template extraction. The template is any static
  // .subject-section. If none exists, the static HTML is broken and
  // there's nothing to mimic — bail with a warning.
  if (!_sectionTemplate) {
    const firstStatic = context.root.querySelector('.subject-section');
    if (!firstStatic) {
      console.warn('[SubjectSpecific] No .subject-section template found; cannot build dynamic section');
      return null;
    }
    _sectionTemplate = firstStatic;
  }

  const template = _sectionTemplate;
  const clone    = template.cloneNode(true);

  // Work out the template's subject prefix. The convention is
  // `${subjectId}-topics`, so strip the suffix to get the old ID.
  const oldSectionId = template.id || '';
  const oldSubjectId = oldSectionId.endsWith('-topics')
    ? oldSectionId.slice(0, -'-topics'.length)
    : null;
  if (!oldSubjectId) {
    console.warn('[SubjectSpecific] Template section has no recognizable ID; cannot rename');
    return null;
  }

  // Rewrite every id="oldSubject-…" → id="newSubject-…" and every
  // data-subject="oldSubject" → data-subject="newSubject".
  const oldPrefix = oldSubjectId + '-';
  const newPrefix = subjectId + '-';
  clone.querySelectorAll('[id]').forEach(el => {
    if (el.id.startsWith(oldPrefix)) {
      el.id = newPrefix + el.id.slice(oldPrefix.length);
    }
  });
  if (clone.id.startsWith(oldPrefix)) {
    clone.id = newPrefix + clone.id.slice(oldPrefix.length);
  }
  clone.querySelectorAll('[data-subject]').forEach(el => {
    if (el.dataset.subject === oldSubjectId) el.dataset.subject = subjectId;
  });
  if (clone.dataset.subject === oldSubjectId) {
    clone.dataset.subject = subjectId;
  }

  // Clear any static content inside the tree so renderTopicTree()
  // can rebuild it against the slide manifest. Any inline onclick
  // handlers that referenced the old subject by name would now be
  // stale — removing them here prevents accidental navigation to
  // the template's subject. Listeners are re-attached via
  // attachEventListeners() in init step 8.
  const tree = clone.querySelector(`#${subjectId}-topics-tree`);
  if (tree) tree.innerHTML = '';

  clone.querySelectorAll('[onclick]').forEach(el => {
    el.removeAttribute('onclick');
  });

  // Insert next to the existing static sections so any styles that
  // depend on sibling context (.subject-section + .subject-section,
  // :first-of-type selectors, etc.) still match.
  if (template.parentElement) {
    template.parentElement.appendChild(clone);
  } else {
    context.root.appendChild(clone);
  }

  console.log(`[SubjectSpecific] Built dynamic section for "${subjectId}"`);
  return clone;
}

// ==================== RENDER TOPICS ====================
function renderTopicTree(subjectId, topics) {
  const container = $(`#${subjectId}-topics-tree`);
  if (!container) return;

  let html = '';
  topics.forEach(topic => {
    const estimated = Math.ceil(topic.questions * 0.75);
    const isFree = subscription.isTopicFree(subjectId, topic.id);
    const enabled = hasActiveSub || isFree;
    const lockIcon = !enabled ? '<span class="lock-icon" title="Subscribe to unlock">🔒</span>' : '';
    const disabledAttr = enabled ? '' : 'disabled';

    html += `
      <div class="topic-item ${enabled ? '' : 'locked'}">
        <label>
          <input type="checkbox" name="topic" data-subject="${subjectId}" data-topic-id="${topic.id}" data-questions="${topic.questions}" data-estimated="${estimated}" ${disabledAttr}>
          <span class="topic-name">${topic.name} ${lockIcon}</span>
          <span class="topic-stats">${topic.questions} q · ~${estimated} min</span>
        </label>
        ${!enabled ? '<div class="tooltip">This topic requires a subscription</div>' : ''}
      </div>
    `;
  });
  container.innerHTML = html;

  // Attach change listeners to enabled checkboxes
  container.querySelectorAll('input[type="checkbox"]:enabled').forEach(cb => {
    cb.addEventListener('change', () => {
      updateSelectionSummary(subjectId);
      saveSelection(subjectId);
    });
  });
}

// ==================== RECENT TOPICS ====================
function renderRecentTopics(topics) {
  const container = $('#recent-topics-list');
  const section = $('#recent-section');
  if (!container || !section) return;

  if (!topics || topics.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  let html = '';
  topics.forEach(t => {
    html += `<div class="recent-topic" data-subject="${t.subjectId}" data-topic="${t.topicId}">📘 ${t.topicName} – ${t.questions} questions</div>`;
  });
  container.innerHTML = html;

  // Attach click listeners
  container.querySelectorAll('.recent-topic').forEach(el => {
    el.addEventListener('click', () => {
      const subject = el.dataset.subject;
      const topicId = el.dataset.topic;
      quickStudyTopic(subject, topicId);
    });
  });
}

// ==================== SELECTION SUMMARY ====================
function updateSelectionSummary(subjectId) {
  const container = $(`#${subjectId}-topics-tree`);
  if (!container) return;
  const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
  const totalSelected = checkboxes.length;
  const totalTopics = container.querySelectorAll('input[type="checkbox"]').length;
  let totalQuestions = 0;
  let totalMinutes = 0;
  checkboxes.forEach(cb => {
    totalQuestions += parseInt(cb.dataset.questions);
    totalMinutes += parseInt(cb.dataset.estimated);
  });

  $('#selected-count').textContent = `${totalSelected} of ${totalTopics} topics selected`;
  $('#selected-questions').textContent = `${totalQuestions} questions selected`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  $('#estimated-time').textContent = `~${hours}h ${mins}m`;

  const primaryBtn = $('#primary-action-btn');
  const secondaryBtn = $('#secondary-action-btn');

  if (currentMode === 'internal') {
    primaryBtn.textContent = 'Start Exam';
    primaryBtn.onclick = () => studySelectedTopics(subjectId);
    secondaryBtn.style.display = 'inline-block';
    secondaryBtn.textContent = 'Quick Exam (10q)';
    secondaryBtn.onclick = () => quickExamSelected(subjectId);

    if (totalSelected === 0) {
      primaryBtn.disabled = true;
      secondaryBtn.disabled = true;
    } else {
      primaryBtn.disabled = false;
      secondaryBtn.disabled = false;
    }
  } else {
    // PDF mode
    primaryBtn.textContent = 'Create PDF';
    primaryBtn.onclick = () => createPDF(subjectId);
    secondaryBtn.style.display = 'none';

    const enoughTopics = totalSelected >= 2;
    const hasSub = hasActiveSub;

    if (!hasSub) {
      primaryBtn.disabled = true;
      const subMsg = $('#pdf-sub-required');
      if (subMsg) subMsg.style.display = 'inline';
    } else if (!enoughTopics) {
      primaryBtn.disabled = true;
      const subMsg = $('#pdf-sub-required');
      if (subMsg) subMsg.style.display = 'none';
    } else {
      primaryBtn.disabled = false;
      const subMsg = $('#pdf-sub-required');
      if (subMsg) subMsg.style.display = 'none';
    }
  }
}

function saveSelection(subjectId) {
  const container = $(`#${subjectId}-topics-tree`);
  if (!container) return;
  const selected = [];
  container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    selected.push(cb.dataset.topicId);
  });
  sessionStorage.setItem(`topicSelection_${subjectId}`, JSON.stringify(selected));
}

function restoreSelection(selectedIds) {
  if (!currentSubject) return;
  const container = $(`#${currentSubject}-topics-tree`);
  if (!container) return;
  container.querySelectorAll('input[type="checkbox"]:enabled').forEach(cb => {
    if (selectedIds.includes(cb.dataset.topicId)) {
      cb.checked = true;
    }
  });
  updateSelectionSummary(currentSubject);
}

// ==================== MODE SWITCHING ====================
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });

  const subMsg = $('#pdf-sub-required');
  if (subMsg) subMsg.style.display = 'none';

  if (currentSubject) {
    updateSelectionSummary(currentSubject);
  }
}

// ==================== EVENT LISTENERS ====================
function attachEventListeners(context) {
  // Back button — plain navigation. The user is explicitly
  // abandoning the subject-specific flow.
  const backBtn = $('#backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  // Theme toggle
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // Mode buttons
  const modeInternal = $('#modeInternal');
  const modePdf = $('#modePdf');
  if (modeInternal) {
    modeInternal.addEventListener('click', () => setMode('internal'));
  }
  if (modePdf) {
    modePdf.addEventListener('click', () => setMode('pdf'));
  }

  // Select All buttons
  context.root.querySelectorAll('.select-all-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const subjectId = btn.dataset.subject;
      selectAllTopics(subjectId);
    });
  });

  // Clear All buttons
  context.root.querySelectorAll('.clear-all-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const subjectId = btn.dataset.subject;
      clearAllTopics(subjectId);
    });
  });
}

// ==================== GLOBAL ACTIONS (exposed for inline onclick) ====================
function selectAllTopics(subjectId) {
  const container = $(`#${subjectId}-topics-tree`);
  if (!container) return;
  container.querySelectorAll('input[type="checkbox"]:enabled').forEach(cb => cb.checked = true);
  updateSelectionSummary(subjectId);
  saveSelection(subjectId);
}

function clearAllTopics(subjectId) {
  const container = $(`#${subjectId}-topics-tree`);
  if (!container) return;
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
  updateSelectionSummary(subjectId);
  saveSelection(subjectId);
}

function studySelectedTopics(subjectId) {
  const container = $(`#${subjectId}-topics-tree`);
  const selected = [];
  container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    selected.push({
      id: cb.dataset.topicId,
      name: cb.parentElement.querySelector('.topic-name').textContent.replace('🔒', '').trim(),
      questions: parseInt(cb.dataset.questions),
      estimated: parseInt(cb.dataset.estimated)
    });
  });
  if (selected.length === 0) {
    ui.showToast('Please select at least one topic', 'warning');
    return;
  }
  examEngine.setExamConfig({
    subject: subjectId,
    topics: selected,
    totalQuestions: selected.reduce((sum, t) => sum + t.questions, 0),
    mode: 'study'
  });
  // Plain navigation — exam-settings and its downstream pages own
  // their own gates. If auth/subscription is required, they push
  // the return chain, and on success the user lands back on
  // whichever page gated them (typically exam-room).
  router.navigateTo('exam-settings');
}

function quickExamSelected(subjectId) {
  const container = $(`#${subjectId}-topics-tree`);
  const selected = [];
  container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    selected.push({
      id: cb.dataset.topicId,
      name: cb.parentElement.querySelector('.topic-name').textContent.replace('🔒', '').trim(),
      questions: parseInt(cb.dataset.questions),
      estimated: parseInt(cb.dataset.estimated)
    });
  });
  if (selected.length === 0) {
    ui.showToast('Please select at least one topic', 'warning');
    return;
  }
  examEngine.setExamConfig({
    subject: subjectId,
    topics: selected,
    totalQuestions: 10,
    mode: 'quick'
  });
  router.navigateTo('exam-settings');
}

function createPDF(subjectId) {
  const container = $(`#${subjectId}-topics-tree`);
  const selected = [];
  container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
    selected.push({
      id: cb.dataset.topicId,
      name: cb.parentElement.querySelector('.topic-name').textContent.replace('🔒', '').trim(),
      questions: parseInt(cb.dataset.questions),
      estimated: parseInt(cb.dataset.estimated)
    });
  });
  if (selected.length < 2) {
    ui.showToast('Please select at least 2 topics to export PDF', 'warning');
    return;
  }
  if (!hasActiveSub) {
    // The button is disabled in the UI when there is no active
    // subscription, but this is a belt-and-braces check for the
    // case where the mode got switched programmatically. Since
    // pdf-settings itself has a subscription gate, we could route
    // through subscription here — but the UI already prevents
    // reaching this point, so a toast is sufficient.
    ui.showToast('An active subscription is required to export PDF', 'error');
    return;
  }
  examEngine.setExamConfig({
    subject: subjectId,
    topics: selected,
    totalQuestions: selected.reduce((sum, t) => sum + t.questions, 0),
    mode: 'pdf'
  });
  // pdf-settings has its own auth + subscription gates. Plain nav.
  router.navigateTo('pdf-settings');
}

function quickStudyTopic(subjectId, topicId) {
  const topic = topicsData.find(t => t.id === topicId);
  if (!topic) return;
  examEngine.setExamConfig({
    subject: subjectId,
    topics: [topic],
    totalQuestions: 10,
    mode: 'quick'
  });
  router.navigateTo('exam-settings');
}

// ==================== EXPOSE GLOBALLY (for inline onclick) ====================
window.selectAllTopics = selectAllTopics;
window.clearAllTopics = clearAllTopics;
window.studySelectedTopics = studySelectedTopics;
window.quickExamSelected = quickExamSelected;
window.createPDF = createPDF;
window.quickStudyTopic = quickStudyTopic;
window.setMode = setMode;

export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's module state.
  try { redirect.unregisterStateAdapter('subject-specific'); } catch { /* ignore */ }

  // ── SLIDE: drop the cached template reference so it doesn't keep a
  //    detached DOM tree alive across visits.
  _sectionTemplate = null;
}