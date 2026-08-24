// scripts/pages/exam-room.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as examEngine from '../exam-engine.js';
import * as timer from '../timer.js';
import * as questions from '../questions.js';
import * as db from '../db.js';
import * as security from '../security.js';
import * as subscription from '../subscription.js';
import * as examChat from '../exam-chat.js';

// ── GLOBALS ──
let timerInstance = null;
let globalTimerInstance = null;  // shared mode global timer
let autoSaveInterval = null;
let examMode = 'standard';
let currentQuestionIndex = 0;
let totalQuestions = 0;
let isFinished = false;
let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();
  const shimmer = $('#shimmer-overlay');
  const layouts = {
    standard: $('#standard-layout'),
    revision: $('#revision-layout'),
    shared: $('#shared-layout')
  };

  // Check authentication (app is already initialized)
  if (!auth.checkAuth()) {
    shimmer.style.display = 'none';
    ui.showToast('Please log in first', 'warning');
    router.navigateTo('login');
    return;
  }

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

  if (examMode === 'standard') {
    const hasActiveSub = await subscription.hasActiveSubscription();
    if (!hasActiveSub) {
      const allFree = subscription.areAllTopicsFree(config);
      if (!allFree) {
        shimmer.style.display = 'none';
        showSubscriptionCard(() => router.navigateTo('exam-settings'));
        return;
      }
    }
  }

  try {
    await examEngine.createExam(config);
    examEngine.startExam();
    totalQuestions = examEngine.totalQuestions();
    localStorage.removeItem('pendingExamConfig');

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
      renderQuestion();
      startTimer();
      if (examMode === 'revision') {
        setTimeout(ensureFooterVisible, 200);
      }
    }
    setupAutoSave();
    setupEventListeners();
    updateProgress();
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

  // Compute total exam time
  const DIFFICULTY_SECONDS = { 1: 21, 2: 30, 3: 42, 4: 54, 5: 54 };
  let totalExamSeconds = 0;
  questionsList.forEach(q => {
    const diff = q.difficulty || 3;
    totalExamSeconds += DIFFICULTY_SECONDS[diff] || 42;
  });

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
  return `
    <div class="question-card" id="questionCard-${q.globalIndex}">
      ${savedIndicator}
      <div class="q-header">
        <span class="q-number">Q${q.globalIndex + 1}.</span>
        <span class="q-text">${q.question}</span>
        <button class="flag-btn ${flagged ? 'flagged' : ''}" data-index="${q.globalIndex}" title="Mark for review">★</button>
      </div>
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

  if (current.image) {
    qImage.innerHTML = `<img src="/data/images/${current.subject}/${current.image}" alt="Diagram">`;
    qImage.style.display = 'block';
  } else {
    qImage.style.display = 'none';
  }

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
  } else if (examMode === 'standard' || examMode === 'revision') {
    finishExam();
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
  try {
    const results = await examEngine.endExam();
    await db.saveExamResult(results);
    ui.hideLoading();
    ui.showToast('Exam completed!', 'success');
    router.navigateTo('results', { examId: results.examId });
  } catch (err) {
    ui.hideLoading();
    ui.showToast('Error: ' + err.message, 'error');
    router.navigateTo('subjects');
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
  $('#submit-exam-btn')?.addEventListener('click', () => {
    if (examMode === 'standard') {
      ui.showConfirmationDialog('Submit Exam', 'Are you sure?', 'warning').then(ok => { if (ok) finishExam(); });
    }
  });
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
      <button onclick="router.navigateTo('subscription')" class="subscribe-now-btn">Subscribe</button>
      <span class="close-card" id="closeSubscriptionCard"><i class="fas fa-times"></i></span>
    </div>
  `;
  document.body.appendChild(card);
  document.getElementById('closeSubscriptionCard').addEventListener('click', () => {
    card.remove();
    if (onClose) onClose();
  });
}

window.addEventListener('beforeunload', () => {
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  if (timerInstance) timerInstance.stop();
  if (globalTimerInstance) globalTimerInstance.stop();
  examChat.stopChat();
  examEngine.autoSave();
});

export function destroy() {
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  if (timerInstance) timerInstance.stop();
  if (globalTimerInstance) globalTimerInstance.stop();
  examChat.stopChat();
}