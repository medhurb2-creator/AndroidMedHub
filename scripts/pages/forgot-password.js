// scripts/pages/forgot-password.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as validation from '../validation.js';

let $;
let currentIdentifier = '';
let securityQuestions = [];

// ==================== SECURITY QUESTION RENDERING ====================
//
// Extracted so both the normal flow (initiateReset) and the state
// adapter's restore path can call it. Renders the inputs and returns
// nothing — the caller decides which step to show.
function renderQuestions(questions) {
  const container = $('#questions-container');
  if (!container) return;
  container.innerHTML = questions.map((q, idx) => `
    <div class="form-group">
      <label>${q}</label>
      <input type="text" id="answer-${idx}" class="security-answer" placeholder="Your answer" autocomplete="off">
    </div>
  `).join('');
}

// ==================== INIT ====================
export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ── State adapter ────────────────────────────────────────────────
  // Registered before any redirect can fire. Captures everything the
  // wizard holds in memory: which step, the identifier the user typed,
  // the (already-fetched) security questions, and any answers they'd
  // entered. Without this, being bounced away mid-flow would drop them
  // back on step 1 with an empty form.
  //
  // We do NOT capture the answer inputs via the module's automatic UI
  // snapshot alone, because they only exist after renderQuestions() —
  // if we're restoring to step 2, the module would look for them
  // before we've had a chance to create them. The adapter handles it
  // in one pass.
  redirect.registerStateAdapter('forgot-password', {
    capture: () => {
      // Read current answers from the DOM if step 2/3 is showing.
      const answers = [];
      if (securityQuestions.length > 0) {
        for (let i = 0; i < securityQuestions.length; i++) {
          const input = document.getElementById(`answer-${i}`);
          answers.push(input ? input.value : '');
        }
      }

      // Which step is showing?
      const step1 = document.getElementById('step1');
      const step2 = document.getElementById('step2');
      const step3 = document.getElementById('step3');
      let step = 1;
      if (step3 && step3.style.display === 'block') step = 3;
      else if (step2 && step2.style.display === 'block') step = 2;
      else if (step1 && step1.style.display === 'block') step = 1;

      return {
        step,
        currentIdentifier,
        securityQuestions: [...securityQuestions],
        answers,
      };
    },

    restore: (data) => {
      if (!data) return;

      // Restore module-level state first.
      if (typeof data.currentIdentifier === 'string') {
        currentIdentifier = data.currentIdentifier;
      }
      if (Array.isArray(data.securityQuestions)) {
        securityQuestions = [...data.securityQuestions];
      }

      // Rehydrate the identifier input so step 1 looks right if the
      // user goes back to it.
      const emailInput = document.getElementById('email');
      if (emailInput && currentIdentifier) {
        emailInput.value = currentIdentifier;
      }

      // Re-render step 2's inputs before showing any step ≥ 2. If we
      // restored straight to step 3, step 2's inputs still need to
      // exist so the user can navigate back.
      if (securityQuestions.length > 0) {
        renderQuestions(securityQuestions);
        // Pre-fill answers
        (data.answers || []).forEach((val, i) => {
          const input = document.getElementById(`answer-${i}`);
          if (input && typeof val === 'string') input.value = val;
        });
      }

      // Show the correct step.
      const step1 = document.getElementById('step1');
      const step2 = document.getElementById('step2');
      const step3 = document.getElementById('step3');
      if (step1) step1.style.display = data.step === 1 ? 'block' : 'none';
      if (step2) step2.style.display = data.step === 2 ? 'block' : 'none';
      if (step3) step3.style.display = data.step === 3 ? 'block' : 'none';
    },
  });

  // Check if already logged in (optional warning)
  if (auth.checkAuth()) {
    ui.showToast('You are already logged in. Resetting password will log you out.', 'warning');
  }

  // Attach event listeners
  const step1Form = $('#step1-form');
  if (step1Form) {
    step1Form.addEventListener('submit', initiateReset);
  }

  // Back-to-login — plain navigation to login, preserving any pending
  // redirect context as a URL param. The login page reads the param
  // (via readRedirectContext, which checks URL first) and knows where
  // to send the user after they authenticate.
  const backToLogin = $('#backToLogin');
  if (backToLogin) {
    backToLogin.addEventListener('click', () => {
      const ctx = redirect.readRedirectContext();
      if (ctx.hasContext && ctx.returnTo) {
        const params = new URLSearchParams();
        params.set('redirect', ctx.returnTo);
        if (ctx.reason) params.set('redirect_reason', ctx.reason);
        router.navigateTo(`login?${params.toString()}`);
      } else {
        router.navigateTo('login');
      }
    });
  }

  const verifyAnswersBtn = $('#verifyAnswersBtn');
  if (verifyAnswersBtn) {
    verifyAnswersBtn.addEventListener('click', verifyAnswers);
  }

  const backToStep1 = $('#backToStep1');
  if (backToStep1) {
    backToStep1.addEventListener('click', backToStep1Handler);
  }

  const step3Form = $('#step3-form');
  if (step3Form) {
    step3Form.addEventListener('submit', resetPassword);
  }

  const backToStep2 = $('#backToStep2');
  if (backToStep2) {
    backToStep2.addEventListener('click', backToStep2Handler);
  }

  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a just-completed round
  // trip. Pop the entry so the stack does not grow on subsequent
  // redirects.
  //
  // In practice this rarely fires for forgot-password because this
  // page normally doesn't push itself onto the stack — but if a
  // caller in the future uses navigateWithReturn('forgot-password')
  // and the returning path uses history.back() instead of
  // consumeAndReturn(), this keeps the stack tidy.
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
    console.warn('[ForgotPassword] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Restores the step, identifier, security questions, and any
  // answers the user had typed. One-shot: the snapshot is deleted
  // after this call, so subsequent reloads start fresh.
  const snap = redirect.consumeSnapshot();
  if (snap && snap.page && snap.page.step && snap.page.step !== 1) {
    ui.showToast('Continuing where you left off', 'info', 1800);
  }

  console.log('[ForgotPassword] Initialized');
}

// ==================== Step Handlers ====================

async function initiateReset(event) {
  event.preventDefault();
  const identifier = $('#email').value.trim();
  if (!validation.validateEmail(identifier) && !validation.validatePhone(identifier)) {
    ui.showToast('Enter a valid email or Kenyan phone', 'error');
    return;
  }

  ui.showLoading('Verifying account...');
  try {
    const questions = await auth.getSecurityQuestions(identifier);
    securityQuestions = questions;
    currentIdentifier = identifier;
    ui.hideLoading();

    // Show step 2
    $('#step1').style.display = 'none';
    $('#step2').style.display = 'block';

    // Render questions
    renderQuestions(securityQuestions);
  } catch (error) {
    ui.hideLoading();
    ui.showToast(error.message || 'Account not found', 'error');
  }
}

async function verifyAnswers() {
  const answers = [];
  for (let i = 0; i < securityQuestions.length; i++) {
    const ans = $(`#answer-${i}`).value.trim();
    if (!ans) {
      ui.showToast('Please answer all questions', 'error');
      return;
    }
    answers.push(ans);
  }

  ui.showLoading('Verifying answers...');
  try {
    await auth.verifySecurityAnswers(currentIdentifier, answers);
    ui.hideLoading();

    // Show step 3
    $('#step2').style.display = 'none';
    $('#step3').style.display = 'block';
  } catch (error) {
    ui.hideLoading();
    ui.showToast(error.message || 'Incorrect answers', 'error');
  }
}

async function resetPassword(event) {
  event.preventDefault();

  const newPassword = $('#new-password').value;
  const confirmPassword = $('#confirm-password').value;

  if (newPassword !== confirmPassword) {
    ui.showToast('Passwords do not match', 'error');
    return;
  }

  const strength = validation.validatePassword(newPassword);
  if (!strength.isValid) {
    ui.showToast('Password must be 8+ chars, include uppercase, lowercase, number', 'error');
    return;
  }

  ui.showLoading('Resetting password...');
  try {
    await auth.resetPassword(currentIdentifier, newPassword);
    ui.hideLoading();
    ui.showToast('Password reset successful! Please login.', 'success');

    // Preserve any pending redirect context when sending the user to
    // login. This is what makes the full chain work:
    //
    //   agent-registration → forgot-password → login → agent-registration
    //
    // The context is passed via URL param so it survives even if
    // sessionStorage is wiped between navigations.
    const ctx = redirect.readRedirectContext();
    if (ctx.hasContext && ctx.returnTo) {
      const params = new URLSearchParams();
      params.set('redirect', ctx.returnTo);
      if (ctx.reason) params.set('redirect_reason', ctx.reason);
      router.navigateTo(`login?${params.toString()}`);
    } else {
      router.navigateTo('login');
    }
  } catch (error) {
    ui.hideLoading();
    ui.showToast(error.message || 'Reset failed', 'error');
  }
}

// ==================== Navigation Helpers ====================

function backToStep1Handler() {
  $('#step2').style.display = 'none';
  $('#step1').style.display = 'block';
}

function backToStep2Handler() {
  $('#step3').style.display = 'none';
  $('#step2').style.display = 'block';
}

// ==================== Destroy ====================
export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's DOM.
  try { redirect.unregisterStateAdapter('forgot-password'); } catch { /* ignore */ }
}