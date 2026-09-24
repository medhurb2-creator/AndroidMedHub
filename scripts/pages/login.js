// scripts/pages/login.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as validation from '../validation.js';
import * as security from '../security.js';
import * as utils from '../utils.js';
import { initGoogleSignIn, disableGoogleAutoSelect } from '../auth/google.js';

export async function init(context) {
  // Apply theme
  ui.applyTheme();

  // Deep-link redirect
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

  const loginForm = $('#login-form');
  const emailInput = $('#email');
  const passwordInput = $('#password');
  const toggleBtn = $('#togglePassword');
  const rememberCheck = $('#remember');
  const forgotBtn = $('#forgotBtn');
  const signupBtn = $('#signupBtn');
  const backBtn = $('#backBtn');
  const themeToggle = $('#themeToggle');
  const googleContainer = $('#google-login-container');

  // ---- Live validation ----
  validation.setupLiveValidation('login-form', {
    email: { required: true, email: true },
    password: { required: true, min: 8 }
  });

  // ---- Remembered email ----
  const rememberedEmail = utils.getLocalStorage('rememberedEmail');
  if (rememberedEmail && emailInput) {
    emailInput.value = rememberedEmail;
    if (rememberCheck) rememberCheck.checked = true;
  }

  // ---- Theme toggle ----
  if (themeToggle) {
    themeToggle.addEventListener('click', () => ui.toggleTheme());
  }

  // ---- Toggle password visibility ----
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      ui.togglePasswordVisibility('password');
    });
  }

  // ---- Forgot password ----
  if (forgotBtn) {
    forgotBtn.addEventListener('click', () => {
      let url = 'forgot-password';
      if (redirectTarget) url += `?redirect=${encodeURIComponent(redirectTarget)}`;
      router.navigateTo(url);
    });
  }

  // ---- Signup ----
  if (signupBtn) {
    signupBtn.addEventListener('click', () => {
      let url = 'signup';
      if (redirectTarget) url += `?redirect=${encodeURIComponent(redirectTarget)}`;
      router.navigateTo(url);
    });
  }

  // ---- Back ----
  if (backBtn) {
    backBtn.addEventListener('click', () => router.navigateTo('welcome'));
  }

  // ============================================================
  // GOOGLE SIGN-IN
  // ============================================================
  if (googleContainer) {
    await initGoogleSignIn({
      container: googleContainer,
      text: 'continue_with',           // renders "Continue with Google"
      onCredential: async (response) => {
        await handleGoogleCredential(response.credential);
      },
    });
  }

  // ============================================================
  // PASSWORD LOGIN
  // ============================================================
  if (loginForm) {
    loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();

      const email = emailInput.value.trim();
      const password = passwordInput.value;
      const remember = rememberCheck ? rememberCheck.checked : false;

      // Validate
      if (!validation.validateEmail(email) && !validation.validatePhone(email)) {
        ui.showToast('Enter a valid email or Kenyan phone', 'error');
        return;
      }
      if (!validation.validatePassword(password)) {
        ui.showToast('Password must be 8+ chars with upper, lower, number', 'error');
        return;
      }

      ui.showLoading();
      try {
        const deviceFingerprint = security.generateDeviceFingerprint();
        const deviceInfo = {
          platform: navigator.platform,
          userAgent: navigator.userAgent,
          screen: `${screen.width}x${screen.height}`,
          timezone: new Date().getTimezoneOffset()
        };

        await auth.login(email, password, { deviceFingerprint, deviceInfo });

        if (remember) utils.setLocalStorage('rememberedEmail', email);
        else utils.removeLocalStorage('rememberedEmail');

        ui.hideLoading();
        ui.showToast('Login successful!', 'success');

        if (redirectTarget) {
          window.location.href = redirectTarget;
        } else {
          router.navigateTo('subjects');
        }
      } catch (error) {
        ui.hideLoading();
        ui.showToast(error.message || 'Login failed', 'error');
        if (error.code === 'ACCOUNT_LOCKED') {
          router.navigateTo('locked?reason=time_manipulation');
        }
      }
    });
  }

  // ============================================================
  // GOOGLE CREDENTIAL HANDLER
  // ============================================================
  async function handleGoogleCredential(idToken) {
    ui.showLoading('Signing in with Google…');

    try {
      const result = await auth.loginWithGoogle(idToken);

      // Existing account with this email → link flow
      if (result.requiresLink) {
        ui.hideLoading();
        openGoogleLinkModal({
          email: result.email,
          linkToken: result.linkToken,                     // ← NEW: forward linkToken
          idToken,
          googleSub: result.googleSub,                     // ← kept for legacy
          deviceFingerprint: result.deviceFingerprint,
          deviceInfo: result.deviceInfo
        });
        return;
      }

      // Success (new or existing Google identity)
      ui.hideLoading();
      ui.showToast(
        result.isNewUser ? 'Account created — welcome!' : 'Signed in with Google',
        'success'
      );

      if (redirectTarget) {
        window.location.href = redirectTarget;
      } else {
        router.navigateTo('subjects');
      }

    } catch (err) {
      ui.hideLoading();
      ui.showToast(err.message || 'Google sign-in failed', 'error');
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
    deviceInfo
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

        if (redirectTarget) {
          window.location.href = redirectTarget;
        } else {
          router.navigateTo('subjects');
        }

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

  console.log('[Login] Initialized.');
}

export function destroy() {
  // Nothing to clean up beyond what the page-manager handles.
}