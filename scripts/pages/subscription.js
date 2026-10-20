// scripts/pages/subscription.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
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

  // ── State adapter ────────────────────────────────────────────────
  // Registered before the auth gate so a capture-on-redirect is
  // possible the moment we push login. Captures the parts of UI
  // state that would otherwise be lost on a redirect round-trip:
  //
  //   • activeView  — which body-view is showing ('method-selection',
  //                   'stk-plans', 'c2b-details').
  //   • c2bCode     — the M-Pesa transaction code being typed.
  //   • c2bPhone    — the phone number field (optional).
  //
  // We do NOT capture the inline amount field, the plan card
  // selection state, or the trial option — those are all regenerated
  // by renderInlinePlans() / renderHeaderStatus() on init.
  //
  // Restore order matters: switchBodyView('c2b-details') invokes
  // resetC2BForm(), which wipes the C2B inputs. So we must re-apply
  // the saved values AFTER switchBodyView runs. The adapter's
  // restore does exactly that.
  redirect.registerStateAdapter('subscription', {
    capture: () => {
      const activeViewEl =
        document.querySelector('.body-view.active');

      const codeEl = document.getElementById('c2b-mpesa-code');
      const phoneEl = document.getElementById('c2b-phone');

      return {
        activeView: activeViewEl
          ? activeViewEl.id.replace(/^view-/, '')
          : 'method-selection',
        c2bCode: codeEl ? codeEl.value : '',
        c2bPhone: phoneEl ? phoneEl.value : '',
      };
    },
    restore: (data) => {
      if (!data) return;

      // Switch to the saved view first. For c2b-details this calls
      // resetC2BForm() internally, wiping the inputs — so we re-apply
      // the saved values immediately after.
      if (data.activeView) {
        try { switchBodyView(data.activeView); }
        catch (err) { console.warn('[Subscription] view restore failed:', err); }
      }

      if (data.activeView === 'c2b-details') {
        const codeEl = document.getElementById('c2b-mpesa-code');
        const phoneEl = document.getElementById('c2b-phone');
        if (codeEl && typeof data.c2bCode === 'string') codeEl.value = data.c2bCode;
        if (phoneEl && typeof data.c2bPhone === 'string') phoneEl.value = data.c2bPhone;
      }
    },
  });

  // ── Auth gate ────────────────────────────────────────────────────
  // Round-trip through login. Subscription is a resolver, so it
  // pushes itself — after the user authenticates, we come back here
  // with the same view state and can continue toward payment/trial.
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to view subscription plans', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  // ============================================================
  // ✅ Get cached subscription and compute actual active status
  // ============================================================
  let currentSub = null;
  let isActive = false;
  try {
    currentSub = await subscription.getSubscription(); // cached object
    isActive = await subscription.hasActiveSubscription(); // real-time expiry check
  } catch (e) {
    console.warn('[Subscription] Failed to get subscription:', e);
  }

  // If not in memory, try to load from IndexedDB
  if (!currentSub) {
    try {
      currentSub = await db.getSubscription();
      if (currentSub) await subscription.setSubscription(currentSub);
      isActive = await subscription.hasActiveSubscription();
    } catch (e) { /* ignore */ }
  }

  // Load plans
  plansList = await subscription.getSubscriptionPlans();

  // Render header status
  await renderHeaderStatus(currentSub, isActive);

  // Hide shimmer, show real content
  const shimmer = $('#shimmer-content');
  const real = $('#real-content');
  if (shimmer) shimmer.style.display = 'none';
  if (real) real.style.display = 'block';

  // Show default method selection. If the user was on a different
  // body-view when they were bounced, the adapter restores it below.
  switchBodyView('method-selection');

  // Check trial eligibility ONLY if online and no active subscription
  if (navigator.onLine && !isActive) {
    try {
      trialEligible = await subscription.checkTrialEligibility();
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

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a completed round trip.
  // Pop so the stack doesn't grow on subsequent redirects.
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
    console.warn('[Subscription] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Restores body view and C2B fields via the adapter. The inline
  // custom amount field is captured by the UI snapshot (it has an
  // id) but its oninput listener is not re-fired, so
  // updateCustomDuration is invoked manually by the adapter's
  // restore path via switchBodyView → renderInlinePlans.
  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[Subscription] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

  console.log('[Subscription] Initialized');
}

function attachEventListeners(context) {
  // Back button — plain navigation. The user is explicitly leaving
  // the subscription flow.
  const backBtn = $('#backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  // Theme toggle
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // ── Payment method selections ────────────────────────────────────
  //
  // None of these push the redirect stack. Subscription is an
  // intermediate page: the user arrived here to satisfy a
  // subscription_required gate upstream, and every exit is a
  // hand-off to a downstream resolver (payment, trial) that will
  // pop the ORIGINAL chain entry on its own success. Pushing
  // subscription here would corrupt the chain by inserting an
  // intermediate step that nobody wants to return to.
  //
  // The single exception is the auth gate at the top of init(),
  // which does push because returning to subscription after login
  // is exactly the intent.

  const trialOption = $('#trialOption');
  if (trialOption) {
    trialOption.addEventListener('click', () => {
      if (!trialEligible) { ui.showToast('Free trial not available', 'warning'); return; }
      // Plain nav — trial activation is a resolver that pops.
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
      const amt = $('#c2b-expected-amount');
      if (amt) amt.textContent = 'any amount';
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
async function renderHeaderStatus(sub, isActive) {
  const container = $('#status-area');
  if (!container) return;
  if (isActive && sub) {
    const remaining = await subscription.formatRemainingTime();
    container.innerHTML = `<span class="status-text">Plan: ${sub.plan} · expires ${utils.formatDate(sub.expiryDate)}</span><span class="status-text">(${remaining} left)</span>`;
    return;
  }

  let trialAvailable = false;
  if (navigator.onLine) {
    try {
      trialAvailable = await subscription.checkTrialEligibility();
    } catch (e) { /* ignore */ }
  }
  if (trialAvailable) {
    container.innerHTML = `<span class="status-text">No active plan</span><button id="trialHeaderBtn" class="trial-btn">Start Free Trial</button>`;
    const trialHeaderBtn = $('#trialHeaderBtn');
    if (trialHeaderBtn) {
      // Plain nav — same reasoning as the main trial option.
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

  const regularPlans = plansList.filter(p => p.id !== 'trial' && p.id !== 'custom');
  const order = ['monthly', 'quarterly', 'yearly'];
  regularPlans.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  container.innerHTML =
    renderCustomCard(customPlan, defaultAmount) +
    regularPlans.map(renderPlanCard).join('');

  attachPlanCardListeners(container);
  updateCustomDuration(defaultAmount, 'inline-custom-duration-preview');
}

function renderPlanCard(plan) {
  const deviceOptions = plan.deviceOptions || [
    { devices: 1, price: plan.basePrice || plan.price, icon: '📱', label: '1 DEVICE' }
  ];
  const defaultOption = deviceOptions[0];
  const priceDisplay  = `KES ${defaultOption.price.toLocaleString()}`;
  const suffix        = plan.priceSuffix || '';
  const shortSuffix   = plan.shortSuffix || '';

  return `
    <div class="plan-card ${plan.popular ? 'popular' : ''}"
         data-plan-id="${plan.id}"
         data-selected-devices="${defaultOption.devices}"
         data-selected-price="${defaultOption.price}">

      <div class="plan-header">
        <p class="plan-period">${plan.periodLabel || plan.name.toUpperCase()}</p>
        <div class="plan-price-row">
          <span class="plan-price" data-price-display>${priceDisplay}</span>
          <span class="plan-price-suffix">${suffix}</span>
        </div>
        ${plan.tagline ? `<p class="plan-tagline">${plan.tagline}</p>` : ''}
      </div>

      <ul class="plan-features">
        ${plan.features.map(f => `<li>${f}</li>`).join('')}
      </ul>

      <div class="device-selector">
        <p class="device-label">USE ON</p>
        <div class="device-options">
          ${deviceOptions.map((opt, i) => `
            <button type="button"
                    class="device-option ${i === 0 ? 'active' : ''}"
                    data-devices="${opt.devices}"
                    data-price="${opt.price}">
              <span class="device-icon">${opt.icon}</span>
              <span class="device-name">${opt.label}${opt.featured ? ' ⭐' : ''}</span>
              <span class="device-price">KES ${opt.price.toLocaleString()}${shortSuffix}</span>
            </button>
          `).join('')}
        </div>
      </div>

      <button type="button" class="plan-subscribe-btn">${plan.ctaText || 'Subscribe'}</button>
    </div>`;
}

function renderCustomCard(plan, defaultAmount) {
  const previewText = plan.duration > 0
    ? `<strong>${plan.duration} days</strong> of access`
    : 'Minimum KES 50 required';

  return `
    <div class="plan-card custom-card" onclick="window.initiateCustomPayment()">
      <h3>${plan.name}</h3>
      <div class="price">
        <input type="number" id="inline-custom-amount" min="50" max="150000"
               placeholder="Enter amount (KES)" value="${defaultAmount}"
               onclick="event.stopPropagation();"
               oninput="window.updateInlineCustomAmount(this.value)">
      </div>
      <div class="duration">
        <span id="inline-custom-duration-preview" class="custom-duration-preview">${previewText}</span>
      </div>
      <ul class="features">${plan.features.map(f => `<li>${f}</li>`).join('')}</ul>
      <button onclick="event.stopPropagation(); window.initiateCustomPayment();">Pay Now</button>
    </div>`;
}

function attachPlanCardListeners(container) {
  container.querySelectorAll('.plan-card[data-plan-id]').forEach(card => {
    const deviceButtons = card.querySelectorAll('.device-option');
    const priceDisplay  = card.querySelector('[data-price-display]');

    deviceButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        deviceButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        const price   = parseInt(btn.dataset.price, 10);
        const devices = parseInt(btn.dataset.devices, 10);

        if (priceDisplay) priceDisplay.textContent = `KES ${price.toLocaleString()}`;
        card.dataset.selectedDevices = String(devices);
        card.dataset.selectedPrice   = String(price);
      });
    });

    const subscribeBtn = card.querySelector('.plan-subscribe-btn');
    if (subscribeBtn) {
      subscribeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const planId = card.dataset.planId;
        const plan   = plansList.find(p => p.id === planId);
        if (!plan) { ui.showToast('Plan not found', 'error'); return; }

        const devices = parseInt(card.dataset.selectedDevices, 10) || 1;
        const price   = parseInt(card.dataset.selectedPrice, 10)
                      || plan.basePrice || plan.price;

        const selectedPlan = {
          ...plan,
          price,
          devices,
          ctaText: `Subscribe – KES ${price.toLocaleString()}`
        };
        payment.setSelectedPlan(selectedPlan);

        // Plain nav. Payment is the resolver that pops the outer
        // chain (e.g. exam-room) on success.
        router.navigateTo('payment');
      });
    }
  });
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
  const codeInput = $('#c2b-mpesa-code');
  if (codeInput) codeInput.value = '';

  const phoneInput = $('#c2b-phone');
  if (phoneInput) phoneInput.value = '';

  const statusDiv = $('#verification-status');
  if (statusDiv) {
    statusDiv.className = 'verification-status';
    statusDiv.style.display = 'none';
    statusDiv.innerHTML = '';
  }

  isProcessing = false;
  const btn = $('#verifyC2BBtn');
  if (btn) btn.disabled = false;
}

async function verifyC2BPayment(event) {
  event.preventDefault();
  if (isProcessing) return;

  const phoneInput = $('#c2b-phone');
  const phone = phoneInput ? phoneInput.value.trim() : '';
  const codeInput = $('#c2b-mpesa-code');
  const mpesaCode = codeInput ? codeInput.value.trim() : '';

  if (!phone && !mpesaCode) {
    ui.showToast('Please enter your M‑Pesa transaction code.', 'warning');
    return;
  }

  const btn = $('#verifyC2BBtn');
  if (btn) btn.disabled = true;
  isProcessing = true;

  const statusDiv = $('#verification-status');
  if (statusDiv) {
    statusDiv.className = 'verification-status';
    statusDiv.style.display = 'block';
    statusDiv.innerHTML = '⏳ Checking payment...';
    statusDiv.style.background = '#fff3cd';
    statusDiv.style.color = '#856404';
    statusDiv.style.border = '1px solid #ffc107';
  }

  try {
    const result = await window.Payment.claimManualPayment({ mpesaCode, phoneNumber: phone });
    if (statusDiv) {
      statusDiv.className = 'verification-status success';
      statusDiv.innerHTML = `✅ ${result.message || 'Subscription activated successfully!'}`;
    }

    // Refresh subscription status from backend so the header and
    // any downstream page sees the new active state.
    await subscription.syncSubscription(true);

    // C2B success is a resolver: the user now has an active
    // subscription. Pop the chain if the caller was gated into
    // subscription from another page; fall through to subjects
    // otherwise.
    //
    // Replaces the previous `window.location.reload()` — a full
    // reload would lose the redirect chain and re-bootstrap the
    // entire app for a simple state change.
    setTimeout(() => {
      try {
        redirect.consumeAndReturn('subjects');
      } catch (err) {
        console.warn('[Subscription] C2B consumeAndReturn failed, reloading:', err);
        window.location.reload();
      }
    }, 1500);
  } catch (err) {
    if (statusDiv) {
      statusDiv.className = 'verification-status error';
      statusDiv.innerHTML = `❌ ${err.message || 'Payment verification failed.'} <button class="close-status" onclick="document.getElementById('verification-status').style.display='none'">&times;</button>`;
    }
    if (btn) btn.disabled = false;
    isProcessing = false;
  }
}

// ==================== DESTROY ====================
export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's module state.
  try { redirect.unregisterStateAdapter('subscription'); } catch { /* ignore */ }
}