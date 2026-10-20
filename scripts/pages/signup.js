// scripts/pages/signup.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as validation from '../validation.js';
import * as utils from '../utils.js';
import * as referral from '../referral.js';
import { initGoogleSignIn, disableGoogleAutoSelect } from '../auth/google.js';

export async function init(context) {
  ui.applyTheme();

  // ---- Redirect context ----
  const redirectCtx = redirect.readRedirectContext();
  const redirectTarget = redirectCtx.returnTo || null;

  if (auth.checkAuth()) {
    redirect.consumeAndReturn('subjects');
    return;
  }

  // ---- DOM refs ----
  const $ = (sel) => context.root.querySelector(sel);

  const stepIndicator = $('#step-indicator');
  const step1 = $('#step1');
  const step2 = $('#step2');
  const step3 = $('#step3');
  const step4 = $('#step4');

  // Step 1
  const referralCode = $('#referralCode');
  const referralStatus = $('#referral-status');
  const terms = $('#terms');
  const emailSignupBtn = $('#emailSignupBtn');
  const googleContainer = $('#google-signup-container');
  const googleClickGuard = $('#google-click-guard');

  // Step 2
  const fullName = $('#fullName');
  const email = $('#email');
  const phone = $('#phone');
  const password = $('#password');
  const confirmPassword = $('#confirmPassword');
  const togglePwd1 = $('#togglePassword1');
  const togglePwd2 = $('#togglePassword2');
  const backStep2Btn = $('#backStep2Btn');
  const nextStep2Btn = $('#nextStep2Btn');

  // Step 3
  const sq1 = $('#sq1');
  const ans1 = $('#answer1');
  const sq2 = $('#sq2');
  const ans2 = $('#answer2');
  const sq3 = $('#sq3');
  const ans3 = $('#answer3');
  const backStep3Btn = $('#backStep3Btn');
  const createAccountBtn = $('#createAccountBtn');

  // Step 4
  const successTitle = $('#successTitle');
  const successMessage = $('#successMessage');
  const redirectNowBtn = $('#redirectNowBtn');

  // Header
  const themeToggle = $('#themeToggle');
  const backBtn = $('#backBtn');
  const loginLink = $('#loginLink');

  // ---- In-memory state ----
  const formData = {
    name: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
    referralCode: '',
    securityQuestions: [
      { question: '', answer: '' },
      { question: '', answer: '' },
      { question: '', answer: '' },
    ],
  };

  // ---- Step navigation ----
  const STEP_LABELS = {
    1: 'Step 1 of 4: Choose your sign-up method',
    2: 'Step 2 of 4: Personal Information',
    3: 'Step 3 of 4: Security Questions',
    4: '',
  };

  function showStep(n) {
    [step1, step2, step3, step4].forEach((el, idx) => {
      if (el) el.style.display = (idx + 1 === n) ? 'block' : 'none';
    });
    if (stepIndicator) {
      if (n === 4) {
        stepIndicator.style.display = 'none';
      } else {
        stepIndicator.style.display = 'block';
        stepIndicator.textContent = STEP_LABELS[n] || '';
      }
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function detectCurrentStep() {
    if (step4 && step4.style.display === 'block') return 4;
    if (step3 && step3.style.display === 'block') return 3;
    if (step2 && step2.style.display === 'block') return 2;
    return 1;
  }

  // ── State adapter ────────────────────────────────────────────────
  redirect.registerStateAdapter('signup', {
    capture: () => ({
      currentStep: detectCurrentStep(),
      formData: {
        ...formData,
        securityQuestions: formData.securityQuestions.map((q) => ({ ...q })),
      },
    }),
    restore: (data) => {
      if (!data) return;

      if (data.formData) {
        Object.assign(formData, data.formData);
        if (Array.isArray(data.formData.securityQuestions)) {
          formData.securityQuestions = data.formData.securityQuestions.map((q) => ({ ...q }));
        }
      }

      if (data.currentStep) {
        try { showStep(data.currentStep); }
        catch (err) { console.warn('[Signup] step restore failed:', err); }
      }
    },
  });

  // ---- Header buttons ----
  if (themeToggle) themeToggle.addEventListener('click', () => ui.toggleTheme());
  if (backBtn) backBtn.addEventListener('click', () => router.navigateTo('welcome'));
  if (loginLink) {
    loginLink.addEventListener('click', () => {
      let url = 'login';
      if (redirectTarget) {
        url += `?returnTo=${encodeURIComponent(redirectTarget)}`;
        if (redirectCtx.reason) {
          url += `&redirect_reason=${encodeURIComponent(redirectCtx.reason)}`;
        }
      }
      router.navigateTo(url);
    });
  }

  // ============================================================
  // STEP 1 – Referral + Terms handling
  // ============================================================

  function captureManualReferral() {
    const raw = (referralCode?.value || '').trim();
    if (!raw) {
      return formData.referralCode || '';
    }

    formData.referralCode = raw;

    try {
      utils.setLocalStorage('referral_code', raw);
    } catch (_) { /* ignore */ }

    console.log('[Signup] captureManualReferral →', formData.referralCode);
    return formData.referralCode;
  }

  async function prefillReferral() {
    if (!referralCode) return;

    const urlRef = referral.detectReferralFromURL?.();
    const storedRef = referral.getStoredReferralCode?.();
    const refCode = urlRef || storedRef;
    if (!refCode) return;

    referralCode.value = refCode;
    referralCode.readOnly = true;

    if (referralStatus) {
      referralStatus.textContent = '⏳ Validating referral code…';
      referralStatus.style.color = 'var(--text-muted)';
    }

    try {
      const result = await referral.validateReferralCode(refCode);
      if (result?.valid) {
        if (referralStatus) {
          referralStatus.textContent = `✅ Referred by ${result.referrerName || 'a MedVix user'}`;
          referralStatus.style.color = 'var(--success)';
        }
        formData.referralCode = refCode;
      } else {
        if (referralStatus) {
          referralStatus.textContent = '⚠️ Invalid referral code. You can still sign up.';
          referralStatus.style.color = 'var(--warning)';
        }
        referralCode.readOnly = false;
      }
    } catch (err) {
      console.warn('[Signup] Referral validation error:', err);
      if (referralStatus) {
        referralStatus.textContent = '⚠️ Could not validate code. You can still sign up.';
        referralStatus.style.color = 'var(--warning)';
      }
      referralCode.readOnly = false;
    }
  }
  await prefillReferral();

  function validateStep1() {
    let ok = true;
    ui.clearFormError('terms');

    if (!terms.checked) {
      ui.showFormError('terms', 'Please accept the Terms of Service to continue.');
      ok = false;
    }
    return ok;
  }

  // ============================================================
  // GOOGLE TERMS GUARD
  // ------------------------------------------------------------
  // Renders the Google sign-up block as DISABLED until the user
  // accepts the Terms of Service. The disabled state is signalled
  // three ways so no assistive tech or visual cue is missed:
  //
  //   1. Functionally — the click-guard overlay captures every
  //      click and shows a "accept terms first" toast instead of
  //      forwarding to Google.
  //   2. Visually — the container gets `is-terms-gated`, which CSS
  //      styles as dimmed + `cursor: not-allowed`. The Google
  //      button element inside also receives `disabled` so its
  //      own hover/active states never fire.
  //   3. Semantically — `aria-disabled="true"` on the container
  //      tells screen readers the block is not interactive.
  //
  // The guard stays on top with `pointer-events: auto` while
  // disabled (so it can catch clicks) and `pointer-events: none`
  // once the user accepts (so clicks pass through to the real
  // Google button underneath).
  // ============================================================
  function updateGoogleGuard() {
    const accepted = !!(terms && terms.checked);

    if (googleClickGuard) {
      // The guard is what catches clicks. When terms are accepted it
      // becomes transparent to pointer events so the real Google
      // button works normally.
      googleClickGuard.style.pointerEvents = accepted ? 'none' : 'auto';
      googleClickGuard.setAttribute('aria-hidden', accepted ? 'true' : 'false');
    }

    if (googleContainer) {
      googleContainer.classList.toggle('is-terms-gated', !accepted);
      googleContainer.setAttribute('aria-disabled', accepted ? 'false' : 'true');

      // Belt-and-braces: also disable any real button element inside
      // the container so its native hover/focus/active states never
      // fire while the guard is active. A disabled button does not
      // respond to clicks either, but the guard is still what shows
      // the toast — that is why both exist.
      googleContainer.querySelectorAll('button, [role="button"]').forEach((btn) => {
        btn.disabled = !accepted;
        btn.setAttribute('aria-disabled', accepted ? 'false' : 'true');
      });
    }
  }

  if (terms) {
    terms.addEventListener('change', updateGoogleGuard);
    updateGoogleGuard();
  }
  if (googleClickGuard) {
    googleClickGuard.addEventListener('click', () => {
      ui.showFormError('terms', 'Please accept the Terms of Service to continue.');
      terms?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // ============================================================
  // STEP 1 – Email/Phone path
  // ============================================================
  if (emailSignupBtn) {
    emailSignupBtn.addEventListener('click', () => {
      if (!validateStep1()) return;
      captureManualReferral();
      showStep(2);
    });
  }

  // ============================================================
  // STEP 1 – Google path
  // ============================================================
  if (googleContainer) {
    await initGoogleSignIn({
      container: googleContainer,
      text: 'signup_with',
      onCredential: async (response) => {
        // Terms gate — defensive re-check in case the click-guard
        // was bypassed (e.g. programmatic click, autofill).
        if (!validateStep1()) {
          showStep(1);
          updateGoogleGuard();
          return;
        }
        const refCode = captureManualReferral();
        await handleGoogleCredential(response.credential, refCode);
      },
    });

    // The GIS SDK injects its own iframe/button into the container
    // after initGoogleSignIn resolves. Re-apply the disabled state
    // so the injected button also picks up the correct attributes.
    updateGoogleGuard();
  }

  // ============================================================
  // STEP 2 – Personal Info (email/phone path only)
  // ============================================================
  if (togglePwd1) togglePwd1.addEventListener('click', () => ui.togglePasswordVisibility('password'));
  if (togglePwd2) togglePwd2.addEventListener('click', () => ui.togglePasswordVisibility('confirmPassword'));

  if (password) {
    password.addEventListener('input', function () {
      const s = validation.checkPasswordStrength(this.value);
      ui.updatePasswordStrength(s);
    });
  }

  validation.setupLiveValidation('step2-form', {
    fullName: { required: true, min: 2, pattern: '^[A-Za-z ]+$' },
    email: { required: true, email: true },
    phone: { required: true, phone: 'KE' },
    password: { required: true, password: true },
  });

  if (backStep2Btn) {
    backStep2Btn.addEventListener('click', () => {
      formData.name = fullName.value.trim();
      formData.email = email.value.trim();
      formData.phone = phone.value.trim();
      showStep(1);
    });
  }

  if (nextStep2Btn) {
    nextStep2Btn.addEventListener('click', () => {
      const data = {
        fullName: fullName.value.trim(),
        email: email.value.trim(),
        phone: phone.value.trim(),
        password: password.value,
        confirmPassword: confirmPassword.value,
      };

      const rules = {
        fullName: { required: true, min: 2 },
        email: { required: true, email: true },
        phone: { required: true, phone: 'KE' },
        password: { required: true, password: true },
        confirmPassword: { required: true, equalTo: 'password' },
      };

      const result = validation.validateForm(data, rules);
      if (!result.valid) {
        validation.showValidationSummary(result.errors);
        return;
      }

      formData.name = data.fullName;
      formData.email = data.email;
      formData.phone = validation.formatKenyanPhone(data.phone) || data.phone;
      formData.password = data.password;
      formData.confirmPassword = data.confirmPassword;

      showStep(3);
    });
  }

  // ============================================================
  // STEP 3 – Security Questions (email/phone path only)
  // ============================================================
  if (backStep3Btn) {
    backStep3Btn.addEventListener('click', () => showStep(2));
  }

  if (createAccountBtn) {
    createAccountBtn.addEventListener('click', async () => {
      const sq1Val = sq1.value;
      const ans1Val = ans1.value.trim();
      const sq2Val = sq2.value;
      const ans2Val = ans2.value.trim();
      const sq3Val = sq3.value;
      const ans3Val = ans3.value.trim();

      if (!sq1Val || !ans1Val || !sq2Val || !ans2Val || !sq3Val || !ans3Val) {
        ui.showToast('Please fill in all security questions and answers', 'error');
        return;
      }

      if (new Set([sq1Val, sq2Val, sq3Val]).size !== 3) {
        ui.showToast('Please choose three different questions', 'error');
        return;
      }

      formData.securityQuestions = [
        { question: sq1Val, answer: ans1Val },
        { question: sq2Val, answer: ans2Val },
        { question: sq3Val, answer: ans3Val },
      ];

      captureManualReferral();

      ui.showLoading('Creating account…');

      try {
        // Device identity is built once inside auth.register() via
        // security.buildDeviceIdentity(). Do NOT construct it here —
        // that would duplicate the call and, worse, allow it to drift
        // from the ID used by Google flows.
        await auth.register({
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          password: formData.password,
          securityQuestions: formData.securityQuestions,
          referralCode: formData.referralCode || undefined,
        });

        ui.hideLoading();
        goToSuccess(redirectTarget);

      } catch (error) {
        ui.hideLoading();
        ui.showToast(error.message || 'Registration failed', 'error');
      }
    });
  }

  // ============================================================
  // STEP 4 – Success & Redirect
  // ============================================================
  function goToSuccess(target) {
    const fallback = target || '/free-trial';
    const hasChain = redirect.hasReturn() || !!target;

    if (successTitle) successTitle.textContent = 'Account created successfully!';
    if (successMessage) {
      successMessage.innerHTML = hasChain
        ? `Your account is ready. Redirecting to your page in <span id="countdown">3</span> seconds…`
        : `Your account is ready. Redirecting to your free trial in <span id="countdown">3</span> seconds…`;
    }
    if (redirectNowBtn) {
      redirectNowBtn.textContent = hasChain ? 'Go to your page now' : 'Go to Free Trial now';
    }

    showStep(4);

    let countdown = 3;
    const cd = $('#countdown');
    if (cd) cd.textContent = countdown;

    const go = () => {
      try {
        redirect.consumeAndReturn(fallback);
      } catch (err) {
        console.warn('[Signup] consumeAndReturn failed, using fallback:', err);
        router.navigateTo(fallback);
      }
    };

    const interval = setInterval(() => {
      countdown -= 1;
      const el = $('#countdown');
      if (el) el.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(interval);
        go();
      }
    }, 1000);

    if (redirectNowBtn) {
      redirectNowBtn.onclick = () => {
        clearInterval(interval);
        go();
      };
    }
  }

  // ============================================================
  // GOOGLE CREDENTIAL HANDLER
  // ============================================================
  async function handleGoogleCredential(idToken, refCode) {
    ui.showLoading('Signing up with Google…');

    try {
      const result = await auth.loginWithGoogle(idToken, refCode || undefined);

      if (result.requiresLink) {
        ui.hideLoading();
        openGoogleLinkModal({
          email: result.email,
          linkToken: result.linkToken,
          // loginWithGoogle() returns the device identity it already
          // built (deviceId + deviceInfo). Pass it through unchanged
          // so linkGoogleAccount() reuses the SAME dv_… ID rather
          // than re-deriving. (Previously this key was named
          // `deviceFingerprint`, which does not exist on the result
          // object — the modal silently received undefined.)
          deviceId: result.deviceId,
          deviceInfo: result.deviceInfo,
          referralCode: refCode || undefined,
          redirectTarget,
        });
        return;
      }

      ui.hideLoading();
      ui.showToast(
        result.isNewUser ? 'Account created — welcome!' : 'Signed in with Google',
        'success'
      );
      goToSuccess(redirectTarget);

    } catch (err) {
      ui.hideLoading();
      ui.showToast(err.message || 'Google sign-up failed', 'error');
    }
  }

  // ============================================================
  // ACCOUNT LINKING MODAL
  // ============================================================
  function openGoogleLinkModal({
    email: linkedEmail,
    linkToken,
    deviceId,
    deviceInfo,
    referralCode: refCode,
    redirectTarget: target,
  }) {
    const modal = $('#google-link-modal');
    const emailEl = $('#google-link-email');
    const pwdInput = $('#google-link-password');
    const submitBtn = $('#google-link-submit');
    const cancelBtn = $('#google-link-cancel');
    const closeBtn = $('#google-link-close');

    emailEl.textContent = linkedEmail;
    pwdInput.value = '';
    modal.style.display = 'flex';
    setTimeout(() => pwdInput.focus(), 100);

    const close = () => {
      modal.style.display = 'none';
      disableGoogleAutoSelect?.();
    };

    const submit = async () => {
      const pwd = pwdInput.value;
      if (!pwd) {
        ui.showFormError('google-link-password', 'Password required');
        return;
      }
      ui.clearFormError('google-link-password');

      submitBtn.disabled = true;
      submitBtn.textContent = 'Connecting…';

      try {
        // linkGoogleAccount() destructures { linkToken, password,
        // deviceId, deviceInfo }. Passing deviceId (already built by
        // loginWithGoogle) keeps the linking session aligned with
        // the sign-in attempt that produced the linkToken.
        await auth.linkGoogleAccount({
          linkToken,
          password: pwd,
          deviceId,
          deviceInfo,
        });

        modal.style.display = 'none';
        ui.showToast('Google connected to your account', 'success');
        goToSuccess(target);

      } catch (err) {
        ui.showToast(err.message || 'Could not connect Google', 'error');
        ui.showFormError('google-link-password', err.message || 'Invalid password');
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Connect Google';
      }
    };

    submitBtn.onclick = submit;
    cancelBtn.onclick = close;
    closeBtn.onclick = close;
    pwdInput.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    };
  }

  // ── Self-consume of the return stack ─────────────────────────────
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
    console.warn('[Signup] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[Signup] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

  console.log('[Signup] Initialized.');
}

export function destroy() {
  try { redirect.unregisterStateAdapter('signup'); } catch { /* ignore */ }
}