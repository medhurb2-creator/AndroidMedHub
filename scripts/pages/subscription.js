// scripts/pages/subscription.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as subscription from '../subscription.js';
import * as utils from '../utils.js';
import * as db from '../db.js';
import * as payment from '../payment.js';

let $;
let plansList = [];
let trialEligible = false;
let customPlan = null;
let isProcessing = false;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // Check auth
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to view subscriptions', 'warning');
    router.navigateTo('login');
    return;
  }

  // ============================================================
  // ✅ Load subscription from cache (no backend refresh)
  // ============================================================
  let currentSub = null;
  try {
    currentSub = await subscription.getSubscription(); // returns cached object
  } catch (e) {
    console.warn('[Subscription] Failed to get subscription:', e);
  }

  // If not in memory, try to load from IndexedDB
  if (!currentSub) {
    try {
      currentSub = await db.getSubscription();
      if (currentSub) await subscription.setSubscription(currentSub);
    } catch (e) { /* ignore */ }
  }

  // Load plans
  plansList = await subscription.getSubscriptionPlans();

  // Render header status
  await renderHeaderStatus(currentSub);

  // Hide shimmer, show real content
  $('#shimmer-content').style.display = 'none';
  $('#real-content').style.display = 'block';

  // Show method selection
  switchBodyView('method-selection');

  // Check trial eligibility ONLY if online and no active subscription
  if (navigator.onLine && !(currentSub && currentSub.isActive)) {
    try {
      trialEligible = await subscription.checkTrialEligibility();
      // If trial eligible, update UI; but we don't refresh subscription from backend here
      // because we only need eligibility flag, not the subscription object.
    } catch (e) {
      console.warn('Trial eligibility check failed', e);
      trialEligible = false;
    }
  } else {
    trialEligible = false; // already subscribed or offline
  }

  // Show/hide trial option
  const trialOption = $('#trialOption');
  if (trialOption) {
    if (!trialEligible) trialOption.classList.add('hidden');
    else trialOption.classList.remove('hidden');
  }

  // Attach event listeners
  attachEventListeners(context);

  console.log('[Subscription] Initialized');
}

function attachEventListeners(context) {
  // Back button
  const backBtn = $('#backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  // Theme toggle
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // Payment method selections
  const trialOption = $('#trialOption');
  if (trialOption) {
    trialOption.addEventListener('click', () => {
      if (!trialEligible) { ui.showToast('Free trial not available', 'warning'); return; }
      router.navigateTo('free-trial');
    });
  }

  const stkOption = $('#stkOption');
  if (stkOption) {
    stkOption.addEventListener('click', () => {
      switchBodyView('stk-plans');
      renderInlinePlans();
    });
  }

  const c2bOption = $('#c2bOption');
  if (c2bOption) {
    c2bOption.addEventListener('click', () => {
      switchBodyView('c2b-details');
      $('#c2b-expected-amount').textContent = 'any amount';
      resetC2BForm();
    });
  }

  // Back to methods from STK
  const backToMethodsBtn = $('#backToMethodsBtn');
  if (backToMethodsBtn) {
    backToMethodsBtn.addEventListener('click', () => switchBodyView('method-selection'));
  }

  // Back to methods from C2B
  const backToMethodsC2BBtn = $('#backToMethodsC2BBtn');
  if (backToMethodsC2BBtn) {
    backToMethodsC2BBtn.addEventListener('click', () => switchBodyView('method-selection'));
  }

  // Verify C2B payment
  const verifyC2BBtn = $('#verifyC2BBtn');
  if (verifyC2BBtn) {
    verifyC2BBtn.addEventListener('click', verifyC2BPayment);
  }
}

// ==================== VIEW SWITCHING ====================
function switchBodyView(viewName) {
  document.querySelectorAll('.body-view').forEach(v => v.classList.remove('active'));
  const target = document.getElementById('view-' + viewName);
  if (target) target.classList.add('active');
  if (viewName === 'stk-plans') renderInlinePlans();
  if (viewName === 'c2b-details') resetC2BForm();
}

// ==================== HEADER STATUS ====================
async function renderHeaderStatus(sub) {
  const container = $('#status-area');
  if (!container) return;
  if (sub && sub.isActive) {
    const remaining = await subscription.formatRemainingTime(); // uses cached expiry
    container.innerHTML = `<span class="status-text">Plan: ${sub.plan} · expires ${utils.formatDate(sub.expiryDate)}</span><span class="status-text">(${remaining} left)</span>`;
    return;
  }
  if (trialEligible) {
    container.innerHTML = `<span class="status-text">No active plan</span><button id="trialHeaderBtn" class="trial-btn">Start Free Trial</button>`;
    const trialHeaderBtn = $('#trialHeaderBtn');
    if (trialHeaderBtn) {
      trialHeaderBtn.addEventListener('click', () => router.navigateTo('free-trial'));
    }
    return;
  }
  container.innerHTML = `<span class="status-text">No active plan</span><span class="status-text" style="color: var(--danger);">Please subscribe</span>`;
}

// ==================== CUSTOM PLAN HELPERS ====================
function calculatePremiumDays(amount) {
  const amt = Math.round(amount);
  let days = 0;
  if (amt === 300) return 30;
  if (amt === 850) return 90;
  if (amt === 2100) return 270;
  if (amt < 300) days = amt / 11.75;
  else if (amt > 300 && amt < 850) days = 30 + (amt - 300) / 11.1944;
  else if (amt > 850) days = 90 + (amt - 850) / 9.5277;
  return Math.floor(days);
}

function createCustomPlan(amount) {
  const days = calculatePremiumDays(amount);
  const durationText = days > 0 ? `${days} days` : 'Invalid amount';
  return {
    id: 'custom',
    name: 'Custom Amount',
    price: amount,
    duration: days,
    durationText: durationText,
    features: ['Pay any amount', 'Get pro‑rated days', 'No fixed commitment'],
    ctaText: `Pay KES ${amount}`,
    ctaColor: 'primary'
  };
}

function updateCustomDuration(amount, previewElId) {
  const days = calculatePremiumDays(amount);
  const previewEl = document.getElementById(previewElId);
  if (previewEl) {
    if (days > 0) {
      previewEl.innerHTML = `<strong>${days} days</strong> of access`;
    } else {
      previewEl.innerHTML = `<span style="color: var(--danger);">Minimum KES 50 required</span>`;
    }
  }
  customPlan = createCustomPlan(amount);
}

// ==================== INLINE PLANS ====================
function renderInlinePlans() {
  const container = $('#inline-plan-cards');
  if (!container) return;
  const defaultAmount = 300;
  customPlan = createCustomPlan(defaultAmount);
  const orderedPlans = [];
  orderedPlans.push(customPlan);
  const regularPlans = plansList.filter(p => p.id !== 'trial' && p.id !== 'custom');
  const order = ['monthly', 'quarterly', 'yearly'];
  regularPlans.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  orderedPlans.push(...regularPlans);

  container.innerHTML = orderedPlans.map(plan => {
    let cardClass = 'plan-card';
    if (plan.popular) cardClass += ' popular';
    if (plan.id === 'custom') cardClass += ' custom-card';
    const durationDisplay = plan.durationText || utils.formatDuration(plan.duration);
    if (plan.id === 'custom') {
      const previewText = plan.duration > 0 ? `<strong>${plan.duration} days</strong> of access` : 'Minimum KES 50 required';
      return `
        <div class="${cardClass}" onclick="window.initiateCustomPayment()">
          <h3>${plan.name}</h3>
          <div class="price">
            <input type="number" id="inline-custom-amount" min="50" max="150000" placeholder="Enter amount (KES)" value="${defaultAmount}" onclick="event.stopPropagation();" oninput="window.updateInlineCustomAmount(this.value)">
          </div>
          <div class="duration"><span id="inline-custom-duration-preview" class="custom-duration-preview">${previewText}</span></div>
          <ul class="features">${plan.features.map(f => `<li>✓ ${f}</li>`).join('')}</ul>
          <button onclick="event.stopPropagation(); window.initiateCustomPayment();">Pay Now</button>
        </div>`;
    }
    return `
      <div class="${cardClass}" onclick="window.selectPlanInline('${plan.id}')">
        <h3>${plan.name}</h3>
        <div class="price">${plan.price === 0 ? 'FREE' : `KES ${plan.price}`}</div>
        <div class="duration">${durationDisplay}</div>
        <ul class="features">${plan.features.map(f => `<li>✓ ${f}</li>`).join('')}</ul>
        ${plan.limitations ? `<p class="limitations">${plan.limitations.join(', ')}</p>` : ''}
        <button>${plan.ctaText || 'Select'}</button>
      </div>`;
  }).join('');
  updateCustomDuration(defaultAmount, 'inline-custom-duration-preview');
}

// ==================== GLOBAL FUNCTIONS (exposed for inline onclick) ====================
window.updateInlineCustomAmount = function (value) {
  updateCustomDuration(parseFloat(value) || 0, 'inline-custom-duration-preview');
};

window.selectPlanInline = function (planId) {
  const plan = plansList.find(p => p.id === planId);
  if (!plan) { ui.showToast('Plan not found', 'error'); return; }
  payment.setSelectedPlan(plan);
  router.navigateTo('payment');
};

window.initiateCustomPayment = function () {
  let plan = customPlan;
  if (!plan) {
    const input = document.getElementById('inline-custom-amount');
    plan = createCustomPlan(parseFloat(input?.value) || 300);
  }
  if (!plan || plan.duration <= 0) {
    ui.showToast('Please enter a valid amount (minimum KES 50)', 'error');
    return;
  }
  payment.setSelectedPlan(plan);
  router.navigateTo('payment');
};

// ==================== C2B ====================
function resetC2BForm() {
  $('#c2b-phone').value = '';
  $('#c2b-mpesa-code').value = '';
  const statusDiv = $('#verification-status');
  statusDiv.className = 'verification-status';
  statusDiv.style.display = 'none';
  statusDiv.innerHTML = '';
  isProcessing = false;
  const btn = $('#verifyC2BBtn');
  if (btn) btn.disabled = false;
}

async function verifyC2BPayment(event) {
  event.preventDefault();
  if (isProcessing) return;
  const phone = $('#c2b-phone').value.trim();
  const mpesaCode = $('#c2b-mpesa-code').value.trim();
  if (!phone && !mpesaCode) {
    ui.showToast('Please enter either your phone number or M-Pesa code.', 'warning');
    return;
  }
  const btn = $('#verifyC2BBtn');
  btn.disabled = true;
  isProcessing = true;
  const statusDiv = $('#verification-status');
  statusDiv.className = 'verification-status';
  statusDiv.style.display = 'block';
  statusDiv.innerHTML = '⏳ Checking payment...';
  statusDiv.style.background = '#fff3cd';
  statusDiv.style.color = '#856404';
  statusDiv.style.border = '1px solid #ffc107';
  try {
    const result = await window.Payment.claimManualPayment({ mpesaCode, phoneNumber: phone });
    statusDiv.className = 'verification-status success';
    statusDiv.innerHTML = `✅ ${result.message || 'Subscription activated successfully!'} <button class="close-status" onclick="document.getElementById('verification-status').style.display='none'">&times;</button>`;
    // After successful claim, refresh subscription status from backend
    await subscription.syncSubscription(true);
    setTimeout(() => window.location.reload(), 2000);
  } catch (err) {
    statusDiv.className = 'verification-status error';
    statusDiv.innerHTML = `❌ ${err.message || 'Payment verification failed.'} <button class="close-status" onclick="document.getElementById('verification-status').style.display='none'">&times;</button>`;
    btn.disabled = false;
    isProcessing = false;
  }
}

// ==================== DESTROY ====================
export function destroy() {
  // Cleanup if needed
}