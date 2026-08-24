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
    // Hide shimmer before redirect
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

  // ============================================================
  // ✅ Use cached subscription – no backend calls
  // ============================================================
  let sub = null;
  try {
    sub = await subscription.getSubscription(); // returns cached object
  } catch (err) {
    console.warn('[Profile] Failed to get subscription:', err);
    sub = null;
  }

  // Update header status
  const statusEl = $('#header-status');
  if (sub && sub.isActive) {
    const remaining = await subscription.formatRemainingTime(); // uses cached expiry
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
  if (sub?.isActive) {
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

  // Kenyan medical institutions (both public and private)
  const institutions = [
    // Public Universities
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
    // Private Universities
    'Mount Kenya University (MKU)',
    'Kenyatta University Teaching, Referral & Research Hospital (KUTRRH)',
    'Strathmore University',
    'United States International University Africa (USIU-Africa)',
    'Africa Nazarene University (ANU)',
    'Daystar University',
    'Catholic University of Eastern Africa (CUEA)',
    'Adventist University of Africa (AUA)',
    'Pan Africa Christian University (PACU)',
    'St. Paul\'s University',
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
    // Teaching and Referral Hospitals (with training programs)
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
    // Medical Training Colleges
    'Kenya Medical Training College (KMTC)',
    'Nairobi Institute of Health Sciences (NIHS)',
    'Kampala International University (KIU) - Kenya Campus',
    'Jomo Kenyatta University of Agriculture and Technology (JKUAT) - Health Sciences',
    // International/Kenyan partnerships
    'AMREF International University (AMIU)',
    'African Medical and Research Foundation (AMREF)',
    // Other notable medical institutions
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

  // Filter unique and sort
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

  // On load, if there's a value, show it as selected
  if (input.value) {
    selectedInstitution = input.value;
  }
}

// ==================== EVENT LISTENERS ====================
function attachEventListeners(context) {
  // Theme toggle
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // Back to Subjects
  const backSubjectsBtn = $('#backSubjectsBtn');
  if (backSubjectsBtn) {
    backSubjectsBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  // Performance button
  const performanceBtn = $('#performanceBtn');
  if (performanceBtn) {
    performanceBtn.addEventListener('click', () => router.navigateTo('performance'));
  }

  // Profile form submit
  const profileForm = $('#profileForm');
  if (profileForm) {
    profileForm.addEventListener('submit', saveProfile);
  }

  // Change password
  const changePasswordBtn = $('#changePasswordBtn');
  if (changePasswordBtn) {
    changePasswordBtn.addEventListener('click', changePassword);
  }

  // Export data
  const exportDataBtn = $('#exportDataBtn');
  if (exportDataBtn) {
    exportDataBtn.addEventListener('click', exportData);
  }

  // Delete account
  const deleteAccountBtn = $('#deleteAccountBtn');
  if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener('click', deleteAccount);
  }

  // Logout all devices
  const logoutAllDevicesBtn = $('#logoutAllDevicesBtn');
  if (logoutAllDevicesBtn) {
    logoutAllDevicesBtn.addEventListener('click', logoutAllDevices);
  }

  // Save preferences
  const savePreferencesBtn = $('#savePreferencesBtn');
  if (savePreferencesBtn) {
    savePreferencesBtn.addEventListener('click', savePreferences);
  }

  // View analytics
  const viewAnalyticsBtn = $('#viewAnalyticsBtn');
  if (viewAnalyticsBtn) {
    viewAnalyticsBtn.addEventListener('click', () => router.navigateTo('performance'));
  }

  // Back to Subjects (footer)
  const backToSubjectsFooterBtn = $('#backToSubjectsFooterBtn');
  if (backToSubjectsFooterBtn) {
    backToSubjectsFooterBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  // Tabs
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

    // Attach logout device event listeners
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

// ==================== ACCOUNT DELETION ====================
async function deleteAccount() {
  const confirmText = prompt('Type "DELETE" to confirm permanent account deletion:');
  if (confirmText !== 'DELETE') {
    ui.showToast('Deletion cancelled', 'info');
    return;
  }

  const password = prompt('Enter your password to confirm:');
  if (!password) return;

  ui.showLoading('Deleting account...');
  try {
    await auth.deleteAccount(password);
    ui.hideLoading();
    ui.showToast('Account deleted. Redirecting...', 'info');
    router.navigateTo('index');
  } catch (error) {
    ui.hideLoading();
    ui.showToast(error.message || 'Deletion failed', 'error');
  }
}

// ==================== DESTROY ====================
export function destroy() {
  // Cleanup if needed
}