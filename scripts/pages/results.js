// scripts/pages/results.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as utils from '../utils.js';
import * as db from '../db.js';
import * as sync from '../sync.js';
// ── IMAGES: needed to resolve slide images from IndexedDB and to
//    distinguish slide from static subjects for URL construction.
import * as questions from '../questions.js';
import * as slideData from '../slide-data.js';
import * as examEngine from '../exam-engine.js';

let $;
let currentExamId = null;
let currentExamData = null;

// ── IMAGES: object-URL lifecycle ──
// Slide images are loaded as Blobs and mounted via object-URL. Track
// every URL we create so destroy() can revoke them and let the blobs
// be GC'd. Static images use plain URLs and don't need tracking.
const _createdObjectUrls = new Set();

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ── State adapter ────────────────────────────────────────────────
  redirect.registerStateAdapter('results', {
    capture: () => ({
      examId: currentExamId,
    }),
    restore: (data) => {
      if (!data) return;
      if (!currentExamId && data.examId) {
        currentExamId = data.examId;
      }
    },
  });

  // ── Auth gate ────────────────────────────────────────────────────
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to view your results', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  let examId = new URLSearchParams(window.location.search).get('examId');
  if (!examId) {
    const navData = router.getNavData();
    if (navData && navData.examId) examId = navData.examId;
  }

  if (!examId) {
    const snap = redirect.peekSnapshot();
    if (snap && snap.page && snap.page.examId) {
      examId = snap.page.examId;
      console.log('[Results] Recovered examId from redirect snapshot');
    }
  }

  if (!examId) {
    ui.showToast('No exam ID provided', 'error');
    try { redirect.clearReturns(); }   catch { /* ignore */ }
    try { redirect.clearSnapshots(); } catch { /* ignore */ }
    setTimeout(() => router.navigateTo('subjects'), 2000);
    return;
  }

  currentExamId = examId;
  console.log('[Results] Loading exam ID:', currentExamId);
  ui.showLoading('Loading results...');

  try {
    let results = await db.getExamResult(currentExamId);
    if (!results) {
      const lastExam = utils.getLocalStorage('lastExam', null);
      if (lastExam && lastExam.examId === currentExamId) {
        results = lastExam;
        console.log('[Results] Using localStorage fallback');
      }
    }

    if (!results) {
      ui.hideLoading();
      context.root.querySelector('main').innerHTML = `
        <div class="error-state">
          <h2>Results Not Found</h2>
          <p>We couldn't find the exam results.</p>
          <button id="backErrorBtn" class="btn-primary">Back to Subjects</button>
        </div>
      `;
      const backErrorBtn = $('#backErrorBtn');
      if (backErrorBtn) {
        backErrorBtn.addEventListener('click', () => router.navigateTo('subjects'));
      }
      return;
    }

    currentExamData = results;
    displaySummary(results);

    if (results.topics && results.topics.length > 0) {
      renderTopicPerformance(results.topics);
      $('#topic-performance').style.display = 'block';
    }
    if (results.weakAreas && results.weakAreas.length > 0) {
      displayRecommendations(results.weakAreas);
      $('#recommendations').style.display = 'block';
    }

    // ── ENGINE: compact post-exam insights (silently no-ops if empty)
    try {
      renderResultsInsights(results);
    } catch (e) {
      console.warn('[Results] renderResultsInsights failed (non-fatal):', e);
    }

    if (results.questions && results.questions.length > 0) {
      // ── IMAGES: pass results.subject so the review-list image
      //    hydrator knows which subject's folder / slide namespace
      //    to look in. All questions in an exam share this subject.
      renderReviewList(results.questions, results.subject);
      $('#reviewSection').style.display = 'block';
    }

  } catch (error) {
    console.error('[Results] Error loading results:', error);
    ui.showToast('Failed to load results: ' + error.message, 'error');
  } finally {
    ui.hideLoading();
  }

  attachEventListeners(context);

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
    console.warn('[Results] Return-stack cleanup failed:', err);
  }

  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[Results] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

  console.log('[Results] Initialized');
}

function attachEventListeners(context) {
  const subjectsBtn = $('#subjectsBtn');
  if (subjectsBtn) {
    subjectsBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  const downloadBtn = $('#downloadBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', downloadExam);
  }

  const analyticsBtn = $('#analyticsBtn');
  if (analyticsBtn) {
    analyticsBtn.addEventListener('click', () => router.navigateTo('performance'));
  }
}

// ==================== DISPLAY FUNCTIONS ====================

function displaySummary(results) {
  const score = Math.round(results.scorePercentage);
  $('#score-percentage').textContent = `${score}%`;
  $('#correct-count').textContent =
    `${results.correctAnswers}/${results.totalQuestions}`;

  const timeAlloc = results.timeAllocated || (results.totalQuestions * 30);
  const timeSpentSec = Math.floor(results.timeSpent / 1000);
  const timePercent = timeAlloc > 0 ? Math.round((timeSpentSec / timeAlloc) * 100) : 0;
  $('#time-stats').textContent =
    `${utils.formatTime(timeSpentSec)} / ${utils.formatTime(timeAlloc)} (${timePercent}%)`;

  let grade = 'F';
  if (score >= 80) grade = 'A';
  else if (score >= 70) grade = 'B';
  else if (score >= 60) grade = 'C';
  else if (score >= 50) grade = 'D';
  $('#grade').textContent = grade;

  $('#exam-date').textContent = utils.formatDate(results.date);
  $('#exam-subject').textContent = results.subject || 'General';
  $('#exam-mode').textContent = results.mode || 'Timed';

  updatePieChart(score);
}

function updatePieChart(percentage) {
  const circle = $('#scoreCircle');
  const angle = (percentage / 100) * 360;
  circle.style.background =
    `conic-gradient(var(--accent) 0deg, var(--accent) ${angle}deg, var(--border) ${angle}deg, var(--border) 360deg)`;
}

function renderReviewList(questionsList, subject) {
  const container = $('#review-list');
  if (!questionsList || questionsList.length === 0) {
    container.innerHTML = '<p class="no-data">No questions to review.</p>';
    return;
  }

  container.innerHTML = questionsList.map((q, idx) => {
    const isCorrect = q.correct;
    const statusClass = isCorrect ? 'correct' : 'incorrect';
    const statusIcon = isCorrect ? '✅' : '❌';

    function getOptionText(letter) {
      if (!letter || !q.options || !Array.isArray(q.options)) return letter || '—';
      const index = letter.toUpperCase().charCodeAt(0) - 65;
      if (index < 0 || index >= q.options.length) return letter;
      const opt = q.options[index];
      return (typeof opt === 'object' && opt !== null) ? opt.text : opt;
    }

    const userAnswerText = getOptionText(q.userAnswer);
    const correctAnswerText = getOptionText(q.correctAnswer);

    let explanationHtml = '';
    if (q.explanation) {
      if (typeof q.explanation === 'object') {
        const parts = [];
        if (q.explanation.overview) parts.push(q.explanation.overview);
        if (q.explanation.highYield) parts.push(`<br><strong>High‑Yield:</strong> ${q.explanation.highYield}`);
        if (q.explanation.clinicalCorrelation) parts.push(`<br><strong>Clinical:</strong> ${q.explanation.clinicalCorrelation}`);
        explanationHtml = parts.join(' ');
      } else {
        explanationHtml = q.explanation;
      }
    }

    // ── IMAGES: emit an empty slot keyed by question index (not by
    //    the raw filename) so no zip-controlled string enters the
    //    HTML. The hydrator below reads the filename from the
    //    questionsList[idx] object directly.
    const imageHtml = q.image
      ? `<div class="review-image" data-q-idx="${idx}"></div>`
      : '';

    return `
      <div class="review-item ${statusClass}">
        <div class="review-header">
          <span class="q-num">Q${idx + 1}</span>
          <span class="status">${statusIcon}</span>
          <span class="topic-tag">${q.topic || 'General'}</span>
          <span class="time-spent">⏱️ ${q.timeSpent || 0}s</span>
        </div>
        <div class="review-question">${q.question}</div>
        ${imageHtml}
        <div class="review-answers">
          <div><strong>Your answer:</strong> ${userAnswerText}</div>
          <div><strong>Correct answer:</strong> ${correctAnswerText}</div>
        </div>
        <div class="review-explanation">
          <strong>Explanation:</strong> ${explanationHtml || 'No explanation available.'}
        </div>
        ${q.flagged ? '<span class="flagged-badge">🏴 Flagged</span>' : ''}
      </div>
    `;
  }).join('');

  // ── IMAGES: progressive enhancement. The text of every review item
  //    is already in the DOM; images pop in as their Blobs resolve.
  hydrateReviewImages(container, subject, questionsList);
}

// ── IMAGES: hydrate the empty .review-image slots in the review list.
//
// Mirrors exam-room.js's renderQuestionImage: static subjects use the
// conventional /data/images/{subject}/{filename} URL; slide subjects
// load the Blob from IndexedDB (written by slide-data.js at download
// time) and mount an object-URL. Object-URLs are tracked in
// _createdObjectUrls so destroy() can revoke them.
async function hydrateReviewImages(container, subject, questionsList) {
  if (!subject) return;

  const slots = container.querySelectorAll('.review-image[data-q-idx]');
  if (slots.length === 0) return;

  const meta = questions.getSubjectMeta(subject);
  const isSlide = meta.source === 'slide';

  for (const slot of slots) {
    const idx = parseInt(slot.dataset.qIdx, 10);
    const q = questionsList[idx];
    if (!q || !q.image) continue;

    const filename = q.image;

    try {
      if (isSlide) {
        const blob = await slideData.getSlideImage(subject, filename);
        if (!blob) {
          console.warn(`[Results] Slide image missing: ${subject}/${filename}`);
          continue;
        }
        const url = URL.createObjectURL(blob);
        _createdObjectUrls.add(url);
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Question diagram';
        img.loading = 'lazy';
        slot.appendChild(img);
      } else {
        // Static subject — plain URL, same convention as exam-room.js.
        // onerror removes the element so a 404 doesn't leave a broken
        // <img> icon in the review list.
        const img = document.createElement('img');
        img.src = `/data/images/${encodeURIComponent(subject)}/${encodeURIComponent(filename)}`;
        img.alt = 'Question diagram';
        img.loading = 'lazy';
        img.onerror = () => img.remove();
        slot.appendChild(img);
      }
    } catch (e) {
      console.warn(`[Results] Failed to load image for ${subject}/${filename}:`, e);
    }
  }
}

function renderTopicPerformance(topicData) {
  const container = $('#topic-performance');
  if (!topicData || topicData.length === 0) {
    container.innerHTML = '<p class="no-data">No topic data available.</p>';
    return;
  }

  topicData.sort((a, b) => a.percentage - b.percentage);

  let html = '<h3>Topic Performance</h3><ul class="topic-list">';
  topicData.forEach(t => {
    const color = t.percentage >= 70 ? 'green' : (t.percentage >= 50 ? 'orange' : 'red');
    html += `
      <li>
        <span class="topic-name">${t.topic}</span>
        <span class="topic-score" style="color: ${color};">${Math.round(t.percentage)}%</span>
        <span class="topic-count">${t.correct}/${t.questions}</span>
        <div class="topic-bar">
          <div class="bar-fill" style="width: ${t.percentage}%; background: ${color};"></div>
        </div>
      </li>
    `;
  });
  html += '</ul>';
  container.innerHTML = html;
}

function displayRecommendations(weakAreas) {
  const container = $('#recommendations');
  if (!weakAreas || weakAreas.length === 0) {
    container.innerHTML = '<p class="no-data">Great job! No weak areas detected.</p>';
    return;
  }
  let html = '<h3>📚 Recommended Focus</h3><ul>';
  weakAreas.forEach(area => {
    html += `<li>🔍 Focus on <strong>${area}</strong> – review related topics.</li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
}

// ==================== LEARNING INSIGHTS (compact, engine-backed) ====================

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function prettifyTopic(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function shortReviewTime(days) {
  if (!Number.isFinite(days)) return '';
  const d = Math.max(0, Math.round(days));
  if (d <= 1) return 'tomorrow';
  if (d <= 7) return `${d}d`;
  return `${Math.round(d / 7)}w`;
}

/**
 * Compact post-exam insights. Shows ONLY what this exam touched:
 *   • session narration (one line from the narrator)
 *   • a horizontal chip row of review timings
 *   • a single-line misconception warning when applicable
 *   • one CTA to practice the same concepts adaptively
 *
 * Silently no-ops if there is nothing genuinely useful to show.
 */
function renderResultsInsights(results) {
  const container = $('#medvix-results-insights');
  if (!container) return;

  const medvix = results && results.medvix;
  if (!medvix || !medvix.ingested) return;

  const sessionNarration = medvix.sessionNarration || null;
  const reviewPlans = medvix.reviewPlans || {};
  const diagnostics = medvix.diagnostics || {};
  const touched = new Set(medvix.conceptsTouched || []);

  // Retention items — only for concepts THIS exam touched, sorted by urgency
  const URGENCY_RANK = { high: 0, moderate: 1, low: 2 };
  const reviewItems = Object.entries(reviewPlans)
    .filter(([cid]) => touched.size === 0 || touched.has(cid))
    .map(([conceptId, plan]) => ({ conceptId, ...plan }))
    .filter(p => Number.isFinite(p.currentP))
    .sort((a, b) => {
      const ra = URGENCY_RANK[a.urgency] ?? 3;
      const rb = URGENCY_RANK[b.urgency] ?? 3;
      if (ra !== rb) return ra - rb;
      return a.currentP - b.currentP;
    })
    .slice(0, 3);

  // Misconception flags — only for concepts THIS exam touched
  const misconceptionItems = Object.entries(diagnostics)
    .filter(([cid, d]) =>
      (touched.size === 0 || touched.has(cid)) &&
      d.misconceptions && d.misconceptions.flagged === true
    )
    .slice(0, 2);

  // Nothing useful? Hide entirely — no empty card, no wasted space.
  if (!sessionNarration && reviewItems.length === 0 && misconceptionItems.length === 0) {
    return;
  }

  const parts = [];

  // 1. Session narration — one paragraph, no tagline above it
  if (sessionNarration) {
    parts.push(`<p class="insights-session">${escapeHtml(sessionNarration)}</p>`);
  }

  // 2. Review timeline — horizontal chips, wraps only on very narrow screens
  if (reviewItems.length > 0) {
    const chips = reviewItems.map(p => {
      const [, rawTopic] = String(p.conceptId).split('::');
      const topic = prettifyTopic(rawTopic || p.conceptId);
      const when = shortReviewTime(p.nextReviewInDays);
      const cls = p.urgency === 'high' ? 'urgent'
                : p.urgency === 'moderate' ? 'warning' : 'fine';
      const whenPart = when ? `<span class="insights-chip-when">${escapeHtml(when)}</span>` : '';
      return `<span class="insights-chip insights-chip-${cls}">${escapeHtml(topic)}${whenPart}</span>`;
    }).join('');
    parts.push(`
      <div class="insights-review-line">
        <span class="insights-line-label">Review</span>${chips}
      </div>
    `);
  }

  // 3. Misconception warning — one line, only if any
  if (misconceptionItems.length > 0) {
    const topics = misconceptionItems.map(([cid]) => {
      const [, rawTopic] = String(cid).split('::');
      return prettifyTopic(rawTopic || cid);
    }).join(', ');
    parts.push(`
      <p class="insights-misconception">
        ⚠️ High-confidence errors on <strong>${escapeHtml(topics)}</strong>
      </p>
    `);
  }

  // 4. CTA — one compact button, only when there's something to retry
  if (reviewItems.length > 0) {
    parts.push(`
      <div class="insights-actions">
        <button id="medvix-retry-weak" class="btn-secondary" type="button">
          Practice Weak Concepts
        </button>
      </div>
    `);
  }

  container.innerHTML = `
    <h2>🧠 What the Engine Saw</h2>
    ${parts.join('')}
  `;
  container.style.display = 'block';

  const retryBtn = document.getElementById('medvix-retry-weak');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => retryWeakConcepts(retryBtn, results));
  }
}

async function retryWeakConcepts(button, results) {
  const originalLabel = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = 'Preparing…';
  }
  try {
    const medvix = results && results.medvix;
    const plans = medvix && medvix.reviewPlans;
    if (!plans) {
      ui.showToast('Nothing to retry from this session.', 'info');
      return;
    }

    const touched = new Set(medvix.conceptsTouched || []);
    const URGENCY_RANK = { high: 0, moderate: 1, low: 2 };
    const ranked = Object.entries(plans)
      .filter(([cid]) => touched.size === 0 || touched.has(cid))
      .map(([conceptId, plan]) => ({ conceptId, ...plan }))
      .sort((a, b) => (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3))
      .slice(0, 5);

    const bySubject = {};
    for (const p of ranked) {
      const [subject, topic] = String(p.conceptId).split('::');
      if (!subject || !topic) continue;
      if (!bySubject[subject]) bySubject[subject] = [];
      bySubject[subject].push(topic);
    }
    const subjectKeys = Object.keys(bySubject);
    if (subjectKeys.length === 0) {
      ui.showToast('Could not determine target topics.', 'info');
      return;
    }

    const targetSubject = subjectKeys.includes(results.subject)
      ? results.subject
      : subjectKeys[0];
    const topics = bySubject[targetSubject] || [];

    const config = await examEngine.buildAdaptiveExamConfig({
      subject: targetSubject,
      topics,
      questionCount: 15,
      preferredExamMode: 'standard',
    });
    examEngine.setExamConfig(config);

    ui.showToast(`Adaptive session prepared · ${topics.length} topic(s)`, 'success');

    try {
      router.navigateTo('exam-settings');
    } catch (e) {
      console.warn('[Results] navigateTo("exam-settings") failed:', e);
    }
  } catch (e) {
    console.error('[Results] retryWeakConcepts failed:', e);
    ui.showToast('Could not prepare adaptive session.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || 'Practice Weak Concepts';
    }
  }
}

// ==================== DOWNLOAD EXAM ====================
async function downloadExam() {
  if (!currentExamId) {
    ui.showToast('No exam ID found', 'error');
    return;
  }
  if (!currentExamData) {
    ui.showToast('Exam data not loaded', 'error');
    return;
  }

  const examWithDownload = {
    ...currentExamData,
    downloaded: true,
  };

  try {
    await saveDownloadedExam(examWithDownload);
    if (navigator.onLine) {
      sync.syncExamResults(examWithDownload).catch(err => {
        console.warn('[Results] Immediate sync after download failed:', err);
      });
    }
    ui.showToast('Exam downloaded and synced to cloud', 'success');
  } catch (err) {
    console.error('[Results] Download error:', err);
    ui.showToast('Failed to download exam', 'error');
  }
}

async function saveDownloadedExam(exam) {
  try {
    let downloaded = await db.getDownloadedExams() || [];
    downloaded = downloaded.filter(e => e.examId !== exam.examId);
    downloaded.unshift({
      examId: exam.examId,
      subject: exam.subject,
      date: exam.date,
      score: exam.scorePercentage,
      data: exam
    });
    if (downloaded.length > 10) downloaded = downloaded.slice(0, 10);
    await db.saveDownloadedExams(downloaded);
    await db.saveExamResult(exam);
  } catch (err) {
    console.error('[Results] Error saving downloaded exam:', err);
    throw err;
  }
}

// ==================== DESTROY ====================
export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's module state.
  try { redirect.unregisterStateAdapter('results'); } catch { /* ignore */ }

  // ── IMAGES: revoke every object-URL we created so the blobs can
  //    be GC'd. Without this, each visit to the results page for a
  //    slide exam leaks one blob per image-bearing question.
  for (const url of _createdObjectUrls) {
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }
  _createdObjectUrls.clear();
}