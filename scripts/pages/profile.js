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
import * as contentStore from '../db/content-store.js';

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

  // Load storage info (Storage tab)
  await loadStorageInfo();

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

  // ── Storage tab ──────────────────────────────────────────────────
  // The roots list and its per-root action buttons are rendered
  // dynamically by renderRootsList(), so their listeners are attached
  // there. Only the tab-level controls are wired here.
  const deleteAllDataBtn = $('#deleteAllDataBtn');
  if (deleteAllDataBtn) {
    deleteAllDataBtn.addEventListener('click', deleteAllData);
  }

  const cancelMigrationBtn = $('#cancelMigrationBtn');
  if (cancelMigrationBtn) {
    cancelMigrationBtn.addEventListener('click', cancelMigration);
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

// ==================== ACCOUNT DELETION ====================

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
      ui.hideLoading();
    } catch (error) {
      ui.hideLoading();
      ui.showToast(error.message || 'Deletion failed. Please try again.', 'error');
    }
  } catch (error) {
    if (error.message !== 'Deletion cancelled') {
      ui.showToast(error.message || 'Operation cancelled', 'info');
    }
  }
}

// ==================== STORAGE ====================
//
// Three roots can exist on Android:
//
//   internal  — app-private internal storage.
//   external  — Android's emulated external storage (same physical chip
//               as internal on modern phones; moving here does not free
//               space).
//   sdcard    — the removable SD card's app-specific directory. Real,
//               separate physical volume. Only present when a card is
//               mounted.
//
// The user picks which one NEW writes go to. Reads work across all
// three, so switching the preference never strands an existing file.
//
// This panel:
//   • Lists every available root with free space and a removable
//     badge for the SD card.
//   • Lets the user switch the write preference without moving
//     anything ("Switch without moving") or move all existing content
//     to a chosen root ("Move content here").
//   • Deletes all data (DB + on-disk content + cache).
//
// Migration drives content-store.migrateContentToRoot(), which is
// idempotent and resumable — files already in the target are skipped
// via fileInRoot(), so a run that is cancelled, crashes, or is killed
// by the OS can be restarted without re-doing completed work.
//
// All styling lives in profile.css under the "STORAGE TAB" section.
// This module only writes class names — never inline styles — so the
// stylesheet and the markup cannot drift.

// Module-scoped abort controller so Cancel can stop an in-flight
// migration. Null when no migration is running.
let _migrationController = null;

/**
 * Read every available root from the native bridge.
 * Returns [] on any failure (bridge absent, malformed JSON).
 *
 * @returns {Array<{
 *   type: 'internal'|'external'|'sdcard',
 *   path: string,
 *   available: boolean,
 *   removable: boolean,
 *   freeBytes: number,
 *   isCurrent: boolean,
 *   volumeId: string,
 * }>}
 */
function getNativeRoots() {
  try {
    const raw = window.MedVixStorage?.getAvailableRoots?.();
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/**
 * Human-readable label for a root type.
 */
function rootLabel(type) {
  if (type === 'internal') return 'Internal storage';
  if (type === 'external') return 'Emulated external';
  if (type === 'sdcard')   return 'SD card';
  return type || 'Unknown';
}

/**
 * Format a byte count as a short human-readable string.
 */
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * Shorten a long relative path for display in the migration status.
 * "content/resources/textbooks/foo/bar.pdf" → "…/foo/bar.pdf"
 */
function shortenPath(rel) {
  if (!rel) return '';
  const parts = String(rel).split('/');
  if (parts.length <= 3) return rel;
  return '…/' + parts.slice(-3).join('/');
}

/**
 * Refresh the storage tab: current-root summary, usage, and the list
 * of available roots with their per-root actions.
 *
 * Called once from init() and again after every preference change or
 * completed migration.
 */
async function loadStorageInfo() {
  const rootTypeEl = $('#storage-current-root');
  const rootPathEl = $('#storage-current-path');
  const usageEl    = $('#storage-usage');
  const listEl     = $('#storage-roots-list');

  // If neither the app-level wrapper nor the native bridge is present
  // (web dev build), mark the whole panel inert.
  const hasApp    = !!window.app?.storageAvailable?.();
  const hasNative = !!window.MedVixStorage?.isAvailable?.();
  if (!hasApp && !hasNative) {
    if (rootTypeEl) rootTypeEl.textContent = 'Not available';
    if (rootPathEl) rootPathEl.textContent = '—';
    if (usageEl)    usageEl.textContent = '—';
    if (listEl) {
      listEl.innerHTML =
        '<p class="storage-hint">Storage controls are available only in the installed app.</p>';
    }
    return;
  }

  // Current write root. Prefer the app-level wrapper if it exists;
  // otherwise fall back to the native bridge directly.
  const currentType =
    (window.app?.storageRootType?.()) ||
    (window.MedVixStorage?.getRootType?.()) ||
    'internal';
  const currentPath =
    (window.app?.storageRoot?.()) ||
    (window.MedVixStorage?.getRoot?.()) ||
    '';

  if (rootTypeEl) rootTypeEl.textContent = rootLabel(currentType);
  if (rootPathEl) rootPathEl.textContent = currentPath || '—';

  // Total bytes used by MedVix.
  try {
    const stats = await (window.app?.storageStats?.() ?? Promise.resolve(null));
    const bytes = Number(stats?.totalBytes) || 0;
    if (usageEl) usageEl.textContent = formatBytes(bytes);
  } catch {
    if (usageEl) usageEl.textContent = '—';
  }

  // Roots list.
  const roots = getNativeRoots();
  renderRootsList(roots, currentType);
}

/**
 * Render one card per available root. Each non-current, available root
 * gets a "Move content here" button (migration + preference commit)
 * and a lighter "Switch without moving" text button (preference only).
 */
function renderRootsList(roots, currentType) {
  const listEl = $('#storage-roots-list');
  if (!listEl) return;

  if (!roots || roots.length === 0) {
    listEl.innerHTML = '<p class="storage-hint">No storage locations detected.</p>';
    return;
  }

  listEl.innerHTML = '';
  for (const root of roots) {
    listEl.appendChild(buildRootCard(root, currentType));
  }
}

/**
 * Build a single root card.
 *
 * Styling lives entirely in profile.css (.storage-root and friends).
 * The class names are the contract; do not inline style here or the
 * stylesheet will be shadowed.
 */
function buildRootCard(root, currentType) {
  const isCurrent   = root.type === currentType;
  const isAvailable = !!root.available;

  const card = document.createElement('div');
  card.className = 'storage-root';
  if (isCurrent)    card.classList.add('is-current');
  if (!isAvailable) card.classList.add('is-unavailable');

  // Header row: name + badges.
  const header = document.createElement('div');
  header.className = 'storage-root-header';

  const name = document.createElement('span');
  name.className = 'storage-root-name';
  name.textContent = rootLabel(root.type);
  header.appendChild(name);

  if (root.removable) {
    const badge = document.createElement('span');
    badge.className = 'storage-root-badge storage-root-badge-removable';
    badge.textContent = 'SD Card';
    header.appendChild(badge);
  }

  if (isCurrent) {
    const badge = document.createElement('span');
    badge.className = 'storage-root-badge storage-root-badge-current';
    badge.textContent = 'Current';
    header.appendChild(badge);
  }

  if (!isAvailable) {
    const badge = document.createElement('span');
    badge.className = 'storage-root-badge storage-root-badge-unavailable';
    badge.textContent = 'Not available';
    header.appendChild(badge);
  }

  card.appendChild(header);

  // Path.
  const path = document.createElement('code');
  path.className = 'storage-root-path';
  path.textContent = root.path || '—';
  card.appendChild(path);

  // Free space.
  const free = document.createElement('div');
  free.className = 'storage-root-meta';
  free.textContent = `${formatBytes(root.freeBytes)} free`;
  card.appendChild(free);

  // Action buttons — only for non-current, available roots.
  // (CSS hides .storage-root-actions on .is-unavailable, but we also
  // skip constructing them so there are no listeners to leak.)
  if (!isCurrent && isAvailable) {
    const actions = document.createElement('div');
    actions.className = 'storage-root-actions';

    const moveBtn = document.createElement('button');
    moveBtn.type = 'button';
    moveBtn.className = 'btn-secondary';
    moveBtn.textContent = 'Move content here';
    moveBtn.addEventListener('click', () => moveContentTo(root.type));
    actions.appendChild(moveBtn);

    const switchBtn = document.createElement('button');
    switchBtn.type = 'button';
    switchBtn.className = 'btn-text';
    switchBtn.textContent = 'Switch without moving';
    switchBtn.addEventListener('click', () => switchPreferenceOnly(root.type));
    actions.appendChild(switchBtn);

    card.appendChild(actions);
  }

  return card;
}

/**
 * Switch the write preference without moving any existing file.
 * Reads continue to work across all roots, so this is safe at any time.
 */
async function switchPreferenceOnly(targetType) {
  const ok = window.MedVixStorage?.setPreferredRoot?.(targetType);
  if (!ok) {
    ui.showToast(`Could not switch to ${rootLabel(targetType)}`, 'error');
    return;
  }
  ui.showToast(`New downloads will use ${rootLabel(targetType)}`, 'success');
  await loadStorageInfo();
}

/**
 * Move every content file from every other available root to the
 * target, then commit the preference on success.
 *
 * Idempotent: files already in the target are skipped. Resumable: a
 * cancelled or interrupted run can be restarted — the scan re-reads
 * each source root fresh, and fileInRoot() filters out what has
 * already moved.
 */
async function moveContentTo(targetType) {
  if (_migrationController) {
    ui.showToast('A migration is already running', 'warning');
    return;
  }

  const label = rootLabel(targetType);
  const isRemovableTarget = targetType === 'sdcard';

  const extraWarning = isRemovableTarget
    ? ' If the card is ejected later, the moved content will be unavailable until you re-insert it.'
    : '';

  const confirmed = await ui.showConfirmationDialog(
    `Move content to ${label}`,
    `All downloaded content on this device will be moved to ${label}.` +
    extraWarning +
    ' The app may briefly freeze while moving large files. ' +
    'Do not close the app or eject the card during the move.',
    'info'
  );
  if (!confirmed) return;

  showMigrationPanel();

  _migrationController = new AbortController();

  try {
    const result = await contentStore.migrateContentToRoot(targetType, {
      onProgress: updateMigrationProgress,
      signal: _migrationController.signal,
    });

    hideMigrationPanel();

    if (result.ok) {
      // Commit the preference only after every file landed. Until
      // this point the write root is unchanged, so new downloads
      // during the migration keep going to the old root — which is
      // fine because migrateContentToRoot() re-scans on the next run.
      window.MedVixStorage?.setPreferredRoot?.(targetType);

      const n = result.migrated.length;
      const skipped = result.skipped.length;
      const msg = skipped > 0
        ? `Moved ${n} file${n === 1 ? '' : 's'} to ${label} (${skipped} already there)`
        : `Moved ${n} file${n === 1 ? '' : 's'} to ${label}`;
      ui.showToast(msg, 'success');
    } else if (result.aborted) {
      ui.showToast(
        `Migration cancelled. ${result.migrated.length} file(s) already moved — preference unchanged.`,
        'info',
        5000
      );
    } else {
      ui.showToast(
        `${result.migrated.length} moved, ${result.failed.length} failed. Preference unchanged.`,
        'warning',
        6000
      );
    }
  } catch (e) {
    hideMigrationPanel();
    ui.showToast(e.message || 'Migration failed', 'error');
  } finally {
    _migrationController = null;
    await loadStorageInfo();
  }
}

/**
 * Signal an in-flight migration to stop. The currently-processing file
 * finishes (the native move is atomic per call); the loop exits before
 * starting the next one.
 */
function cancelMigration() {
  if (_migrationController) {
    _migrationController.abort();
    ui.showToast('Cancelling migration…', 'info');
  }
}

function showMigrationPanel() {
  const panel = $('#storage-migration-panel');
  if (panel) panel.hidden = false;
  updateMigrationProgress({ phase: 'scan' });
}

function hideMigrationPanel() {
  const panel = $('#storage-migration-panel');
  if (panel) panel.hidden = true;
  const fill = $('#storage-migration-fill');
  if (fill) fill.style.width = '0%';
}

/**
 * Update the migration status line and progress bar.
 *
 * Called by content-store.migrateContentToRoot() with a fresh progress
 * object per phase transition and per file. Never throws — missing DOM
 * elements are silently ignored so a template change cannot break
 * migration.
 *
 * The fill width is the only inline style kept: it is a per-frame
 * numeric value with no useful CSS-class equivalent.
 */
function updateMigrationProgress(p) {
  const statusEl = $('#storage-migration-status');
  const fillEl   = $('#storage-migration-fill');
  if (!statusEl || !fillEl) return;

  let text = '';
  let pct  = 0;

  if (p.phase === 'scan') {
    text = `Scanning ${p.sourceRoot || 'sources'}…`;
    pct  = 2;
  } else if (p.phase === 'migrate') {
    text = `Moving: ${shortenPath(p.rel)}`;
    pct  = p.total ? Math.round((p.index / p.total) * 100) : 0;
  } else if (p.phase === 'skip') {
    text = `Already there: ${shortenPath(p.rel)}`;
    pct  = p.total ? Math.round((p.index / p.total) * 100) : 0;
  } else if (p.phase === 'fail') {
    text = `Failed: ${shortenPath(p.rel)}`;
    pct  = p.total ? Math.round((p.index / p.total) * 100) : 0;
  } else if (p.phase === 'complete') {
    text = `Done. ${p.migrated || 0} moved, ${p.skipped || 0} skipped, ${p.failed || 0} failed.`;
    pct  = 100;
  }

  statusEl.textContent = text;
  fillEl.style.width = `${pct}%`;
}

/**
 * Wipe every IndexedDB store and every on-disk content/ and cache/
 * directory. User remains logged in.
 */
async function deleteAllData() {
  const confirmed = await ui.showConfirmationDialog(
    'Delete all data',
    'This will permanently delete all app data on this device — downloads, cached content, notes, and local settings. Your account on the server is not affected. Continue?',
    'critical'
  );
  if (!confirmed) return;

  ui.showLoading('Deleting all data…');
  try {
    // 1. Clear every IndexedDB store. db.clearDatabase() also wipes
    //    the on-disk content/ and cache/ trees via the native bridge.
    await db.clearDatabase();

    // 2. Belt-and-braces: if the native bridge exposes the low-level
    //    directory wipes, call them directly in case a partial IDB
    //    clear left something behind.
    try {
      if (window.MedVixStorage?.deleteDirectory) {
        window.MedVixStorage.deleteDirectory('content');
        window.MedVixStorage.deleteDirectory('cache');
      }
    } catch { /* ignore */ }

    ui.hideLoading();
    ui.showToast('All local data has been deleted', 'success');

    await loadStorageInfo();
  } catch (e) {
    ui.hideLoading();
    ui.showToast(e.message || 'Could not delete data', 'error');
  }
}

// ==================== DESTROY ====================
export function destroy() {
  // Abort any in-flight migration when the page is torn down so its
  // loop does not keep running against a detached DOM.
  if (_migrationController) {
    try { _migrationController.abort(); } catch { /* ignore */ }
    _migrationController = null;
  }
}