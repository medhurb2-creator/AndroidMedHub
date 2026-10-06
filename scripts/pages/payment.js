// scripts/pages/payment.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as validation from '../validation.js';
import * as utils from '../utils.js';
import * as payment from '../payment.js';
import * as subscription from '../subscription.js';

let $;
let cancelPoll = null;

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

// ---------- init ----------
export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  if (!auth.checkAuth()) {
    ui.showToast('Please log in first', 'warning');
    router.navigateTo('login');
    return;
  }

  const plan = payment.getSelectedPlan();
  if (!plan) {
    ui.showToast('No plan selected', 'error');
    router.navigateTo('subscription');
    return;
  }

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

  console.log('[PaymentPage] Initialized', { planId: plan.id, devices, price: plan.price });
}

function attachEventListeners(context) {
  const backBtn = $('#backBtn');
  if (backBtn) backBtn.addEventListener('click', () => router.navigateTo('subjects'));

  const themeToggle = $('#themeToggle');
  if (themeToggle) themeToggle.addEventListener('click', ui.toggleTheme);

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

  if (cancelPoll) {
    cancelPoll();
    cancelPoll = null;
  }

  // Reset any stale status area from a previous attempt
  const retry = $('#retryBtn');
  if (retry) retry.style.display = 'none';

  try {
    const result = await payment.initiateMPesaPayment(formattedPhone, plan.id, devices);
    const transactionId = result.transactionId;

    ui.hideLoading();
    ui.showToast('Check your phone for M‑Pesa prompt', 'info');

    const statusEl = $('#payment-status');
    if (statusEl) statusEl.style.display = 'block';

    const msgEl = $('#status-message');
    const attemptEl = $('#poll-attempt');
    if (msgEl) msgEl.textContent = '⏳ Waiting for payment confirmation...';
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
          // We only update the on-page status message.
          if (status === 'completed') {
            if (msgEl) msgEl.textContent = '✅ Payment successful! Preparing receipt…';
            ui.showToast('Payment successful!', 'success');

            // Fallback in case the receipt UI could not be presented
            // (e.g. modal missing): still force a fresh subscription pull
            // in the background so other pages see the new state.
            try {
              await subscription.refreshSubscription();
            } catch (e) {
              console.warn('[PaymentPage] Post-success refresh failed', e);
            }

            if (attemptEl) attemptEl.textContent = '';
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
  if (cancelPoll) {
    cancelPoll();
    cancelPoll = null;
  }
  // Clear the manager's receipt countdown / pending navigation so a
  // mid-countdown route change doesn't fire a stray navigateTo('subjects').
  try {
    window.Payment?.cancelReceiptFlow?.();
  } catch (_) { /* ignore */ }
}