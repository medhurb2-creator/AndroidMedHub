// scripts/pages/agent-registration.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as validation from '../validation.js';
import * as security from '../security.js';
import * as utils from '../utils.js';
import * as referral from '../referral.js';
import { convexHttpClient } from '../convex-client.js';
import { initGoogleSignIn, disableGoogleAutoSelect } from '../auth/google.js';

// ==================== STATE ====================
let currentUser = null;
let isLoggedIn = false;
const registrationData = {
  name: '',
  email: '',
  phone: '',
  password: '',
  confirm: '',
  referral: '',
  terms: false,
  privacy: false,
  agentTerms: false,
  securityQuestions: [
    { question: '', answer: '' },
    { question: '', answer: '' },
    { question: '', answer: '' }
  ]
};

// DOM helper
let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  const shimmer = $('#shimmer-overlay');

  // 1. Check auth
  currentUser = auth.getUser();
  isLoggedIn = !!currentUser;

  // 2. Show correct view
  const loggedInView = $('#logged-in-view');
  const notLoggedInView = $('#not-logged-in-view');

  if (isLoggedIn) {
    loggedInView.classList.remove('hidden');
    notLoggedInView.classList.add('hidden');
    const displayName = currentUser.name || currentUser.displayName || 'User';
    $('#agent-user-name').textContent = displayName;
    $('#agent-name-after').textContent = displayName;
  } else {
    loggedInView.classList.add('hidden');
    notLoggedInView.classList.remove('hidden');
  }

  // 3. Hide shimmer
  if (shimmer) {
    shimmer.classList.add('hidden');
    setTimeout(() => {
      shimmer.style.display = 'none';
    }, 700);
  }

  // 4. Attach event listeners
  attachEventListeners(context);

  console.log('[AgentRegistration] Initialized');
}

// ==================== EVENT LISTENERS ====================
function attachEventListeners(context) {
  // Theme toggle
  const themeToggle = $('#theme-toggle');
  if (themeToggle) themeToggle.addEventListener('click', ui.toggleTheme);

  // Home button
  const homeBtn = $('#home-btn');
  if (homeBtn) {
    homeBtn.addEventListener('click', () => {
      if (auth.getUser()) router.navigateTo('subjects');
      else router.navigateTo('welcome');
    });
  }

  // Agent Terms links
  ['#agent-terms-link', '#reg-agent-terms-link', '#google-agent-terms-link'].forEach(sel => {
    const link = $(sel);
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        router.navigateTo('agent-terms');
      });
    }
  });

  // Terms checkbox → enable upgrade button
  const termsCheck = $('#agent-terms-check');
  const upgradeBtn = $('#upgrade-btn');
  if (termsCheck && upgradeBtn) {
    termsCheck.addEventListener('change', () => {
      upgradeBtn.disabled = !termsCheck.checked;
    });
  }
  if (upgradeBtn) upgradeBtn.addEventListener('click', upgradeToAgent);

  // Start earning button
  const startEarningBtn = $('#start-earning-btn');
  if (startEarningBtn) {
    startEarningBtn.addEventListener('click', () => router.navigateTo('referral'));
  }

  // Register agent button (not logged in)
  const registerAgentBtn = $('#register-agent-btn');
  if (registerAgentBtn) {
    registerAgentBtn.addEventListener('click', () => {
      showModal();
      showChoice();
      resetRegistrationForm();
    });
  }

  // Modal events
  const modalOverlay = $('#auth-modal-overlay');
  const closeModalBtn = $('#close-modal-btn');
  if (closeModalBtn) closeModalBtn.addEventListener('click', hideModal);
  if (modalOverlay) {
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) hideModal();
    });
  }

  // Modal choice buttons
  const choiceYes = $('#choice-yes');
  const choiceNo = $('#choice-no');
  if (choiceYes) {
    choiceYes.addEventListener('click', () => {
      showLoginSheet();
      setTimeout(() => $('#modal-login-email').focus(), 100);
    });
  }
  if (choiceNo) {
    choiceNo.addEventListener('click', () => {
      showRegistrationFlow();
      setTimeout(() => $('#reg-name').focus(), 100);
    });
  }

  // Login sheet navigation
  const modalGoRegister = $('#modal-go-register');
  const modalGoChoice = $('#modal-go-choice');
  if (modalGoRegister) modalGoRegister.addEventListener('click', showRegistrationFlow);
  if (modalGoChoice) modalGoChoice.addEventListener('click', showChoice);

  // Login form submission
  const loginForm = $('#modal-login-form');
  if (loginForm) loginForm.addEventListener('submit', handleLogin);

  // Forgot password
  const modalForgotPw = $('#modal-forgot-pw');
  if (modalForgotPw) {
    modalForgotPw.addEventListener('click', () => {
      hideModal();
      router.navigateTo('forgot-password');
    });
  }

  // Registration step navigation
  const regGoStep2 = $('#reg-go-step2');
  if (regGoStep2) regGoStep2.addEventListener('click', goToStep2);

  const regBackStep1 = $('#reg-back-step1');
  if (regBackStep1) {
    regBackStep1.addEventListener('click', () => {
      $('#reg-step2').classList.remove('active');
      $('#reg-step1').classList.add('active');
      $('#reg-step-indicator').textContent = 'Step 1 of 2: Personal Info';
      clearRegStatus();
    });
  }

  const regBackChoice = $('#reg-back-choice');
  if (regBackChoice) regBackChoice.addEventListener('click', showChoice);

  const regSubmit = $('#reg-submit');
  if (regSubmit) regSubmit.addEventListener('click', handleRegistration);

  const regStartJourney = $('#reg-start-journey');
  if (regStartJourney) {
    regStartJourney.addEventListener('click', () => {
      hideModal();
      router.navigateTo('referral');
    });
  }

  // Referral code validation live
  const regReferral = $('#reg-referral');
  if (regReferral) {
    regReferral.addEventListener('input', () => {
      const code = regReferral.value.trim().toUpperCase();
      if (code.length >= 4) validateReferralCode(code);
      else $('#reg-referral-status').textContent = '';
    });
  }

  // Password strength meter
  const regPassword = $('#reg-password');
  if (regPassword) {
    regPassword.addEventListener('input', () => {
      const val = regPassword.value;
      const strengthEl = $('#reg-pw-strength');
      if (val.length === 0) { strengthEl.textContent = ''; return; }
      const strength = validation.checkPasswordStrength(val);
      let label = 'Weak';
      let color = '#ef4444';
      if (strength.score >= 4) { label = 'Strong'; color = '#10b981'; }
      else if (strength.score >= 2) { label = 'Medium'; color = '#f59e0b'; }
      strengthEl.textContent = `Password strength: ${label}`;
      strengthEl.style.color = color;
    });
  }

  // ============================================================
  // GOOGLE SETUP
  // ============================================================
  setupGoogleChoice();
  setupGoogleTermsGuard();

  // Escape key closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const overlay = $('#auth-modal-overlay');
      if (overlay && overlay.classList.contains('active')) hideModal();
    }
  });
}

// ============================================================
// GOOGLE SIGN-IN / SIGN-UP
// ============================================================

async function setupGoogleChoice() {
  const container = $('#google-agent-container-choice');
  if (!container) return;
  await initGoogleSignIn({
    container,
    text: 'continue_with',
    onCredential: async (response) => {
      // Terms gate (in case the click-guard is bypassed somehow)
      const termsCheck = $('#google-agent-terms-check');
      if (termsCheck && !termsCheck.checked) {
        ui.showToast('Please accept the Agent Terms to continue.', 'warning');
        return;
      }
      captureReferralForGoogle();
      await handleGoogleCredential(response.credential);
    },
  });
}

async function setupGoogleLogin() {
  const container = $('#google-agent-container-login');
  if (!container) return;
  await initGoogleSignIn({
    container,
    text: 'signin_with',
    onCredential: async (response) => {
      captureReferralForGoogle();
      await handleGoogleCredential(response.credential);
    },
  });
}

function setupGoogleTermsGuard() {
  const termsCheck = $('#google-agent-terms-check');
  const guard = $('#google-agent-click-guard');
  const container = $('#google-agent-container-choice');
  if (!termsCheck || !guard) return;

  const update = () => {
    guard.style.pointerEvents = termsCheck.checked ? 'none' : 'auto';
    if (container) container.style.opacity = termsCheck.checked ? '1' : '0.6';
  };
  termsCheck.addEventListener('change', update);
  update();

  guard.addEventListener('click', () => {
    ui.showToast('Please accept the Agent Terms to continue with Google.', 'warning');
    termsCheck.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function captureReferralForGoogle() {
  // Persist any referral so the backend can pick it up during Google signup
  const code =
    ($('#reg-referral')?.value || '').trim().toUpperCase() ||
    referral.detectReferralFromURL?.() ||
    referral.getStoredReferralCode?.();
  if (code) {
    try { utils.setLocalStorage('referral_code', code); } catch (_) {}
  }
}

async function handleGoogleCredential(idToken) {
  ui.showLoading('Signing in with Google…');
  try {
    const result = await auth.loginWithGoogle(idToken);

    // Existing password account with the same email → linking flow
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

    // Success — check if user is already an agent
    const user = result.user || auth.getUser();

    if (user && user.isAgent === true) {
      ui.hideLoading();
      ui.showToast('Welcome back, Agent!', 'success');
      finishAgentFlow(user);
      return;
    }

    // Not an agent yet — upgrade
    ui.showLoading('Upgrading to agent…');
    await upgradeAuthenticatedUserToAgent();
    ui.hideLoading();
    finishAgentFlow(user);

  } catch (err) {
    ui.hideLoading();
    ui.showToast(err.message || 'Google sign-in failed', 'error');
  }
}

async function upgradeAuthenticatedUserToAgent() {
  try {
    const token = auth.getToken();
    const result = await convexHttpClient.action('users/mutations:upgradeToAgent', { token });
    if (!result || !result.success) {
      throw new Error(result?.message || 'Upgrade failed');
    }
    // Reflect locally
    const user = auth.getUser();
    if (user) {
      user.isAgent = true;
      await auth.setUser(user);
    }
    return result.data || {};
  } catch (err) {
    // Non-fatal — user is authenticated, but not an agent
    console.warn('[Agent] Upgrade after Google failed:', err);
    ui.showToast(err.message || 'Could not upgrade to agent', 'warning');
    return null;
  }
}

function finishAgentFlow(user) {
  hideModal();

  const loggedInView = $('#logged-in-view');
  const notLoggedInView = $('#not-logged-in-view');
  loggedInView.classList.remove('hidden');
  notLoggedInView.classList.add('hidden');

  const displayName = user?.name || user?.displayName || 'Agent';
  $('#agent-user-name').textContent = displayName;
  $('#agent-name-after').textContent = displayName;

  $('#upgrade-section')?.classList.add('hidden');
  $('#after-upgrade-view')?.classList.remove('hidden');

  ui.showToast('🎉 You are now a MedVix Agent!', 'success');
}

// ============================================================
// ACCOUNT LINKING MODAL
// ============================================================
function openGoogleLinkModal({
  email,
  linkToken,                                         // ← NEW
  idToken,
  googleSub,
  deviceFingerprint,
  deviceInfo
}) {
  const modal = $('#google-link-modal');
  const emailEl = $('#google-link-email');
  const identifierInput = $('#google-link-identifier');
  const pwdInput = $('#google-link-password');
  const submitBtn = $('#google-link-submit');
  const cancelBtn = $('#google-link-cancel');
  const closeBtn = $('#google-link-close');

  emailEl.textContent = email;
  identifierInput.value = email;
  pwdInput.value = '';
  modal.style.display = 'flex';
  setTimeout(() => pwdInput.focus(), 100);

  const close = () => {
    modal.style.display = 'none';
    disableGoogleAutoSelect?.();
  };

  const submit = async () => {
    const identifier = identifierInput.value.trim() || email;
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
        linkToken,                                   // ← NEW: the important one
        identifier,
        password: pwd,
        idToken,
        googleSub,
        deviceFingerprint,
        deviceInfo
      });

      modal.style.display = 'none';
      ui.showToast('Google connected to your account', 'success');

      // Now upgrade to agent (if not already)
      const user = auth.getUser();
      if (user && user.isAgent !== true) {
        ui.showLoading('Upgrading to agent…');
        await upgradeAuthenticatedUserToAgent();
        ui.hideLoading();
      }
      finishAgentFlow(user);

    } catch (err) {
      ui.showToast(err.message || 'Could not connect Google', 'error');
      ui.showFormError('google-link-password', err.message || 'Invalid credentials');
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

// ==================== MODAL HELPERS ====================
function showModal() {
  const overlay = $('#auth-modal-overlay');
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function hideModal() {
  const overlay = $('#auth-modal-overlay');
  overlay.classList.remove('active');
  document.body.style.overflow = '';

  $('#modal-choice').style.display = 'block';
  $('#login-sheet').classList.remove('active');
  $('#registration-flow').classList.remove('active');
  clearLoginStatus();
  clearRegStatus();

  $('#reg-step1').classList.add('active');
  $('#reg-step2').classList.remove('active');
  $('#reg-step3').classList.remove('active');
  $('#reg-step-indicator').textContent = 'Step 1 of 2: Personal Info';
}

function showChoice() {
  $('#modal-choice').style.display = 'block';
  $('#login-sheet').classList.remove('active');
  $('#registration-flow').classList.remove('active');
  clearLoginStatus();
  clearRegStatus();
  // Re-render Google (container was hidden, GIS needs a fresh render)
  setupGoogleChoice();
}

function showLoginSheet() {
  $('#modal-choice').style.display = 'none';
  $('#login-sheet').classList.add('active');
  $('#registration-flow').classList.remove('active');
  clearLoginStatus();
  // Render Google AFTER the sheet becomes visible
  setupGoogleLogin();
}

function showRegistrationFlow() {
  $('#modal-choice').style.display = 'none';
  $('#login-sheet').classList.remove('active');
  $('#registration-flow').classList.add('active');
  $('#reg-step1').classList.add('active');
  $('#reg-step2').classList.remove('active');
  $('#reg-step3').classList.remove('active');
  $('#reg-step-indicator').textContent = 'Step 1 of 2: Personal Info';
  clearRegStatus();
}

function resetRegistrationForm() {
  $('#reg-name').value = '';
  $('#reg-email').value = '';
  $('#reg-phone').value = '';
  $('#reg-password').value = '';
  $('#reg-confirm').value = '';
  $('#reg-referral').value = '';
  $('#reg-terms-doc').checked = false;
  $('#reg-privacy-doc').checked = false;
  $('#reg-agent-terms-doc').checked = false;

  $('#reg-step1').classList.add('active');
  $('#reg-step2').classList.remove('active');
  $('#reg-step3').classList.remove('active');
  $('#reg-step-indicator').textContent = 'Step 1 of 2: Personal Info';

  clearRegStatus();
  $('#reg-pw-strength').textContent = '';
  $('#reg-referral-status').textContent = '';

  const urlRef = referral.detectReferralFromURL?.();
  const storedRef = referral.getStoredReferralCode?.();
  const refCode = urlRef || storedRef;

  if (refCode) {
    $('#reg-referral').value = refCode;
    $('#reg-referral').readOnly = true;
    $('#reg-referral-status').textContent = '⏳ Validating...';
    validateReferralCode(refCode);
  }
}

// ==================== LOGIN HANDLER (Email/Phone) ====================
async function handleLogin(e) {
  e.preventDefault();

  const email = $('#modal-login-email').value.trim();
  const password = $('#modal-login-password').value;
  const remember = $('#modal-remember').checked;

  if (!email) { showLoginStatus('Please enter your email or phone.', 'error'); return; }
  if (!password || password.length < 8) {
    showLoginStatus('Password must be at least 8 characters.', 'error'); return;
  }

  ui.showLoading('Logging in...');
  try {
    const deviceFingerprint = security.generateDeviceFingerprint();
    const deviceInfo = {
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
      timezone: new Date().getTimezoneOffset()
    };

    const user = await auth.login(email, password, { deviceFingerprint, deviceInfo });

    if (remember) utils.setLocalStorage('rememberedEmail', email);
    else utils.removeLocalStorage('rememberedEmail');

    // Upgrade to agent if needed
    if (user && user.isAgent !== true) {
      ui.showLoading('Upgrading to agent...');
      await upgradeAuthenticatedUserToAgent();
    }
    ui.hideLoading();
    finishAgentFlow(user);

  } catch (error) {
    ui.hideLoading();
    showLoginStatus(error.message || 'Login failed', 'error');
    if (error.code === 'ACCOUNT_LOCKED') {
      router.navigateTo('locked?reason=time_manipulation');
    }
  }
}

function showLoginStatus(msg, type = 'info') {
  const el = $('#modal-login-status');
  el.innerHTML = `<div class="alert alert-${type}" style="font-size:0.85rem;">${msg}</div>`;
}
function clearLoginStatus() { $('#modal-login-status').innerHTML = ''; }

// ==================== REGISTRATION HANDLER ====================
function goToStep2() {
  const name = $('#reg-name').value.trim();
  const email = $('#reg-email').value.trim();
  const phone = $('#reg-phone').value.trim();
  const password = $('#reg-password').value;
  const confirm = $('#reg-confirm').value;
  const terms = $('#reg-terms-doc').checked;
  const privacy = $('#reg-privacy-doc').checked;
  const agentTerms = $('#reg-agent-terms-doc').checked;

  if (!name || name.length < 2) { showRegStatus('Please enter your full name (min 2 characters).', 'error'); return; }
  if (!email || !validation.validateEmail(email)) { showRegStatus('Please enter a valid email address.', 'error'); return; }
  if (!phone || !validation.validatePhone(phone)) { showRegStatus('Please enter a valid Kenyan phone number.', 'error'); return; }
  if (!password || password.length < 8) { showRegStatus('Password must be at least 8 characters.', 'error'); return; }
  if (password !== confirm) { showRegStatus('Passwords do not match.', 'error'); return; }
  if (!terms || !privacy || !agentTerms) {
    showRegStatus('Please accept all three documents: Terms, Privacy, and Agent Terms.', 'error'); return;
  }

  const strength = validation.checkPasswordStrength(password);
  if (strength.score < 2) {
    showRegStatus('Password is too weak. Use a mix of uppercase, lowercase, numbers, and special characters.', 'error');
    return;
  }

  registrationData.name = name;
  registrationData.email = email;
  registrationData.phone = validation.formatKenyanPhone(phone) || phone;
  registrationData.password = password;
  registrationData.confirm = confirm;
  registrationData.referral = $('#reg-referral').value.trim().toUpperCase();
  registrationData.terms = terms;
  registrationData.privacy = privacy;
  registrationData.agentTerms = agentTerms;

  $('#reg-step1').classList.remove('active');
  $('#reg-step2').classList.add('active');
  $('#reg-step-indicator').textContent = 'Step 2 of 2: Security Questions';
  clearRegStatus();
}

async function handleRegistration() {
  const q1 = $('#reg-sq1').value;
  const a1 = $('#reg-ans1').value.trim();
  const q2 = $('#reg-sq2').value;
  const a2 = $('#reg-ans2').value.trim();
  const q3 = $('#reg-sq3').value;
  const a3 = $('#reg-ans3').value.trim();

  if (!q1 || !a1 || !q2 || !a2 || !q3 || !a3) {
    showRegStatus('Please fill in all security questions and answers.', 'error');
    return;
  }
  if (new Set([q1, q2, q3]).size !== 3) {
    showRegStatus('Please choose three different questions.', 'error');
    return;
  }

  registrationData.securityQuestions = [
    { question: q1, answer: a1 },
    { question: q2, answer: a2 },
    { question: q3, answer: a3 }
  ];

  ui.showLoading('Creating agent account...');
  try {
    const deviceFingerprint = security.generateDeviceFingerprint();
    const deviceInfo = {
      platform: navigator.platform,
      userAgent: navigator.userAgent,
      screen: `${screen.width}x${screen.height}`,
      timezone: new Date().getTimezoneOffset()
    };

    await auth.register({
      name: registrationData.name,
      email: registrationData.email,
      phone: registrationData.phone,
      password: registrationData.password,
      securityQuestions: registrationData.securityQuestions,
      deviceFingerprint,
      deviceInfo,
      referralCode: registrationData.referral || undefined,
      isAgent: true,
      agentVerified: false
    });

    ui.hideLoading();

    if (!auth.checkAuth()) {
      window.location.href = '/referral';
      return;
    }

    $('#reg-step2').classList.remove('active');
    $('#reg-step3').classList.add('active');
    $('#reg-step-indicator').textContent = '✅ Account Created!';
    $('#reg-success-name').textContent = registrationData.name;
    clearRegStatus();

    ui.showToast('🎉 Agent registration successful!', 'success');

  } catch (error) {
    ui.hideLoading();
    showRegStatus(error.message || 'Registration failed', 'error');
  }
}

function showRegStatus(msg, type = 'info') {
  const el = $('#reg-status');
  el.innerHTML = `<div class="alert alert-${type}" style="font-size:0.85rem;">${msg}</div>`;
}
function clearRegStatus() { $('#reg-status').innerHTML = ''; }

// ==================== REFERRAL VALIDATION ====================
async function validateReferralCode(code) {
  if (!code) return;
  const statusEl = $('#reg-referral-status');
  try {
    const result = await referral.validateReferralCode(code);
    if (result.valid) {
      statusEl.textContent = `✅ Referred by ${result.referrerName || 'a MedVix user'}`;
      statusEl.style.color = 'var(--success)';
    } else {
      statusEl.textContent = '⚠️ Invalid referral code. You can still sign up without one.';
      statusEl.style.color = 'var(--warning)';
      $('#reg-referral').readOnly = false;
    }
  } catch (err) {
    console.warn('[Agent] Referral validation error:', err);
    statusEl.textContent = '⚠️ Could not validate. You can still sign up.';
    statusEl.style.color = 'var(--warning)';
    $('#reg-referral').readOnly = false;
  }
}

// ==================== UPGRADE TO AGENT (logged-in user path) ====================
async function upgradeToAgent() {
  const termsCheck = $('#agent-terms-check');
  if (!termsCheck.checked) {
    showStatus('Please accept the Agent Terms & Conditions first.', 'warning');
    return;
  }

  const confirmed = await ui.showConfirmationDialog(
    'Become an Agent',
    'Are you sure you want to become a MedVix Agent? Your account will be reviewed by admin within 24 hours.',
    'warning'
  );
  if (!confirmed) return;

  ui.showLoading('Upgrading to agent...');
  try {
    const token = auth.getToken();
    const result = await convexHttpClient.action('users/mutations:upgradeToAgent', { token });
    ui.hideLoading();

    if (result.success) {
      ui.showToast(result.data?.message || 'Upgrade successful!', 'success');
      $('#upgrade-section').classList.add('hidden');
      $('#after-upgrade-view').classList.remove('hidden');
      const displayName = currentUser?.name || currentUser?.displayName || 'User';
      $('#agent-name-after').textContent = displayName;
      clearStatus();
    } else {
      ui.showToast(result.message || 'Upgrade failed', 'error');
    }
  } catch (err) {
    ui.hideLoading();
    ui.showToast(err.message || 'Upgrade failed', 'error');
    console.error('[Agent] Upgrade error:', err);
  }
}

function showStatus(msg, type = 'info') {
  const el = $('#status-message');
  el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`;
}
function clearStatus() { $('#status-message').innerHTML = ''; }

// ==================== DESTROY ====================
export function destroy() {
  // Nothing extra — the page-manager removes the DOM.
}