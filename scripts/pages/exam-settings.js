// scripts/pages/exam-settings.js
import * as examSettings from '../exam-settings.js'; // The existing module
import * as ui from '../ui.js';
import * as router from '../router.js';

// DOM refs – we'll collect them in init
let dom = {};

export async function init(context) {
  // DOM references
  dom = {
    shimmer: context.root.querySelector('#shimmer-skeleton'),
    mainContent: context.root.querySelector('#main-content'),
    bottomCard: context.root.querySelector('#bottomCard'),
    fixedHeader: context.root.querySelector('#fixedHeader'),

    subjectIcon: context.root.querySelector('#subject-icon'),
    subjectName: context.root.querySelector('#subject-name'),
    subjectTopics: context.root.querySelector('#subject-topics'),
    statQuestions: context.root.querySelector('#stat-questions'),
    statDifficulty: context.root.querySelector('#stat-difficulty'),
    statTime: context.root.querySelector('#stat-time'),

    step1: context.root.querySelector('#step1'),
    step2Std: context.root.querySelector('#step2-standard'),
    step2Chal: context.root.querySelector('#step2-challenge'),
    step2Rev: context.root.querySelector('#step2-revision'),
    step2Join: context.root.querySelector('#step2-join'),

    continueBtn: context.root.querySelector('#continue-btn'),
    backBtns: context.root.querySelectorAll('.back-btn'),
    startBtns: context.root.querySelectorAll('.start-exam-btn'),
    challengeStartBtn: context.root.querySelector('#challenge-start-btn'),

    qtyInputs: {
      std: context.root.querySelector('#std-qty'),
      challenge: context.root.querySelector('#challenge-qty'),
      rev: context.root.querySelector('#rev-qty')
    },
    maxHints: {
      std: context.root.querySelector('#std-max-hint'),
      challenge: context.root.querySelector('#challenge-max-hint'),
      rev: context.root.querySelector('#rev-max-hint')
    },
    warnings: {
      std: context.root.querySelector('#std-warning'),
      challenge: context.root.querySelector('#challenge-warning'),
      rev: context.root.querySelector('#rev-warning')
    },

    stdDifficulty: context.root.querySelector('#std-difficulty'),
    revDifficulty: context.root.querySelector('#rev-difficulty'),

    challengeType: context.root.querySelector('#challenge-type'),
    friendExtra: context.root.querySelector('#friend-extra'),
    anyoneExtra: context.root.querySelector('#anyone-extra'),
    challengeStatus: context.root.querySelector('#challenge-status'),
    challengeCodeDisplay: context.root.querySelector('#challenge-code-display'),
    waitingMessage: context.root.querySelector('#waiting-message'),
    challengeActions: context.root.querySelector('#challenge-actions'),
    inviteStatus: context.root.querySelector('#invite-status'),
    inviteFriendInput: context.root.querySelector('#invite-friend-input'),
    sendInviteBtn: context.root.querySelector('#send-invite-btn'),
    cancelInviteBtn: context.root.querySelector('#cancel-invite-btn'),
    copyChallengeCodeBtn: context.root.querySelector('#copy-challenge-code-btn'),
    shareChallengeCodeBtn: context.root.querySelector('#share-challenge-code-btn'),
    refreshInvitations: context.root.querySelector('#refresh-invitations'),
    createGroupBtn: context.root.querySelector('#create-group-btn'),
    invitationList: context.root.querySelector('#invitation-list'),

    joinCodeInput: context.root.querySelector('#join-code-input'),
    joinCodeBtn: context.root.querySelector('#join-code-btn'),
    joinCodeDisplay: context.root.querySelector('#join-code-display'),
    joinStatus: context.root.querySelector('#join-status'),
    joinStartBtn: context.root.querySelector('#join-start-btn'),

    shareLinkArea: context.root.querySelector('#share-link-area'),
    shareLinkInput: context.root.querySelector('#share-link-input'),
    copyShareLinkBtn: context.root.querySelector('#copy-share-link-btn'),

    presetSelect: context.root.querySelector('#preset-select'),
    examMode: context.root.querySelector('#exam-mode'),
    questionCount: context.root.querySelector('#question-count'),
    customCount: context.root.querySelector('#custom-count'),
    customCountContainer: context.root.querySelector('#custom-count-container'),
    timing: context.root.querySelector('#timing'),
    preventCopy: context.root.querySelector('#prevent-copy'),
    autoSave: context.root.querySelector('#auto-save'),
    detectTab: context.root.querySelector('#detect-tab'),
    breakEnabled: context.root.querySelector('#break-enabled'),

    backBtn: context.root.querySelector('#backBtn'),
    themeToggle: context.root.querySelector('#themeToggle'),
  };

  // Pass DOM refs to the exam-settings module
  examSettings.setDomRefs(dom);

  // Update bottom card position
  function updateBottomCardPosition() {
    const header = dom.fixedHeader;
    const card = dom.bottomCard;
    if (header && card) {
      const headerBottom = header.getBoundingClientRect().bottom;
      card.style.top = headerBottom + 'px';
    }
  }

  // Listen for resize and header changes
  window.addEventListener('resize', updateBottomCardPosition);
  const headerObserver = new ResizeObserver(updateBottomCardPosition);
  if (dom.fixedHeader) {
    headerObserver.observe(dom.fixedHeader);
  }

  // Initialize the exam settings
  dom.shimmer.style.display = 'flex';
  await examSettings.initExamSettings();
  dom.shimmer.style.display = 'none';
  dom.mainContent.style.display = 'block';
  updateBottomCardPosition();

  // Auto-join from URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  const examCode = urlParams.get('exam');
  if (examCode) {
    if (dom.joinCodeDisplay) dom.joinCodeDisplay.textContent = examCode;
    showStep('step2-join');
  }

  // Attach event listeners
  setupEventListeners();

  // Expose global functions for inline onclick (preserved)
  window.showShareableLink = (code) => {
    if (dom.shareLinkArea && dom.shareLinkInput) {
      dom.shareLinkInput.value = getShareableLink(code);
      dom.shareLinkArea.style.display = 'block';
    }
  };
  window.shareChallengeLink = shareChallengeLink;
  window.showInlineSpinner = showInlineSpinner;
  window.hideInlineSpinner = hideInlineSpinner;
  window.showStep = showStep;
  window.updateBottomCardPosition = updateBottomCardPosition;
}

// ==================== HELPER FUNCTIONS ====================

function getShareableLink(code) {
  const BASE_URL = 'https://medvix.edgeone.app';
  const PAGE_PATH = '/exam-settings/';
  return `${BASE_URL}${PAGE_PATH}?exam=${encodeURIComponent(code)}`;
}

function shareChallengeLink(code) {
  const link = getShareableLink(code);
  const shareData = {
    title: 'Join my MedVix Challenge!',
    text: 'Join my medical exam challenge on MedVix!',
    url: link
  };

  // Capacitor / Web Share / Clipboard fallback
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share) {
    window.Capacitor.Plugins.Share.share({
      title: shareData.title,
      text: shareData.text,
      url: shareData.url,
      dialogTitle: 'Share Challenge'
    }).catch(() => fallbackShare(shareData));
  } else if (navigator.share) {
    navigator.share(shareData).catch(() => fallbackShare(shareData));
  } else {
    fallbackShare(shareData);
  }
}

function fallbackShare(shareData) {
  navigator.clipboard?.writeText(shareData.url).then(() => {
    ui.showToast('Link copied to clipboard!', 'success');
  }).catch(() => {
    const textarea = document.createElement('textarea');
    textarea.value = shareData.url;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    ui.showToast('Link copied!', 'success');
  });
}

function showInlineSpinner(message) {
  const spinner = document.getElementById('inline-spinner');
  spinner.querySelector('span').textContent = message || 'Loading...';
  spinner.style.display = 'flex';
}

function hideInlineSpinner() {
  document.getElementById('inline-spinner').style.display = 'none';
}

function showStep(stepId) {
  document.querySelectorAll('.card-step').forEach(el => el.classList.remove('active'));
  const step = document.getElementById(stepId);
  if (step) step.classList.add('active');
  updateBottomCardPosition();
}

// ==================== EVENT LISTENERS ====================
function setupEventListeners() {
  // Back button (clean URL)
  dom.backBtn.addEventListener('click', () => router.navigateTo('subjects'));

  // Theme toggle
  dom.themeToggle.addEventListener('click', ui.toggleTheme);

  // Step navigation
  dom.continueBtn.addEventListener('click', () => {
    const selected = document.querySelector('.mode-option.selected');
    if (!selected) {
      ui.showToast('Please select an exam type', 'warning');
      return;
    }
    const mode = selected.dataset.mode;
    if (mode === 'standard') showStep('step2-standard');
    else if (mode === 'challenge') showStep('step2-challenge');
    else if (mode === 'revision') showStep('step2-revision');
    updateBottomCardPosition();
  });

  dom.backBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      showStep('step1');
      dom.challengeStatus.textContent = '';
      dom.challengeCodeDisplay.textContent = '---';
      dom.waitingMessage.style.display = 'none';
      dom.challengeActions.style.display = 'none';
      updateBottomCardPosition();
    });
  });

  // Start exam buttons (except challenge and join)
  dom.startBtns.forEach(btn => {
    if (btn.id !== 'challenge-start-btn' && btn.id !== 'join-start-btn') {
      btn.addEventListener('click', examSettings.startExam);
    }
  });

  // Mode selection
  document.querySelectorAll('.mode-option').forEach(el => {
    el.addEventListener('click', function() {
      document.querySelectorAll('.mode-option').forEach(o => o.classList.remove('selected'));
      this.classList.add('selected');
    });
  });

  // Challenge type
  dom.challengeType.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', function() {
      dom.challengeType.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const type = this.dataset.type;
      dom.friendExtra.classList.toggle('show', type === 'friend');
      dom.anyoneExtra.classList.toggle('show', type === 'anyone');
      dom.challengeStatus.textContent = '';
      dom.challengeCodeDisplay.textContent = '---';
      dom.waitingMessage.style.display = 'none';
      dom.challengeActions.style.display = 'none';
      if (dom.shareLinkArea) dom.shareLinkArea.style.display = 'none';
      updateBottomCardPosition();
    });
  });

  // Send invite
  dom.sendInviteBtn.addEventListener('click', async () => {
    const email = dom.inviteFriendInput.value.trim();
    if (!email) {
      ui.showToast('Please enter a friend\'s email', 'warning');
      return;
    }
    showInlineSpinner('Sending invitation...');
    try {
      await examSettings.inviteFriend();
    } finally {
      hideInlineSpinner();
    }
  });

  // Cancel invite
  dom.cancelInviteBtn.addEventListener('click', () => {
    dom.inviteFriendInput.value = '';
    dom.inviteStatus.textContent = '';
    dom.challengeStatus.textContent = '';
    dom.challengeCodeDisplay.textContent = '---';
    dom.waitingMessage.style.display = 'none';
    dom.challengeActions.style.display = 'none';
    if (dom.shareLinkArea) dom.shareLinkArea.style.display = 'none';
  });

  // Create challenge
  dom.challengeStartBtn.addEventListener('click', async function () {
    if (this.disabled) return;
    this.disabled = true;
    this.textContent = 'Creating…';
    showInlineSpinner('Creating challenge...');
    try {
      await examSettings.startChallenge();
    } finally {
      hideInlineSpinner();
      this.disabled = false;
      this.textContent = 'Create Challenge →';
    }
  });

  // Copy challenge code
  dom.copyChallengeCodeBtn.addEventListener('click', () => {
    const code = dom.challengeCodeDisplay.textContent;
    if (!code || code === '---') {
      ui.showToast('No challenge code available', 'warning');
      return;
    }
    navigator.clipboard?.writeText(code).then(() => {
      ui.showToast('Code copied!', 'success');
    }).catch(() => {
      const input = document.createElement('input');
      input.value = code;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
      ui.showToast('Code copied!', 'success');
    });
  });

  // Share challenge code (full link)
  dom.shareChallengeCodeBtn.addEventListener('click', () => {
    const code = dom.challengeCodeDisplay.textContent;
    if (!code || code === '---') {
      ui.showToast('No challenge code available', 'warning');
      return;
    }
    shareChallengeLink(code);
  });

  // Refresh invitations (simulated)
  dom.refreshInvitations.addEventListener('click', () => {
    dom.invitationList.innerHTML = `
      <div>No new invitations.</div>
      <button style="margin-top:0.5rem; padding:0.3rem; width:100%; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-sm);">Accept Group Challenge</button>
      <button style="margin-top:0.3rem; padding:0.3rem; width:100%; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-sm);">Decline</button>
    `;
    ui.showToast('Refreshed (simulated)', 'info');
  });

  dom.createGroupBtn.addEventListener('click', () => {
    ui.showToast('Group challenge creation coming soon!', 'info');
  });

  // Join code
  dom.joinCodeBtn.addEventListener('click', () => {
    const code = dom.joinCodeInput.value.trim();
    if (!code) {
      ui.showToast('Please enter a challenge code', 'warning');
      return;
    }
    dom.joinCodeDisplay.textContent = code;
    showStep('step2-join');
  });

  dom.joinStartBtn.addEventListener('click', async function () {
    if (this.disabled) return;
    const code = dom.joinCodeDisplay.textContent;
    if (!code || code === '---') {
      ui.showToast('Invalid challenge code', 'error');
      return;
    }
    this.disabled = true;
    this.textContent = 'Joining…';
    showInlineSpinner('Joining challenge...');
    try {
      await examSettings.joinChallenge(code);
    } finally {
      hideInlineSpinner();
      this.disabled = false;
      this.textContent = 'Join & Start';
    }
  });

  // Copy shareable link
  dom.copyShareLinkBtn.addEventListener('click', () => {
    const link = dom.shareLinkInput.value;
    if (!link) return;
    navigator.clipboard?.writeText(link).then(() => {
      ui.showToast('Link copied!', 'success');
    }).catch(() => {
      ui.showToast('Failed to copy link', 'error');
    });
  });

  // Presets
  dom.presetSelect?.addEventListener('change', function() {
    const idx = parseInt(this.value);
    if (!isNaN(idx)) examSettings.applyPreset(idx);
  });
  document.querySelector('[onclick="savePreset()"]')?.addEventListener('click', examSettings.savePreset);
  document.querySelector('[onclick="resetToDefault()"]')?.addEventListener('click', examSettings.resetToDefault);
}

export function destroy() {
  // Cleanup: remove observers, listeners if needed
  window.removeEventListener('resize', updateBottomCardPosition);
  // The page-manager will abort any pending fetches via context.signal
}