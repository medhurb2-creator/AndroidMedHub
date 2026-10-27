// scripts/pages/performance.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as utils from '../utils.js';
import * as analytics from '../analytics.js';
import * as db from '../db.js';
import { convexHttpClient } from '../convex-client.js';

import * as performanceRating from '../performance-rating-v2.js';
// ── IMAGE: needed to resolve slide-subject images from IndexedDB and
//    distinguish slide from static subjects for URL construction.
import * as questions from '../questions.js';
import * as slideData from '../slide-data.js';
// ── ENGINE: local adaptive learning intelligence + narration. Used to
//    render the MedVix Insights card, enrich subject/weak cards with
//    posterior mastery, and (optionally) launch an adaptive session.
import * as medvix from '../medvix.js';
import * as examEngine from '../exam-engine.js';

let $;
let analyticsData = null;
let chartInstance = null;

// Module-scoped chart instances for academic charts
const academicChartInstances = {};

// ── IMAGE: tracks the currently-open review modal so destroy() can
//    clean it up (and revoke its object-URLs) if the user navigates
//    away with the modal still open.
let _openReviewModal = null;

// ── ENGINE: tracks whether the MedVix insights card has been rendered
//    and a reference to the visibility listener so destroy() can detach.
let _medvixRendered = false;
let _medvixVisibilityListener = null;

// ==================== HELPER: SET TEXT (early definition) ====================
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? '';
}


// ==================== HELPER: ESCAPE HTML (for narrator / user text) ====================
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ==================== HELPER: DISTINCT COLOR GENERATOR ====================
// Generates an infinite sequence of distinct colors using the Golden Angle
// (137.508 degrees) on the HSL color wheel. This ensures that even if you
// have 50 subjects, no two colors will look the same.
function getDistinctColor(index) {
  const goldenAngle = 137.508;
  const hue = (index * goldenAngle) % 360;
  
  // Vary saturation and lightness slightly to further separate hues
  // that might naturally look similar.
  const sat = 65 + (index % 3) * 10; // 65%, 75%, 85%
  const light = 45 + (index % 2) * 10; // 45%, 55%
  
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

// ==================== HELPER: FORMAT STUDY DURATION ====================
// Renders a total in seconds using the smallest sensible unit:
//   < 60s   → "45s"
//   < 60m   → "12m"
//   >= 60m  → "1h" / "1.5h" / "22h"
// Zero data is shown as "0h" to match the pre-existing stat-card style.
function formatStudyDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (s === 0) return '0h';
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.round(s / 60);
    return m >= 60 ? '1h' : `${m}m`;
  }
  const h = s / 3600;
  const rounded = Math.round(h * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}h` : `${rounded.toFixed(1)}h`;
}

// ==================== HELPER: NATIVE SHARE & FALLBACK ====================
function nativeShare(shareData) {
  const data = {
    title: shareData.title || 'MedVix',
    text: shareData.text || '',
    url: shareData.url || '',
    dialogTitle: shareData.dialogTitle || 'Share',
  };

  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.MedvixShare) {
    window.Capacitor.Plugins.MedvixShare.share(data).catch(() => fallbackShare(data));
  } else if (navigator.share) {
    navigator.share(data).catch(() => fallbackShare(data));
  } else {
    fallbackShare(data);
  }
}

function fallbackShare(shareData) {
  const url = shareData.url || shareData.text || '';
  if (!url) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => ui.showToast('Link copied to clipboard!', 'success'))
      .catch(() => fallbackCopy(url));
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
  } catch {
    ui.showToast('Failed to copy link. Please copy manually.', 'error');
  }
  document.body.removeChild(textarea);
}

// ==================== INIT ====================
export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  if (!auth.checkAuth()) {
    ui.showToast('Please log in to view your performance', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  redirect.registerStateAdapter('performance', {
    capture: () => {
      const activeTab = document.querySelector('.tab-content.active');
      const activeTabBtn = document.querySelector('.tab-button.active');
      const activePlanner = document.querySelector('.planner-btn.active');
      const activeAcademic = document.querySelector('.academic-btn.active');
      const activeChart = document.querySelector('.chart-btn.active');
      const activeLbTab = document.querySelector('.leaderboard-tabs button.active');

      return {
        activeTabId: activeTab ? activeTab.id : null,
        activeTabBtnId: activeTabBtn ? activeTabBtn.dataset.tab : null,
        plannerKey: activePlanner ? activePlanner.dataset.planner : null,
        academicKey: activeAcademic ? activeAcademic.dataset.academic : null,
        chartType: activeChart ? activeChart.dataset.chart : null,
        leaderboardTab: activeLbTab ? activeLbTab.dataset.leaderboard : null,
        pendingAIPlan: window._lastAIPlan || null,
      };
    },
    restore: (data) => {
      if (!data) return;
      if (data.pendingAIPlan) {
        window._lastAIPlan = data.pendingAIPlan;
        const aiActions = document.getElementById('ai-actions');
        if (aiActions) aiActions.style.display = 'flex';
      }
      if (data.activeTabBtnId) {
        try { switchTab(data.activeTabBtnId); } catch { /* ignore */ }
      }
      if (data.plannerKey) {
        document.querySelectorAll('.planner-btn').forEach((b) => {
          b.classList.toggle('active', b.dataset.planner === data.plannerKey);
        });
        document.querySelectorAll('.planner-module-container').forEach((el) => {
          el.classList.toggle('active', el.id === `planner-${data.plannerKey}`);
        });
      }
      if (data.academicKey) {
        document.querySelectorAll('.academic-btn').forEach((b) => {
          b.classList.toggle('active', b.dataset.academic === data.academicKey);
        });
        document.querySelectorAll('.academic-module-container').forEach((el) => {
          el.classList.toggle('active', el.id === `academic-${data.academicKey}`);
        });
      }
      if (data.chartType) {
        document.querySelectorAll('.chart-btn').forEach((b) => {
          b.classList.toggle('active', b.dataset.chart === data.chartType);
        });
        try { renderChart(data.chartType); } catch { /* ignore */ }
      }
      if (data.leaderboardTab) {
        document.querySelectorAll('.leaderboard-tabs button').forEach((b) => {
          b.classList.toggle('active', b.dataset.leaderboard === data.leaderboardTab);
        });
        try { renderLeaderboard(data.leaderboardTab); } catch { /* ignore */ }
      }
    },
  });

  const shimmer = $('#shimmer-overlay');
  const realContent = $('#real-content');
  if (realContent) realContent.classList.remove('visible');

  ui.showLoading('Loading analytics...');

  try {
    const allResults = await db.getAllExamResults();
    analyticsData = await analytics.calculateAllAnalytics(allResults);

    const performanceData = (await db.getUserPerformance()) || {};
    const leaderboardData = (await db.getLeaderboard()) || [];
    const challengeHistoryData = (await db.getChallengeHistory()) || [];

    renderSummary(analyticsData.summary);
    renderSubjectMastery(analyticsData.subjectAnalysis);
    renderStudyPatterns(analyticsData.studyPatterns);
    renderWeakAreas(analyticsData.weakAreas);
    renderRecommendations(analyticsData.recommendations);
    renderChart('score');

    const user = auth.getUser();
    renderAcademicProfile({
      performance: performanceData,
      leaderboard: leaderboardData,
      challengeHistory: challengeHistoryData,
      examResults: allResults,
      analytics: analyticsData,
      user,
    });

    renderLeaderboard(leaderboardData);
    renderCompetitionStats(challengeHistoryData, user?._id);
    renderActivityFeed(challengeHistoryData);
    renderGrowth(allResults, challengeHistoryData, performanceData);

    // Avatar: explicit upload wins; fall back to backend picture URL;
    // otherwise initials.
    const savedAvatar = localStorage.getItem('userAvatar');
    const currentUser = auth.getUser();
    const backendAvatar = currentUser
      ? (currentUser.picture || currentUser.photoURL || currentUser.avatar || currentUser.avatarUrl)
      : null;
    updateAvatar(savedAvatar || backendAvatar || null);

    renderDownloadedExams();
    renderAllPlannerModules();
    setupPlannerButtons();
    setupAcademicButtons();

    // ── ENGINE: render the MedVix Insights card (non-blocking).
    //    The digest comes from the local engine — offline, ~20ms.
    renderMedVixInsights(analyticsData).catch((e) =>
      console.warn('[Performance] MedVix render failed:', e)
    );

    // Refresh the insights card when the user returns to the tab.
    // The engine resets and replays all exams to pick up any sessions
    // performed in another tab.
    if (!_medvixVisibilityListener) {
      _medvixVisibilityListener = async () => {
        if (document.visibilityState !== 'visible') return;
        if (!_medvixRendered) return;
        try {
          await medvix.reset();
          _medvixRendered = false;
          await renderMedVixInsights(analyticsData);
        } catch (e) {
          console.warn('[Performance] MedVix refresh on visibility failed:', e);
          _medvixRendered = true;
        }
      };
      document.addEventListener('visibilitychange', _medvixVisibilityListener);
    }
  } catch (error) {
    console.error('[Performance] Error:', error);
    ui.showToast('Failed to load analytics', 'error');
  } finally {
    ui.hideLoading();
    if (shimmer) shimmer.style.display = 'none';
    if (realContent) realContent.classList.add('visible');
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
    console.warn('[Performance] Return-stack cleanup failed:', err);
  }

  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[Performance] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

  console.log('[Performance] Initialized');
}

// ==================== ATTACH EVENT LISTENERS ====================
function attachEventListeners(context) {
  const root = context.root && context.root.nodeType === 1 ? context.root : document;

  const themeToggle = $('#themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', ui.toggleTheme);

  const notifBtn = $('#notifBtn');
  if (notifBtn) notifBtn.addEventListener('click', () => router.navigateTo('notifications'));

  const tabs = root.querySelectorAll('.tab-button');
  tabs.forEach((btn) => {
    btn.addEventListener('click', function () {
      switchTab(this.dataset.tab, root);
    });
  });

  root.querySelectorAll('.quick-link[data-tab]').forEach((el) => {
    el.addEventListener('click', function () {
      switchTab(this.dataset.tab, root);
    });
  });

  const weakStudyBtn = $('#weakStudyBtn');
  if (weakStudyBtn) {
    weakStudyBtn.addEventListener('click', () =>
      router.navigateTo('subject-specific?focus=weak')
    );
  }

  const chartBtns = root.querySelectorAll('.chart-btn');
  chartBtns.forEach((btn) => {
    btn.addEventListener('click', function () {
      chartBtns.forEach((b) => b.classList.remove('active'));
      this.classList.add('active');
      renderChart(this.dataset.chart);
    });
  });

  const plannerBtns = root.querySelectorAll('.planner-btn');
  plannerBtns.forEach((btn) => {
    btn.addEventListener('click', function () {
      plannerBtns.forEach((b) => b.classList.remove('active'));
      this.classList.add('active');
      const key = this.dataset.planner;
      root.querySelectorAll('.planner-module-container').forEach((el) => {
        el.classList.toggle('active', el.id === `planner-${key}`);
      });
      switch (key) {
        case 'timetable': renderTimetable(); break;
        case 'topics': renderTopics(); break;
        case 'sessions': renderSessions(); break;
        case 'streaks': renderStreaks(); break;
        case 'exams': renderExams(); break;
        case 'checklist': renderChecklist(); break;
        case 'reminders': renderReminders(); break;
      }
    });
  });

  const academicBtns = root.querySelectorAll('.academic-btn');
  academicBtns.forEach((btn) => {
    btn.addEventListener('click', function () {
      academicBtns.forEach((b) => b.classList.remove('active'));
      this.classList.add('active');
      const key = this.dataset.academic;
      root.querySelectorAll('.academic-module-container').forEach((el) => {
        el.classList.toggle('active', el.id === `academic-${key}`);
      });
    });
  });

  const leaderboardBtns = root.querySelectorAll('.leaderboard-tabs button');
  leaderboardBtns.forEach((btn) => {
    btn.addEventListener('click', function () {
      leaderboardBtns.forEach((b) => b.classList.remove('active'));
      this.classList.add('active');
      renderLeaderboard(this.dataset.leaderboard);
    });
  });

  const addTimetableBtn = $('#addTimetableBtn');
  if (addTimetableBtn) addTimetableBtn.addEventListener('click', addTimetableSlot);

  const addTopicBtn = $('#addTopicBtn');
  if (addTopicBtn) addTopicBtn.addEventListener('click', addTopicItem);

  const addSessionBtn = $('#addSessionBtn');
  if (addSessionBtn) addSessionBtn.addEventListener('click', addStudySession);

  const addExamBtn = $('#addExamBtn');
  if (addExamBtn) addExamBtn.addEventListener('click', addExamCountdown);

  const addChecklistBtn = $('#addChecklistBtn');
  if (addChecklistBtn) addChecklistBtn.addEventListener('click', addChecklistItem);

  const generateAIPlanBtn = $('#generateAIPlanBtn');
  if (generateAIPlanBtn) generateAIPlanBtn.addEventListener('click', generateAIPlan);

  const adoptAIPlanBtn = $('#adoptAIPlanBtn');
  if (adoptAIPlanBtn) adoptAIPlanBtn.addEventListener('click', adoptAIPlan);

  const regenerateAIPlanBtn = $('#regenerateAIPlanBtn');
  if (regenerateAIPlanBtn) regenerateAIPlanBtn.addEventListener('click', regenerateAIPlan);

  const amendAIPlanBtn = $('#amendAIPlanBtn');
  if (amendAIPlanBtn) amendAIPlanBtn.addEventListener('click', showAmendInput);

  const cancelAIPlanBtn = $('#cancelAIPlanBtn');
  if (cancelAIPlanBtn) cancelAIPlanBtn.addEventListener('click', cancelAIPlan);

  const sendAmendmentBtn = $('#sendAmendmentBtn');
  if (sendAmendmentBtn) sendAmendmentBtn.addEventListener('click', sendAmendment);

  const closeShareModalBtn = $('#closeShareModalBtn');
  if (closeShareModalBtn) {
    closeShareModalBtn.addEventListener('click', () => {
      const modal = $('#share-modal');
      if (modal) modal.style.display = 'none';
    });
  }

  const copyShareLinkBtn = $('#copyShareLinkBtn');
  if (copyShareLinkBtn) copyShareLinkBtn.addEventListener('click', copyShareLink);

  const shareProfileBtn = $('#shareProfileBtn');
  if (shareProfileBtn) shareProfileBtn.addEventListener('click', shareAcademicProfile);

  const copyProfileBtn = $('#copyProfileBtn');
  if (copyProfileBtn) copyProfileBtn.addEventListener('click', copyProfileLink);

  const shareNativeBtn = $('#shareNativeBtn');
  if (shareNativeBtn) shareNativeBtn.addEventListener('click', shareLinkViaNative);

  const avatarUpload = $('#avatar-upload');
  if (avatarUpload) {
    avatarUpload.addEventListener('change', function (e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function (event) {
        const dataUrl = event.target.result;
        localStorage.setItem('userAvatar', dataUrl);
        updateAvatar(dataUrl);
      };
      reader.readAsDataURL(file);
    });
  }

  root.querySelectorAll('.toggle-switch').forEach((toggle) => {
    toggle.addEventListener('click', function () {
      this.classList.toggle('on');
    });
  });

  context.root.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', () => router.navigateTo(el.dataset.route));
  });
}

// ==================== TAB SWITCHING ====================
function switchTab(tabId, root = document) {
  if (!root || root.nodeType !== 1 || typeof root.getElementById !== 'function') {
    root = document;
  }
  root.querySelectorAll('.tab-content').forEach((el) => el.classList.remove('active'));
  root.querySelectorAll('.tab-button').forEach((el) => el.classList.remove('active'));

  const tab = root.getElementById(tabId);
  if (tab) tab.classList.add('active');

  const btn = root.querySelector(`.tab-button[data-tab="${tabId}"]`);
  if (btn) btn.classList.add('active');

  if (tabId === 'downloaded-tab') renderDownloadedExams();
  if (tabId === 'planner-tab') renderAllPlannerModules();
}

// ==================== RENDER FUNCTIONS (summary, subjects, etc.) ====================
function renderSummary(summary) {
  if (!summary) return;
  const el = (id) => $(id);
  const totalExams = el('#total-exams');
  const totalQuestions = el('#total-questions');
  const avgScore = el('#avg-score');
  const totalTime = el('#total-time');
  const bestScore = el('#best-score');
  if (totalExams) totalExams.textContent = summary.totalExams || 0;
  if (totalQuestions) totalQuestions.textContent = summary.totalQuestions || 0;
  if (avgScore) avgScore.textContent = summary.averageScore ? `${summary.averageScore}%` : '—';
  if (totalTime) {
    // Prefer the raw seconds field — falls back to totalStudyTime (hours)
    // for older cached analytics objects that predate the field.
    let seconds = Number(summary.totalStudyTimeSeconds);
    if (!Number.isFinite(seconds)) {
      const hours = Number(summary.totalStudyTime);
      seconds = Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3600) : 0;
    }
    totalTime.textContent = formatStudyDuration(seconds);
  }
  if (bestScore) bestScore.textContent = summary.bestScore ? `${summary.bestScore}%` : '—';
}

function renderSubjectMastery(subjectData) {
  const container = $('#subject-mastery');
  if (!container) return;
  if (!subjectData || subjectData.length === 0) {
    container.innerHTML = '<p class="no-data">No subject data yet. Take some exams!</p>';
    return;
  }
  subjectData.sort((a, b) => b.percentage - a.percentage);
  let html = '<div class="subject-grid">';
  subjectData.forEach((s) => {
    const masteryClass = s.mastery || 'beginner';
    // ── ENGINE: posterior mastery + retention, when available.
    const hasEngine = Number.isFinite(s.engineMastery);
    const engineMasteryPct = hasEngine ? Math.round(s.engineMastery * 100) : null;
    const engineRetrievalPct = Number.isFinite(s.engineRetrieval)
      ? Math.round(s.engineRetrieval * 100)
      : null;
    const engineLine = hasEngine
      ? `<div style="font-size:0.72rem;color:var(--text-muted);margin-top:0.25rem;">
           Engine: ${engineMasteryPct}% mastery${engineRetrievalPct != null ? ` · ${engineRetrievalPct}% retention` : ''}
         </div>`
      : '';
    html += `
      <div class="subject-card mastery-${masteryClass}">
        <div class="subject-name">${s.subject}</div>
        <div class="subject-score">${s.percentage}%</div>
        <div class="subject-progress"><div class="progress-bar"><div class="progress-fill" style="width:${s.percentage}%;"></div></div></div>
        <div class="subject-stats">${s.correct}/${s.questions} · ⏱️ ${s.averageTime}s</div>
        ${engineLine}
      </div>
    `;
  });
  html += '</div>';
  container.innerHTML = html;
}

function renderStudyPatterns(patterns) {
  if (!patterns) return;
  const el = (id) => $(id);
  const bestDay = el('#best-day');
  const bestTime = el('#best-time');
  const avgSession = el('#avg-session');
  const consistency = el('#consistency');
  if (bestDay) bestDay.textContent = patterns.bestDay || '—';
  if (bestTime) bestTime.textContent = patterns.bestHour !== null ? `${patterns.bestHour}:00` : '—';
  if (avgSession) avgSession.textContent = patterns.averageSessionTime ? `${patterns.averageSessionTime} min` : '—';
  if (consistency) consistency.textContent = patterns.consistency ? `${patterns.consistency}%` : '—';
}

function renderWeakAreas(weakAreas) {
  const container = $('#weak-areas-list');
  if (!container) return;
  if (!weakAreas || weakAreas.length === 0) {
    container.innerHTML = '<p class="no-data">No weak areas identified. Keep up the great work!</p>';
    return;
  }

  // Restrict priority to known values — used as a CSS class suffix,
  // so untrusted values cannot break the classname or inject markup.
  const KNOWN_PRIORITIES = ['high', 'medium', 'low'];

  const items = weakAreas.slice(0, 5).map((area) => {
    const score = Math.round(area.score);
    const priority = KNOWN_PRIORITIES.includes(area.priority)
      ? area.priority
      : 'medium';

    // Engine metadata — only renders if the engine has data for this
    // topic. Both values may be null, one may be null, both may be set.
    const hasMastery = Number.isFinite(area.engineMastery);
    const hasRetention = Number.isFinite(area.engineRetrieval);
    let engineLine = '';
    if (hasMastery || hasRetention) {
      const parts = [];
      if (hasMastery) {
        parts.push(`Engine ${Math.round(area.engineMastery * 100)}%`);
      }
      if (hasRetention) {
        parts.push(`Retention ${Math.round(area.engineRetrieval * 100)}%`);
      }
      engineLine = `<span class="wa-engine">${parts.join(' · ')}</span>`;
    }

    return `
      <li>
        <div class="wa-main">
          <span class="topic">${escapeHtml(area.topic)}</span>
          <span class="score">${score}%</span>
        </div>
        <div class="wa-meta">
          <span class="wa-priority wa-priority-${priority}">${priority} priority</span>
          ${engineLine}
        </div>
      </li>
    `;
  }).join('');

  container.innerHTML = `<ul>${items}</ul>`;
}

// ── RENDER RECOMMENDATIONS (handles engine-generated types) ──
function renderRecommendations(recs) {
  const container = $('#recommendations-list');
  if (!container) return;
  if (!recs || recs.length === 0) {
    container.innerHTML = '<p class="no-data">No recommendations at this time.</p>';
    return;
  }
  const typeMeta = {
    retention_risk: { badge: '🔴', label: 'Retention risk', priority: 0 },
    focus_subject: { badge: '🎯', label: 'Focus area', priority: 1 },
    time_management: { badge: '⏱️', label: 'Time', priority: 2 },
    consistency: { badge: '📅', label: 'Consistency', priority: 3 },
    learning_insights: { badge: '🧠', label: 'Learning insights', priority: 4 },
    info: { badge: 'ℹ️', label: 'Info', priority: 5 },
  };
  const sorted = [...recs].sort((a, b) => {
    const pa = typeMeta[a.type]?.priority ?? 99;
    const pb = typeMeta[b.type]?.priority ?? 99;
    return pa - pb;
  });

  let html = '<ul>';
  sorted.slice(0, 6).forEach((r) => {
    const meta = typeMeta[r.type] || { badge: 'ℹ️', label: r.type || 'Note', priority: 99 };
    const isEngine = r.source === 'medvix-local';
    const sourceBadge = isEngine
      ? '<span style="font-size:0.65rem;background:var(--accent);color:#fff;padding:0.05rem 0.35rem;border-radius:4px;margin-left:0.35rem;">Engine</span>'
      : '';

    // Text extraction: try action → message → insights (in priority order)
    let bodyText = '';
    if (typeof r.action === 'string') bodyText = r.action;
    else if (typeof r.message === 'string') bodyText = r.message;
    else if (typeof r.insights === 'string') bodyText = r.insights;

    // learning_insights may also carry an array of recommendations
    const extraLines = Array.isArray(r.recommendations) && r.recommendations.length > 0
      ? `<div style="margin-top:0.25rem;font-size:0.85rem;color:var(--text-muted);">${escapeHtml(r.recommendations[0])}</div>`
      : '';

    html += `<li>
      <span style="margin-right:0.35rem;">${meta.badge}</span>
      <strong>${meta.label}:</strong> ${escapeHtml(bodyText)}
      ${sourceBadge}
      ${extraLines}
    </li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
}

// ==================== CHARTS ====================
function renderChart(type) {
  if (!analyticsData) return;
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  const chartEl = document.getElementById('main-chart');
  if (!chartEl) return;
  const ctx = chartEl.getContext('2d');
  let config = null;
  switch (type) {
    case 'score': config = getScoreTrendConfig(); break;
    case 'weekly': config = getWeeklyStudyConfig(); break;
    case 'subject': config = getSubjectMasteryConfig(); break;
    case 'accuracy': config = getAccuracyConfig(); break;
    case 'time-dist': config = getTimeDistributionConfig(); break;
    case 'radar': config = getRadarConfig(); break;
    default: config = getScoreTrendConfig();
  }
  if (config) chartInstance = new Chart(ctx, config);
}

function getScoreTrendConfig() {
  const trends = analyticsData.trends || [];
  if (trends.length < 2) {
    return {
      type: 'line',
      data: { labels: ['No Data'], datasets: [{ label: 'Score %', data: [0], borderColor: '#2563eb' }] },
      options: { responsive: true, maintainAspectRatio: false },
    };
  }
  const labels = trends.map((t) => utils.formatDate(t.date, 'short'));
  const scores = trends.map((t) => t.score);
  return {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Score %',
        data: scores,
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37,99,235,0.1)',
        tension: 0.2,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, max: 100, title: { display: true, text: 'Score %' } } },
      plugins: { legend: { display: false } },
    },
  };
}

function getWeeklyStudyConfig() {
  const trends = analyticsData.trends || [];
  if (trends.length < 2) {
    return {
      type: 'bar',
      data: { labels: ['No Data'], datasets: [{ label: 'Study Time (min)', data: [0], backgroundColor: '#f59e0b' }] },
      options: { responsive: true, maintainAspectRatio: false },
    };
  }
  const labels = trends.map((t) => utils.formatDate(t.date, 'short'));
  const times = trends.map((t) => t.time);
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Study Time (min)', data: times, backgroundColor: '#f59e0b', borderRadius: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, title: { display: true, text: 'Minutes' } } },
      plugins: { legend: { display: false } },
    },
  };
}

function getSubjectMasteryConfig() {
  const subjectData = analyticsData.subjectAnalysis || [];
  if (subjectData.length === 0) {
    return {
      type: 'bar',
      data: { labels: ['No Data'], datasets: [{ label: 'Mastery %', data: [0], backgroundColor: '#2563eb' }] },
      options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y' },
    };
  }
  const sorted = [...subjectData].sort((a, b) => a.percentage - b.percentage);
  const labels = sorted.map((s) => s.subject);
  const values = sorted.map((s) => s.percentage);
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Mastery %',
        data: values,
        backgroundColor: values.map((v) => (v >= 80 ? '#10b981' : v >= 60 ? '#f59e0b' : '#ef4444')),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: { x: { beginAtZero: true, max: 100, title: { display: true, text: 'Score %' } } },
      plugins: { legend: { display: false } },
    },
  };
}

function getAccuracyConfig() {
  const summary = analyticsData.summary || {};
  const total = summary.totalQuestions || 0;
  const correct = summary.correct ?? 0;
  const incorrect = Math.max(0, total - correct);
  return {
    type: 'doughnut',
    data: {
      labels: ['Correct', 'Incorrect'],
      datasets: [{ data: [correct, incorrect], backgroundColor: ['#10b981', '#ef4444'], borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
    },
  };
}

function getTimeDistributionConfig() {
  const subjectData = analyticsData.subjectAnalysis || [];
  if (subjectData.length === 0) {
    return {
      type: 'doughnut',
      data: { labels: ['No Data'], datasets: [{ data: [1], backgroundColor: ['#ccc'] }] },
      options: { responsive: true, maintainAspectRatio: false },
    };
  }
  const labels = subjectData.map((s) => s.subject);
  const times = subjectData.map((s) => s.time || s.questions || 10);
  
  // Generate unique colors for EVERY subject
  const dynamicColors = labels.map((_, i) => getDistinctColor(i));

  return {
    type: 'doughnut',
    data: { labels, datasets: [{ data: times, backgroundColor: dynamicColors }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom' } },
    },
  };
}

function getRadarConfig() {
  const subjectData = analyticsData.subjectAnalysis || [];
  if (subjectData.length < 3) {
    return {
      type: 'radar',
      data: { labels: ['No Data'], datasets: [{ label: 'Mastery', data: [0], borderColor: '#2563eb' }] },
      options: { responsive: true, maintainAspectRatio: false },
    };
  }
  const labels = subjectData.map((s) => s.subject);
  const values = subjectData.map((s) => s.percentage);
  return {
    type: 'radar',
    data: {
      labels,
      datasets: [{
        label: 'Mastery %',
        data: values,
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37,99,235,0.2)',
        pointBackgroundColor: '#2563eb',
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { r: { min: 0, max: 100 } },
      plugins: { legend: { display: false } },
    },
  };
}

// ==================== ACADEMIC PROFILE ====================
function renderAcademicProfile(data) {
  const {
    performance = {},
    leaderboard = [],
    challengeHistory = [],
    examResults = [],
    analytics = {},
    user = null,
  } = data || {};

  const safeChallengeHistory = Array.isArray(challengeHistory) ? challengeHistory : [];

  const name = user ? user.displayName || user.name || 'Student' : 'Guest';
  const year = user ? user.yearOfStudy || user.institution || 'Year 1' : 'Year 1';
  setText('#academic-name', name);
  setText('#academic-year', year);

  const rating = performance?.rating ?? 100;
  const rank = performanceRating.getRank(rating);
  setText('#academic-rank-badge', `🏆 ${rank.label}`);
  setText('#academic-mpre-score', Math.round(rating));
  setText('#academic-rank-label', `Rank ${rank.rank} · MPREv2`);

  const summary = analytics?.summary || {};
  const patterns = analytics?.studyPatterns || {};
  setText('#academic-exams', performance?.completedExams ?? 0);
  setText('#academic-questions', summary.totalQuestions ?? 0);
  setText('#academic-accuracy', summary.averageScore ? `${Math.round(summary.averageScore)}%` : '0%');
  setText('#academic-streak', patterns.streak ?? 0);

  setText('#academic-mpre-score-val', Math.round(rating));
  const stars = Math.min(5, Math.floor((rating - 100) / 400) + 1);
  setText('#academic-mpre-stars', '★'.repeat(Math.max(0, stars)) + '☆'.repeat(5 - Math.max(0, stars)));
  setText('#academic-mpre-rank', rank.label);

  const factors = computeAcademicFactors({
    rating,
    rank,
    completedExams: performance?.completedExams ?? 0,
    summary,
    patterns,
    examResults,
  });
  const progressContainer = $('#mpre-progress-bars');
  if (progressContainer) {
    const factorKeys = [
      'Accuracy', 'Difficulty', 'Consistency', 'Speed',
      'Improvement', 'Activity', 'Confidence', 'Stability',
    ];
    let progressHtml = '';
    factorKeys.forEach((key) => {
      const val = factors[key] ?? 0;
      progressHtml += `
        <div class="progress-bar-item">
          <div class="row"><span class="label">${key}</span><span class="value">${Math.round(val)}%</span></div>
          <div class="track"><div class="fill" style="width:${Math.round(val)}%;"></div></div>
        </div>
      `;
    });
    progressContainer.innerHTML = progressHtml;
  }

  const timelineContainer = $('#mpre-timeline');
  if (timelineContainer) {
    const changes = getRatingChanges(safeChallengeHistory);
    if (changes.length === 0) {
      timelineContainer.innerHTML =
        '<div style="color:var(--text-muted);font-size:0.9rem;text-align:center;">No recent rating changes.</div>';
    } else {
      let timelineHtml = '';
      changes.slice(0, 5).forEach((change) => {
        const cls = change.change >= 0 ? 'positive' : 'negative';
        timelineHtml += `
          <div class="timeline-item">
            <div><strong>${change.label}</strong><br><span style="font-size:0.8rem;color:var(--text-muted);">${change.desc}</span></div>
            <div class="change ${cls}">${change.change >= 0 ? '+' : ''}${Math.round(change.change)}</div>
          </div>
        `;
      });
      timelineContainer.innerHTML = timelineHtml;
    }
  }

  // ── ENGINE: AI Recommendation panel is now engine-narrated
  //    (analytics.aiInsights.source === 'medvix-local').
  const aiRecEl = $('#ai-recommendation-body');
  if (aiRecEl) {
    const txt = analytics?.aiInsights?.insights;
    if (txt) {
      aiRecEl.textContent = txt;
    } else {
      aiRecEl.textContent = 'Answer a few questions to unlock personalized learning insights.';
    }
  }

  const rankHistoryContainer = $('#rank-history-container');
  if (rankHistoryContainer) {
    const ranks = ['Seed', 'Aspire', 'Scholar', 'Proficient', 'Advanced', 'Expert', 'Elite', 'Master', 'Apex', 'Luminary'];
    const idx = ranks.indexOf(rank.label);
    rankHistoryContainer.innerHTML = ranks
      .map((r, i) =>
        `<span style="background:${i === idx ? 'var(--accent)' : 'var(--bg-secondary)'};color:${i === idx ? '#fff' : 'var(--text-primary)'};padding:0.15rem 0.5rem;border-radius:12px;">${r}</span>`
      )
      .join('');
  }

  const rivalTitle = $('#rival-title');
  const rivalSub = $('#rival-sub');
  if (rivalTitle && rivalSub && leaderboard.length) {
    const currentRating = rating;
    let closest = null;
    let minDiff = Infinity;
    for (const u of leaderboard) {
      if (user && u._id === user._id) continue;
      const diff = Math.abs(u.rating - currentRating);
      if (diff < minDiff) {
        minDiff = diff;
        closest = u;
      }
    }
    if (closest) {
      rivalTitle.textContent = `Closest Rival: ${closest.displayName || 'Unknown'}`;
      rivalSub.textContent = `You ${Math.round(currentRating)} · ${closest.displayName} ${Math.round(closest.rating)} · ${currentRating > closest.rating ? '+' : ''}${Math.round(currentRating - closest.rating)} MPRE`;
    } else {
      rivalTitle.textContent = 'No rival found';
      rivalSub.textContent = 'Compete in more exams to find your rival!';
    }
  }

  const latestBadgeTitle = $('#latest-badge-title');
  const latestBadgeSub = $('#latest-badge-sub');
  const badgeIcon = document.querySelector('#latest-badge-container .icon');
  const achievements = performance?.achievements ?? [];
  if (latestBadgeTitle && latestBadgeSub) {
    if (achievements.length > 0) {
      const latest = achievements[achievements.length - 1];
      latestBadgeTitle.textContent = latest.name;
      latestBadgeSub.textContent = `Unlocked ${latest.date || 'recently'}`;
      if (badgeIcon) badgeIcon.textContent = latest.icon || '🏅';
    } else {
      latestBadgeTitle.textContent = 'No badges yet';
      latestBadgeSub.textContent = 'Keep studying!';
    }
  }

  const galleryContainer = $('#badge-gallery');
  if (galleryContainer) {
    const allBadges = [
      { id: 'perfect_score', icon: '⭐', unlocked: achievements.some((a) => a.id === 'perfect_score') },
      { id: 'speed_demon', icon: '⚡', unlocked: achievements.some((a) => a.id === 'speed_demon') },
      { id: 'consistent', icon: '📊', unlocked: achievements.some((a) => a.id === 'consistent') },
      { id: 'rank_proficient', icon: '📚', unlocked: achievements.some((a) => a.id === 'rank_proficient') },
      { id: 'rank_expert', icon: '🚀', unlocked: achievements.some((a) => a.id === 'rank_expert') },
      { id: 'rank_master', icon: '👑', unlocked: achievements.some((a) => a.id === 'rank_master') },
      { id: 'rank_luminary', icon: '🌟', unlocked: achievements.some((a) => a.id === 'rank_luminary') },
    ];
    galleryContainer.innerHTML = allBadges
      .map((b) => `<div class="badge-item ${b.unlocked ? 'unlocked' : 'locked'}">${b.icon}</div>`)
      .join('');
  }

  const summaryBody = $('#academic-summary-body');
  if (summaryBody) {
    const txt = analytics?.aiInsights?.insights;
    if (txt) {
      summaryBody.innerHTML = escapeHtml(txt);
    } else {
      summaryBody.textContent = 'Answer a few questions to unlock your learning summary.';
    }
  }

  const initialsSpan = $('#avatar-initials');
  if (initialsSpan) {
    const displayName = user ? user.displayName || user.name || 'Student' : '?';
    initialsSpan.textContent = displayName
      .split(' ')
      .map((n) => n[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  renderAcademicCharts({ factors, summary, analytics });
}

// ==================== COMPUTE ACADEMIC FACTORS ====================
function computeAcademicFactors({ rating, rank, completedExams, summary, patterns, examResults }) {
  const totalExams = completedExams || 0;
  const totalQuestions = summary?.totalQuestions || 0;
  const avgScore = summary?.averageScore || 0;
  const totalTime = summary?.totalStudyTime || 0;

  const accuracy = Math.min(100, Math.max(0, avgScore));
  const consistency = patterns?.consistency !== undefined ? Math.min(100, Math.max(0, patterns.consistency)) : 50;
  const avgTimePerQ = totalQuestions > 0 ? (totalTime * 60) / totalQuestions : 60;
  const speed = Math.min(100, Math.max(0, 100 - ((avgTimePerQ - 10) / 50) * 100));

  const trends = analyticsData?.trends || [];
  let improvement = 0;
  if (trends.length >= 3) {
    const firstScores = trends.slice(0, 3).map((t) => t.score);
    const lastScores = trends.slice(-3).map((t) => t.score);
    const firstAvg = firstScores.reduce((a, b) => a + b, 0) / firstScores.length;
    const lastAvg = lastScores.reduce((a, b) => a + b, 0) / lastScores.length;
    improvement = Math.min(100, Math.max(0, ((lastAvg - firstAvg) / firstAvg) * 100));
  }

  const examsPerWeek = totalExams / (patterns?.weeksActive || 1);
  const activity = Math.min(100, Math.max(0, (examsPerWeek / 5) * 100));
  const confidence = Math.min(100, Math.max(0, (totalExams / 200) * 100));

  let stability = 50;
  if (trends.length >= 5) {
    const scores = trends.map((t) => t.score);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    const stdDev = Math.sqrt(variance);
    stability = Math.min(100, Math.max(0, 100 - (stdDev / 30) * 100));
  }

  return {
    Accuracy: Math.round(accuracy),
    Consistency: Math.round(consistency),
    Speed: Math.round(speed),
    Improvement: Math.round(improvement),
    Activity: Math.round(activity),
    Confidence: Math.round(confidence),
    Stability: Math.round(stability),
    Difficulty: Math.round(accuracy),
  };
}

// ==================== RENDER ACADEMIC CHARTS ====================
function renderAcademicCharts({ factors, summary, analytics }) {
  Object.values(academicChartInstances).forEach((chart) => chart.destroy());
  for (const key in academicChartInstances) delete academicChartInstances[key];

  const pieCanvas = document.getElementById('overview-pie-chart');
  if (pieCanvas) {
    const total = summary?.totalQuestions || 100;
    const correct = summary?.correct || 90;
    const incorrect = Math.max(0, total - correct);
    academicChartInstances.overviewPie = new Chart(pieCanvas, {
      type: 'doughnut',
      data: {
        labels: ['Correct', 'Incorrect'],
        datasets: [{ data: [correct, incorrect], backgroundColor: ['#10b981', '#ef4444'], borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12 } } },
      },
    });
  }

  const radarCanvas = document.getElementById('mpre-radar-chart');
  if (radarCanvas) {
    const labels = Object.keys(factors);
    const dataValues = Object.values(factors);
    academicChartInstances.mpreRadar = new Chart(radarCanvas, {
      type: 'radar',
      data: {
        labels,
        datasets: [{
          label: 'MPREv2 Factors',
          data: dataValues,
          backgroundColor: 'rgba(37, 99, 235, 0.2)',
          borderColor: '#2563eb',
          pointBackgroundColor: '#2563eb',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        scales: { r: { min: 0, max: 100, ticks: { stepSize: 20, font: { size: 10 } } } },
        plugins: { legend: { display: false } },
      },
    });
  }

  const doughnutCanvas = document.getElementById('mpre-doughnut-chart');
  if (doughnutCanvas) {
    const labels = Object.keys(factors);
    const dataValues = Object.values(factors);
    // Generate unique colors dynamically
    const dynamicColors = dataValues.map((_, i) => getDistinctColor(i));
    
    academicChartInstances.mpreDoughnut = new Chart(doughnutCanvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data: dataValues, backgroundColor: dynamicColors, borderWidth: 0 }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } } },
      },
    });
  }
}

// ==================== LEADERBOARD ====================
function renderLeaderboard(leaderboardData) {
  const container = $('#leaderboard-body');
  if (!container) return;
  if (!Array.isArray(leaderboardData) || leaderboardData.length === 0) {
    container.innerHTML =
      '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No users found.</td></tr>';
    return;
  }
  const currentUser = auth.getUser();
  let html = '';
  leaderboardData.forEach((u, idx) => {
    const isMe = currentUser && u._id === currentUser._id;
    const change = idx > 0 ? u.rating - leaderboardData[idx - 1].rating : 0;
    const cls = change > 0 ? 'up' : change < 0 ? 'down' : '';
    const arrow = change > 0 ? '↑' : change < 0 ? '↓' : '→';
    html += `
      <tr style="${isMe ? 'background:var(--bg-secondary);font-weight:600;' : ''}">
        <td class="rank-num">${idx + 1}</td>
        <td class="name">${u.displayName || 'Unknown'} ${isMe ? '(You)' : ''}</td>
        <td class="score">${Math.round(u.rating || 100)}</td>
        <td class="movement ${cls}">${arrow}${Math.abs(change)}</td>
      </tr>
    `;
  });
  container.innerHTML = html;
}

// ==================== COMPETITION STATS ====================
function renderCompetitionStats(challengeHistory, currentUserId) {
  const safeHistory = Array.isArray(challengeHistory) ? challengeHistory : [];
  if (safeHistory.length === 0) {
    setText('#comp-wins', '0');
    setText('#comp-top3', '0');
    setText('#comp-challenges', '0');
    setText('#comp-winrate', '0%');
    return;
  }
  const wins = safeHistory.filter((c) => c.winnerId === currentUserId).length;
  const top3 = safeHistory.filter((c) => c.result && c.result.percentage >= 70).length;
  const challenges = safeHistory.length;
  const winRate = challenges > 0 ? Math.round((wins / challenges) * 100) : 0;
  setText('#comp-wins', wins);
  setText('#comp-top3', top3);
  setText('#comp-challenges', challenges);
  setText('#comp-winrate', `${winRate}%`);
}

// ==================== ACTIVITY FEED ====================
function renderActivityFeed(challengeHistory) {
  const container = $('#activity-feed');
  if (!container) return;
  const safeHistory = Array.isArray(challengeHistory) ? challengeHistory : [];
  if (safeHistory.length === 0) {
    container.innerHTML =
      '<div style="color:var(--text-muted);font-size:0.9rem;text-align:center;">No recent activity.</div>';
    return;
  }
  const recent = safeHistory.slice(-5).reverse();
  let html = '';
  recent.forEach((c) => {
    const date = new Date(c.createdAt).toLocaleDateString('en-US', { weekday: 'long' });
    const change = c.result ? c.result.ratingAfter - c.result.ratingBefore : 0;
    const cls = change >= 0 ? 'positive' : 'negative';
    html += `
      <div class="timeline-item">
        <div><strong>${date}</strong><br><span style="font-size:0.8rem;color:var(--text-muted);">Challenge ${c.challengeCode}</span></div>
        <div><span style="font-weight:600;">${c.result ? Math.round(c.result.percentage) : '?'}%</span> · <span class="change ${cls}">${change >= 0 ? '+' : ''}${Math.round(change)} MPRE</span></div>
      </div>
    `;
  });
  container.innerHTML = html;
}

// ==================== GROWTH ====================
function renderGrowth(examResults, challengeHistory, performance) {
  const totalQuestions = examResults.reduce((sum, e) => sum + (e.totalQuestions || 0), 0);
  const streak = performance?.streak || 0;

  const qCrusher = $('#growth-questions-crusher');
  const qFill = $('#growth-questions-fill');
  if (qCrusher) qCrusher.textContent = `${totalQuestions} / 10,000`;
  if (qFill) qFill.style.width = `${Math.min(100, (totalQuestions / 10000) * 100)}%`;

  const streakProgress = $('#growth-streak-progress');
  const streakFill = $('#growth-streak-fill');
  if (streakProgress) streakProgress.textContent = `${streak} / 30`;
  if (streakFill) streakFill.style.width = `${Math.min(100, (streak / 30) * 100)}%`;

  const patterns = analyticsData?.studyPatterns || {};
  setText('#growth-avg-q', patterns.averageQuestionsPerDay ?? 0);
  setText('#growth-best-time', patterns.bestHour !== null ? `${patterns.bestHour}:00` : '—');
  setText('#growth-longest', patterns.longestSession ?? 0);
  setText('#growth-avg-session', patterns.averageSessionTime ?? 0);

  const heatmapContainer = $('#study-heatmap');
  if (heatmapContainer) {
    const heatmapData = generateHeatmap(examResults);
    heatmapContainer.innerHTML = heatmapData
      .map((d) => `<div class="cell ${d.active ? (d.semi ? 'semi' : 'active') : ''}"></div>`)
      .join('');
  }

  const trends = analyticsData?.trends || [];
  const questionTrendContainer = $('#questions-trend-chart');
  const hourTrendContainer = $('#hours-trend-chart');
  if (questionTrendContainer && hourTrendContainer) {
    if (trends.length > 0) {
      const recentTrends = trends.slice(-5);
      const qMax = Math.max(...recentTrends.map((t) => t.questions || 0), 1);
      const hMax = Math.max(...recentTrends.map((t) => t.time || 0), 1);
      questionTrendContainer.innerHTML = recentTrends
        .map((t) => `<div style="width:20px;height:${(t.questions / qMax) * 50 + 10}px;background:var(--accent);border-radius:2px;"></div>`)
        .join('');
      hourTrendContainer.innerHTML = recentTrends
        .map((t) => `<div style="width:20px;height:${(t.time / hMax) * 50 + 10}px;background:var(--warning);border-radius:2px;"></div>`)
        .join('');
    } else {
      questionTrendContainer.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No data</div>';
      hourTrendContainer.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;">No data</div>';
    }
  }
}

// ==================== HELPER: GENERATE HEATMAP ====================
function generateHeatmap(examResults) {
  const days = 28;
  const cells = [];
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - (days - 1 - i));
    const dateStr = date.toISOString().split('T')[0];
    const exam = examResults.find((e) => e.date?.startsWith(dateStr));
    cells.push({ active: !!exam, semi: false });
  }
  return cells;
}

// ==================== HELPER: GET RATING CHANGES ====================
function getRatingChanges(challengeHistory) {
  if (!Array.isArray(challengeHistory) || challengeHistory.length < 2) return [];
  const changes = [];
  for (const c of challengeHistory) {
    if (c.result && c.result.ratingBefore !== undefined && c.result.ratingAfter !== undefined) {
      const diff = c.result.ratingAfter - c.result.ratingBefore;
      if (diff !== 0) {
        changes.push({
          label: new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          desc: `Challenge ${c.challengeCode}`,
          change: diff,
        });
      }
    }
  }
  return changes.slice(-5).reverse();
}

// ==================== MEDVIX LEARNING INSIGHTS (new) ====================

function ensureMedVixContainer() {
  let container = document.getElementById('medvix-insights');
  if (container) return container;

  // Prefer inserting right after the recommendations card
  const recList = document.getElementById('recommendations-list');
  if (recList) {
    let card = recList;
    while (card && card.parentNode && !card.className?.toString?.().includes('card')) {
      card = card.parentNode;
    }
    if (card && card.className?.toString?.().includes('card') && card.parentNode) {
      container = document.createElement('div');
      container.id = 'medvix-insights';
      container.className = card.className;
      container.style.marginTop = '1rem';
      card.parentNode.insertBefore(container, card.nextSibling);
      return container;
    }
  }

  // Fallback: append to real content or body
  const root = document.getElementById('real-content') || document.body;
  container = document.createElement('div');
  container.id = 'medvix-insights';
  container.className = 'card';
  container.style.marginTop = '1rem';
  root.appendChild(container);
  return container;
}

async function renderMedVixInsights(analyticsSnapshot) {
  if (_medvixRendered) return;
  _medvixRendered = true;

  const container = ensureMedVixContainer();
  container.innerHTML = `
    <div class="card-header" style="display:flex;justify-content:space-between;align-items:center;">
      <h2 style="margin:0;">🧠 Learning Insights</h2>
      <span style="font-size:0.7rem;color:var(--text-muted);">Local engine · offline · truthful</span>
    </div>
    <div class="card-body" id="medvix-insights-body">
      <p class="no-data">Analysing your history...</p>
    </div>
  `;
  const body = document.getElementById('medvix-insights-body');
  if (!body) return;

  let digest = null;
  try {
    digest = await analytics.getLearningDigest('friendly');
  } catch (e) {
    console.warn('[Performance] getLearningDigest failed:', e);
  }

  if (!digest || digest.evidenceCount === 0) {
    body.innerHTML = `
      <p class="no-data">
        Answer a few questions and the learning engine will start reporting here —
        mastery estimates, retention risks, and review targets, all computed on-device.
      </p>
    `;
    return;
  }

  const totalConcepts = digest.totalConcepts || 0;
  const evidenceCount = digest.evidenceCount || 0;
  const avgMasteryPct = Number.isFinite(digest.averageMastery)
    ? Math.round(digest.averageMastery * 100)
    : null;
  const brierVal = digest.brier?.value;

  // Mode recommendation from the engine
  let modeRec = null;
  try {
    modeRec = await analytics.getRecommendedMode({
      budgetSec: 600,
      subject: analyticsSnapshot?.subjectAnalysis?.[0]?.subject || null,
    });
  } catch { /* ignore */ }

  const modeLabel = modeRec
    ? modeRec.mode.replace(/_/g, ' ')
    : 'broad curriculum revision';

  const parts = [];

  // ── Stat strip ──
  parts.push(`
    <div class="medvix-stats" style="display:flex;flex-wrap:wrap;gap:0.75rem 1.5rem;margin-bottom:1rem;font-size:0.9rem;">
      <div><strong>${totalConcepts}</strong> concepts tracked</div>
      <div><strong>${evidenceCount}</strong> observations</div>
      ${avgMasteryPct != null ? `<div>Avg mastery <strong>${avgMasteryPct}%</strong></div>` : ''}
      ${brierVal != null ? `<div>Calibration (Brier) <strong>${brierVal.toFixed(3)}</strong></div>` : ''}
      <div>Suggested mode <strong>${escapeHtml(modeLabel)}</strong></div>
    </div>
  `);

  // ── Retention risks ──
  if (Array.isArray(digest.riskNarrations) && digest.riskNarrations.length > 0) {
    parts.push('<h3 style="margin:0.75rem 0 0.4rem;font-size:1rem;">⚠️ Retention Risk</h3><ul style="padding-left:1.2rem;">');
    for (const r of digest.riskNarrations) {
      parts.push(`<li>${escapeHtml(r.narration.text)}</li>`);
    }
    parts.push('</ul>');
  }

  // ── Focus concepts ──
  if (Array.isArray(digest.weakNarrations) && digest.weakNarrations.length > 0) {
    parts.push('<h3 style="margin:0.75rem 0 0.4rem;font-size:1rem;">🎯 Focus Concepts</h3><ul style="padding-left:1.2rem;">');
    for (const w of digest.weakNarrations) {
      parts.push(`<li>${escapeHtml(w.narration.text)}</li>`);
    }
    parts.push('</ul>');
  }

  // ── Suggested reviews ──
  if (Array.isArray(digest.targets) && digest.targets.length > 0) {
    parts.push('<h3 style="margin:0.75rem 0 0.4rem;font-size:1rem;">📅 Suggested Reviews</h3><ul style="padding-left:1.2rem;">');
    for (const t of digest.targets) {
      parts.push(`<li>${escapeHtml(t.narration.text)}</li>`);
    }
    parts.push('</ul>');
  }

  // ── Action row ──
  parts.push(`
    <div style="display:flex;gap:0.5rem;margin-top:1rem;flex-wrap:wrap;">
      <button id="medvix-start-adaptive" class="btn btn-primary" type="button">
        Start Adaptive Session
      </button>
      <button id="medvix-refresh" class="btn btn-secondary" type="button">
        Refresh Insights
      </button>
    </div>
  `);

  body.innerHTML = parts.join('');

  // Wire the buttons
  const startBtn = document.getElementById('medvix-start-adaptive');
  if (startBtn) {
    startBtn.addEventListener('click', () => prepareAdaptiveSession(startBtn));
  }
  const refreshBtn = document.getElementById('medvix-refresh');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      try {
        await medvix.reset();
        _medvixRendered = false;
        await renderMedVixInsights(analyticsSnapshot);
      } catch (e) {
        console.warn('[Performance] MedVix refresh failed:', e);
        _medvixRendered = true;
      }
    });
  }
}

/**
 * Prepare an adaptive session: pick the top-reviewed concept's subject,
 * build an engine-ranked config, stash it, and navigate to exam-config.
 * If the config page is unavailable, the config is still stashed in
 * sessionStorage so the flow can be completed manually.
 */
async function prepareAdaptiveSession(button) {
  const originalLabel = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Preparing...';
  }
  try {
    const targets = await analytics.getReviewTargets(3);
    if (!targets || targets.length === 0) {
      ui.showToast('Not enough data yet — take a few questions first.', 'info');
      return;
    }

    // Group targets by subject
    const bySubject = {};
    for (const t of targets) {
      if (!t.conceptId || !t.conceptId.includes('::')) continue;
      const [subject, topic] = t.conceptId.split('::');
      if (!bySubject[subject]) bySubject[subject] = [];
      bySubject[subject].push(topic);
    }
    const subjects = Object.keys(bySubject);
    if (subjects.length === 0) {
      ui.showToast('Could not determine a target subject yet.', 'info');
      return;
    }
    // Prefer subject with most review targets
    const topSubject = subjects.sort(
      (a, b) => bySubject[b].length - bySubject[a].length
    )[0];
    const topics = bySubject[topSubject];

    const config = await examEngine.buildAdaptiveExamConfig({
      subject: topSubject,
      topics,
      questionCount: 20,
      preferredExamMode: 'standard',
    });

    // Stash so the exam-config / exam page can pick it up
    try {
      examEngine.setExamConfig(config);
    } catch (e) {
      console.warn('[Performance] setExamConfig failed:', e);
    }

    ui.showToast(
      `Adaptive session prepared: ${topSubject} · ${topics.length} topic(s)`,
      'success'
    );

    // exam-settings.js picks up the config via examEngine.getConfig().
    try {
      router.navigateTo('exam-settings');
    } catch (e) {
      console.warn('[Performance] navigateTo("exam-settings") failed:', e);
    }
  } catch (e) {
    console.error('[Performance] prepareAdaptiveSession failed:', e);
    ui.showToast('Could not prepare an adaptive session.', 'error');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || 'Start Adaptive Session';
    }
  }
}

// ==================== DOWNLOADED EXAMS ====================
async function renderDownloadedExams() {
  const container = $('#downloaded-list');
  if (!container) return;
  const exams = await db.getDownloadedExams();
  if (!exams || exams.length === 0) {
    container.innerHTML =
      '<p class="no-data">No downloaded exams yet. Download exams from results page.</p>';
    return;
  }
  let html = '';
  exams.forEach((exam) => {
    const score = exam.score != null ? Math.round(exam.score) : 0;
    const date = exam.date ? utils.formatDate(exam.date) : '';
    html += `
      <div class="downloaded-item" data-examid="${exam.examId}">
        <div class="downloaded-header"><span class="subject">${exam.subject}</span> <span class="score">${score}%</span> <span class="date">${date}</span></div>
        <div class="downloaded-actions">
          <button class="btn-small review-btn" data-examid="${exam.examId}">Review</button>
          <button class="btn-small btn-secondary share-btn" data-examid="${exam.examId}">Share</button>
          <button class="btn-small btn-danger delete-btn" data-examid="${exam.examId}">Delete</button>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;

  container.querySelectorAll('.review-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await reviewDownloadedExam(btn.dataset.examid);
      } catch (err) {
        console.error('[Review] Error:', err);
        ui.showToast('Failed to open review. Please try again.', 'error');
      }
    });
  });
  container.querySelectorAll('.share-btn').forEach((btn) => {
    btn.addEventListener('click', () => shareDownloadedExam(btn.dataset.examid));
  });
  container.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteDownloadedExam(btn.dataset.examid));
  });
}

async function reviewDownloadedExam(examId) {
  const exams = await db.getDownloadedExams();
  const exam = exams.find((e) => e.examId === examId);
  if (!exam) {
    ui.showToast('Exam not found.', 'error');
    return;
  }

  let examData = exam.data;
  if (typeof examData === 'string') {
    try {
      examData = JSON.parse(examData);
    } catch (e) {
      console.error('Failed to parse exam data:', e);
      ui.showToast('Failed to load exam data.', 'error');
      return;
    }
  }

  const questionsList = examData && Array.isArray(examData.questions) ? examData.questions : [];
  const subject = (examData && examData.subject) || exam.subject || '';
  const totalQuestions = examData && examData.totalQuestions != null ? examData.totalQuestions : questionsList.length;
  const correctAnswers = examData && examData.correctAnswers != null ? examData.correctAnswers : 0;

  const formatDateSafe = (date) => {
    try {
      return utils.formatDate ? utils.formatDate(date) : new Date(date).toLocaleDateString();
    } catch {
      return '—';
    }
  };

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.style.cssText =
    'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;overflow-y:auto;padding:1rem;';

  let reviewHtml = '';
  if (questionsList.length > 0) {
    reviewHtml = questionsList.map((q, idx) => {
      const isCorrect = q.correct;
      const userAnswerText = getOptionText(q.userAnswer, q.options);
      const correctAnswerText = getOptionText(q.correctAnswer, q.options);
      const explanationHtml = formatExplanation(q.explanation);
      const imageHtml = q.image
        ? `<div class="modal-review-image" data-q-idx="${idx}" style="text-align:center;margin:0.5rem 0;"></div>`
        : '';
      return `
        <div class="review-item ${isCorrect ? 'correct' : 'incorrect'}" style="margin-bottom:1rem;padding:1rem;border-radius:8px;background:var(--bg-secondary, #0f172a);border-left:4px solid ${isCorrect ? '#10b981' : '#ef4444'};">
          <div style="font-weight:600;margin-bottom:0.5rem;color:var(--text-primary, #fff);"><strong>Q${idx + 1}:</strong> ${q.question}</div>
          ${imageHtml}
          <div style="font-size:0.85rem;color:var(--text-muted, #94a3b8);margin-bottom:0.5rem;display:flex;flex-wrap:wrap;gap:0.5rem;align-items:center;">
            <span>
              <span style="color:#60a5fa; font-weight:600;">Your answer:</span>
              <span style="color:${isCorrect ? '#10b981' : '#ef4444'}; font-weight:500;">${userAnswerText}</span>
            </span>
            <span style="color:var(--border, #334155);">|</span>
            <span>
              <span style="color:#60a5fa; font-weight:600;">Correct:</span>
              <span style="color:#10b981; font-weight:500;">${correctAnswerText}</span>
            </span>
          </div>
          <div class="explanation" style="font-size:0.85rem;padding:0.5rem;background:var(--bg-card, #1e293b);border-radius:4px;color:var(--text-primary, #fff);">${explanationHtml}</div>
        </div>
      `;
    }).join('');
  } else {
    reviewHtml = '<p style="text-align:center;color:var(--text-muted);">No question data available for this exam.</p>';
  }

  const pieDeg = exam.score * 3.6; // 100% = 360deg
  
  modal.innerHTML = `
    <div class="modal review-modal" style="background:var(--bg-card, #1e293b);border-radius:12px;max-width:600px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 10px 25px rgba(0,0,0,0.5);">
      
      <!-- Compact Header -->
      <div class="modal-header" style="padding:0.75rem 1rem;border-bottom:1px solid var(--border, #334155);display:flex;justify-content:space-between;align-items:center;background:var(--bg-card, #1e293b);">
        <h2 style="margin:0;font-size:1rem;color:var(--text-primary, #fff);font-weight:600;letter-spacing:0.02em;">Exam Review</h2>
        <div style="display:flex;align-items:center;gap:0.75rem;">
          <span style="font-size:0.85rem;color:var(--text-muted, #94a3b8);font-weight:500;background:var(--bg-secondary);padding:0.15rem 0.5rem;border-radius:20px;">${Math.round(exam.score)}%</span>
          <button class="modal-close" style="background:none;border:none;font-size:1.5rem;cursor:pointer;color:var(--text-primary, #fff);line-height:1;padding:0;margin-top:-2px;">&times;</button>
        </div>
      </div>

      <div class="modal-body" style="padding:1rem;overflow-y:auto;flex:1;">
        <div class="summary-card" style="display:flex;gap:1rem;margin-bottom:1rem;padding:1rem;background:var(--bg-secondary, #0f172a);border-radius:8px;align-items:center;">
          
          <!-- Fixed Pie Chart -->
          <div class="score-circle" style="width:80px;height:80px;border-radius:50%;background:conic-gradient(var(--accent, #2563eb) ${pieDeg}deg, var(--border, #334155) 0deg);display:flex;align-items:center;justify-content:center;font-weight:bold;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,0.6);font-size:1.1rem;">${Math.round(exam.score)}%</div>
          
          <div style="color:var(--text-primary, #fff);font-size:0.9rem;">
            <p style="margin:0.2rem 0;"><strong>Date:</strong> ${formatDateSafe(exam.date)}</p>
            <p style="margin:0.2rem 0;"><strong>Questions:</strong> ${totalQuestions}</p>
            <p style="margin:0.2rem 0;"><strong>Correct:</strong> ${correctAnswers}</p>
          </div>
        </div>
        <div id="modal-review-list" class="review-list">${reviewHtml}</div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  _openReviewModal = modal;
  hydrateModalReviewImages(modal, subject, questionsList).catch((err) =>
    console.warn('[Performance] hydrateModalReviewImages failed:', err)
  );

  modal.querySelector('.modal-close').onclick = () => _cleanupReviewModal(modal);
  modal.onclick = (e) => {
    if (e.target === modal) _cleanupReviewModal(modal);
  };
}

async function hydrateModalReviewImages(modal, subject, questionsList) {
  if (!subject) return;

  const slots = modal.querySelectorAll('.modal-review-image[data-q-idx]');
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
          console.warn(`[Performance] Slide image missing: ${subject}/${filename}`);
          continue;
        }
        const url = URL.createObjectURL(blob);
        if (!modal._objectUrls) modal._objectUrls = [];
        modal._objectUrls.push(url);

        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Question diagram';
        img.style.cssText =
          'max-width:100%;max-height:300px;border-radius:8px;display:inline-block;' +
          'background:var(--bg-card, #1e293b);padding:4px;border:1px solid var(--border, #334155);';
        slot.appendChild(img);
      } else {
        const img = document.createElement('img');
        img.src = `/data/images/${encodeURIComponent(subject)}/${encodeURIComponent(filename)}`;
        img.alt = 'Question diagram';
        img.style.cssText =
          'max-width:100%;max-height:300px;border-radius:8px;display:inline-block;' +
          'background:var(--bg-card, #1e293b);padding:4px;border:1px solid var(--border, #334155);';
        img.onerror = () => img.remove();
        slot.appendChild(img);
      }
    } catch (e) {
      console.warn(`[Performance] Failed to load image ${subject}/${filename}:`, e);
    }
  }
}

function _cleanupReviewModal(modal) {
  if (!modal) return;
  if (modal._objectUrls) {
    for (const url of modal._objectUrls) {
      try { URL.revokeObjectURL(url); } catch { /* ignore */ }
    }
    modal._objectUrls = null;
  }
  if (modal.parentNode) modal.remove();
  if (_openReviewModal === modal) _openReviewModal = null;
}

function getOptionText(letter, options) {
  if (!letter || !options || !Array.isArray(options)) return letter || '—';
  const index = letter.toUpperCase().charCodeAt(0) - 65;
  if (index < 0 || index >= options.length) return letter;
  const opt = options[index];
  return typeof opt === 'object' && opt !== null ? opt.text : opt;
}

function formatExplanation(explanation) {
  if (!explanation) return '';
  if (typeof explanation === 'object') {
    let parts = [];
    if (explanation.overview) parts.push(explanation.overview);
    if (explanation.highYield) parts.push(`<br><strong>High‑Yield:</strong> ${explanation.highYield}`);
    if (explanation.clinicalCorrelation)
      parts.push(`<br><strong>Clinical:</strong> ${explanation.clinicalCorrelation}`);
    return parts.join(' ');
  }
  return explanation;
}

async function shareDownloadedExam(examId) {
  const exams = await db.getDownloadedExams();
  const exam = exams.find((e) => e.examId === examId);
  if (!exam) return;
  if (!navigator.onLine) {
    ui.showToast('You need to be online to create a share link.', 'error');
    return;
  }
  const user = auth.getUser();
  if (!user || !user._id) {
    ui.showToast('You must be logged in to share exams.', 'error');
    return;
  }
  ui.showLoading('Creating share link...');
  try {
    const result = await convexHttpClient.mutation('sharedExams/mutations:createShare', {
      examData: exam.data,
      userId: user._id,
    });
    const shareLinkInput = $('#share-link');
    const shareModal = $('#share-modal');
    if (shareLinkInput) shareLinkInput.value = result.url;
    if (shareModal) shareModal.style.display = 'flex';
    ui.showToast('Share link created!', 'success');
  } catch (error) {
    console.error('Failed to create share link:', error);
    ui.showToast(error.message || 'Failed to create share link', 'error');
  } finally {
    ui.hideLoading();
  }
}

async function deleteDownloadedExam(examId) {
  if (!confirm('Delete this downloaded exam?')) return;
  let exams = await db.getDownloadedExams();
  exams = exams.filter((e) => e.examId !== examId);
  await db.saveDownloadedExams(exams);
  renderDownloadedExams();
  ui.showToast('Exam deleted', 'success');
}

// ==================== PLANNER MODULES ====================
const LS_KEYS = {
  timetable: 'medvix_planner_timetable',
  topics: 'medvix_planner_topics',
  sessions: 'medvix_planner_sessions',
  streaks: 'medvix_planner_streaks',
  exams: 'medvix_planner_exams',
  checklist: 'medvix_planner_checklist',
};

function loadData(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function saveData(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function getToday() { return new Date().toISOString().split('T')[0]; }
function getYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}
function getWeekStart() {
  const d = new Date();
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const m = new Date(d.setDate(diff));
  return m.toISOString().split('T')[0];
}
function getDaysInMonth(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  return new Date(year, month, 0).getDate();
}
function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function formatDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ── Timetable colours ────────────────────────────────────────────────
// Any user-typed subject/activity gets a stable color. Two-tier:
//   Tier 1 — known semantic subjects get their historical class.
//   Tier 2 — every other subject name → deterministic HSL from Golden Angle.

const KNOWN_SEMANTIC_COLORS = new Set([
  'anatomy', 'physiology', 'biochemistry', 'revision',
  'mcq', 'pathology', 'pharmacology',
]);

// Convert a string to a large integer index for the golden angle generator
function _stringToIndex(str) {
  let h = 0;
  const s = String(str || '').trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h) * 17; // Multiply by prime to spread far across color wheel
}

function _renderSubjectTag(subject, storedColor) {
  const safeText = escapeHtml(subject);
  const normalizedSubject = String(subject || '').trim().toLowerCase();

  // Tier 1: legacy known-semantic class (backward compat)
  if (
    typeof storedColor === 'string' &&
    KNOWN_SEMANTIC_COLORS.has(storedColor) &&
    storedColor === normalizedSubject
  ) {
    return `<span class="subject-tag ${storedColor}">${safeText}</span>`;
  }

  // Tier 2: Infinite distinct colors via Golden Angle generator
  const colorIndex = _stringToIndex(subject);
  const color = getDistinctColor(colorIndex);
  return `<span class="subject-tag" style="background:${color}; color:#fff;">${safeText}</span>`;
}

function renderTimetable() {
  const container = $('#timetable-container');
  if (!container) return;
  const data = loadData(LS_KEYS.timetable, {});
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  let html = '';
  days.forEach((day) => {
    const slots = data[day] || [];
    html += `<div class="timetable-day"><div class="day-label">${day}</div>`;
    if (slots.length === 0) {
      html += `<div style="color:var(--text-muted);font-size:0.85rem;">No sessions</div>`;
    } else {
      slots.forEach((s, idx) => {
        const tag = _renderSubjectTag(s.subject, s.color);
        html += `
          <div class="timetable-slot" style="display:flex; justify-content:space-between; align-items:center;">
            <div><span class="time">${escapeHtml(s.time)}</span> ${tag}</div>
            <button onclick="window.deleteTimetableSlot('${day}', ${idx})" style="background:none;border:none;color:var(--danger);cursor:pointer;font-size:1rem;padding:0 0.5rem;">&times;</button>
          </div>`;
      });
    }
    html += `</div>`;
  });
  container.innerHTML = html;
}

window.deleteTimetableSlot = function (day, idx) {
  const data = loadData(LS_KEYS.timetable, {});
  if (data[day] && data[day][idx]) {
    data[day].splice(idx, 1);
    saveData(LS_KEYS.timetable, data);
    renderTimetable();
    renderReminders();
  }
};

function addTimetableSlot() {
  const day = $('#tt-day-select')?.value;
  const time = $('#tt-time')?.value.trim();
  const subject = $('#tt-subject')?.value.trim();
  if (!day || !time || !subject) {
    ui.showToast('Please fill in day, time and subject.', 'error');
    return;
  }

  const data = loadData(LS_KEYS.timetable, {});
  if (!data[day]) data[day] = [];
  data[day].push({ time, subject });
  saveData(LS_KEYS.timetable, data);
  renderTimetable();
  renderReminders();
  const timeInput = $('#tt-time');
  const subjectInput = $('#tt-subject');
  if (timeInput) timeInput.value = '';
  if (subjectInput) subjectInput.value = '';
  ui.showToast('Session added to timetable!', 'success');
}

function renderTopics() {
  const container = $('#topic-planner-list');
  if (!container) return;
  const data = loadData(LS_KEYS.topics, []);
  if (data.length === 0) {
    container.innerHTML =
      '<div style="color:var(--text-muted);font-size:0.9rem;">No topics yet. Add one above.</div>';
    return;
  }
  const statusMap = {
    'not-started': '🔴 Not Started',
    'in-progress': '🟡 In Progress',
    'needs-revision': '🔵 Needs Revision',
    'completed': '🟢 Completed',
  };
  let html = '';
  data.forEach((item, idx) => {
    const statusLabel = statusMap[item.status] || item.status;
    html += `
      <div class="topic-item" onclick="window.toggleTopicStatus(${idx})">
        <span class="status-icon">${statusLabel.split(' ')[0]}</span>
        <span class="topic-name"><strong>${item.subject}</strong> — ${item.topic}</span>
        <span class="status-label ${item.status}">${statusLabel}</span>
      </div>
    `;
  });
  container.innerHTML = html;
}

window.toggleTopicStatus = function (idx) {
  const data = loadData(LS_KEYS.topics, []);
  if (!data[idx]) return;
  const order = ['not-started', 'in-progress', 'needs-revision', 'completed'];
  const current = data[idx].status;
  let nextIdx = order.indexOf(current) + 1;
  if (nextIdx >= order.length) nextIdx = 0;
  data[idx].status = order[nextIdx];
  saveData(LS_KEYS.topics, data);
  renderTopics();
  ui.showToast(`Status changed to ${order[nextIdx].replace('-', ' ')}`, 'info');
};

function addTopicItem() {
  const subject = $('#tp-subject')?.value.trim();
  const topic = $('#tp-topic')?.value.trim();
  const status = $('#tp-status')?.value;
  if (!subject || !topic) {
    ui.showToast('Please fill in subject and topic.', 'error');
    return;
  }
  const data = loadData(LS_KEYS.topics, []);
  data.push({ subject, topic, status });
  saveData(LS_KEYS.topics, data);
  renderTopics();
  const subjectInput = $('#tp-subject');
  const topicInput = $('#tp-topic');
  if (subjectInput) subjectInput.value = '';
  if (topicInput) topicInput.value = '';
  ui.showToast('Topic added!', 'success');
}

function renderSessions() {
  const container = $('#session-log');
  if (!container) return;
  const data = loadData(LS_KEYS.sessions, []);
  const today = getToday();
  const weekStart = getWeekStart();

  let todayTotal = 0, weekTotal = 0, durations = [];
  data.forEach((s) => {
    const d = s.start ? s.start.split('T')[0] : '';
    if (d === today) todayTotal += s.duration || 0;
    if (d >= weekStart) weekTotal += s.duration || 0;
    if (s.duration) durations.push(s.duration);
  });
  const avg = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

  const el = (id) => $(id);
  const ssToday = el('#ss-today');
  const ssWeek = el('#ss-week');
  const ssAvg = el('#ss-avg');
  if (ssToday) ssToday.textContent = (todayTotal / 60).toFixed(1) + 'h';
  if (ssWeek) ssWeek.textContent = (weekTotal / 60).toFixed(1) + 'h';
  if (ssAvg) ssAvg.textContent = avg + 'm';

  if (data.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;">No sessions logged yet.</div>';
    return;
  }
  let html = '';
  data.slice().reverse().slice(0, 10).forEach((s) => {
    const startFmt = s.start ? formatTime(s.start) : '—';
    const endFmt = s.end ? formatTime(s.end) : '—';
    html += `<div class="entry"><span><strong>${s.subject}</strong> ${s.topic ? '– ' + s.topic : ''}</span><span>${startFmt}–${endFmt} (${s.duration || 0}m)</span></div>`;
  });
  container.innerHTML = html;
}

function addStudySession() {
  const subject = $('#ss-subject')?.value.trim();
  const topic = $('#ss-topic')?.value.trim();
  const start = $('#ss-start')?.value;
  const end = $('#ss-end')?.value;
  const notes = $('#ss-notes')?.value.trim();
  if (!subject || !start || !end) {
    ui.showToast('Please fill in subject, start and end times.', 'error');
    return;
  }
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (endMs <= startMs) {
    ui.showToast('End time must be after start time.', 'error');
    return;
  }
  const duration = Math.round((endMs - startMs) / 60000);
  const data = loadData(LS_KEYS.sessions, []);
  data.push({ subject, topic, start, end, duration, notes, date: getToday() });
  saveData(LS_KEYS.sessions, data);
  renderSessions();
  ['#ss-subject', '#ss-topic', '#ss-start', '#ss-end', '#ss-notes'].forEach((sel) => {
    const input = $(sel);
    if (input) input.value = '';
  });
  ui.showToast(`Session logged: ${duration} minutes!`, 'success');
}

function renderStreaks() {
  const container = $('#streak-current');
  if (!container) return;
  const data = loadData(LS_KEYS.streaks, { current: 0, longest: 0, lastDate: null, monthDays: [] });
  const today = getToday();
  let current = data.current || 0;
  let longest = data.longest || 0;

  const sessions = loadData(LS_KEYS.sessions, []);
  const studiedToday = sessions.some((s) => s.date === today);
  const studiedYesterday = sessions.some((s) => s.date === getYesterday());

  if (studiedToday && data.lastDate !== today) {
    if (data.lastDate === getYesterday()) current += 1;
    else current = 1;
    data.lastDate = today;
    if (current > longest) longest = current;
    data.current = current;
    data.longest = longest;
    const monthKey = today.substring(0, 7);
    const monthDays = data.monthDays || [];
    if (!monthDays.includes(today)) monthDays.push(today);
    data.monthDays = monthDays;
    saveData(LS_KEYS.streaks, data);
  } else if (!studiedToday && data.lastDate !== today && data.lastDate !== getYesterday()) {
    current = 0;
    data.current = 0;
    data.lastDate = today;
    saveData(LS_KEYS.streaks, data);
  }

  const el = (id) => $(id);
  const streakCurrent = el('#streak-current');
  const streakLongest = el('#streak-longest');
  const streakMonth = el('#streak-month');
  if (streakCurrent) streakCurrent.textContent = current;
  if (streakLongest) streakLongest.textContent = longest;

  const monthKey = today.substring(0, 7);
  const monthDays = data.monthDays || [];
  const daysInMonth = getDaysInMonth(today);
  const count = monthDays.filter((d) => d.startsWith(monthKey)).length;
  if (streakMonth) streakMonth.textContent = `${count}/${daysInMonth}`;
}

function renderExams() {
  const container = $('#exam-cards');
  if (!container) return;
  const data = loadData(LS_KEYS.exams, []);
  if (data.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.9rem;">No exams added yet.</div>';
    return;
  }
  let html = '';
  data.forEach((exam) => {
    const now = new Date();
    const examDate = new Date(exam.date + 'T00:00:00');
    const diff = Math.ceil((examDate - now) / (1000 * 60 * 60 * 24));
    const days = diff > 0 ? diff : 0;
    html += `
      <div class="exam-card">
        <div class="exam-name">${exam.name}</div>
        <div class="exam-date">🗓️ ${formatDateShort(exam.date)}</div>
        <div class="countdown">⏳ ${days}</div>
        <div class="countdown-label">Days Remaining</div>
      </div>
    `;
  });
  container.innerHTML = html;
}

function addExamCountdown() {
  const name = $('#ec-name')?.value.trim();
  const date = $('#ec-date')?.value;
  if (!name || !date) {
    ui.showToast('Please fill in exam name and date.', 'error');
    return;
  }
  const data = loadData(LS_KEYS.exams, []);
  data.push({ name, date });
  saveData(LS_KEYS.exams, data);
  renderExams();
  const nameInput = $('#ec-name');
  const dateInput = $('#ec-date');
  if (nameInput) nameInput.value = '';
  if (dateInput) dateInput.value = '';
  ui.showToast('Exam added!', 'success');
}

function renderChecklist() {
  const container = $('#checklist-items');
  if (!container) return;
  const data = loadData(LS_KEYS.checklist, []);
  const total = data.length;
  const done = data.filter((d) => d.done).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  const checklistText = $('#checklist-text');
  const checklistRing = $('#checklist-ring');
  
  if (checklistText) {
    // Added "Clear All" button next to the completion text
    checklistText.innerHTML = `${done} / ${total} completed 
      ${total > 0 ? '<button id="clearChecklistBtn" style="margin-left:0.5rem;background:none;border:none;color:var(--danger);cursor:pointer;font-size:0.75rem;text-decoration:underline;">Clear All</button>' : ''}`;
    
    const clearBtn = document.getElementById('clearChecklistBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (confirm('Are you sure you want to clear all tasks?')) {
          saveData(LS_KEYS.checklist, []);
          renderChecklist();
        }
      });
    }
  }

  if (checklistRing) {
    checklistRing.textContent = pct + '%';
    checklistRing.style.background = `conic-gradient(var(--accent) ${pct * 3.6}deg, var(--border) 0deg)`;
  }

  if (total === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:0.9rem;">No tasks yet. Add one above.</div>';
    return;
  }
  let html = '';
  data.forEach((item, idx) => {
    html += `
      <div class="checklist-item ${item.done ? 'done' : ''}" onclick="window.toggleChecklist(${idx})">
        <span class="check-box">${item.done ? '✅' : '☐'}</span>
        <span class="task-name">${item.task}</span>
      </div>
    `;
  });
  container.innerHTML = html;
}

window.toggleChecklist = function (idx) {
  const data = loadData(LS_KEYS.checklist, []);
  if (!data[idx]) return;
  data[idx].done = !data[idx].done;
  saveData(LS_KEYS.checklist, data);
  renderChecklist();
};

function addChecklistItem() {
  const task = $('#cl-task')?.value.trim();
  if (!task) {
    ui.showToast('Please enter a task.', 'error');
    return;
  }
  const data = loadData(LS_KEYS.checklist, []);
  data.push({ task, done: false });
  saveData(LS_KEYS.checklist, data);
  renderChecklist();
  const taskInput = $('#cl-task');
  if (taskInput) taskInput.value = '';
  ui.showToast('Task added!', 'success');
}

function renderAllPlannerModules() {
  renderTimetable();
  renderTopics();
  renderSessions();
  renderStreaks();
  renderExams();
  renderChecklist();
  renderReminders(); // <-- Added dynamic reminders generation
}

function setupPlannerButtons() { /* handled in attachEventListeners */ }
function setupAcademicButtons() { /* handled in attachEventListeners */ }


// ==================== DYNAMIC REMINDERS ====================
function renderReminders() {
  const container = $('#reminder-list');
  if (!container) return;

  const reminders = [];
  const now = new Date();
  
  // 1. Timetable Reminders for Today
  const daysOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayName = daysOfWeek[now.getDay()];
  const timetable = loadData(LS_KEYS.timetable, {});
  const todaySessions = timetable[todayName] || [];
  
  todaySessions.forEach(s => {
    reminders.push({ icon: '⏰', text: `<strong>${s.subject}</strong> scheduled at ${s.time}` });
  });

  // 2. Upcoming Exams (within 14 days)
  const exams = loadData(LS_KEYS.exams, []);
  exams.forEach(e => {
    const examDate = new Date(e.date + 'T00:00:00');
    const diff = Math.ceil((examDate - now) / (1000 * 60 * 60 * 24));
    if (diff >= 0 && diff <= 14) {
      reminders.push({ icon: '🎯', text: `<strong>${e.name}</strong> is in ${diff} days!` });
    }
  });

  // 3. Weak Areas / Revision
  const weakAreas = analyticsData?.weakAreas || [];
  if (weakAreas.length > 0) {
    reminders.push({ icon: '📝', text: `Revision reminder: Focus on <strong>${weakAreas[0].topic}</strong>` });
  }

  // 4. Daily Goal
  const patterns = analyticsData?.studyPatterns || {};
  const goal = patterns.averageSessionTime ? Math.max(30, patterns.averageSessionTime * 2) : 60; 
  reminders.push({ icon: '🔥', text: `Today's Goal: Study ${Math.round(goal / 60 * 10) / 10} hours` });

  if (reminders.length === 0) {
    container.innerHTML = `<div class="reminder-item"><span class="icon">☕</span> No upcoming reminders. Enjoy your day!</div>`;
    return;
  }

  container.innerHTML = reminders.slice(0, 5).map(r => `
    <div class="reminder-item"><span class="icon">${r.icon}</span> ${r.text}</div>
  `).join('');
}
// ==================== AI PLANNER (local algorithm) ====================
// Deterministic study-plan generator. No network, no LLM. Weak subjects
// are prioritised on the first days, then the remaining days rotate
// through all subjects. Rendered as a compact table so it fits in the
// existing #ai-result container.

function _parseAiInputs() {
  const examDate = $('#ai-exam-date')?.value || '';
  const subjectsStr = $('#ai-subjects')?.value.trim() || '';
  const hours = parseFloat($('#ai-hours')?.value) || 4;
  const weakStr = $('#ai-weak')?.value.trim() || '';

  const subjects = subjectsStr.split(',').map((s) => s.trim()).filter(Boolean);
  const weak = weakStr.split(',').map((s) => s.trim()).filter(Boolean);

  return { examDate, subjects, hours, weak };
}

function _renderAiPlan(plan) {
  const { examDate, subjects, hours, weak } = plan;
  const daysLeft = Math.max(
    1,
    Math.ceil((new Date(examDate) - new Date()) / (1000 * 60 * 60 * 24))
  );

  const parts = [];
  parts.push(
    `<h3 style="margin:0 0 0.5rem; font-size:1rem;">📚 ${daysLeft}-Day Study Plan</h3>`
  );
  parts.push(
    `<p style="font-size:0.82rem; margin:0 0 0.75rem; color:var(--text-muted);">` +
    `Goal: <strong>${hours} h/day</strong> · ${subjects.length} subject${subjects.length === 1 ? '' : 's'}` +
    `</p>`
  );

  parts.push(
    '<table style="width:100%; border-collapse:collapse; font-size:0.82rem;">' +
    '<tr style="border-bottom:2px solid var(--border); text-align:left;">' +
    '<th style="padding:0.35rem 0.5rem;">Day</th>' +
    '<th style="padding:0.35rem 0.5rem;">Focus</th>' +
    '<th style="padding:0.35rem 0.5rem;">Hours</th>' +
    '</tr>'
  );

  const totalDaysToShow = Math.min(7, daysLeft);
  for (let i = 1; i <= totalDaysToShow; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    const dateStr = date.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric',
    });

    let focus = 'Mixed Revision';
    if (weak.length > 0 && i <= weak.length) {
      focus = `🎯 ${weak[i - 1]}`;
    } else if (subjects.length > 0) {
      focus = subjects[(i - 1) % subjects.length];
    }

    parts.push(
      '<tr style="border-bottom:1px solid var(--border);">' +
      `<td style="padding:0.35rem 0.5rem; font-weight:500;">${dateStr}</td>` +
      `<td style="padding:0.35rem 0.5rem; color:var(--accent);">${escapeHtml(focus)}</td>` +
      `<td style="padding:0.35rem 0.5rem;">${hours} h</td>` +
      '</tr>'
    );
  }
  parts.push('</table>');

  if (daysLeft > totalDaysToShow) {
    parts.push(
      `<p style="font-size:0.75rem; color:var(--text-muted); margin-top:0.5rem;">` +
      `…and ${daysLeft - totalDaysToShow} more day${daysLeft - totalDaysToShow === 1 ? '' : 's'}.` +
      `</p>`
    );
  }

  return parts.join('');
}

function generateAIPlan() {
  const inputs = _parseAiInputs();

  if (!inputs.examDate || inputs.subjects.length === 0) {
    ui.showToast('Please fill in at least exam date and subjects.', 'error');
    return;
  }

  const aiResult = $('#ai-result');
  if (aiResult) aiResult.innerHTML = _renderAiPlan(inputs);

  const aiActions = $('#ai-actions');
  if (aiActions) aiActions.style.display = 'flex';

  window._lastAIPlan = inputs;
}

function adoptAIPlan() {
  if (!window._lastAIPlan) {
    ui.showToast('No plan to adopt. Generate a plan first.', 'error');
    return;
  }

  // Persist as an exam countdown entry so it shows up in the Exams tab.
  const { examDate, subjects } = window._lastAIPlan;
  const exams = loadData(LS_KEYS.exams, []);
  const exists = exams.some((e) => e.date === examDate);
  if (!exists && examDate) {
    exams.push({
      name: subjects.join(' + ') || 'Study Plan',
      date: examDate,
    });
    saveData(LS_KEYS.exams, exams);
    renderExams();
  }

  ui.showToast('Plan adopted — exam added to countdown.', 'success');
  const aiActions = $('#ai-actions');
  if (aiActions) aiActions.style.display = 'none';
  window._lastAIPlan = null;
}

function regenerateAIPlan() {
  if (!window._lastAIPlan) {
    ui.showToast('No plan to regenerate. Generate a plan first.', 'error');
    return;
  }
  generateAIPlan();
}

function showAmendInput() {
  const amendArea = $('#amend-area');
  if (amendArea) amendArea.classList.add('visible');
}

function sendAmendment() {
  const text = $('#amend-text')?.value.trim();
  if (!text) {
    ui.showToast('Please describe your amendments.', 'error');
    return;
  }
  // The generator is deterministic, so amendments are recorded but
  // the plan is regenerated from the same inputs. A future iteration
  // could parse the text to alter weak-subject priority.
  ui.showToast('Amendments recorded. Regenerating plan…', 'info');
  const amendText = $('#amend-text');
  if (amendText) amendText.value = '';
  const amendArea = $('#amend-area');
  if (amendArea) amendArea.classList.remove('visible');
  generateAIPlan();
}

function cancelAIPlan() {
  const aiActions = $('#ai-actions');
  if (aiActions) aiActions.style.display = 'none';
  const aiResult = $('#ai-result');
  if (aiResult) aiResult.innerHTML = 'Enter your details and click Generate Plan.';
  window._lastAIPlan = null;
}

// ==================== SHARE FUNCTIONS ====================
function shareAcademicProfile() {
  nativeShare({
    title: 'MedVix Academic Profile',
    text: 'Check out my academic performance on MedVix!',
    url: window.location.href,
    dialogTitle: 'Share Profile',
  });
}

function copyProfileLink() {
  const url = window.location.href;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => ui.showToast('Profile link copied to clipboard!', 'success'))
      .catch(() => fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
}

function copyShareLink() {
  const linkInput = document.getElementById('share-link');
  if (!linkInput) {
    ui.showToast('Share link not found.', 'error');
    return;
  }
  const url = linkInput.value;
  if (!url) {
    ui.showToast('No link to copy.', 'error');
    return;
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => ui.showToast('Link copied to clipboard!', 'success'))
      .catch(() => fallbackCopy(url));
  } else {
    fallbackCopy(url);
  }
}

async function shareLinkViaNative() {
  const linkInput = document.getElementById('share-link');
  if (!linkInput || !linkInput.value) {
    ui.showToast('No link to share.', 'error');
    return;
  }
  const url = linkInput.value;
  nativeShare({
    title: 'MedVix Exam',
    text: 'Check out this MedVix exam!',
    url,
    dialogTitle: 'Share Exam',
  });
  const shareModal = $('#share-modal');
  if (shareModal) setTimeout(() => { shareModal.style.display = 'none'; }, 500);
}

// ==================== AVATAR ====================
// Resolution order (highest priority first):
//   1. localStorage `userAvatar` — user explicitly uploaded this file
//      via the avatar-upload input on this page.
//   2. Backend picture URL — user.picture / photoURL / avatar / avatarUrl.
//      Same source the subjects page uses for the header avatar.
//   3. Initials fallback.
//
// Image errors (offline, 404, blocked) fall through to initials so the
// page never shows a broken <img> icon.
function updateAvatar(url) {
  const img = $('#avatar-img');
  const initials = $('#avatar-initials');
  if (!img || !initials) return;

  if (url) {
    img.onerror = () => {
      img.style.display = 'none';
      initials.style.display = 'flex';
    };
    img.src = url;
    img.style.display = 'block';
    initials.style.display = 'none';
  } else {
    img.style.display = 'none';
    initials.style.display = 'flex';
  }
}

// ==================== DESTROY ====================
export function destroy() {
  try { redirect.unregisterStateAdapter('performance'); } catch { /* ignore */ }

  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  Object.values(academicChartInstances).forEach((chart) => chart.destroy());
  for (const key in academicChartInstances) {
    delete academicChartInstances[key];
  }

  if (_openReviewModal) {
    _cleanupReviewModal(_openReviewModal);
  }

  // ── ENGINE: remove the visibility listener and drop the engine cache.
  if (_medvixVisibilityListener) {
    try { document.removeEventListener('visibilitychange', _medvixVisibilityListener); } catch { /* ignore */ }
    _medvixVisibilityListener = null;
  }
  try { medvix.reset(); } catch { /* ignore */ }
  _medvixRendered = false;
}