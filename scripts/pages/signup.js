// scripts/pages/signup.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as validation from '../validation.js';
import * as security from '../security.js';
import * as utils from '../utils.js';
import * as referral from '../referral.js';
import { initGoogleSignIn, disableGoogleAutoSelect } from '../auth/google.js';

export async function init(context) {
  ui.applyTheme();

  // ---- Deep-link redirect (?redirect=...) ----
  const redirectParam = new URLSearchParams(window.location.search).get('redirect');
  let redirectTarget = null;
  if (redirectParam) {
    try {
      const decoded = decodeURIComponent(redirectParam);
      if (decoded.startsWith('/')) redirectTarget = decoded;
    } catch { /* ignore */ }
  }

  // If already authenticated → redirect
  if (auth.checkAuth()) {
    if (redirectTarget) window.location.href = redirectTarget;
    else router.navigateTo('subjects');
    return;
  }

  // ---- DOM refs (scoped to the page root) ----
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

  // ---- Header buttons ----
  if (themeToggle) themeToggle.addEventListener('click', () => ui.toggleTheme());
  if (backBtn) backBtn.addEventListener('click', () => router.navigateTo('welcome'));
  if (loginLink) {
    loginLink.addEventListener('click', () => {
      let url = 'login';
      if (redirectTarget) url += `?redirect=${encodeURIComponent(redirectTarget)}`;
      router.navigateTo(url);
    });
  }

  // ============================================================
  // STEP 1 – Referral + Terms handling
  // ============================================================

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
    }
  }
  await prefillReferral();

  function captureManualReferral() {
    const code = (referralCode?.value || '').trim().toUpperCase();
    if (code) {
      formData.referralCode = code;
      try {
        // Persist so the backend's Google signup action can read it
        utils.setLocalStorage('referral_code', code);
      } catch (_) { /* ignore */ }
    }
  }

  function validateStep1() {
    let ok = true;
    ui.clearFormError('terms');

    if (!terms.checked) {
      ui.showFormError('terms', 'Please accept the Terms of Service to continue.');
      ok = false;
    }
    return ok;
  }

  // Google click guard: blocks click until terms accepted
  function updateGoogleGuard() {
    if (!googleClickGuard) return;
    googleClickGuard.style.pointerEvents = terms.checked ? 'none' : 'auto';
    if (googleContainer) {
      googleContainer.style.opacity = terms.checked ? '1' : '0.6';
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
      text: 'signup_with',              // renders "Sign up with Google"
      onCredential: async (response) => {
        if (!validateStep1()) {
          showStep(1);
          return;
        }
        captureManualReferral();
        await handleGoogleCredential(response.credential);
      },
    });
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

      ui.showLoading('Creating account…');

      try {
        const deviceFingerprint = security.generateDeviceFingerprint();
        const deviceInfo = {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          screen: `${screen.width}x${screen.height}`,
          timezone: new Date().getTimezoneOffset(),
        };

        await auth.register({
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          password: formData.password,
          securityQuestions: formData.securityQuestions,
          deviceFingerprint,
          deviceInfo,
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
    const finalTarget = target || '/free-trial';

    if (successTitle) successTitle.textContent = 'Account created successfully!';
    if (successMessage) {
      successMessage.innerHTML = target
        ? `Your account is ready. Redirecting to your page in <span id="countdown">3</span> seconds…`
        : `Your account is ready. Redirecting to your free trial in <span id="countdown">3</span> seconds…`;
    }
    if (redirectNowBtn) {
      redirectNowBtn.textContent = target ? 'Go to your page now' : 'Go to Free Trial now';
    }

    showStep(4);

    let countdown = 3;
    const cd = $('#countdown');
    if (cd) cd.textContent = countdown;

    const interval = setInterval(() => {
      countdown -= 1;
      const el = $('#countdown');
      if (el) el.textContent = countdown;
      if (countdown <= 0) {
        clearInterval(interval);
        router.navigateTo(finalTarget);
      }
    }, 1000);

    if (redirectNowBtn) {
      redirectNowBtn.onclick = () => {
        clearInterval(interval);
        router.navigateTo(finalTarget);
      };
    }
  }

  // ============================================================
  // GOOGLE CREDENTIAL HANDLER
  // ============================================================
  async function handleGoogleCredential(idToken) {
    ui.showLoading('Signing up with Google…');

    try {
      const result = await auth.loginWithGoogle(idToken);

      if (result.requiresLink) {
        ui.hideLoading();
        openGoogleLinkModal({
          email: result.email,
          linkToken: result.linkToken,                     // ← NEW: forward linkToken
          idToken,
          googleSub: result.googleSub,                     // ← kept for legacy
          deviceFingerprint: result.deviceFingerprint,
          deviceInfo: result.deviceInfo,
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
    linkToken,                                           // ← NEW
    idToken,
    googleSub,
    deviceFingerprint,
    deviceInfo,
    redirectTarget: target
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
        await auth.linkGoogleAccount({
          linkToken,                                     // ← NEW: the important one
          identifier: linkedEmail,
          password: pwd,
          idToken,
          googleSub,
          deviceFingerprint,
          deviceInfo
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

  console.log('[Signup] Initialized.');
}

export function destroy() {
  // Nothing to clean up beyond what the page-manager handles.
}