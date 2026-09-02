// scripts/pages/shared-exam.js
import * as ui from '../ui.js';
import * as utils from '../utils.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as db from '../db.js';
import { convexHttpClient } from '../convex-client.js';

let $;
let sharedExamData = null;
let isLoggedIn = false;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // Auth check (app already initialized)
  isLoggedIn = auth.checkAuth();

  // DOM refs
  const authModal = $('#authModal');
  const modalCloseBtn = $('#modalCloseBtn');
  const ctaActions = $('#cta-actions');
  const resultsContainer = $('#shared-results-container');
  const homeBtn = $('#homeBtn');
  const shareBtn = $('#shareBtn');
  const themeToggle = $('#themeToggle');
  const loginModalBtn = $('#loginModalBtn');
  const signupModalBtn = $('#signupModalBtn');

  // ===== Modal helpers =====
  function showAuthModal() { authModal.classList.add('active'); }
  function closeAuthModal() { authModal.classList.remove('active'); }

  if (authModal) {
    authModal.addEventListener('click', (e) => {
      if (e.target === authModal) closeAuthModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAuthModal();
  });
  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeAuthModal);
  }

  // ===== Update CTA buttons =====
  function updateCTAButtons() {
    if (isLoggedIn) {
      ctaActions.innerHTML = `
        <button id="subjectsCtaBtn" class="btn-sm btn-sm-primary">📚 Subjects</button>
        <button id="downloadCtaBtn" class="btn-sm btn-sm-success">📥 Download</button>
      `;
      const subjectsCtaBtn = $('#subjectsCtaBtn');
      if (subjectsCtaBtn) {
        subjectsCtaBtn.addEventListener('click', () => router.navigateTo('subjects'));
      }
      const downloadCtaBtn = $('#downloadCtaBtn');
      if (downloadCtaBtn) {
        downloadCtaBtn.addEventListener('click', handleDownload);
      }
    } else {
      ctaActions.innerHTML = `
        <button id="signupCtaBtn" class="btn-sm btn-sm-primary">Sign Up</button>
        <button id="loginCtaBtn" class="btn-sm btn-sm-secondary">Log In</button>
        <button id="downloadCtaBtn" class="btn-sm btn-sm-success">📥 Download</button>
      `;
      const signupCtaBtn = $('#signupCtaBtn');
      if (signupCtaBtn) {
        signupCtaBtn.addEventListener('click', () => router.navigateTo('signup'));
      }
      const loginCtaBtn = $('#loginCtaBtn');
      if (loginCtaBtn) {
        loginCtaBtn.addEventListener('click', () => router.navigateTo('login'));
      }
      const downloadCtaBtn = $('#downloadCtaBtn');
      if (downloadCtaBtn) {
        downloadCtaBtn.addEventListener('click', handleDownload);
      }
    }
  }

  // ===== Download handler =====
  async function handleDownload() {
    if (isLoggedIn) {
      await downloadSharedExam();
    } else {
      showAuthModal();
    }
  }

  async function downloadSharedExam() {
    if (!sharedExamData) {
      ui.showToast('No exam data to download.', 'error');
      return;
    }

    const downloadBtn = ctaActions.querySelector('.btn-sm-success');
    if (downloadBtn) downloadBtn.disabled = true;
    ui.showLoading('Saving exam...');

    try {
      const examToSave = {
        examId: sharedExamData.examId || 'shared_' + Date.now(),
        subject: sharedExamData.subject || 'General',
        date: sharedExamData.date || new Date().toISOString(),
        score: sharedExamData.scorePercentage || 0,
        correctAnswers: sharedExamData.correctAnswers || 0,
        totalQuestions: sharedExamData.totalQuestions || 0,
        scorePercentage: sharedExamData.scorePercentage || 0,
        mode: sharedExamData.mode || 'Standard',
        timeSpent: sharedExamData.timeSpent || 0,
        timeAllocated: sharedExamData.timeAllocated || 0,
        questions: (sharedExamData.questions || []).map(q => ({
          id: q.id,
          question: q.question,
          options: q.options || [],
          correctAnswer: q.correctAnswer || q.correct || '—',
          userAnswer: q.userAnswer || 'Not answered',
          timeSpent: q.timeSpent || 0,
          correct: q.correct || (q.userAnswer && q.userAnswer === q.correctAnswer),
          flagged: q.flagged || false,
          topic: q.topic || 'General',
          explanation: q.explanation || ''
        })),
        topicPerformance: sharedExamData.topicPerformance || sharedExamData.topics || [],
        weakAreas: sharedExamData.weakAreas || [],
        downloaded: true
      };

      await db.saveExamResult(examToSave);

      let downloaded = await db.getDownloadedExams() || [];
      downloaded = downloaded.filter(e => e.examId !== examToSave.examId);
      downloaded.unshift({
        examId: examToSave.examId,
        subject: examToSave.subject,
        date: examToSave.date,
        score: examToSave.scorePercentage,
        data: examToSave
      });
      if (downloaded.length > 10) downloaded = downloaded.slice(0, 10);
      await db.saveDownloadedExams(downloaded);

      ui.showToast('Exam downloaded successfully!', 'success');
    } catch (error) {
      console.error(error);
      ui.showToast('Failed to download: ' + error.message, 'error');
    } finally {
      ui.hideLoading();
      if (downloadBtn) downloadBtn.disabled = false;
    }
  }

  // ===== Share handler =====
  function handleShare() {
    const url = window.location.href;
    if (navigator.share) {
      navigator.share({
        title: 'MedVix Shared Exam',
        text: 'Check out this exam I shared on MedVix!',
        url: url
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(url).then(() => {
        ui.showToast('Link copied to clipboard!', 'success');
      }).catch(() => {
        prompt('Copy this link:', url);
      });
    }
  }

  // ===== Attach event listeners =====
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }
  if (homeBtn) {
    homeBtn.addEventListener('click', () => router.navigateTo('index'));
  }
  if (shareBtn) {
    shareBtn.addEventListener('click', handleShare);
  }
  if (loginModalBtn) {
    loginModalBtn.addEventListener('click', () => {
      closeAuthModal();
      router.navigateTo('login');
    });
  }
  if (signupModalBtn) {
    signupModalBtn.addEventListener('click', () => {
      closeAuthModal();
      router.navigateTo('signup');
    });
  }

  // ===== Main init =====
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  if (!token) {
    resultsContainer.innerHTML = `
      <div class="error-state">
        <h2>Invalid Link</h2>
        <p>No exam token provided.</p>
        <button id="homeErrorBtn" class="btn-primary">Go Home</button>
      </div>
    `;
    const homeErrorBtn = $('#homeErrorBtn');
    if (homeErrorBtn) {
      homeErrorBtn.addEventListener('click', () => router.navigateTo('index'));
    }
    return;
  }

  ui.showLoading('Loading shared exam...');

  try {
    const examData = await convexHttpClient.query("sharedExams/queries:getByToken", { token });

    if (!examData) {
      ui.hideLoading();
      resultsContainer.innerHTML = `
        <div class="error-state">
          <h2>Exam Not Found</h2>
          <p>This shared exam may have expired or been deleted.</p>
          <button id="homeNotFoundBtn" class="btn-primary">Go Home</button>
        </div>
      `;
      const homeNotFoundBtn = $('#homeNotFoundBtn');
      if (homeNotFoundBtn) {
        homeNotFoundBtn.addEventListener('click', () => router.navigateTo('index'));
      }
      return;
    }

    sharedExamData = examData;

    // --- Prepare data ---
    const totalQuestions = examData.totalQuestions || 0;
    const correctAnswers = examData.correctAnswers || 0;
    const scorePercentage = totalQuestions > 0 ? (correctAnswers / totalQuestions) * 100 : 0;

    let topics = [];
    if (examData.topicPerformance) {
      topics = examData.topicPerformance.map(t => ({
        topic: t.topic,
        correct: t.correct,
        total: t.questions || t.total || 0,
        percentage: t.percentage || ((t.correct / (t.questions || 1)) * 100),
        avgTime: t.averageTime || 0
      }));
    } else if (examData.topics) {
      topics = examData.topics.map(t => ({
        topic: t.topic,
        correct: t.correct,
        total: t.questions || t.total || 0,
        percentage: t.percentage || ((t.correct / (t.questions || 1)) * 100),
        avgTime: t.averageTime || 0
      }));
    }

    const timeSpentSecs = Math.floor((examData.timeSpent || 0) / 1000);

    const questions = (examData.questions || []).map(q => {
      const optionMap = {};
      if (q.options && Array.isArray(q.options)) {
        q.options.forEach((opt, idx) => {
          const letter = String.fromCharCode(65 + idx);
          optionMap[letter] = opt.text || opt;
        });
      }

      let userAnswerText = '—';
      if (q.userAnswer) {
        const letter = q.userAnswer.trim().toUpperCase();
        if (optionMap[letter]) userAnswerText = optionMap[letter];
        else userAnswerText = q.userAnswer;
      }

      let correctAnswerText = '—';
      if (q.correctAnswer) {
        const letter = q.correctAnswer.trim().toUpperCase();
        if (optionMap[letter]) correctAnswerText = optionMap[letter];
        else correctAnswerText = q.correctAnswer;
      }

      let explanationText = '';
      if (q.explanation) {
        if (typeof q.explanation === 'string') {
          explanationText = q.explanation;
        } else if (typeof q.explanation === 'object') {
          const parts = [];
          if (q.explanation.overview) parts.push(`<strong>Overview:</strong> ${q.explanation.overview}`);
          if (q.explanation.highYield) parts.push(`<strong>High Yield:</strong> ${q.explanation.highYield}`);
          if (q.explanation.clinicalCorrelation) parts.push(`<strong>Clinical:</strong> ${q.explanation.clinicalCorrelation}`);
          explanationText = parts.join('<br>');
        }
      }

      return {
        ...q,
        userAnswerText,
        correctAnswerText,
        explanationText,
        options: q.options,
        correct: q.correct || (q.userAnswer && q.userAnswer === q.correctAnswer),
        flagged: q.flagged || false,
        timeSpent: q.timeSpent || 0
      };
    });

    const results = {
      scorePercentage,
      subject: examData.subject || 'General',
      date: examData.date || new Date().toISOString(),
      correctAnswers,
      totalQuestions,
      timeSpent: timeSpentSecs,
      mode: examData.mode || 'Standard',
      topics,
      questions
    };

    displaySharedResults(results);

    // Update CTA buttons after load
    updateCTAButtons();

  } catch (error) {
    console.error(error);
    let errorMsg = error.message || 'An unexpected error occurred.';
    if (errorMsg.includes('expired')) {
      errorMsg = 'This shared exam has expired (links are valid for 48 hours).';
    }
    resultsContainer.innerHTML = `
      <div class="error-state">
        <h2>Error Loading Exam</h2>
        <p>${errorMsg}</p>
        <button id="homeErrorBtn2" class="btn-primary">Go Home</button>
      </div>
    `;
    const homeErrorBtn2 = $('#homeErrorBtn2');
    if (homeErrorBtn2) {
      homeErrorBtn2.addEventListener('click', () => router.navigateTo('index'));
    }
  } finally {
    ui.hideLoading();
  }

  // Re-check auth on focus (to update CTA buttons)
  window.addEventListener('focus', () => {
    const newAuth = auth.checkAuth();
    if (newAuth !== isLoggedIn) {
      isLoggedIn = newAuth;
      updateCTAButtons();
    }
  });

  console.log('[SharedExam] Initialized');
}

// ==================== DISPLAY RESULTS ====================
function displaySharedResults(results) {
  const resultsContainer = $('#shared-results-container');
  const scorePct = Math.min(100, Math.max(0, results.scorePercentage));
  const correctDeg = (scorePct / 100) * 360;
  const pieBackground = `conic-gradient(var(--success) 0deg, var(--success) ${correctDeg}deg, var(--danger) ${correctDeg}deg, var(--danger) 360deg)`;

  let html = `
    <!-- Compact Summary Card -->
    <div class="summary-compact">
      <div class="pie-cell">
        <div class="score-circle" style="background: ${pieBackground};">${Math.round(scorePct)}%</div>
      </div>
      <div class="meta-item">
        <span class="meta-label">Subject</span>
        <span class="meta-value subject">${results.subject || 'General'}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Score</span>
        <span class="meta-value score">${results.correctAnswers}/${results.totalQuestions}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Mode</span>
        <span class="meta-value mode">${results.mode || 'Standard'}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Date</span>
        <span class="meta-value">${utils.formatDate(results.date)}</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Time</span>
        <span class="meta-value">${utils.formatTime(results.timeSpent)}</span>
      </div>
    </div>
  `;

  // Topic performance
  if (results.topics && results.topics.length > 0) {
    html += `<div class="topic-section"><h3>📊 Topics</h3><ul class="topic-list">`;
    results.topics.sort((a, b) => a.percentage - b.percentage).forEach(t => {
      const color = t.percentage >= 70 ? 'var(--success)' : (t.percentage >= 50 ? 'var(--warning)' : 'var(--danger)');
      const total = t.total || t.questions || 1;
      const correct = t.correct || 0;
      html += `
        <li>
          <span class="topic-name">${t.topic}</span>
          <span class="topic-score" style="color:${color};">${Math.round(t.percentage)}%</span>
          <span class="topic-count">${correct}/${total}</span>
          <div class="topic-bar">
            <div class="bar-fill" style="width: ${t.percentage}%; background: ${color};"></div>
          </div>
        </li>
      `;
    });
    html += `</ul></div>`;
  }

  // Question review
  html += `<div class="review-section"><h2>📝 Question Review</h2><div class="review-list">`;
  if (results.questions && results.questions.length > 0) {
    results.questions.forEach((q, idx) => {
      const isCorrect = q.correct;
      const statusClass = isCorrect ? 'correct' : 'incorrect';
      const statusIcon = isCorrect ? '✅' : '❌';
      html += `
        <div class="review-item ${statusClass}">
          <div class="review-header">
            <span class="q-num">Q${idx+1}</span>
            <span class="status">${statusIcon}</span>
            <span class="topic-tag">${q.topic || 'General'}</span>
            <span class="time-spent">⏱️ ${q.timeSpent || 0}s</span>
          </div>
          <div class="review-question">${q.question}</div>
          <div class="review-answers">
            <div><strong>Your answer:</strong> ${q.userAnswerText}</div>
            <div><strong>Correct answer:</strong> ${q.correctAnswerText}</div>
          </div>
          ${q.explanationText ? `<div class="review-explanation"><div class="explanation-parts">${q.explanationText}</div></div>` : ''}
          ${q.flagged ? '<span class="flagged-badge">🏴 Flagged</span>' : ''}
        </div>
      `;
    });
  } else {
    html += `<p class="no-data">No question details available.</p>`;
  }
  html += `</div></div>`;

  resultsContainer.innerHTML = html;
}

export function destroy() {
  // Cleanup if needed
}