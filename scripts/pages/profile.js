// scripts/pages/profile.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as utils from '../utils.js';
import * as validation from '../validation.js';
import * as security from '../security.js';
import * as db from '../db.js';
import * as analytics from '../analytics.js';
import * as subscription from '../subscription.js';

let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // Check auth
  if (!auth.checkAuth()) {
    ui.showToast('Please log in first', 'warning');
    router.navigateTo('login');
    hideShimmer();
    return;
  }

  const user = auth.getUser();
  if (!user) {
    ui.showToast('User data not found', 'error');
    router.navigateTo('login');
    hideShimmer();
    return;
  }

  // Get cached subscription and compute actual active status
  let sub = null;
  let isActive = false;
  try {
    sub = await subscription.getSubscription();
    isActive = await subscription.hasActiveSubscription();
  } catch (err) {
    console.warn('[Profile] Failed to get subscription:', err);
    sub = null;
    isActive = false;
  }

  // Update header status
  const statusEl = $('#header-status');
  if (isActive && sub) {
    const remaining = await subscription.formatRemainingTime();
    statusEl.textContent = `${sub.plan} · expires ${utils.formatDate(sub.expiryDate)} (${remaining} left)`;
  } else {
    statusEl.textContent = 'No active plan';
  }

  // Populate profile form
  $('#full-name').value = user.name || '';
  $('#email').value = user.email || '';
  $('#phone').value = user.phone || '';
  $('#institution').value = user.institution || '';
  $('#year-of-study').value = user.yearOfStudy || '';

  // Subscription info
  const subEl = $('#subscription-info');
  if (isActive && sub) {
    const remaining = await subscription.formatRemainingTime();
    subEl.innerHTML = `
      <p><strong>Plan:</strong> ${sub.plan}</p>
      <p><strong>Expires:</strong> ${utils.formatDate(sub.expiryDate)} (${remaining} left)</p>
      <p><strong>Auto-renew:</strong> ${sub.autoRenew ? 'On' : 'Off'}</p>
      <button id="changePlanBtn" class="btn-small">Change Plan</button>
    `;
    const changePlanBtn = $('#changePlanBtn');
    if (changePlanBtn) {
      changePlanBtn.addEventListener('click', () => router.navigateTo('subscription'));
    }
  } else {
    subEl.innerHTML = '<p>No active subscription. <a href="#" id="subscribeLink">Subscribe now</a></p>';
    const subscribeLink = $('#subscribeLink');
    if (subscribeLink) {
      subscribeLink.addEventListener('click', (e) => {
        e.preventDefault();
        router.navigateTo('subscription');
      });
    }
  }

  // Load devices
  await loadDevices();

  // Load preferences
  loadPreferences(user.preferences);

  // Load statistics
  await loadStatistics();

  // Set device fingerprint display
  const fpEl = $('#device-fingerprint');
  if (fpEl) {
    fpEl.textContent = security.getDeviceFingerprint() || '—';
  }

  // Initialize institution dropdown
  initInstitutionDropdown();

  // Attach event listeners
  attachEventListeners(context);

  // Hide shimmer
  hideShimmer();

  console.log('[Profile] Initialized');
}

// ==================== SHIMMER ====================
function hideShimmer() {
  const loader = $('#shimmer-loader');
  if (loader) {
    loader.classList.add('hidden');
    setTimeout(() => {
      loader.classList.add('removed');
      if (loader.parentNode) loader.parentNode.removeChild(loader);
    }, 400);
  }
}

// ==================== INSTITUTION DROPDOWN ====================
function initInstitutionDropdown() {
  const input = $('#institution');
  const dropdown = $('#institution-dropdown');

  const institutions = [
    'University of Nairobi (UoN)',
    'Moi University',
    'Kenyatta University (KU)',
    'Egerton University',
    'Jomo Kenyatta University of Agriculture and Technology (JKUAT)',
    'Maseno University',
    'Masinde Muliro University of Science and Technology (MMUST)',
    'Technical University of Kenya (TUK)',
    'Dedan Kimathi University of Technology (DeKUT)',
    'Kisii University',
    'Meru University of Science and Technology (MUST)',
    'South Eastern Kenya University (SEKU)',
    'University of Eldoret (UoE)',
    'Chuka University',
    'Karatina University',
    'Kaimosi Friends University',
    'Kirinyaga University (KyU)',
    'Maasai Mara University',
    'Rongo University',
    'Garissa University',
    'Taita Taveta University',
    'Turkana University College',
    'Mount Kenya University (MKU)',
    'Kenyatta University Teaching, Referral & Research Hospital (KUTRRH)',
    'Strathmore University',
    'United States International University Africa (USIU-Africa)',
    'Africa Nazarene University (ANU)',
    'Daystar University',
    'Catholic University of Eastern Africa (CUEA)',
    'Adventist University of Africa (AUA)',
    'Pan Africa Christian University (PACU)',
    "St. Paul's University",
    'University of Eastern Africa, Baraton (UEAB)',
    'Great Lakes University of Kisumu (GLUK)',
    'Kenya Methodist University (KeMU)',
    'Kabarak University',
    'KCA University',
    'Pioneer International University (PIU)',
    'Management University of Africa (MUA)',
    'Hekima University College',
    'Tangaza University College',
    'Nazarene Theological College',
    'Scott Theological College',
    'Kenyatta National Hospital (KNH)',
    'Moi Teaching and Referral Hospital (MTRH)',
    'Coast General Teaching and Referral Hospital',
    'Kisumu County Hospital',
    'Nakuru Level 5 Hospital',
    'Thika Level 5 Hospital',
    'Kakamega County Referral Hospital',
    'Embu Level 5 Hospital',
    'Meru Level 5 Hospital',
    'Garissa County Referral Hospital',
    'Homa Bay County Teaching and Referral Hospital',
    'Machakos County Referral Hospital',
    'Kisii Level 5 Hospital',
    'Mama Lucy Kibaki Hospital',
    'Pumwani Maternity Hospital',
    'Kenya Medical Training College (KMTC)',
    'Nairobi Institute of Health Sciences (NIHS)',
    'Kampala International University (KIU) - Kenya Campus',
    'Jomo Kenyatta University of Agriculture and Technology (JKUAT) - Health Sciences',
    'AMREF International University (AMIU)',
    'African Medical and Research Foundation (AMREF)',
    'Kenyatta University School of Medicine',
    'University of Nairobi School of Medicine',
    'Moi University School of Medicine',
    'Kenyatta University Teaching, Referral & Research Hospital',
    'International Centre of Insect Physiology and Ecology (ICIPE)',
    'Kenya Institute of Health Research (KIHR)',
    'Kenya Medical Research Institute (KEMRI)',
    'National AIDS Control Council (NACC)',
    'National Tuberculosis, Leprosy and Lung Disease Program (NTLD)'
  ];

  const uniqueInstitutions = [...new Set(institutions)].sort();
  let selectedInstitution = '';

  function renderDropdown(filter = '') {
    const filtered = filter ?
      uniqueInstitutions.filter(inst => inst.toLowerCase().includes(filter.toLowerCase())) :
      uniqueInstitutions;

    dropdown.innerHTML = '';
    if (filtered.length === 0) {
      dropdown.innerHTML = '<div class="no-result">No institutions found</div>';
    } else {
      filtered.forEach(inst => {
        const div = document.createElement('div');
        div.className = 'item';
        div.textContent = inst;
        if (inst === selectedInstitution) {
          div.classList.add('selected');
        }
        div.addEventListener('click', () => {
          selectedInstitution = inst;
          input.value = inst;
          dropdown.classList.remove('show');
          dropdown.querySelectorAll('.item').forEach(el => el.classList.remove('selected'));
          div.classList.add('selected');
        });
        dropdown.appendChild(div);
      });
    }
    dropdown.classList.add('show');
  }

  input.addEventListener('focus', () => {
    renderDropdown(input.value);
  });

  input.addEventListener('input', () => {
    renderDropdown(input.value);
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('show');
    }
  });

  if (input.value) {
    selectedInstitution = input.value;
  }
}

// ==================== EVENT LISTENERS ====================
function attachEventListeners(context) {
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  const backSubjectsBtn = $('#backSubjectsBtn');
  if (backSubjectsBtn) {
    backSubjectsBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  const performanceBtn = $('#performanceBtn');
  if (performanceBtn) {
    performanceBtn.addEventListener('click', () => router.navigateTo('performance'));
  }

  const profileForm = $('#profileForm');
  if (profileForm) {
    profileForm.addEventListener('submit', saveProfile);
  }

  const changePasswordBtn = $('#changePasswordBtn');
  if (changePasswordBtn) {
    changePasswordBtn.addEventListener('click', changePassword);
  }

  const exportDataBtn = $('#exportDataBtn');
  if (exportDataBtn) {
    exportDataBtn.addEventListener('click', exportData);
  }

  const deleteAccountBtn = $('#deleteAccountBtn');
  if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener('click', deleteAccount);
  }

  const logoutAllDevicesBtn = $('#logoutAllDevicesBtn');
  if (logoutAllDevicesBtn) {
    logoutAllDevicesBtn.addEventListener('click', logoutAllDevices);
  }

  const savePreferencesBtn = $('#savePreferencesBtn');
  if (savePreferencesBtn) {
    savePreferencesBtn.addEventListener('click', savePreferences);
  }

  const viewAnalyticsBtn = $('#viewAnalyticsBtn');
  if (viewAnalyticsBtn) {
    viewAnalyticsBtn.addEventListener('click', () => router.navigateTo('performance'));
  }

  const backToSubjectsFooterBtn = $('#backToSubjectsFooterBtn');
  if (backToSubjectsFooterBtn) {
    backToSubjectsFooterBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  const tabs = context.root.querySelectorAll('.tab-button');
  tabs.forEach(btn => {
    btn.addEventListener('click', function() {
      const tabId = this.dataset.tab;
      context.root.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      tabs.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      const tab = document.getElementById(tabId);
      if (tab) tab.classList.add('active');
    });
  });
}

// ==================== PROFILE UPDATE ====================
async function saveProfile(event) {
  event.preventDefault();

  const updates = {
    name: $('#full-name').value.trim(),
    email: $('#email').value.trim(),
    phone: $('#phone').value.trim(),
    institution: $('#institution').value.trim(),
    yearOfStudy: parseInt($('#year-of-study').value) || null
  };

  const validationResult = validation.validateForm(updates, {
    name: { required: true, min: 2 },
    email: { required: true, email: true },
    phone: { required: true, phone: 'KE' }
  });

  if (!validationResult.valid) {
    ui.showValidationSummary(validationResult.errors);
    return;
  }

  ui.showLoading('Updating profile...');
  try {
    await auth.updateProfile(updates);
    ui.hideLoading();
    ui.showToast('Profile updated successfully', 'success');
  } catch (error) {
    ui.hideLoading();
    ui.showToast(error.message || 'Update failed', 'error');
  }
}

// ==================== PASSWORD CHANGE ====================
async function changePassword() {
  const currentPwd = $('#current-password').value;
  const newPwd = $('#new-password').value;
  const confirmPwd = $('#confirm-password').value;

  if (!currentPwd || !newPwd || !confirmPwd) {
    ui.showToast('All password fields are required', 'error');
    return;
  }

  if (newPwd !== confirmPwd) {
    ui.showToast('New passwords do not match', 'error');
    return;
  }

  if (!validation.validatePassword(newPwd)) {
    ui.showToast('Password must be 8+ chars, include uppercase, lowercase, number', 'error');
    return;
  }

  const confirmed = await ui.showConfirmationDialog(
    'Change Password',
    'You will be logged out from all other devices. Continue?',
    'warning'
  );
  if (!confirmed) return;

  ui.showLoading('Changing password...');
  try {
    await auth.changePassword({ currentPassword: currentPwd, newPassword: newPwd });
    ui.hideLoading();
    ui.showToast('Password changed successfully', 'success');
    $('#current-password').value = '';
    $('#new-password').value = '';
    $('#confirm-password').value = '';
  } catch (error) {
    ui.hideLoading();
    ui.showToast(error.message || 'Password change failed', 'error');
  }
}

// ==================== DEVICE MANAGEMENT ====================
async function loadDevices() {
  const container = $('#devices-list');
  try {
    const devices = await security.getUserDevices?.() || [];
    if (!devices || devices.length === 0) {
      container.innerHTML = '<p class="no-data">No other devices.</p>';
      return;
    }
    let html = '';
    devices.forEach(dev => {
      html += `
        <div class="device-item ${dev.current ? 'current-device' : ''}">
          <span class="device-icon">${dev.platform?.includes('Android') ? '📱' : '💻'}</span>
          <span class="device-name">${dev.platform || 'Unknown'}</span>
          <span class="device-last">Last used: ${utils.formatDate(dev.lastUsed)}</span>
          ${dev.current ? '<span class="badge">Current</span>' : ''}
          ${!dev.current ? `<button class="btn-small logout-device-btn" data-fingerprint="${dev.fingerprint}">Logout</button>` : ''}
        </div>
      `;
    });
    container.innerHTML = html;

    container.querySelectorAll('.logout-device-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        logoutDevice(btn.dataset.fingerprint);
      });
    });
  } catch (error) {
    container.innerHTML = '<p class="error">Failed to load devices.</p>';
  }
}

async function logoutDevice(fingerprint) {
  if (await ui.showConfirmationDialog('Logout Device', 'Logout this device?')) {
    try {
      await security.logoutDevice?.(fingerprint);
      ui.showToast('Device logged out', 'success');
      loadDevices();
    } catch (error) {
      ui.showToast('Failed to logout device', 'error');
    }
  }
}

async function logoutAllDevices() {
  if (await ui.showConfirmationDialog('Logout All Devices', 'Logout from all other devices? (you will stay logged in here)')) {
    try {
      await security.logoutAllOtherDevices?.();
      ui.showToast('All other devices logged out', 'success');
      loadDevices();
    } catch (error) {
      ui.showToast('Operation failed', 'error');
    }
  }
}

// ==================== PREFERENCES ====================
function loadPreferences(prefs = {}) {
  $('#theme-select').value = prefs.theme || 'auto';
  $('#notifications').checked = prefs.notifications?.examReminders ?? true;
  $('#sync-mobile').checked = prefs.dataUsage?.syncOnMobile ?? false;
  $('#cache-size').value = prefs.dataUsage?.cacheSize || '1gb';
}

async function savePreferences() {
  const preferences = {
    theme: $('#theme-select').value,
    notifications: {
      examReminders: $('#notifications').checked,
      subscriptionExpiry: true,
      newFeatures: false
    },
    dataUsage: {
      syncOnMobile: $('#sync-mobile').checked,
      downloadImages: 'wifi_only',
      cacheSize: $('#cache-size').value
    }
  };

  try {
    await auth.updatePreferences(preferences);
    ui.setTheme(preferences.theme);
    ui.showToast('Preferences saved', 'success');
  } catch (error) {
    ui.showToast('Failed to save preferences', 'error');
  }
}

// ==================== STATISTICS ====================
async function loadStatistics() {
  try {
    const allResults = await db.getAllExamResults() || [];
    
    const totalExams = allResults.length;
    let totalQuestions = 0;
    let totalCorrect = 0;
    let totalStudyTime = 0;
    let bestScore = 0;

    allResults.forEach(exam => {
      totalQuestions += exam.totalQuestions || 0;
      totalCorrect += exam.correctAnswers || 0;
      totalStudyTime += exam.timeSpent || 0;
      const score = exam.scorePercentage || 0;
      if (score > bestScore) bestScore = score;
    });

    const avgScore = totalQuestions > 0 ? (totalCorrect / totalQuestions) * 100 : 0;
    const totalHours = totalStudyTime > 0 ? Math.round(totalStudyTime / (1000 * 60 * 60) * 10) / 10 : 0;

    $('#total-exams').textContent = totalExams || 0;
    $('#total-questions').textContent = totalQuestions || 0;
    $('#avg-score').textContent = avgScore ? `${Math.round(avgScore)}%` : '—';
    $('#study-time').textContent = totalHours ? `${totalHours}h` : '0h';

    await db.saveUserStatistics({
      totalExams,
      totalQuestions,
      averageScore: Math.round(avgScore),
      totalStudyTime: totalStudyTime,
      bestScore: Math.round(bestScore)
    });

  } catch (error) {
    console.error('[Profile] Error loading statistics:', error);
    const cached = await db.getUserStatistics();
    if (cached) {
      $('#total-exams').textContent = cached.totalExams || 0;
      $('#total-questions').textContent = cached.totalQuestions || 0;
      $('#avg-score').textContent = cached.averageScore ? `${cached.averageScore}%` : '—';
      $('#study-time').textContent = cached.totalStudyTime ? `${Math.round(cached.totalStudyTime / 60)}h` : '0h';
    }
  }
}

// ==================== DATA EXPORT ====================
async function exportData() {
  const confirmed = await ui.showConfirmationDialog(
    'Export Data',
    'This may take a few minutes. A JSON file will be downloaded. Continue?',
    'info'
  );
  if (!confirmed) return;

  ui.showLoading('Preparing export...');
  try {
    await auth.exportData();
    ui.hideLoading();
    ui.showToast('Export started', 'success');
  } catch (error) {
    ui.hideLoading();
    ui.showToast('Export failed', 'error');
  }
}

// ==================== ACCOUNT DELETION (UPDATED) ====================

/**
 * Show a custom modal for account deletion with password confirmation.
 * Returns a promise that resolves with the password if confirmed, or rejects if cancelled.
 */
function showDeleteConfirmationModal() {
  return new Promise((resolve, reject) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
      display: flex; align-items: center; justify-content: center;
      z-index: 10000;
    `;

    const modal = document.createElement('div');
    modal.className = 'modal-card';
    modal.style.cssText = `
      background: var(--bg-card);
      border-radius: var(--radius-lg);
      padding: 2rem;
      max-width: 420px;
      width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    `;
    modal.innerHTML = `
      <h2 style="margin-top:0; color: var(--danger);">⚠️ Delete Account</h2>
      <p><strong>This action is permanent and cannot be undone.</strong></p>
      <p style="font-size:0.95rem; color: var(--text-secondary);">
        All your personal data, notes, conversations, and exam history will be permanently deleted.
        Some financial and audit records may be anonymised and retained as required by law.
      </p>
      <div style="margin: 1.2rem 0;">
        <label style="display:block; font-weight:500; margin-bottom:0.3rem;">
          Type <strong>DELETE</strong> to confirm:
        </label>
        <input type="text" id="delete-confirm-input" placeholder="DELETE" style="width:100%; padding:0.6rem; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-input); color:var(--text-primary);">
        <div id="delete-confirm-error" style="color:var(--danger); font-size:0.85rem; margin-top:0.2rem;"></div>
      </div>
      <div style="margin: 1.2rem 0;">
        <label style="display:block; font-weight:500; margin-bottom:0.3rem;">Enter your password:</label>
        <input type="password" id="delete-password-input" placeholder="Your password" style="width:100%; padding:0.6rem; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg-input); color:var(--text-primary);">
        <div id="delete-password-error" style="color:var(--danger); font-size:0.85rem; margin-top:0.2rem;"></div>
      </div>
      <div style="display:flex; gap:0.75rem; justify-content:flex-end; margin-top:1.5rem;">
        <button id="delete-cancel-btn" style="padding:0.6rem 1.5rem; border-radius:30px; background:var(--bg-secondary); border:1px solid var(--border); color:var(--text-primary); cursor:pointer;">Cancel</button>
        <button id="delete-confirm-btn" disabled style="padding:0.6rem 1.5rem; border-radius:30px; background:var(--danger); color:white; border:1px solid var(--danger); cursor:pointer; opacity:0.5;">Delete Permanently</button>
      </div>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const confirmInput = modal.querySelector('#delete-confirm-input');
    const passwordInput = modal.querySelector('#delete-password-input');
    const confirmBtn = modal.querySelector('#delete-confirm-btn');
    const cancelBtn = modal.querySelector('#delete-cancel-btn');
    const confirmError = modal.querySelector('#delete-confirm-error');
    const passwordError = modal.querySelector('#delete-password-error');

    function validate() {
      const isDelete = confirmInput.value.trim() === 'DELETE';
      const hasPassword = passwordInput.value.trim().length > 0;
      confirmBtn.disabled = !isDelete || !hasPassword;
      confirmBtn.style.opacity = confirmBtn.disabled ? '0.5' : '1';
      if (confirmInput.value.trim() && confirmInput.value.trim() !== 'DELETE') {
        confirmError.textContent = 'Please type DELETE exactly.';
      } else {
        confirmError.textContent = '';
      }
      if (hasPassword) {
        passwordError.textContent = '';
      }
    }

    confirmInput.addEventListener('input', validate);
    passwordInput.addEventListener('input', validate);

    const cleanup = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    cancelBtn.addEventListener('click', () => {
      cleanup();
      reject(new Error('Deletion cancelled'));
    });

    confirmBtn.addEventListener('click', async () => {
      const password = passwordInput.value.trim();
      if (confirmInput.value.trim() !== 'DELETE') {
        confirmError.textContent = 'Please type DELETE exactly.';
        return;
      }
      if (!password) {
        passwordError.textContent = 'Please enter your password.';
        return;
      }
      cleanup();
      resolve(password);
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        reject(new Error('Deletion cancelled'));
      }
    });

    const onEnter = (e) => {
      if (e.key === 'Enter' && !confirmBtn.disabled) {
        confirmBtn.click();
      }
    };
    confirmInput.addEventListener('keydown', onEnter);
    passwordInput.addEventListener('keydown', onEnter);

    setTimeout(() => confirmInput.focus(), 100);
  });
}

/**
 * Delete account – calls auth.deleteAccount which clears all data and redirects.
 */
async function deleteAccount() {
  try {
    const password = await showDeleteConfirmationModal();

    ui.showLoading('Deleting account...');
    try {
      await auth.deleteAccount(password);
      // auth.deleteAccount already clears local data, logs out, and navigates to welcome.html.
      // We hide loading manually (auth.deleteAccount doesn't hide it).
      ui.hideLoading();
      // No need to navigate – auth.deleteAccount does that.
    } catch (error) {
      ui.hideLoading();
      ui.showToast(error.message || 'Deletion failed. Please try again.', 'error');
    }
  } catch (error) {
    // User cancelled
    if (error.message !== 'Deletion cancelled') {
      ui.showToast(error.message || 'Operation cancelled', 'info');
    }
  }
}

// ==================== DESTROY ====================
export function destroy() {
  // Cleanup if needed
}