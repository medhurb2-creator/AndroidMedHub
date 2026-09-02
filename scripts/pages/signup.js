// scripts/pages/signup.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as validation from '../validation.js';
import * as security from '../security.js';
import * as utils from '../utils.js';
import * as db from '../db.js';
import * as referral from '../referral.js';

export async function init(context) {
  ui.applyTheme();

  // Deep‑link redirect
  const redirectParam = new URLSearchParams(window.location.search).get('redirect');
  let redirectTarget = null;
  if (redirectParam) {
    try {
      redirectTarget = decodeURIComponent(redirectParam);
      if (!redirectTarget.startsWith('/')) redirectTarget = null;
    } catch {
      redirectTarget = null;
    }
  }

  // If already authenticated, redirect
  if (app.checkAuth()) {
    if (redirectTarget) {
      window.location.href = redirectTarget;
    } else {
      router.navigateTo('subjects');
    }
    return;
  }

  // DOM refs – scoped to the page root
  const $ = (sel) => context.root.querySelector(sel);
  const step1 = $('#step1');
  const step2 = $('#step2');
  const step3 = $('#step3');
  const stepIndicator = $('#step-indicator');

  // Form inputs
  const fullName = $('#fullName');
  const email = $('#email');
  const phone = $('#phone');
  const password = $('#password');
  const confirmPassword = $('#confirmPassword');
  const terms = $('#terms');
  const referralCode = $('#referralCode');
  const referralStatus = $('#referral-status');
  const strengthMeter = $('#password-strength');

  // Buttons
  const themeToggle = $('#themeToggle');
  const backBtn = $('#backBtn');
  const loginLink = $('#loginLink');
  const cancelBtn = $('#cancelBtn');
  const nextStep1Btn = $('#nextStep1Btn');
  const backStep2Btn = $('#backStep2Btn');
  const nextStep2Btn = $('#nextStep2Btn');
  const redirectNowBtn = $('#redirectNowBtn');

  // Toggle password buttons
  const togglePwd1 = $('#togglePassword1');
  const togglePwd2 = $('#togglePassword2');

  // Step 2 fields
  const sq1 = $('#sq1');
  const ans1 = $('#answer1');
  const sq2 = $('#sq2');
  const ans2 = $('#answer2');
  const sq3 = $('#sq3');
  const ans3 = $('#answer3');

  // === STATE ===
  let formData = {
    name: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
    terms: false,
    referralCode: '',
    securityQuestions: [
      { question: '', answer: '' },
      { question: '', answer: '' },
      { question: '', answer: '' }
    ]
  };

  // === UPDATE LOGIN LINK ===
  if (loginLink) {
    loginLink.addEventListener('click', () => {
      let url = 'login';
      if (redirectTarget) {
        url += `?redirect=${encodeURIComponent(redirectTarget)}`;
      }
      router.navigateTo(url);
    });
  }

  // === THEME TOGGLE ===
  if (themeToggle) {
    themeToggle.addEventListener('click', () => ui.toggleTheme());
  }

  // === BACK BUTTON ===
  if (backBtn) {
    backBtn.addEventListener('click', () => router.navigateTo('welcome'));
  }

  // === CANCEL BUTTON ===
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => router.navigateTo('welcome'));
  }

  // === PASSWORD TOGGLE ===
  if (togglePwd1) {
    togglePwd1.addEventListener('click', () => ui.togglePasswordVisibility('password'));
  }
  if (togglePwd2) {
    togglePwd2.addEventListener('click', () => ui.togglePasswordVisibility('confirmPassword'));
  }

  // === PASSWORD STRENGTH ===
  if (password) {
    password.addEventListener('input', function () {
      const strength = validation.checkPasswordStrength(this.value);
      ui.updatePasswordStrength(strength);
    });
  }

  // === REFERRAL CODE ===
  async function handleReferralCode() {
    const urlRef = referral.detectReferralFromURL();
    const storedRef = referral.getStoredReferralCode();
    const refCode = urlRef || storedRef;

    if (refCode && referralCode) {
      referralCode.value = refCode;
      referralCode.readOnly = true;
      referralStatus.textContent = '⏳ Validating referral code...';
      referralStatus.style.color = 'var(--text-muted)';

      try {
        const result = await referral.validateReferralCode(refCode);
        if (result.valid) {
          referralStatus.textContent = `✅ Referred by ${result.referrerName || 'a MedVix user'}`;
          referralStatus.style.color = 'var(--success)';
          formData.referralCode = refCode;
        } else {
          referralStatus.textContent = '⚠️ Invalid referral code. You can still sign up without one.';
          referralStatus.style.color = 'var(--warning)';
          referralCode.readOnly = false;
        }
      } catch (err) {
        console.warn('[Signup] Referral validation error:', err);
        referralStatus.textContent = '⚠️ Could not validate referral code. You can still sign up.';
        referralStatus.style.color = 'var(--warning)';
      }
    }
  }

  // === INITIALIZATION ===
  // Setup live validation
  validation.setupLiveValidation('step1-form', {
    fullName: { required: true, min: 2, pattern: '^[A-Za-z ]+$' },
    email: { required: true, email: true },
    phone: { required: true, phone: 'KE' },
    password: { required: true, password: true },
    terms: { required: true }
  });

  // Handle referral
  await handleReferralCode();

  // Restore saved data if any
  const saved = sessionStorage.getItem('signupData');
  if (saved) {
    try {
      formData = JSON.parse(saved);
      fullName.value = formData.name || '';
      email.value = formData.email || '';
      phone.value = formData.phone || '';
      password.value = formData.password || '';
      confirmPassword.value = formData.confirmPassword || '';
      terms.checked = formData.terms || false;
      referralCode.value = formData.referralCode || '';
      if (formData.securityQuestions) {
        sq1.value = formData.securityQuestions[0]?.question || '';
        ans1.value = formData.securityQuestions[0]?.answer || '';
        sq2.value = formData.securityQuestions[1]?.question || '';
        ans2.value = formData.securityQuestions[1]?.answer || '';
        sq3.value = formData.securityQuestions[2]?.question || '';
        ans3.value = formData.securityQuestions[2]?.answer || '';
      }
    } catch (e) {}
  }

  // === STEP NAVIGATION ===

  // Step 1 → Step 2
  if (nextStep1Btn) {
    nextStep1Btn.addEventListener('click', () => {
      const step1Data = {
        fullName: fullName.value.trim(),
        email: email.value.trim(),
        phone: phone.value.trim(),
        password: password.value,
        confirmPassword: confirmPassword.value,
        terms: terms.checked,
        referralCode: referralCode.value.trim().toUpperCase()
      };

      const rules = {
        fullName: { required: true, min: 2 },
        email: { required: true, email: true },
        phone: { required: true, phone: 'KE' },
        password: { required: true, password: true },
        confirmPassword: { required: true, equalTo: 'password' },
        terms: { required: true }
      };

      const result = validation.validateForm(step1Data, rules);
      if (!result.valid) {
        validation.showValidationSummary(result.errors);
        return;
      }

      formData.name = step1Data.fullName;
      formData.email = step1Data.email;
      formData.phone = validation.formatKenyanPhone(step1Data.phone) || step1Data.phone;
      formData.password = step1Data.password;
      formData.confirmPassword = step1Data.confirmPassword;
      formData.terms = step1Data.terms;
      formData.referralCode = step1Data.referralCode;

      step1.style.display = 'none';
      step2.style.display = 'block';
      stepIndicator.textContent = 'Step 2 of 3: Security Questions';

      sessionStorage.setItem('signupData', JSON.stringify(formData));
    });
  }

  // Step 2 → Step 1
  if (backStep2Btn) {
    backStep2Btn.addEventListener('click', () => {
      const sq1Val = sq1.value;
      const ans1Val = ans1.value.trim();
      const sq2Val = sq2.value;
      const ans2Val = ans2.value.trim();
      const sq3Val = sq3.value;
      const ans3Val = ans3.value.trim();

      if (sq1Val && ans1Val) formData.securityQuestions[0] = { question: sq1Val, answer: ans1Val };
      if (sq2Val && ans2Val) formData.securityQuestions[1] = { question: sq2Val, answer: ans2Val };
      if (sq3Val && ans3Val) formData.securityQuestions[2] = { question: sq3Val, answer: ans3Val };

      step2.style.display = 'none';
      step1.style.display = 'block';
      stepIndicator.textContent = 'Step 1 of 3: Personal Information';

      sessionStorage.setItem('signupData', JSON.stringify(formData));
    });
  }

  // Step 2 → Step 3 (Registration)
  if (nextStep2Btn) {
    nextStep2Btn.addEventListener('click', async () => {
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

      const questions = [sq1Val, sq2Val, sq3Val];
      const unique = new Set(questions);
      if (unique.size !== 3) {
        ui.showToast('Please choose three different questions', 'error');
        return;
      }

      formData.securityQuestions = [
        { question: sq1Val, answer: ans1Val },
        { question: sq2Val, answer: ans2Val },
        { question: sq3Val, answer: ans3Val }
      ];

      ui.showLoading('Creating account...');

      try {
        const deviceFingerprint = security.generateDeviceFingerprint();
        const deviceInfo = {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          screen: `${screen.width}x${screen.height}`,
          timezone: new Date().getTimezoneOffset()
        };

        const userData = {
          name: formData.name,
          email: formData.email,
          phone: formData.phone,
          password: formData.password,
          securityQuestions: formData.securityQuestions,
          deviceFingerprint,
          deviceInfo
        };

        const user = await auth.register(userData, deviceInfo, formData.referralCode || null, false);

        if (!app.checkAuth()) {
          console.warn('Auth check failed after registration, forcing reload.');
          window.location.href = '/free-trial';
          return;
        }

        ui.hideLoading();

        step2.style.display = 'none';
        step3.style.display = 'block';
        stepIndicator.style.display = 'none';

        sessionStorage.removeItem('signupData');

        // === HANDLE DEEP LINK REDIRECT ===
        let finalTarget = redirectTarget || '/free-trial';
        const successMsg = $('#successMessage');
        if (redirectTarget) {
          successMsg.innerHTML =
            `Your account has been created. You will be redirected to your intended page in <span id="countdown">3</span> seconds.`;
          redirectNowBtn.textContent = 'Go to your page now';
        } else {
          successMsg.innerHTML =
            `Your account has been created. You will be redirected to start your free trial in <span id="countdown">3</span> seconds.`;
        }

        // Countdown and redirect
        let countdown = 3;
        const countdownEl = $('#countdown');
        const interval = setInterval(() => {
          countdown--;
          countdownEl.textContent = countdown;
          if (countdown <= 0) {
            clearInterval(interval);
            router.navigateTo(finalTarget);
          }
        }, 1000);

        // Button to redirect immediately
        redirectNowBtn.addEventListener('click', () => {
          clearInterval(interval);
          router.navigateTo(finalTarget);
        });

      } catch (error) {
        ui.hideLoading();
        ui.showToast(error.message || 'Registration failed', 'error');
      }
    });
  }
}

export function destroy() {
  // Cleanup – called when user leaves the page
}