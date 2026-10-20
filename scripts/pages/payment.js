// scripts/pages/payment.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as validation from '../validation.js';
import * as utils from '../utils.js';
import * as payment from '../payment.js';
import * as subscription from '../subscription.js';

let $;
let cancelPoll = null;

// ── In-flight transaction ────────────────────────────────────────────
// Set while a poll is running; cleared the moment the poll reaches a
// terminal state (success, timeout, failed, expired). The state
// adapter captures this so if the user is bounced away mid-poll and
// comes back, we can resume polling the same transaction — the
// M-Pesa prompt might still be waiting on their phone.
let currentTransactionId = null;

// ---------- helpers ----------
function describeDevices(n) {
  const count = Number(n) || 1;
  if (count <= 1) return '1 device · 📱';
  if (count === 2) return '2 devices · 📱 + 💻';
  return `${count} devices`;
}

function formatKes(n) {
  const num = Number(n) || 0;
  return `KES ${num.toLocaleString()}`;
}

// ---------- poll orchestration ----------
//
// Extracted so both initiatePayment() and the state adapter's restore
// path can start a poll without duplicating the callbacks. Cancels any
// existing poll first.
function _startPoll(transactionId) {
  if (cancelPoll) {
    try { cancelPoll(); } catch { /* ignore */ }
    cancelPoll = null;
  }
  if (!transactionId) return;

  currentTransactionId = transactionId;

  // Make sure the status area is showing.
  const statusEl = $('#payment-status');
  if (statusEl) statusEl.style.display = 'block';
  const msgEl = $('#status-message');
  const attemptEl = $('#poll-attempt');
  if (msgEl) msgEl.textContent = '⏳ Waiting for M‑Pesa confirmation...';
  if (attemptEl) attemptEl.textContent = '';

  cancelPoll = payment.pollPaymentStatus(
    transactionId,
    {
      onUpdate: ({ status, attempt }) => {
        console.log(`[Poll ${attempt}/10] Status: ${status}`);
        if (attemptEl) attemptEl.textContent = `Checking (${attempt}/10)...`;
        if (msgEl) {
          msgEl.textContent =
            status === 'pending'
              ? '⏳ Waiting for M‑Pesa confirmation...'
              : `Status: ${status}`;
        }
      },

      onComplete: async ({ status, timedOut }) => {
        cancelPoll = null;
        currentTransactionId = null;

        // ---- Timeout ----
        if (timedOut) {
          if (msgEl) {
            msgEl.textContent =
              '⏰ Payment not confirmed after 150 seconds. Please check your M‑Pesa app or try again.';
          }
          const retryBtn = $('#retryBtn');
          if (retryBtn) retryBtn.style.display = 'block';
          ui.showToast('Payment timeout. Check M‑Pesa or retry.', 'warning');
          if (attemptEl) attemptEl.textContent = '';
          return;
        }

        // ---- Success ----
        // PaymentManager already:
        //   • force-refreshed the subscription from backend
        //   • built the receipt payload
        //   • rendered the receipt modal (or emitted payment:completed)
        //   • scheduled navigation to /subjects
        //
        // We override that last step so the user follows the redirect
        // chain instead of always landing on /subjects.
        if (status === 'completed') {
          if (msgEl) msgEl.textContent = '✅ Payment successful! Preparing receipt…';
          ui.showToast('Payment successful!', 'success');

          // Fallback in case the receipt UI could not be presented:
          // still force a fresh subscription pull in the background so
          // other pages see the new state.
          try {
            await subscription.refreshSubscription();
          } catch (e) {
            console.warn('[PaymentPage] Post-success refresh failed', e);
          }

          if (attemptEl) attemptEl.textContent = '';

          // Cancel PaymentManager's own pending navigation to
          // /subjects — we're going to route through the redirect
          // module instead. The receipt modal stays on screen; the
          // user sees it briefly, then we pop the chain.
          try { window.Payment?.cancelReceiptFlow?.(); } catch { /* ignore */ }

          // Give the receipt modal a beat to render, then pop.
          // clearAll: true — the whole chain (exam-room → subscription
          // → payment) is now satisfied. Intermediate plan-picker
          // screens are no longer relevant.
          setTimeout(() => {
            try {
              redirect.consumeAndReturn('subjects', { clearAll: true });
            } catch (err) {
              console.warn('[PaymentPage] redirect consume failed:', err);
              router.navigateTo('subjects');
            }
          }, 1800);
          return;
        }

        // ---- Other terminal statuses (failed / expired / unknown) ----
        if (msgEl) msgEl.textContent = `❌ Payment ${status}. Please try again.`;
        const retryBtn = $('#retryBtn');
        if (retryBtn) retryBtn.style.display = 'block';
        ui.showToast(`Payment ${status}. Please retry.`, 'error');
        if (attemptEl) attemptEl.textContent = '';
      }
    },
    15000,
    10
  );
}

// ---------- init ----------
export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ── Auth gate ────────────────────────────────────────────────────
  // Round-trip through login. If the user was mid-payment, the
  // state adapter below captures the transaction ID so polling
  // resumes on return.
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to continue with payment', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  // ── Plan gate ────────────────────────────────────────────────────
  // If there's no plan in memory, push the user through subscription.
  // The self-consume block at the end of init() keeps the stack tidy
  // when the user re-enters payment after picking a plan — payment
  // pops itself off the top so the outer chain (exam-room, etc.)
  // survives.
  const plan = payment.getSelectedPlan();
  if (!plan) {
    ui.showToast('Please choose a plan to continue', 'warning');
    redirect.navigateWithReturn('subscription', 'plan_required');
    return;
  }

  // ── State adapter ────────────────────────────────────────────────
  // Registered AFTER the gates so we only capture meaningful state.
  // The phone input is captured automatically by the module's UI
  // snapshot (it has an id). The only thing this adapter adds is the
  // in-flight transaction ID, so a mid-poll bounce can resume.
  redirect.registerStateAdapter('payment', {
    capture: () => ({
      transactionId: currentTransactionId,
    }),
    restore: (data) => {
      if (!data) return;
      if (data.transactionId) {
        console.log('[PaymentPage] Resuming poll for', data.transactionId);
        _startPoll(data.transactionId);
      }
    },
  });

  const devices = Number(plan.devices) || 1;
  const priceLabel = formatKes(plan.price);
  const durationDisplay = plan.durationText || utils.formatDuration(plan.duration);
  const deviceLabel = describeDevices(devices);

  const nameEl = $('#plan-name');
  if (nameEl) nameEl.textContent = plan.name;

  const devicesEl = $('#plan-devices');
  if (devicesEl) devicesEl.textContent = deviceLabel;

  const priceEl = $('#plan-price');
  if (priceEl) priceEl.textContent = priceLabel;

  const durationEl = $('#plan-duration');
  if (durationEl) durationEl.textContent = durationDisplay;

  const summaryEl = $('#plan-summary');
  if (summaryEl) {
    summaryEl.innerHTML =
      `<strong>${plan.name}</strong> · ${deviceLabel} · ${durationDisplay} · <strong>${priceLabel}</strong>`;
  }

  const user = auth.getUser();
  const phoneEl = $('#phone');
  if (phoneEl && user?.phone) phoneEl.value = user.phone;

  validation.setupLiveValidation('payment-form', {
    phone: { required: true, phone: 'KE' }
  });

  const shimmer = $('#shimmer-content');
  const real = $('#real-content');
  if (shimmer) shimmer.style.display = 'none';
  if (real) real.style.display = 'block';

  attachEventListeners(context);

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a just-completed round
  // trip. Pop the entry so the stack does not grow on subsequent
  // redirects. This covers the "no plan → subscription → pick plan
  // → back to payment" path: when the user re-enters payment, we
  // see ourselves at the top of the stack and pop so the outer
  // chain (e.g. exam-room) survives.
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
    console.warn('[PaymentPage] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Restores the phone input value (auto) and, via the adapter,
  // resumes polling any in-flight transaction.
  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    if (snap.page?.transactionId) {
      ui.showToast('Resuming payment status check…', 'info', 2000);
    } else {
      ui.showToast('Continuing where you left off', 'info', 1800);
    }
  }

  console.log('[PaymentPage] Initialized', { planId: plan.id, devices, price: plan.price });
}

function attachEventListeners(context) {
  const backBtn = $('#backBtn');
  if (backBtn) backBtn.addEventListener('click', () => router.navigateTo('subjects'));

  const themeToggle = $('#themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', ui.toggleTheme);

  // Change plan — plain navigation. Payment stays on the stack so
  // when the user picks a plan and returns, the self-consume block
  // tidies the stack and the outer chain survives.
  const changePlanBtn = $('#changePlanBtn');
  if (changePlanBtn) changePlanBtn.addEventListener('click', () => router.navigateTo('subscription'));

  const paymentForm = $('#payment-form');
  if (paymentForm) paymentForm.addEventListener('submit', initiatePayment);

  const retryBtn = $('#retryBtn');
  if (retryBtn) retryBtn.addEventListener('click', retryPayment);
}

// ==================== Payment Handlers ====================

async function initiatePayment(event) {
  event.preventDefault();

  const phoneEl = $('#phone');
  const phone = phoneEl ? phoneEl.value.trim() : '';
  const plan = payment.getSelectedPlan();

  if (!plan) {
    ui.showToast('No plan selected', 'error');
    return;
  }

  if (!validation.validatePhone(phone)) {
    ui.showToast('Enter a valid Kenyan phone (07XX or 2547XX)', 'error');
    return;
  }

  const devices = Number(plan.devices) || 1;
  const formattedPhone = validation.formatKenyanPhone(phone);
  ui.showLoading('Initiating payment...');

  // Cancel any poll left over from a previous attempt.
  if (cancelPoll) {
    try { cancelPoll(); } catch { /* ignore */ }
    cancelPoll = null;
  }
  currentTransactionId = null;

  // Reset any stale status area from a previous attempt
  const retry = $('#retryBtn');
  if (retry) retry.style.display = 'none';

  try {
    const result = await payment.initiateMPesaPayment(formattedPhone, plan.id, devices);
    const transactionId = result.transactionId;

    ui.hideLoading();
    ui.showToast('Check your phone for M‑Pesa prompt', 'info');

    // Start the poll via the shared helper — same callbacks used by
    // the resume path.
    _startPoll(transactionId);
  } catch (error) {
    ui.hideLoading();
    ui.showToast(error.message || 'Payment initiation failed', 'error');
  }
}

function retryPayment() {
  const retry = $('#retryBtn');
  if (retry) retry.style.display = 'none';
  const msgEl = $('#status-message');
  if (msgEl) msgEl.textContent = '🔄 Retrying...';
  initiatePayment(new Event('submit'));
}

// ==================== Cleanup ====================
export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's DOM.
  try { redirect.unregisterStateAdapter('payment'); } catch { /* ignore */ }

  if (cancelPoll) {
    try { cancelPoll(); } catch { /* ignore */ }
    cancelPoll = null;
  }
  currentTransactionId = null;

  // Clear the manager's receipt countdown / pending navigation so a
  // mid-countdown route change doesn't fire a stray navigateTo('subjects').
  try {
    window.Payment?.cancelReceiptFlow?.();
  } catch (_) { /* ignore */ }
}