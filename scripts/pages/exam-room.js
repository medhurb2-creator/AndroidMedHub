// scripts/pages/exam-room.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as examEngine from '../exam-engine.js';
import * as timer from '../timer.js';
import * as questions from '../questions.js';
import * as db from '../db.js';
import * as security from '../security.js';
import * as subscription from '../subscription.js';
import * as examChat from '../exam-chat.js';
// ── SLIDE IMAGE: fetch slide-subject image blobs from IndexedDB
import * as slideData from '../slide-data.js';

// ── GLOBALS ──
let timerInstance = null;
let globalTimerInstance = null;  // shared mode global timer
let autoSaveInterval = null;
let examMode = 'standard';
let currentQuestionIndex = 0;
let totalQuestions = 0;
let isFinished = false;
let $;

// ── SLIDE IMAGE: object-URL lifecycle ──
//
// Slide-subject images live in IndexedDB as Blobs. They need an
// object-URL to serve as <img src>. Standard and revision modes show
// only one question at a time, so _currentImageUrl tracks that single
// slot. Shared mode renders every question at once and keeps its own
// collection in _sharedImageUrls. Both sets are revoked on teardown.
let _currentImageUrl = null;
let _imageGen = 0;
const _sharedImageUrls = new Set();

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  // ── Reset module-scope state from any previous exam session ────────
  // In an SPA the module is cached across navigations, so these
  // variables keep their values from the previous exam. Without this
  // reset, `isFinished` stays `true` after the first exam — every
  // subsequent exam's submit silently no-ops (`finishExam` returns
  // early), and `currentQuestionIndex` may point at a stale index.
  examMode = 'standard';
  currentQuestionIndex = 0;
  totalQuestions = 0;
  isFinished = false;
  if (timerInstance) { try { timerInstance.stop(); } catch { /* ignore */ } timerInstance = null; }
  if (globalTimerInstance) { try { globalTimerInstance.stop(); } catch { /* ignore */ } globalTimerInstance = null; }
  if (autoSaveInterval) { clearInterval(autoSaveInterval); autoSaveInterval = null; }
  if (_currentImageUrl) { try { URL.revokeObjectURL(_currentImageUrl); } catch { /* ignore */ } _currentImageUrl = null; }
  for (const url of _sharedImageUrls) { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }
  _sharedImageUrls.clear();
  _imageGen = 0;
  sheetState = 'closed';

  ui.applyTheme();
  const shimmer = $('#shimmer-overlay');
  const layouts = {
    standard: $('#standard-layout'),
    revision: $('#revision-layout'),
    shared: $('#shared-layout')
  };

  // ── Auth gate ────────────────────────────────────────────────────
  // Round-trip through login so the user comes back to exam-room with
  // the exam config still intact (the config lives in the exam-engine
  // module, which persists across SPA navigations).
  if (!auth.checkAuth()) {
    shimmer.style.display = 'none';
    ui.showToast('Please log in to start an exam', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  // ── State adapter ────────────────────────────────────────────────
  // Registered after the auth gate so we only ever capture meaningful
  // state. The exam engine persists answers/flags/timing via autoSave;
  // this adapter covers the parts of state that live only in this
  // module's memory and never land in the DOM: which question the user
  // was looking at, which mode, how many questions there are, and
  // whether the exam has already finished.
  redirect.registerStateAdapter('exam-room', {
    capture: () => {
      // Force a save right now so nothing between the last periodic
      // autosave (30 s ago) and this redirect moment is lost.
      try { examEngine.autoSave(); }
      catch (e) { console.warn('[ExamRoom] autoSave during capture failed:', e); }

      return {
        currentQuestionIndex,
        examMode,
        totalQuestions,
        isFinished,
      };
    },
    restore: (data) => {
      if (!data) return;

      if (typeof data.examMode === 'string') examMode = data.examMode;
      if (typeof data.totalQuestions === 'number') totalQuestions = data.totalQuestions;
      if (typeof data.isFinished === 'boolean') isFinished = data.isFinished;

      if (typeof data.currentQuestionIndex === 'number') {
        currentQuestionIndex = data.currentQuestionIndex;
        // Only safe to call goTo() after the exam has been created —
        // init() calls consumeSnapshot() after createExam/startExam,
        // so by the time this runs the engine is ready.
        try {
          examEngine.goTo(currentQuestionIndex);
        } catch (e) {
          console.warn('[ExamRoom] goTo on restore failed:', e);
        }
      }
    },
  });

  // ── Config resolution ────────────────────────────────────────────
  let config = examEngine.getConfig();
  if (!config) {
    const pending = localStorage.getItem('pendingExamConfig');
    if (pending) {
      try {
        config = JSON.parse(pending);
        examEngine.setExamConfig(config);
        console.log('[ExamRoom] Loaded pending exam config from localStorage');
      } catch (e) {
        console.warn('[ExamRoom] Failed to parse pending exam config', e);
      }
    }
  }

  if (!config) {
    const saved = await examEngine.loadSavedExam();
    if (saved) {
      config = saved;
      examEngine.setExamConfig(config);
      ui.showToast('Resuming saved exam...', 'info');
    } else {
      shimmer.style.display = 'none';
      ui.showToast('No exam configuration found', 'error');
      // Clear any dangling redirect chain — the user has no exam to
      // resume, so a pending return URL would just loop them here.
      try { redirect.clearReturns(); } catch { /* ignore */ }
      try { redirect.clearSnapshots(); } catch { /* ignore */ }
      router.navigateTo('subjects');
      return;
    }
  }

  examMode = config.mode || 'standard';
  if (examMode === 'challenge') examMode = 'shared';

  Object.values(layouts).forEach(el => el.style.display = 'none');
  const layout = layouts[examMode];
  if (!layout) {
    shimmer.style.display = 'none';
    ui.showToast('Unknown exam mode', 'error');
    router.navigateTo('subjects');
    return;
  }

  // ── Subscription gate (standard mode only) ───────────────────────
  // Round-trip through subscription. The chain subscription → payment
  // → consumeAndReturn() lands the user back here with the exam ready
  // to start, config still in the engine.
  if (examMode === 'standard') {
    const hasActiveSub = await subscription.hasActiveSubscription();
    if (!hasActiveSub) {
      const allFree = subscription.areAllTopicsFree(config);
      if (!allFree) {
        shimmer.style.display = 'none';
        ui.showToast('This exam includes premium topics — subscribe to continue', 'warning');
        redirect.navigateWithReturn('subscription', 'subscription_required', {
          meta: { subject: config?.subject, examMode },
        });
        return;
      }
    }
  }

  try {
    await examEngine.createExam(config);
    examEngine.startExam();
    totalQuestions = examEngine.totalQuestions();
    localStorage.removeItem('pendingExamConfig');

    // ── Consume snapshot BEFORE first render ────────────────────────
    // Restores form fields, scroll, focus and (via the adapter above)
    // the question index. Runs after createExam/startExam so goTo() can
    // safely move the engine's cursor to the saved position.
    const snap = redirect.consumeSnapshot();

    // Self-consume the return stack if it's still pointing here. This
    // covers the case where the returning page used history.back()
    // instead of consumeAndReturn() — otherwise the stack would grow
    // on every subsequent redirect from this page.
    try {
      const top = redirect.peekReturn();
      const myUrl =
        window.location.pathname +
        (window.location.search || '') +
        (window.location.hash || '');
      if (top && top.url === myUrl) redirect.popReturn();
    } catch (err) {
      console.warn('[ExamRoom] Return-stack cleanup failed:', err);
    }

    // ── Setup UI shells ─────────────────────────────────────────────
    if (examMode === 'standard') {
      setupStandardUI();
    } else if (examMode === 'revision') {
      setupRevisionUI();
    } else if (examMode === 'shared') {
      setupSharedUI();
    }

    layout.style.display = 'flex';
    shimmer.style.display = 'none';

    if (examMode !== 'shared') {
      // renderQuestion() reads currentQuestionIndex, which the adapter
      // has already restored — so we render at the right question.
      renderQuestion();
      startTimer();
      if (examMode === 'revision') {
        setTimeout(ensureFooterVisible, 200);
      }
    }
    setupAutoSave();
    setupEventListeners();
    updateProgress();

    // Friendly confirmation that a redirect round-trip resumed state.
    if (snap && snap.page && typeof snap.page.currentQuestionIndex === 'number') {
      ui.showToast('Continuing where you left off', 'info', 1800);
      console.log('[ExamRoom] Resumed at question', snap.page.currentQuestionIndex + 1);
    }
  } catch (error) {
    shimmer.style.display = 'none';
    console.error('[ExamRoom] Failed to start exam:', error);
    ui.showToast('Failed to start exam: ' + error.message, 'error');
    router.navigateTo('exam-settings');
  }
}

// ── STANDARD SETUP ──
function setupStandardUI() {
  $('#mode-badge-std').textContent = 'Standard';
  renderNavGridStandard();
}
function renderNavGridStandard() {
  const grid = $('#nav-grid-std');
  grid.innerHTML = '';
  for (let i = 0; i < totalQuestions; i++) {
    const btn = document.createElement('button');
    btn.className = 'q-btn unseen';
    btn.textContent = i + 1;
    btn.dataset.index = i;
    btn.addEventListener('click', () => jumpToQuestion(i));
    grid.appendChild(btn);
  }
  updateNavGridStandard();
}
function updateNavGridStandard() {
  const btns = document.querySelectorAll('#nav-grid-std .q-btn');
  btns.forEach((btn, i) => {
    const state = examEngine.getQuestionState(i);
    btn.className = 'q-btn';
    if (i === currentQuestionIndex) btn.classList.add('current');
    else if (state.answered) btn.classList.add('answered');
    else if (state.flagged) btn.classList.add('flagged');
    else if (state.visited) btn.classList.add('visited');
    else btn.classList.add('unseen');
  });
}

// ── REVISION SETUP ──
function setupRevisionUI() {
  $('#mode-badge-rev').textContent = 'Revision';
  renderDashNavigatorRevision('rev-dash-progress');
  $('#submit-btn-rev').style.display = 'block';
  $('#next-btn-rev').style.display = 'none';
  $('#next-btn-rev').disabled = true;
}
function renderDashNavigatorRevision(containerId) {
  const container = $(`#${containerId}`);
  container.innerHTML = '';
  for (let i = 0; i < totalQuestions; i++) {
    const dash = document.createElement('span');
    dash.className = 'dash unanswered';
    dash.dataset.index = i;
    dash.addEventListener('click', () => jumpToQuestion(i));
    container.appendChild(dash);
  }
  updateDashNavigatorRevision(containerId);
}
function updateDashNavigatorRevision(containerId) {
  const container = $(`#${containerId}`);
  const dashes = container.querySelectorAll('.dash');
  dashes.forEach((dash, i) => {
    const state = examEngine.getQuestionState(i);
    dash.classList.remove('answered', 'flagged', 'current', 'unanswered');
    if (i === currentQuestionIndex) dash.classList.add('current');
    else if (state.flagged) dash.classList.add('flagged');
    else if (state.answered) dash.classList.add('answered');
    else dash.classList.add('unanswered');
  });
}

// ── SHARED SETUP ──
function setupSharedUI() {
  const badge = $('#mode-badge-shared');
  if (badge) badge.textContent = 'Shared';
  initSharedMode();
}
function initSharedMode() {
  const questionsList = examEngine.getAllQuestions();
  totalQuestions = questionsList.length;
  $('#shared-total-questions').textContent = totalQuestions;
  if (totalQuestions === 0) {
    ui.showToast('No questions for this challenge', 'error');
    return;
  }

  const els = {
    title: $('#shared-room-title'),
    creator: $('#shared-creator'),
    topic: $('#shared-topic'),
    timer: $('#shared-timer'),
    participants: $('#shared-participants'),
    progressFill: $('#shared-progress-fill'),
    progressFraction: $('#shared-progress-fraction'),
    answeredCount: $('#shared-answered-count'),
    remainingCount: $('#shared-remaining-count'),
    dashProgress: $('#shared-dash-progress'),
    questionsArea: $('#shared-questions-area'),
    submitAnswered: $('#shared-submit-answered'),
    submitUnanswered: $('#shared-submit-unanswered'),
    submitBtn: $('#shared-submit-btn'),
    floatingBtn: $('#shared-floating-discuss-btn'),
    discussBadge: $('#shared-discuss-badge'),
    discussionSheet: $('#shared-discussion-sheet'),
    sheetDragHandle: $('#shared-sheet-drag-handle'),
    sheetCloseBtn: $('#shared-sheet-close-btn'),
    sheetContent: $('#shared-sheet-content'),
    chatMessages: $('#shared-chat-messages'),
    chatInput: $('#shared-chat-input'),
    chatSendBtn: $('#shared-chat-send-btn'),
    confirmModal: $('#shared-confirm-modal'),
    confirmText: $('#shared-confirm-text'),
    confirmCancel: $('#shared-confirm-cancel'),
    confirmSubmit: $('#shared-confirm-submit'),
    moodOptions: $('#shared-mood-options'),
    onlineUsers: $('#shared-online-users')
  };

  els.title.textContent = '📚 Shared Challenge';
  els.topic.textContent = examEngine.getSubject() || 'Mixed Topics';

  const config = examEngine.getConfig() || JSON.parse(localStorage.getItem('pendingExamConfig') || '{}');

const totalExamSeconds = timer.getTotalTimeForQuestions(questionsList);

  // Start global countdown
  if (globalTimerInstance) globalTimerInstance.stop();
  globalTimerInstance = timer.createTimer(1, 'fixed', totalExamSeconds);
  globalTimerInstance.start(
    (timeData) => {
      const remaining = timeData.remaining;
      const totalSec = Math.floor(remaining / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      els.timer.textContent = `⏱ ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
      const colors = { green: '#10b981', yellow: '#f59e0b', red: '#ef4444' };
      els.timer.style.color = colors[timeData.color] || '#e67e22';
      els.timer.style.fontWeight = timeData.shouldFlash ? 'bold' : '600';
      if (timeData.shouldFlash) {
        els.timer.classList.add('warning');
      } else {
        els.timer.classList.remove('warning');
      }
    },
    () => {
      if (!isFinished) {
        ui.showToast('⏰ Time is up! Submitting your answers.', 'warning');
        submitSharedExam(els, questionsList);
      }
    }
  );

  // Chat & participants
  const roomId = config.challengeCode || 'shared-room-default';
  examChat.initChat(roomId, {
    onChatUpdate: (messages) => {
      renderChat(els, messages);
      if (sheetState === 'closed' && messages.length > 0) {
        els.discussBadge.style.display = 'flex';
        els.discussBadge.textContent = messages.length;
      }
    },
    onParticipantUpdate: (data) => {
      els.creator.textContent = data.creator || 'Unknown';
      els.participants.textContent = `👥 ${data.count || 0}`;
      els.participants.classList.add('updating');
      setTimeout(() => els.participants.classList.remove('updating'), 400);
      if (els.onlineUsers && data.onlineUsers) {
        els.onlineUsers.innerHTML = data.onlineUsers.map(u =>
          `<span class="presence-user"><span class="online-dot"></span> ${u}</span>`
        ).join('') || '—';
      }
    }
  });

  const SECTION_SIZE = 10;
  const orderedSections = {};
  const usedNames = new Set();
  let partCounter = 1;
  for (let i = 0; i < totalQuestions; i += SECTION_SIZE) {
    const chunk = questionsList.slice(i, i + SECTION_SIZE);
    const firstQ = chunk[0];
    let secName = firstQ.section;
    if (!secName || usedNames.has(secName)) {
      secName = `Part ${partCounter++}`;
    }
    usedNames.add(secName);
    orderedSections[secName] = chunk.map((q, idxOffset) => ({ ...q, globalIndex: i + idxOffset }));
  }

  renderDashNavigator(els.dashProgress, totalQuestions);
  renderSections(els.questionsArea, orderedSections, els);

  // ── SLIDE IMAGE: hydrate every image slot after the sections are
  //    in the DOM. Fire-and-forget — images pop in as their Blobs
  //    resolve, the rest of the UI is already interactive.
  hydrateSharedImages(questionsList).catch(err =>
    console.warn('[ExamRoom] hydrateSharedImages failed:', err)
  );

  attachSharedHandlers(els, questionsList);
  updateAllSharedUI(els, questionsList);

  els.submitBtn.addEventListener('click', () => {
    if (isFinished) return;
    const answered = countAnswered(questionsList);
    els.confirmText.textContent = `Answered: ${answered} | Unanswered: ${totalQuestions - answered}`;
    els.confirmModal.classList.add('active');
  });
  els.confirmCancel.addEventListener('click', () => els.confirmModal.classList.remove('active'));
  els.confirmSubmit.addEventListener('click', () => {
    els.confirmModal.classList.remove('active');
    submitSharedExam(els, questionsList);
  });
  els.confirmModal.addEventListener('click', (e) => {
    if (e.target === els.confirmModal) els.confirmModal.classList.remove('active');
  });

  initDiscussion(els);
}

// ── SHARED RENDERING HELPERS ──
function renderDashNavigator(container, total) {
  container.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dash = document.createElement('span');
    dash.className = 'dash unanswered';
    dash.dataset.index = i;
    dash.addEventListener('click', () => {
      currentQuestionIndex = i;
      navigateToQuestion(i);
      updateDashNavigator(container, examEngine.getAllQuestions());
    });
    container.appendChild(dash);
  }
}
function updateDashNavigator(container, questionsList) {
  const dashes = container.querySelectorAll('.dash');
  dashes.forEach((dash, i) => {
    const state = examEngine.getQuestionState(i);
    dash.classList.remove('answered', 'flagged', 'current', 'unanswered');
    if (i === currentQuestionIndex) dash.classList.add('current');
    else if (state.flagged) dash.classList.add('flagged');
    else if (state.answered) dash.classList.add('answered');
    else dash.classList.add('unanswered');
  });
}
function renderSections(area, sections, els) {
  area.innerHTML = '';
  let isFirst = true;
  Object.entries(sections).forEach(([secTitle, qs]) => {
    const block = document.createElement('div');
    block.className = 'section-block';
    if (isFirst) { block.classList.add('expanded'); isFirst = false; }
    block.dataset.section = secTitle;
    const answeredInSection = qs.filter(q => examEngine.getQuestionState(q.globalIndex).answered).length;
    const totalInSection = qs.length;
    let badge = '';
    if (answeredInSection === totalInSection) badge = '<span class="section-badge badge-complete">✓ Completed</span>';
    else if (answeredInSection > 0) badge = `<span class="section-badge badge-in-progress">${answeredInSection}/${totalInSection}</span>`;
    block.innerHTML = `
      <div class="section-header" data-section="${secTitle}">
        <span class="section-title">
          <span class="chevron">▼</span>
          <span>${secTitle}</span>
          <span style="font-weight:400;font-size:0.75rem;color:#8b949e;">(${qs[0].globalIndex + 1}–${qs[qs.length - 1].globalIndex + 1})</span>
        </span>
        ${badge}
      </div>
      <div class="section-questions">
        ${qs.map(q => buildQuestionCard(q)).join('')}
      </div>
    `;
    area.appendChild(block);
    block.querySelector('.section-header').addEventListener('click', () => {
      block.classList.toggle('expanded');
      if (block.classList.contains('expanded')) {
        updateSectionBadge(block, secTitle, qs);
      }
    });
  });
}
function buildQuestionCard(q) {
  const answered = examEngine.getQuestionState(q.globalIndex).answered;
  const flagged = examEngine.getQuestionState(q.globalIndex).flagged;
  const savedIndicator = answered ? '<span class="save-indicator">✓ Saved</span>' : '<span class="save-indicator" style="opacity:0;"></span>';

  // ── SLIDE IMAGE: empty slot keyed by question index. The actual
  //    <img> is injected asynchronously by hydrateSharedImages() so
  //    no user/zip-controlled string ever enters the HTML.
const imageHtml = q.image
  ? `<div class="question-image" data-q-idx="${q.globalIndex}"></div>`
  : '';

  return `
    <div class="question-card" id="questionCard-${q.globalIndex}">
      ${savedIndicator}
      <div class="q-header">
        <span class="q-number">Q${q.globalIndex + 1}.</span>
        <span class="q-text">${q.question}</span>
        <button class="flag-btn ${flagged ? 'flagged' : ''}" data-index="${q.globalIndex}" title="Mark for review">★</button>
      </div>
      ${imageHtml}
      <div class="options-list" data-index="${q.globalIndex}">
        ${q.options.map((opt, oi) => `
          <div class="option-item ${examEngine.getAnswer(q.globalIndex)?.selectedOption === String.fromCharCode(65 + oi) ? 'selected' : ''}" data-index="${q.globalIndex}" data-option="${String.fromCharCode(65 + oi)}">
            <div class="option-radio"></div>
            <span>${opt.text}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

// ── SLIDE IMAGE: bulk hydrator for shared/challenge mode ──
//
// Shared mode renders all questions at once, so we hydrate every image
// slot in one pass rather than the single-image pattern used by
// renderQuestionImage(). Same static-vs-slide split:
//
//   • static subject  → /data/images/{subject}/{filename}
//   • slide subject   → Blob from IndexedDB → object-URL
//
// Object-URLs are collected in _sharedImageUrls and revoked on
// teardown. Failures are logged, not thrown — a missing image must
// not stop the rest of the review list from rendering.
async function hydrateSharedImages(questionsList) {
 const slots = document.querySelectorAll('#shared-layout .question-image[data-q-idx]');
  if (slots.length === 0) return;

  const examSubject = examEngine.getSubject();

  for (const slot of slots) {
    const idx = parseInt(slot.dataset.qIdx, 10);
    const q = questionsList[idx];
    if (!q || !q.image) continue;

    const subject  = q.subject || examSubject;
    if (!subject) continue;

    const filename = q.image;
    const meta = questions.getSubjectMeta(subject);

    try {
      if (meta.source === 'slide') {
        const blob = await slideData.getSlideImage(subject, filename);
        if (!blob) {
          console.warn(`[ExamRoom] Shared slide image missing: ${subject}/${filename}`);
          continue;
        }
        const url = URL.createObjectURL(blob);
        _sharedImageUrls.add(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Question diagram';
        img.loading = 'lazy';
        slot.appendChild(img);
      } else {
        // Static subject — plain URL, onerror drops the element so a
        // 404 doesn't leave a broken <img> icon in the card.
        const img = document.createElement('img');
        img.src = `/data/images/${encodeURIComponent(subject)}/${encodeURIComponent(filename)}`;
        img.alt = 'Question diagram';
        img.loading = 'lazy';
        img.onerror = () => img.remove();
        slot.appendChild(img);
      }
    } catch (e) {
      console.warn(`[ExamRoom] Failed to load shared image ${subject}/${filename}:`, e);
    }
  }
}

function attachSharedHandlers(els, questionsList) {
  document.querySelectorAll('#shared-layout .option-item').forEach(item => {
    item.addEventListener('click', function (e) {
      if (isFinished) return;
      const idx = parseInt(this.dataset.index);
      const optionLetter = this.dataset.option;
      selectAnswer(idx, optionLetter, els, questionsList);
    });
  });
  document.querySelectorAll('#shared-layout .flag-btn').forEach(btn => {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (isFinished) return;
      const idx = parseInt(this.dataset.index);
      toggleFlagAtIndex(idx, els, questionsList);
    });
  });
}
function selectAnswer(index, optionLetter, els, questionsList) {
  examEngine.submitAnswerAtIndex(index, optionLetter, 0);
  const card = document.getElementById('questionCard-' + index);
  if (card) {
    card.querySelectorAll('.option-item').forEach(opt => {
      opt.classList.toggle('selected', opt.dataset.option === optionLetter);
    });
    const saveInd = card.querySelector('.save-indicator');
    if (saveInd) { saveInd.textContent = '✓ Saved'; saveInd.classList.add('visible'); }
    card.querySelector('.flag-btn')?.classList.remove('flagged');
  }
  currentQuestionIndex = index;
  updateAllSharedUI(els, questionsList);
  checkAutoSectionProgress(index, questionsList);
}
function toggleFlagAtIndex(index, els, questionsList) {
  examEngine.toggleFlagAtIndex(index);
  const card = document.getElementById('questionCard-' + index);
  if (card) {
    card.querySelector('.flag-btn')?.classList.toggle('flagged', examEngine.getQuestionState(index).flagged);
  }
  updateAllSharedUI(els, questionsList);
}
function updateAllSharedUI(els, questionsList) {
  const answeredCount = countAnswered(questionsList);
  const percent = totalQuestions > 0 ? (answeredCount / totalQuestions) * 100 : 0;
  els.progressFill.style.width = percent + '%';
  els.progressFraction.textContent = `${answeredCount}/${totalQuestions}`;
  els.answeredCount.textContent = answeredCount;
  els.remainingCount.textContent = totalQuestions - answeredCount;
  els.submitAnswered.textContent = answeredCount;
  els.submitUnanswered.textContent = totalQuestions - answeredCount;
  els.submitBtn.disabled = answeredCount === 0;
  updateDashNavigator(els.dashProgress, questionsList);
  document.querySelectorAll('#shared-layout .section-block').forEach(block => {
    const secTitle = block.dataset.section;
    const sectionQuestions = [];
    questionsList.forEach((q, idx) => {
      if ((q.section || `Part ${Math.floor(idx / 10) + 1}`) === secTitle) sectionQuestions.push({ ...q, globalIndex: idx });
    });
    updateSectionBadge(block, secTitle, sectionQuestions);
  });
}
function updateSectionBadge(block, secTitle, qs) {
  const answered = qs.filter(q => examEngine.getQuestionState(q.globalIndex).answered).length;
  const header = block.querySelector('.section-header');
  header.querySelector('.section-badge')?.remove();
  if (answered === qs.length) {
    header.insertAdjacentHTML('beforeend', '<span class="section-badge badge-complete">✓ Completed</span>');
  } else if (answered > 0) {
    header.insertAdjacentHTML('beforeend', `<span class="section-badge badge-in-progress">${answered}/${qs.length}</span>`);
  }
}
function countAnswered(questionsList) {
  let c = 0;
  questionsList.forEach((_, i) => { if (examEngine.getQuestionState(i).answered) c++; });
  return c;
}
function navigateToQuestion(index) {
  const card = document.getElementById('questionCard-' + index);
  if (!card) return;
  const block = card.closest('.section-block');
  if (block && !block.classList.contains('expanded')) block.classList.add('expanded');
  const top = card.getBoundingClientRect().top + window.scrollY - 150;
  window.scrollTo({ top, behavior: 'smooth' });
  card.classList.add('highlight-flash');
  setTimeout(() => card.classList.remove('highlight-flash'), 800);
}
function checkAutoSectionProgress(index, questionsList) {
  const currentQ = questionsList[index];
  const secKey = currentQ.section || `Part ${Math.floor(index / 10) + 1}`;
  const sectionQs = questionsList.filter((q, idx) => (q.section || `Part ${Math.floor(idx / 10) + 1}`) === secKey);
  if (sectionQs.every(q => examEngine.getQuestionState(q.globalIndex ?? questionsList.indexOf(q)).answered)) {
    const allBlocks = [...document.querySelectorAll('#shared-layout .section-block')];
    let found = false;
    for (const block of allBlocks) {
      if (block.dataset.section === secKey) { found = true; continue; }
      if (found) { block.classList.add('expanded'); break; }
    }
  }
}
async function submitSharedExam(els, questionsList) {
  if (isFinished) return;
  isFinished = true;
  if (globalTimerInstance) {
    globalTimerInstance.stop();
    globalTimerInstance = null;
  }
  ui.showLoading('Submitting...');
  try {
    const results = await examEngine.endExam();
    await db.saveExamResult(results);
    ui.hideLoading();
    ui.showToast('Exam completed!', 'success');
    router.navigateTo('results', { examId: results.examId });
  } catch (error) {
    ui.hideLoading();
    ui.showToast('Error finishing exam: ' + error.message, 'error');
    router.navigateTo('subjects');
  }
}

// ── DISCUSSION ──
let sheetState = 'closed';
function initDiscussion(els) {
  els.floatingBtn.addEventListener('click', () => {
    if (sheetState === 'closed') openSheet('half', els); else closeSheet(els);
  });
  els.sheetCloseBtn.addEventListener('click', () => closeSheet(els));
  els.chatSendBtn.addEventListener('click', () => sendChatMessage(els));
  els.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChatMessage(els); });

  let dragStart = 0, startY = 0, isDragging = false;
  els.sheetDragHandle.addEventListener('pointerdown', e => {
    if (sheetState === 'closed') return;
    isDragging = true; dragStart = e.clientY;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(els.discussionSheet).transform);
    startY = els.discussionSheet.offsetHeight ? (matrix.m42 / els.discussionSheet.offsetHeight) * 100 : 100;
    els.discussionSheet.classList.add('no-transition');
  });
  window.addEventListener('pointermove', e => {
    if (!isDragging) return;
    const delta = (e.clientY - dragStart) / els.discussionSheet.offsetHeight * 100;
    const newY = Math.min(100, Math.max(0, startY + delta));
    els.discussionSheet.style.transform = `translateX(-50%) translateY(${newY}%)`;
  });
  window.addEventListener('pointerup', () => {
    if (!isDragging) return;
    isDragging = false;
    els.discussionSheet.classList.remove('no-transition');
    const matrix = new DOMMatrixReadOnly(getComputedStyle(els.discussionSheet).transform);
    const currentY = els.discussionSheet.offsetHeight ? (matrix.m42 / els.discussionSheet.offsetHeight) * 100 : 100;
    if (currentY < 25) openSheet('full', els);
    else if (currentY < 65) openSheet('half', els);
    else closeSheet(els);
  });

  els.moodOptions.addEventListener('click', e => {
    const chip = e.target.closest('.mood-chip');
    if (!chip) return;
    const strong = chip.querySelector('strong');
    if (strong) strong.textContent = parseInt(strong.textContent) + 1;
    chip.classList.add('voted');
    setTimeout(() => chip.classList.remove('voted'), 500);
  });
}
async function sendChatMessage(els) {
  const text = els.chatInput.value.trim();
  if (!text) return;
  const success = await examChat.sendMessage(text);
  if (success) {
    els.chatInput.value = '';
  } else {
    ui.showToast('Message failed to send', 'error');
  }
}
function openSheet(state, els) {
  els.discussionSheet.classList.remove('half-open', 'full-open');
  els.discussionSheet.classList.add(state === 'half' ? 'half-open' : 'full-open');
  sheetState = state;
  els.floatingBtn.classList.add('hidden');
  els.discussBadge.style.display = 'none';
  els.sheetContent.scrollTop = els.sheetContent.scrollHeight;
}
function closeSheet(els) {
  els.discussionSheet.classList.remove('half-open', 'full-open');
  els.discussionSheet.style.transform = 'translateX(-50%) translateY(100%)';
  sheetState = 'closed';
  els.floatingBtn.classList.remove('hidden');
}
function renderChat(els, messages) {
  if (!messages) messages = [];
  els.chatMessages.innerHTML = messages.map(m =>
    `<div class="chat-message ${m.author === 'You' ? 'own-message' : ''}">
      <span class="chat-author">${m.author === 'You' ? '<span class="author-you">You</span>' : m.author}</span>
      <span class="chat-body">${m.body}</span>
    </div>`
  ).join('');
  $('#shared-msg-count').textContent = `(${messages.length} messages)`;
}

// ── CORE RENDER FUNCTION ──
function renderQuestion() {
  if (examMode === 'shared') return;
  const current = examEngine.getCurrentQuestion();
  if (!current) return;

  const isStd = examMode === 'standard';
  const isRev = examMode === 'revision';
  const qCounter = $(isStd ? '#q-counter-std' : '#q-counter-rev');
  const qText = $(isStd ? '#q-text-std' : '#q-text-rev');
  const qImage = $(isStd ? '#q-image-std' : '#q-image-rev');
  const answersList = $(isStd ? '#answers-list-std' : '#answers-list-rev');
  const flagBtn = $(isStd ? '#flag-btn-std' : '#flag-btn-rev');

  qCounter.textContent = `Question ${currentQuestionIndex + 1} / ${totalQuestions}`;
  qText.textContent = current.question;

  answersList.innerHTML = current.options.map((opt, idx) => {
    const letter = String.fromCharCode(65 + idx);
    const currentAnswer = examEngine.getCurrentAnswer();
    const isSelected = currentAnswer?.selectedOption === letter;
    return `
      <li>
        <label class="option-item ${isSelected ? 'selected' : ''}" data-option="${letter}" data-index="${idx}">
          <input type="radio" name="question" value="${letter}" ${isSelected ? 'checked' : ''} style="display:none;">
          <span class="option-letter">${letter}</span>
          <span class="option-text">${opt.text}</span>
        </label>
      </li>
    `;
  }).join('');

  const existingFeedbacks = answersList.querySelectorAll('.option-feedback');
  existingFeedbacks.forEach(el => el.remove());
  const overallDiv = $('#overall-explanation-rev');
  if (overallDiv) overallDiv.style.display = 'none';

  answersList.querySelectorAll('.option-item').forEach(item => {
    item.addEventListener('click', function () {
      const letter = this.dataset.option;
      if (isStd) submitAnswerStd(letter);
      else if (isRev) {
        if (examEngine.isQuestionSubmitted(currentQuestionIndex)) return;
        examEngine.submitAnswer(letter, 0);
        $('#submit-btn-rev').disabled = false;
        this.parentElement.querySelectorAll('.option-item').forEach(el => el.classList.remove('selected'));
        this.classList.add('selected');
      }
    });
  });

  const flagged = examEngine.isCurrentQuestionFlagged();
  flagBtn.classList.toggle('flagged', flagged);
  flagBtn.innerHTML = flagged ? '🏳️ Unflag' : '🏴 Flag';

  // ── SLIDE IMAGE: replaces the inline single-line <img> lookup with a
  //    call that handles both static (URL from /data/images/) and slide
  //    (Blob from IndexedDB) cases. Question JSONs reference images by
  //    bare filename — e.g. "image": "liver.avif" — which is exactly
  //    what slideData.getSlideImage(subject, filename) expects.
  renderQuestionImage(qImage, current);

  if (isRev) {
    const submitBtn = $('#submit-btn-rev');
    const nextBtn = $('#next-btn-rev');
    const alreadySubmitted = examEngine.isQuestionSubmitted(currentQuestionIndex);

    if (alreadySubmitted) {
      restoreRevisionFeedback();
      document.querySelectorAll('#answers-list-rev .option-item').forEach(el => el.style.pointerEvents = 'none');
      submitBtn.style.display = 'none';
      nextBtn.style.display = 'block';
      nextBtn.disabled = false;

      // 🔁 On last question, change "Next →" to "Submit Exam"
      const isLast = currentQuestionIndex === totalQuestions - 1;
      nextBtn.textContent = isLast ? '📤 Submit Exam' : 'Next →';
    } else {
      document.querySelectorAll('#answers-list-rev .option-item').forEach(el => el.style.pointerEvents = 'auto');
      submitBtn.style.display = 'block';
      nextBtn.style.display = 'none';
      nextBtn.disabled = true;
      // Reset button text when not submitted
      nextBtn.textContent = 'Next →';
    }
  }
  if (isRev) setTimeout(ensureFooterVisible, 100);
  updateProgress();
  if (isStd) updateNavGridStandard();
  else if (isRev) updateDashNavigatorRevision('rev-dash-progress');
  updateNavButtons();
}

// ── SLIDE IMAGE: question-image renderer (standard & revision) ──
//
// Static subjects: images live on the web server at
//   /data/images/{subject}/{filename}
// and the question's `image` field is a bare filename. Nothing changes
// for these — same URL as before.
//
// Slide subjects: images live in IndexedDB, written by slide-data.js
// at download time. They need to be loaded as Blobs and exposed via an
// object-URL for the <img src>. The `image` field is still a bare
// filename, matching what slideData.getSlideImage(subject, filename)
// expects.
//
// Async because the IndexedDB read is async. renderQuestion() does not
// await it — the rest of the question UI (text, options, flag) renders
// immediately, and the image pops in once the blob resolves. A
// generation counter ensures a fast sequence of question navigations
// can't leave a stale blob bound to the <img> after a newer render.
//
// Object-URL lifecycle: revoke before minting the next one, and revoke
// on teardown (see beforeunload / destroy below).
async function renderQuestionImage(qImageEl, question) {
  const gen = ++_imageGen;

  // Drop the previous blob's URL before minting a new one.
  if (_currentImageUrl) {
    URL.revokeObjectURL(_currentImageUrl);
    _currentImageUrl = null;
  }

  if (!qImageEl) return;

  if (!question.image) {
    qImageEl.innerHTML = '';
    qImageEl.style.display = 'none';
    return;
  }

  const meta = questions.getSubjectMeta(question.subject);

  // Static (or unknown) subject — URL-based rendering, unchanged from
  // before this fix. `source: 'unknown'` falls through here as well;
  // a genuinely missing subject would 404 the same way it did prior
  // to this change, which is the correct parity.
  if (meta.source !== 'slide') {
    qImageEl.innerHTML = `<img src="/data/images/${question.subject}/${question.image}" alt="Diagram">`;
    qImageEl.style.display = 'block';
    return;
  }

  // Slide subject — fetch the Blob from IndexedDB.
  try {
    const blob = await slideData.getSlideImage(question.subject, question.image);
    if (gen !== _imageGen) return;      // superseded by a newer render
    if (!blob) {
      console.warn(`[ExamRoom] Slide image missing: ${question.subject}/${question.image}`);
      qImageEl.innerHTML = '';
      qImageEl.style.display = 'none';
      return;
    }
    _currentImageUrl = URL.createObjectURL(blob);
    qImageEl.innerHTML = `<img src="${_currentImageUrl}" alt="Diagram">`;
    qImageEl.style.display = 'block';
  } catch (err) {
    if (gen !== _imageGen) return;
    console.warn('[ExamRoom] Failed to load slide image:', err);
    qImageEl.innerHTML = '';
    qImageEl.style.display = 'none';
  }
}

function restoreRevisionFeedback() {
  const feedback = examEngine.getRevisionFeedback();
  if (!feedback) return;
  const answersList = $('#answers-list-rev');
  const selectedItem = answersList.querySelector(`.option-item[data-option="${feedback.selectedOption}"]`);
  const correctItem = answersList.querySelector(`.option-item[data-option="${feedback.correctOption}"]`);

  function appendExplanationAfter(element, text, isCorrect) {
    if (!element) return;
    const feedbackDiv = document.createElement('div');
    feedbackDiv.className = 'option-feedback';
    const icon = isCorrect ? '✅' : '❌';
    const bgColor = isCorrect ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)';
    feedbackDiv.innerHTML = `
      <div style="display:flex; align-items:flex-start; gap:0.5rem; padding:0.5rem; background:${bgColor}; border-radius:8px; margin-top:4px;">
        <span>${icon}</span>
        <span style="flex:1;">${text}</span>
      </div>
    `;
    element.parentNode.insertBefore(feedbackDiv, element.nextSibling);
  }

  if (selectedItem) {
    appendExplanationAfter(selectedItem, `${feedback.selectedText} — ${feedback.selectedExplanation}`, feedback.isCorrect);
  }
  if (!feedback.isCorrect && correctItem) {
    appendExplanationAfter(correctItem, `Correct answer: ${feedback.correctText} — ${feedback.correctExplanation}`, true);
  }

  const overall = feedback.overallExplanation;
  const overallDiv = $('#overall-explanation-rev');
  if (overallDiv) {
    $('#overall-overview').textContent = overall.overview || '';
    $('#overall-highyield').innerHTML = overall.highYield ? `<strong>High‑Yield:</strong> ${overall.highYield}` : '';
    $('#overall-clinical').innerHTML = overall.clinicalCorrelation ? `<strong>Clinical:</strong> ${overall.clinicalCorrelation}` : '';
    overallDiv.style.display = 'block';
  }
}

function submitAnswerStd(letter) {
  const timeSpent = timerInstance?.getTimeSpent() / 1000 || 0;
  examEngine.submitAnswer(letter, timeSpent);
  renderQuestion();
  examEngine.autoSave();
}
function jumpToQuestion(index) {
  examEngine.goTo(index);
  currentQuestionIndex = index;
  renderQuestion();
  resetTimerForCurrentQuestion();
}
function toggleFlag() {
  examEngine.toggleCurrentFlag();
  renderQuestion();
  examEngine.autoSave();
}
function nextQuestion() {
  if (examEngine.hasNext()) {
    examEngine.next();
    currentQuestionIndex++;
    renderQuestion();
    setTimeout(ensureFooterVisible, 100);
    resetTimerForCurrentQuestion();
    return;
  }
  // Revision mode: the Next button on the last question is relabelled
  // "Submit Exam" — finishing directly is the intended behaviour there.
  if (examMode === 'revision') {
    finishExam();
    return;
  }
  // Standard mode: the Next button is hidden on the last question, but
  // the ArrowRight keyboard shortcut can still fire this function.
  // Route through the same confirmation the Submit button uses.
  if (examMode === 'standard') {
    promptAndFinish();
  }
}
function prevQuestion() {
  if (examEngine.hasPrev()) {
    examEngine.prev();
    currentQuestionIndex--;
    renderQuestion();
    resetTimerForCurrentQuestion();
  }
}
async function finishExam() {
  if (isFinished) return;
  isFinished = true;
  ui.showLoading('Calculating results...');

  // Split the try so we can distinguish a fatal endExam failure (stay on
  // the exam room, let the user retry) from non-fatal post-processing
  // (still navigate to results — the exam was already saved inside
  // endExam before the enrichment step).
  let results = null;
  try {
    results = await examEngine.endExam();
  } catch (err) {
    console.error('[ExamRoom] endExam failed:', err);
    ui.hideLoading();
    isFinished = false;  // allow retry
    ui.showToast(
      'Failed to submit exam: ' + (err && err.message ? err.message : 'unknown error'),
      'error'
    );
    return;
  }

  // Best-effort safety save. endExam already persisted the result; this
  // protects against a partial enrichment failure leaving the record in
  // a half-written state.
  try {
    await db.saveExamResult(results);
  } catch (saveErr) {
    console.warn('[ExamRoom] Final save failed (non-fatal):', saveErr);
  }

  ui.hideLoading();
  ui.showToast('Exam completed!', 'success');

  try {
    router.navigateTo('results', { examId: results.examId });
  } catch (navErr) {
    console.error('[ExamRoom] Navigation to results failed:', navErr);
    ui.showToast('Result saved. Open Performance to view it.', 'info');
    try { router.navigateTo('performance'); } catch { /* ignore */ }
  }
}

function startTimer() {
  if (examMode === 'revision' || examMode === 'shared') return;
  const difficulty = examEngine.getCurrentQuestion()?.difficulty || 3;
  const config = examEngine.getConfig();
  const timingMode = config?.timingMode || 'adaptive';
  const customTime = config?.fixedTimePerQuestion || 30;
  timerInstance = timer.createTimer(difficulty, timingMode, customTime);
  const timerEl = $('#timer-display-std');
  if (!timerEl) return;
  timerInstance.start(
    (timeData) => {
      timerEl.textContent = timer.formatTime(timeData.remaining);
      const parent = timerEl.closest('.timer');
      if (parent) {
        parent.className = `timer ${timeData.color}`;
        if (timeData.shouldFlash) parent.classList.add('flash');
      }
    },
    () => ui.showToast('Time expired!', 'warning')
  );
}
function resetTimerForCurrentQuestion() {
  if (timerInstance) timerInstance.stop();
  if (examMode !== 'revision' && examMode !== 'shared') startTimer();
}

function setupAutoSave() {
  autoSaveInterval = setInterval(async () => {
    if (!isFinished) await examEngine.autoSave();
  }, 30000);
}

function setupEventListeners() {
  if (examEngine.getConfig()?.preventCopyPaste) {
    document.addEventListener('copy', e => e.preventDefault());
    document.addEventListener('paste', e => e.preventDefault());
    document.addEventListener('cut', e => e.preventDefault());
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') nextQuestion();
    if (e.key === 'ArrowLeft') prevQuestion();
    if (e.key === 'f' || e.key === 'F') toggleFlag();
  });

  // Standard mode buttons
  $('#prev-btn-std')?.addEventListener('click', prevQuestion);
  $('#next-btn-std')?.addEventListener('click', nextQuestion);
  $('#prev-nav-std')?.addEventListener('click', prevQuestion);
  $('#next-nav-std')?.addEventListener('click', nextQuestion);
  // Route Submit and keyboard-driven "Next on last question" through the
  // same confirmation flow so behaviour is consistent.
  $('#submit-exam-btn')?.addEventListener('click', promptAndFinish);
  $('#flag-btn-std')?.addEventListener('click', toggleFlag);

  // Revision mode buttons
  $('#prev-btn-rev')?.addEventListener('click', prevQuestion);
  $('#submit-btn-rev')?.addEventListener('click', () => {
    const answer = examEngine.getCurrentAnswer();
    if (!answer || !answer.selectedOption) {
      ui.showToast('Please select an option', 'warning');
      return;
    }
    renderQuestion();
  });
  $('#next-btn-rev')?.addEventListener('click', nextQuestion);
  $('#flag-btn-rev')?.addEventListener('click', toggleFlag);

  // Exit button
  $('#exit-btn')?.addEventListener('click', () => router.navigateTo('subjects'));
  $('#back-btn-rev')?.addEventListener('click', () => router.navigateTo('subjects'));

  // Fullscreen / distraction
  $('#fullscreen-btn')?.addEventListener('click', toggleFullscreen);
  $('#distraction-btn')?.addEventListener('click', toggleDistractionFree);
}

function updateNavButtons() {
  if (examMode === 'shared') return;
  const isStd = examMode === 'standard';
  const isRev = examMode === 'revision';
  if (!isStd && !isRev) return;

  const atFirst = currentQuestionIndex === 0;
  const atLast = currentQuestionIndex === totalQuestions - 1;

  const prevBtns = [
    document.getElementById(isStd ? 'prev-btn-std' : 'prev-btn-rev'),
    isStd ? document.getElementById('prev-nav-std') : null,
  ].filter(Boolean);

  const nextBtns = [
    document.getElementById(isStd ? 'next-btn-std' : 'next-btn-rev'),
    isStd ? document.getElementById('next-nav-std') : null,
  ].filter(Boolean);

  // Hide "Previous" on the first question. `visibility: hidden` keeps the
  // button occupying its slot so the Next button never jumps around as the
  // user navigates between first/non-first questions.
  for (const btn of prevBtns) {
    btn.style.visibility = atFirst ? 'hidden' : '';
    btn.setAttribute('aria-hidden', atFirst ? 'true' : 'false');
    btn.tabIndex = atFirst ? -1 : 0;
  }

  // Standard mode: hide "Next" on the last question — Submit takes over.
  // Revision mode: keep Next visible — it is relabelled "Submit Exam" there.
  const hideNext = isStd && atLast;
  for (const btn of nextBtns) {
    btn.style.visibility = hideNext ? 'hidden' : '';
    btn.setAttribute('aria-hidden', hideNext ? 'true' : 'false');
    btn.tabIndex = hideNext ? -1 : 0;
  }
}

async function promptAndFinish() {
  if (examMode !== 'standard') return;
  if (isFinished) return;

  let ok = false;
  try {
    ok = await ui.showConfirmationDialog(
      'Submit Exam',
      'Are you sure? Unanswered questions will be marked wrong.',
      'warning'
    );
  } catch (err) {
    // If the dialog itself fails, do NOT auto-submit. Surface the
    // failure so the button isn't a silent no-op.
    console.error('[ExamRoom] Submit confirmation failed:', err);
    ui.showToast('Could not open confirmation dialog. Please try again.', 'error');
    return;
  }
  if (!ok) return;

  await finishExam();
}

function updateProgress() {
  let answered = 0;
  for (let i = 0; i < totalQuestions; i++) if (examEngine.getQuestionState(i).answered) answered++;
  const percent = totalQuestions > 0 ? (answered / totalQuestions) * 100 : 0;
  if (examMode === 'standard') {
    $('#progress-fill-std').style.width = percent + '%';
    $('#answered-count-std').textContent = `${answered}/${totalQuestions}`;
  } else if (examMode === 'revision') {
    $('#progress-fill-rev').style.width = percent + '%';
    $('#progress-fraction-rev').textContent = `${answered}/${totalQuestions}`;
    $('#answered-rev').textContent = answered;
    $('#remaining-rev').textContent = totalQuestions - answered;
    updateDashNavigatorRevision('rev-dash-progress');
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}
function toggleDistractionFree() {
  document.body.classList.toggle('distraction-free');
}

function ensureFooterVisible() {
  const footer = document.querySelector('.revision-footer');
  if (!footer) return;
  const rect = footer.getBoundingClientRect();
  const windowHeight = window.innerHeight;
  if (rect.bottom > windowHeight || rect.top < 0) {
    footer.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }
}

function showSubscriptionCard(onClose) {
  const card = document.createElement('div');
  card.className = 'subscription-card';
  card.innerHTML = `
    <div class="subscription-card-content">
      <i class="fas fa-crown" style="color:#f5b342;font-size:1.5rem;"></i>
      <div>
        <strong>📘 Premium topics</strong>
        <p>Subscribe to unlock all topics.</p>
      </div>
      <button class="subscribe-now-btn" id="examRoomSubscribeBtn">Subscribe</button>
      <span class="close-card" id="closeSubscriptionCard"><i class="fas fa-times"></i></span>
    </div>
  `;
  document.body.appendChild(card);
  document.getElementById('closeSubscriptionCard').addEventListener('click', () => {
    card.remove();
    if (onClose) onClose();
  });
  // Route Subscribe through the redirect module so a mid-flight login
  // bounce still lands the user back here when they have a plan.
  const subBtn = document.getElementById('examRoomSubscribeBtn');
  if (subBtn) {
    subBtn.addEventListener('click', () => {
      card.remove();
      redirect.navigateWithReturn('subscription', 'subscription_required');
    });
  }
}

window.addEventListener('beforeunload', () => {
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  if (timerInstance) timerInstance.stop();
  if (globalTimerInstance) globalTimerInstance.stop();
  examChat.stopChat();
  examEngine.autoSave();
  // ── SLIDE IMAGE: release all object-URLs so blobs can be GC'd
  if (_currentImageUrl) {
    URL.revokeObjectURL(_currentImageUrl);
    _currentImageUrl = null;
  }
  for (const url of _sharedImageUrls) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  _sharedImageUrls.clear();
});

export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's in-memory state.
  try { redirect.unregisterStateAdapter('exam-room'); } catch { /* ignore */ }

  if (autoSaveInterval) clearInterval(autoSaveInterval);
  if (timerInstance) timerInstance.stop();
  if (globalTimerInstance) globalTimerInstance.stop();
  examChat.stopChat();
  // ── SLIDE IMAGE: release all object-URLs so blobs can be GC'd
  if (_currentImageUrl) {
    URL.revokeObjectURL(_currentImageUrl);
    _currentImageUrl = null;
  }
  for (const url of _sharedImageUrls) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  _sharedImageUrls.clear();
}