// scripts/pages/performance.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as utils from '../utils.js';
import * as analytics from '../analytics.js';
import * as db from '../db.js';
import { convexHttpClient } from '../convex-client.js';
import { PerformanceAI } from '../performance-ai.js';
import * as performanceRating from '../performance-rating-v2.js';

let $;
let analyticsData = null;
let chartInstance = null;
let performanceAI = null;

// Module-scoped chart instances for academic charts
const academicChartInstances = {};

// ==================== HELPER: SET TEXT (early definition) ====================
function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? '';
}

// ==================== INIT ====================
export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  if (!auth.checkAuth()) {
    router.navigateTo('login');
    return;
  }

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

    const savedAvatar = localStorage.getItem('userAvatar');
    if (savedAvatar) updateAvatar(savedAvatar);

    renderDownloadedExams();
    renderAllPlannerModules();
    setupPlannerButtons();
    setupAcademicButtons();
  } catch (error) {
    console.error('[Performance] Error:', error);
    ui.showToast('Failed to load analytics', 'error');
  } finally {
    ui.hideLoading();
    if (shimmer) shimmer.style.display = 'none';
    if (realContent) realContent.classList.add('visible');
  }

  // Initialize PerformanceAI only once
  if (!performanceAI) {
    performanceAI = new PerformanceAI({
      onPlanGenerated: (planData) => {
        const aiActions = $('#ai-actions');
        if (aiActions) aiActions.style.display = 'flex';
        window._lastAIPlan = planData;
      },
      onPlanAdopted: () => {
        ui.showToast('Plan adopted successfully! All modules updated.', 'success');
        renderAllPlannerModules();
        const aiActions = $('#ai-actions');
        if (aiActions) aiActions.style.display = 'none';
      },
      onPlanRegenerated: (planData) => {
        const aiActions = $('#ai-actions');
        if (aiActions) aiActions.style.display = 'flex';
        window._lastAIPlan = planData;
        ui.showToast('Plan regenerated!', 'info');
      },
      onPlanAmended: (planData) => {
        const aiActions = $('#ai-actions');
        if (aiActions) aiActions.style.display = 'flex';
        window._lastAIPlan = planData;
        ui.showToast('Plan amended successfully!', 'success');
      },
      onPlanCancelled: () => {
        const aiActions = $('#ai-actions');
        if (aiActions) aiActions.style.display = 'none';
        const aiResult = $('#ai-result');
        if (aiResult) aiResult.innerHTML = 'Plan cancelled.';
        window._lastAIPlan = null;
        ui.showToast('Plan cancelled.', 'info');
      },
      onAmendInputShow: () => {
        const amendArea = $('#amend-area');
        if (amendArea) amendArea.classList.add('visible');
      },
      onAmendInputHide: () => {
        const amendArea = $('#amend-area');
        if (amendArea) amendArea.classList.remove('visible');
      },
    });
  }

  attachEventListeners(context);

  console.log('[Performance] Initialized');
}

// ==================== ATTACH EVENT LISTENERS ====================
function attachEventListeners(context) {
  const root = context.root && context.root.nodeType === 1 ? context.root : document;

  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  const notifBtn = $('#notifBtn');
  if (notifBtn) {
    notifBtn.addEventListener('click', () => router.navigateTo('notifications'));
  }

  const tabs = root.querySelectorAll('.tab-button');
  tabs.forEach((btn) => {
    btn.addEventListener('click', function () {
      const tabId = this.dataset.tab;
      switchTab(tabId, root);
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
        case 'timetable':
          renderTimetable();
          break;
        case 'topics':
          renderTopics();
          break;
        case 'sessions':
          renderSessions();
          break;
        case 'streaks':
          renderStreaks();
          break;
        case 'exams':
          renderExams();
          break;
        case 'checklist':
          renderChecklist();
          break;
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
  if (shareNativeBtn) {
    shareNativeBtn.addEventListener('click', shareLinkViaNative);
  }

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
    const totalHours = summary.totalStudyTime ? (summary.totalStudyTime / 60).toFixed(1) : '0';
    totalTime.textContent = `${totalHours}h`;
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
    html += `
      <div class="subject-card mastery-${masteryClass}">
        <div class="subject-name">${s.subject}</div>
        <div class="subject-score">${s.percentage}%</div>
        <div class="subject-progress"><div class="progress-bar"><div class="progress-fill" style="width:${s.percentage}%;"></div></div></div>
        <div class="subject-stats">${s.correct}/${s.questions} · ⏱️ ${s.averageTime}s</div>
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
    container.innerHTML =
      '<p class="no-data">No weak areas identified. Keep up the great work!</p>';
    return;
  }
  let html = '<ul>';
  weakAreas.slice(0, 5).forEach((area) => {
    html += `<li><span class="topic">${area.topic}</span> <span class="score">${Math.round(area.score)}%</span> – ${area.priority} priority</li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
}

function renderRecommendations(recs) {
  const container = $('#recommendations-list');
  if (!container) return;
  if (!recs || recs.length === 0) {
    container.innerHTML = '<p class="no-data">No recommendations at this time.</p>';
    return;
  }
  let html = '<ul>';
  recs.slice(0, 4).forEach((r) => {
    html += `<li><strong>${r.type.replace('_', ' ')}:</strong> ${r.action}</li>`;
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
    case 'score':
      config = getScoreTrendConfig();
      break;
    case 'weekly':
      config = getWeeklyStudyConfig();
      break;
    case 'subject':
      config = getSubjectMasteryConfig();
      break;
    case 'accuracy':
      config = getAccuracyConfig();
      break;
    case 'time-dist':
      config = getTimeDistributionConfig();
      break;
    case 'radar':
      config = getRadarConfig();
      break;
    default:
      config = getScoreTrendConfig();
  }
  if (config) chartInstance = new Chart(ctx, config);
}

function getScoreTrendConfig() {
  const trends = analyticsData.trends || [];
  if (trends.length < 2) {
    return {
      type: 'line',
      data: {
        labels: ['No Data'],
        datasets: [{ label: 'Score %', data: [0], borderColor: '#2563eb' }],
      },
      options: { responsive: true, maintainAspectRatio: false },
    };
  }
  const labels = trends.map((t) => utils.formatDate(t.date, 'short'));
  const scores = trends.map((t) => t.score);
  return {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Score %',
          data: scores,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.1)',
          tension: 0.2,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, max: 100, title: { display: true, text: 'Score %' } },
      },
      plugins: { legend: { display: false } },
    },
  };
}

function getWeeklyStudyConfig() {
  const trends = analyticsData.trends || [];
  if (trends.length < 2) {
    return {
      type: 'bar',
      data: {
        labels: ['No Data'],
        datasets: [{ label: 'Study Time (min)', data: [0], backgroundColor: '#f59e0b' }],
      },
      options: { responsive: true, maintainAspectRatio: false },
    };
  }
  const labels = trends.map((t) => utils.formatDate(t.date, 'short'));
  const times = trends.map((t) => t.time);
  return {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Study Time (min)',
          data: times,
          backgroundColor: '#f59e0b',
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, title: { display: true, text: 'Minutes' } },
      },
      plugins: { legend: { display: false } },
    },
  };
}

function getSubjectMasteryConfig() {
  const subjectData = analyticsData.subjectAnalysis || [];
  if (subjectData.length === 0) {
    return {
      type: 'bar',
      data: {
        labels: ['No Data'],
        datasets: [{ label: 'Mastery %', data: [0], backgroundColor: '#2563eb' }],
      },
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
      datasets: [
        {
          label: 'Mastery %',
          data: values,
          backgroundColor: values.map((v) =>
            v >= 80 ? '#10b981' : v >= 60 ? '#f59e0b' : '#ef4444'
          ),
          borderRadius: 4,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { beginAtZero: true, max: 100, title: { display: true, text: 'Score %' } },
      },
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
  const colors = ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  return {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: times, backgroundColor: colors.slice(0, labels.length) }],
    },
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
      data: {
        labels: ['No Data'],
        datasets: [{ label: 'Mastery', data: [0], borderColor: '#2563eb' }],
      },
      options: { responsive: true, maintainAspectRatio: false },
    };
  }
  const labels = subjectData.map((s) => s.subject);
  const values = subjectData.map((s) => s.percentage);
  return {
    type: 'radar',
    data: {
      labels,
      datasets: [
        {
          label: 'Mastery %',
          data: values,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.2)',
          pointBackgroundColor: '#2563eb',
        },
      ],
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

  // Hero Card
  const name = user ? user.displayName || user.name || 'Student' : 'Guest';
  const year = user ? user.yearOfStudy || user.institution || 'Year 1' : 'Year 1';
  setText('#academic-name', name);
  setText('#academic-year', year);

  const rating = performance?.rating ?? 100;
  const rank = performanceRating.getRank(rating);
  setText('#academic-rank-badge', `🏆 ${rank.label}`);
  setText('#academic-mpre-score', Math.round(rating));
  setText('#academic-rank-label', `Rank ${rank.rank} · MPREv2`);

  // Overview Stats
  const summary = analytics?.summary || {};
  const patterns = analytics?.studyPatterns || {};
  setText('#academic-exams', performance?.completedExams ?? 0);
  setText('#academic-questions', summary.totalQuestions ?? 0);
  setText('#academic-accuracy', summary.averageScore ? `${Math.round(summary.averageScore)}%` : '0%');
  setText('#academic-streak', patterns.streak ?? 0);

  // MPRE Card
  setText('#academic-mpre-score-val', Math.round(rating));
  const stars = Math.min(5, Math.floor((rating - 100) / 400) + 1);
  setText('#academic-mpre-stars', '★'.repeat(Math.max(0, stars)) + '☆'.repeat(5 - Math.max(0, stars)));
  setText('#academic-mpre-rank', rank.label);

  // MPRE Progress Bars
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
      'Accuracy',
      'Difficulty',
      'Consistency',
      'Speed',
      'Improvement',
      'Activity',
      'Confidence',
      'Stability',
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

  // MPRE Timeline
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

  // AI Recommendation
  const aiRecEl = $('#ai-recommendation-body');
  if (aiRecEl) {
    if (analytics?.aiInsights?.insights) {
      aiRecEl.textContent = analytics.aiInsights.insights;
    } else {
      aiRecEl.textContent = 'Complete more exams to get personalized AI recommendations!';
    }
  }

  // Rank History
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

  // Rival Spotlight
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

  // Latest Badge
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

  // Badge Gallery
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

  // Academic Summary
  const summaryBody = $('#academic-summary-body');
  if (summaryBody) {
    if (analytics?.aiInsights?.insights) {
      summaryBody.innerHTML = analytics.aiInsights.insights;
    } else {
      summaryBody.textContent = 'Complete more exams to get your AI summary!';
    }
  }

  // Avatar Initials
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
  const totalTime = summary?.totalStudyTime || 0; // hours

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
        datasets: [
          {
            label: 'MPREv2 Factors',
            data: dataValues,
            backgroundColor: 'rgba(37, 99, 235, 0.2)',
            borderColor: '#2563eb',
            pointBackgroundColor: '#2563eb',
          },
        ],
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
    const colors = ['#2563eb', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
    academicChartInstances.mpreDoughnut = new Chart(doughnutCanvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data: dataValues, backgroundColor: colors.slice(0, dataValues.length), borderWidth: 0 }],
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
        .map(
          (t) =>
            `<div style="width:20px;height:${(t.questions / qMax) * 50 + 10}px;background:var(--accent);border-radius:2px;"></div>`
        )
        .join('');
      hourTrendContainer.innerHTML = recentTrends
        .map(
          (t) =>
            `<div style="width:20px;height:${(t.time / hMax) * 50 + 10}px;background:var(--warning);border-radius:2px;"></div>`
        )
        .join('');
    } else {
      questionTrendContainer.innerHTML =
        '<div style="color:var(--text-muted);font-size:0.8rem;">No data</div>';
      hourTrendContainer.innerHTML =
        '<div style="color:var(--text-muted);font-size:0.8rem;">No data</div>';
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
    if (exam) {
      cells.push({ active: true, semi: false });
    } else {
      cells.push({ active: false, semi: false });
    }
  }
  return cells;
}

// ==================== HELPER: GET RATING CHANGES ====================
function getRatingChanges(challengeHistory) {
  if (!Array.isArray(challengeHistory) || challengeHistory.length < 2) {
    return [];
  }
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
    btn.addEventListener('click', () => reviewDownloadedExam(btn.dataset.examid));
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
  if (!exam) return;

  const questions = exam.data && Array.isArray(exam.data.questions) ? exam.data.questions : [];
  const totalQuestions = exam.data && exam.data.totalQuestions != null ? exam.data.totalQuestions : questions.length;
  const correctAnswers = exam.data && exam.data.correctAnswers != null ? exam.data.correctAnswers : 0;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal review-modal">
      <div class="modal-header"><h2>Exam Review: ${exam.subject} - ${Math.round(exam.score)}%</h2><button class="modal-close">&times;</button></div>
      <div class="modal-body">
        <div class="summary-card" style="display:flex; gap:1rem; margin-bottom:1rem;">
          <div class="score-circle" style="width:80px; height:80px; border-radius:50%; background:conic-gradient(var(--accent) ${exam.score}deg, #eee 0deg); display:flex; align-items:center; justify-content:center; font-weight:bold;">${Math.round(exam.score)}%</div>
          <div><p>Date: ${utils.formatDate(exam.date)}</p><p>Questions: ${totalQuestions}</p><p>Correct: ${correctAnswers}</p></div>
        </div>
        <div id="modal-review-list" class="review-list"></div>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const list = modal.querySelector('#modal-review-list');
  if (list) {
    if (questions.length > 0) {
      list.innerHTML = questions
        .map((q, idx) => {
          const isCorrect = q.correct;
          const userAnswerText = getOptionText(q.userAnswer, q.options);
          const correctAnswerText = getOptionText(q.correctAnswer, q.options);
          const explanationHtml = formatExplanation(q.explanation);
          return `
            <div class="review-item ${isCorrect ? 'correct' : 'incorrect'}">
              <div><strong>Q${idx + 1}:</strong> ${q.question}</div>
              <div><small>Your answer: ${userAnswerText} | Correct: ${correctAnswerText}</small></div>
              <div class="explanation">${explanationHtml}</div>
            </div>
          `;
        })
        .join('');
    } else {
      list.innerHTML = '<p>No question data available for this exam.</p>';
    }
  }

  modal.querySelector('.modal-close').onclick = () => modal.remove();
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };
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

function getToday() {
  return new Date().toISOString().split('T')[0];
}

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
      slots.forEach((s) => {
        html += `<div class="timetable-slot"><span class="time">${s.time}</span><span class="subject-tag ${s.color}">${s.subject}</span></div>`;
      });
    }
    html += `</div>`;
  });
  container.innerHTML = html;
}

function addTimetableSlot() {
  const day = $('#tt-day-select')?.value;
  const time = $('#tt-time')?.value.trim();
  const subject = $('#tt-subject')?.value.trim();
  const color = $('#tt-color')?.value;
  if (!day || !time || !subject) {
    ui.showToast('Please fill in day, time and subject.', 'error');
    return;
  }
  const data = loadData(LS_KEYS.timetable, {});
  if (!data[day]) data[day] = [];
  data[day].push({ time, subject, color });
  saveData(LS_KEYS.timetable, data);
  renderTimetable();
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

  let todayTotal = 0,
    weekTotal = 0,
    durations = [];
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
    container.innerHTML =
      '<div style="color:var(--text-muted);font-size:0.85rem;">No sessions logged yet.</div>';
    return;
  }
  let html = '';
  data
    .slice()
    .reverse()
    .slice(0, 10)
    .forEach((s) => {
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
    if (data.lastDate === getYesterday()) {
      current += 1;
    } else {
      current = 1;
    }
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
    container.innerHTML =
      '<div style="color:var(--text-muted);font-size:0.9rem;">No exams added yet.</div>';
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
  if (checklistText) checklistText.textContent = `${done} / ${total} completed`;
  if (checklistRing) {
    checklistRing.textContent = pct + '%';
    checklistRing.style.background = `conic-gradient(var(--accent) ${pct * 3.6}deg, var(--border) 0deg)`;
  }

  if (total === 0) {
    container.innerHTML =
      '<div style="color:var(--text-muted);font-size:0.9rem;">No tasks yet. Add one above.</div>';
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
}

function setupPlannerButtons() {
  // Already handled in attachEventListeners
}

function setupAcademicButtons() {
  // Already handled in attachEventListeners
}

// ==================== AI PLANNER ====================
function generateAIPlan() {
  const examDate = $('#ai-exam-date')?.value;
  const subjects = $('#ai-subjects')?.value.trim();
  const hours = parseFloat($('#ai-hours')?.value) || 4;
  const weak = $('#ai-weak')?.value.trim();
  const preferred = $('#ai-time')?.value.trim();

  if (!examDate || !subjects) {
    ui.showToast('Please fill in at least exam date and subjects.', 'error');
    return;
  }

  const result = performanceAI.generatePlan(examDate, subjects, hours, weak, preferred);
  const aiResult = $('#ai-result');
  if (aiResult) aiResult.innerHTML = result.display;
  if (result.success) {
    const aiActions = $('#ai-actions');
    if (aiActions) aiActions.style.display = 'flex';
  }
}

function adoptAIPlan() {
  if (window._lastAIPlan) {
    performanceAI.adoptPlan(window._lastAIPlan);
  } else {
    ui.showToast('No plan to adopt. Generate a plan first.', 'error');
  }
}

function regenerateAIPlan() {
  if (window._lastAIPlan) {
    const result = performanceAI.regeneratePlan();
    if (result) {
      const aiResult = $('#ai-result');
      if (aiResult) aiResult.innerHTML = result.display;
    }
  } else {
    ui.showToast('No plan to regenerate. Generate a plan first.', 'error');
  }
}

function showAmendInput() {
  performanceAI.showAmendInput();
}

function sendAmendment() {
  const text = $('#amend-text')?.value.trim();
  if (!text) {
    ui.showToast('Please describe your amendments.', 'error');
    return;
  }
  const result = performanceAI.amendPlan(text);
  if (result) {
    const aiResult = $('#ai-result');
    if (aiResult) aiResult.innerHTML = result.display;
    const amendText = $('#amend-text');
    if (amendText) amendText.value = '';
  }
}

function cancelAIPlan() {
  performanceAI.cancelPlan();
}

// ==================== SHARE FUNCTIONS ====================
function shareAcademicProfile() {
  if (navigator.share) {
    navigator
      .share({
        title: 'MedVix Academic Profile',
        text: 'Check out my academic performance on MedVix!',
        url: window.location.href,
      })
      .catch(() => {});
  } else {
    copyProfileLink();
  }
}

function copyProfileLink() {
  const url = window.location.href;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard
      .writeText(url)
      .then(() => {
        ui.showToast('Profile link copied to clipboard!', 'success');
      })
      .catch(() => {
        fallbackCopy(url);
      });
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

async function shareLinkViaNative() {
  const linkInput = document.getElementById('share-link');
  if (!linkInput || !linkInput.value) {
    ui.showToast('No link to share.', 'error');
    return;
  }
  const url = linkInput.value;
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'MedVix Exam',
        text: 'Check out this MedVix exam!',
        url: url,
      });
    } catch (e) {
      if (e.name !== 'AbortError') {
        ui.showToast('Share failed.', 'error');
      }
    }
  } else {
    copyShareLink();
  }
}

// ==================== AVATAR ====================
function updateAvatar(dataUrl) {
  const img = $('#avatar-img');
  const initials = $('#avatar-initials');
  if (img && initials) {
    if (dataUrl) {
      img.src = dataUrl;
      img.style.display = 'block';
      initials.style.display = 'none';
    } else {
      img.style.display = 'none';
      initials.style.display = 'flex';
    }
  }
}

// ==================== DESTROY ====================
export function destroy() {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  Object.values(academicChartInstances).forEach((chart) => chart.destroy());
  for (const key in academicChartInstances) {
    delete academicChartInstances[key];
  }
}