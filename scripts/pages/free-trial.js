// scripts/pages/free-trial.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as security from '../security.js';
import * as subscription from '../subscription.js';
import * as utils from '../utils.js';

let $;
let trialDurationHours = null;   // populated from subscription.getTrialConfig()
let countdownTimer = null;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ── Auth gate ────────────────────────────────────────────────────
  // Round-trip so the user comes back here after logging in. Uses
  // the redirect module so that if the user arrived here from a
  // deeper chain (e.g. exam-room → subscription → free-trial),
  // logging in pops back to free-trial rather than collapasing the
  // whole stack.
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to start your free trial', 'warning');
    const shimmer = $('#shimmer-overlay');
    if (shimmer) shimmer.classList.add('shimmer-hidden');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  const user = auth.getUser();
  if (user) {
    const welcomeEl = $('#user-welcome');
    if (welcomeEl) welcomeEl.textContent = `Welcome, ${user.name}!`;
  }

  // Attach listeners early so nav buttons work while we hydrate
  attachEventListeners(context);

  // ---------------------------------------------------------------
  // 1. Pull the trial duration from subscription.js (backend config)
  // ---------------------------------------------------------------
  try {
    const config = await subscription.getTrialConfig();
    if (config && Number.isFinite(config.trialDurationHours) && config.trialDurationHours > 0) {
      trialDurationHours = config.trialDurationHours;
    }
  } catch (err) {
    console.warn('[FreeTrial] Could not load trial config:', err);
  }

  if (trialDurationHours == null) {
    // Last-resort fallback so the UI never renders "--:--:--"
    trialDurationHours = 24;
  }

  applyTrialDuration(trialDurationHours);

  // ---------------------------------------------------------------
  // 2. If a trial is already running, show a live countdown instead
  // ---------------------------------------------------------------
  let trialAlreadyActive = false;
  try {
    const remaining = await subscription.getTrialRemaining();
    if (remaining) {
      trialAlreadyActive = true;
      showActiveTrial();
    }
  } catch (err) {
    console.warn('[FreeTrial] Could not read active trial:', err);
  }

  // Hide shimmer once UI is ready
  const shimmer = $('#shimmer-overlay');
  if (shimmer) {
    shimmer.classList.add('shimmer-hidden');
    setTimeout(() => {
      if (shimmer && shimmer.parentNode) shimmer.remove();
    }, 450);
  }

  // ---------------------------------------------------------------
  // 3. Async eligibility check (skip if a trial is already active)
  // ---------------------------------------------------------------
  if (!trialAlreadyActive) {
    try {
      const eligible = await subscription.checkTrialEligibility();
      if (!eligible) {
        showAlreadyUsed();
      }
    } catch (error) {
      console.error('[FreeTrial] Eligibility check failed:', error);
      // Non-blocking
    }
  }

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a just-completed round
  // trip. Pop the entry so the stack does not grow on subsequent
  // redirects. Covers the case where the returning page used
  // history.back() instead of consumeAndReturn().
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
    console.warn('[FreeTrial] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Free-trial has no forms and no module-local state worth keeping
  // across a redirect — the duration is re-fetched, the countdown is
  // recreated, and eligibility re-checks. This call exists to drain
  // any snapshot that may have been written by a self-redirect from
  // this page in a future revision, and to keep the module's store
  // from accumulating stale entries.
  redirect.consumeSnapshot();

  console.log('[FreeTrial] Initialized');
}

// ==================== DURATION RENDERING ====================

/**
 * Convert a duration in hours into a HH:MM:SS clock string.
 * Handles fractional hours (e.g. 0.5 → 0:30:00).
 */
function formatClock(hours) {
  const totalSeconds = Math.max(0, Math.round(hours * 3600));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Human-readable duration, e.g. 3 → "3 hours", 1 → "1 hour", 0.5 → "0.5 hours".
 */
function formatHoursText(hours) {
  if (hours === 1) return '1 hour';
  if (Number.isInteger(hours)) return `${hours} hours`;
  return `${hours} hours`;
}

/**
 * Push the configured duration into the DOM.
 */
function applyTrialDuration(hours) {
  const hoursText = formatHoursText(hours);

  const title = $('#trialTitle');
  if (title) title.textContent = `✨ ${hoursText} Free Trial`;

  const durationEl = $('#trialDuration');
  if (durationEl) durationEl.textContent = formatClock(hours);

  const limitEl = $('#trialLimit');
  if (limitEl) limitEl.textContent = `⏱️ ${hoursText} only`;

  // Keep the tab title in sync
  try {
    document.title = `${hoursText} Free Trial – MedVix`;
  } catch {}
}

// ==================== ACTIVE TRIAL VIEW ====================

/**
 * Replace the CTA block with a live countdown when a trial is already running.
 */
function showActiveTrial() {
  const actions = $('#trial-actions');
  if (!actions) return;

  actions.innerHTML = `
    <p style="text-align:center;color:var(--text-secondary);margin-bottom:0.75rem;">
      ✅ Your free trial is already active.
    </p>
    <div class="trial-duration" id="trialCountdown">--:--:--</div>
    <button id="goToSubjectsBtn" class="btn-primary btn-large" style="margin-top:1rem;">
      📚 Continue to Subjects
    </button>
  `;

  const goBtn = $('#goToSubjectsBtn');
  if (goBtn) {
    goBtn.addEventListener('click', () => {
      // A trial is active — this is a successful resolution. If we
      // were sent here by a subscription_required / trial_required
      // gate, pop the stack and land the user where they wanted to
      // be. Otherwise fall through to subjects.
      if (redirect.hasReturn()) {
        redirect.consumeAndReturn('subjects');
      } else {
        router.navigateTo('subjects');
      }
    });
  }

  const tick = async () => {
    const el = $('#trialCountdown');
    if (!el) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }
    let seconds = 0;
    try {
      seconds = await subscription.calculateRemainingTime();
    } catch (err) {
      console.warn('[FreeTrial] Countdown read failed:', err);
    }
    if (!seconds || seconds <= 0) {
      el.textContent = 'Expired';
      clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    el.textContent =
      `${String(h).padStart(2, '0')}:` +
      `${String(m).padStart(2, '0')}:` +
      `${String(s).padStart(2, '0')}`;
  };

  tick();
  countdownTimer = setInterval(tick, 1000);
}

// ==================== INELIGIBLE VIEW ====================

function showAlreadyUsed() {
  const actions = $('#trial-actions');
  if (!actions) return;
  actions.innerHTML = `
    <p style="text-align:center;color:var(--text-secondary);margin-bottom:0.75rem;">
      ⚠️ You have already used your free trial on this device.
    </p>
    <button id="beginTrialBtn" class="btn-primary btn-large" disabled
        style="opacity:0.5;cursor:not-allowed;">
      🚀 Begin Free Trial
    </button>
    <p style="text-align:center;font-size:0.85rem;color:var(--text-secondary);">
      Use the <strong>View Subscription Plans</strong> button above to upgrade.
    </p>
  `;
}

// ==================== EVENT LISTENERS ====================

function attachEventListeners(context) {
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // Back to subjects — plain navigation. The user is explicitly
  // abandoning the trial flow; there is nothing to come back for.
  const backSubjectsBtn = $('#backSubjectsBtn');
  if (backSubjectsBtn) {
    backSubjectsBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  // View subscription plans — the user is choosing a different
  // resolution path than the trial. Plain navigation so the
  // existing return chain (if any) is preserved: subscription →
  // payment → consumeAndReturn will still pop back to the original
  // destination the user was trying to reach.
  const viewSubscriptionBtn = $('#viewSubscriptionBtn');
  if (viewSubscriptionBtn) {
    viewSubscriptionBtn.addEventListener('click', () => router.navigateTo('subscription'));
  }

  const beginTrialBtn = $('#beginTrialBtn');
  if (beginTrialBtn) {
    beginTrialBtn.addEventListener('click', beginTrial);
  }
}

// ==================== Begin Trial ====================

async function beginTrial() {
  console.log('[FreeTrial] Starting trial activation...');

  const timeCheck = await security.detectTimeManipulation();
  console.log('[FreeTrial] Time check result:', timeCheck);

  if (timeCheck.action === 'block' || timeCheck.action === 'lock') {
    ui.showToast(timeCheck.message || 'Time integrity check failed. Cannot activate trial.', 'error');
    return;
  }

  ui.showLoading('Activating trial...');

  try {
    const deviceFingerprint = security.getDeviceFingerprint();

    const result = await subscription.startFreeTrial({
      deviceFingerprint,
      clientTime: Date.now()
    });

    ui.hideLoading();

    // Prefer the actual expiry returned by the backend; fall back to the
    // configured duration if we can't compute it.
    let remainingText = '';
    try {
      remainingText = (await subscription.getTrialRemaining()) || '';
    } catch {}

    if (!remainingText && trialDurationHours != null) {
      remainingText = formatHoursText(trialDurationHours);
    }

    ui.showToast(
      remainingText
        ? `Trial activated! ${remainingText} remaining.`
        : 'Trial activated!',
      'success'
    );

    if (result && result.subscription) {
      await subscription.setSubscription(result.subscription);
    }

    // ── Consume the return stack ─────────────────────────────────
    // The trial is active; whatever subscription_required or
    // trial_required gate sent the user here is now satisfied.
    // Pop the stack and land them back on their original page.
    // If the stack is empty, fall through to subjects.
    redirect.consumeAndReturn('subjects');
  } catch (error) {
    ui.hideLoading();
    console.error('[FreeTrial] Activation failed:', error);
    ui.showToast(error.message || 'Failed to start trial', 'error');
  }
}

export function destroy() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  // No state adapter to unregister — free-trial registers none.
}