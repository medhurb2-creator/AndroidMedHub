// scripts/pages/locked.js
import * as utils from '../utils.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as security from '../security.js';
import * as db from '../db.js';
import * as auth from '../auth.js';

let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // Get lock details from URL or from stored lock status
  const params = new URLSearchParams(window.location.search);
  let reason = params.get('reason');
  let timestamp = params.get('timestamp');
  let duration = params.get('duration');

  // If not in URL, try to get from lock status in database
  if (!reason) {
    const lockStatus = await db.getLockStatus();
    if (lockStatus && lockStatus.locked) {
      reason = lockStatus.reason;
      timestamp = lockStatus.timestamp;
      duration = lockStatus.duration || 'Permanent';
    }
  }

  // Fallback defaults
  if (!reason) reason = 'time_manipulation';
  if (!timestamp) timestamp = Date.now();
  if (!duration) duration = 'Permanent';

  // Display lock info
  const reasonEl = $('#lock-reason');
  if (reasonEl) reasonEl.textContent = getReasonDescription(reason);

  const timestampEl = $('#lock-timestamp');
  if (timestampEl) {
    timestampEl.textContent = `Locked on: ${utils.formatDate(new Date(parseInt(timestamp)))} at ${utils.formatTime(parseInt(timestamp))}`;
  }

  const durationEl = $('#lock-duration');
  if (durationEl) durationEl.textContent = duration;

  // Display device fingerprint
  const fpEl = $('#device-fp');
  if (fpEl) {
    fpEl.textContent = security.getDeviceFingerprint() || 'Not available';
  }

  // Attach event listeners
  const emailSupportBtn = $('#emailSupportBtn');
  if (emailSupportBtn) {
    emailSupportBtn.addEventListener('click', contactSupport);
  }

  const callSupportBtn = $('#callSupportBtn');
  if (callSupportBtn) {
    callSupportBtn.addEventListener('click', callSupport);
  }

  const clearDataBtn = $('#clearDataBtn');
  if (clearDataBtn) {
    clearDataBtn.addEventListener('click', clearLocalData);
  }

  const homeBtn = $('#homeBtn');
  if (homeBtn) {
    homeBtn.addEventListener('click', () => router.navigateTo('index'));
  }
}

// ==================== Helpers ====================

function getReasonDescription(code) {
  const reasons = {
    'time_manipulation': 'Time manipulation detected. Changing device time to extend trial/subscription is strictly prohibited.',
    'multiple_devices': 'Account accessed from too many devices simultaneously.',
    'security_breach': 'Security breach detected. Account locked for your protection.',
    'payment_fraud': 'Suspicious payment activity detected.',
    'admin_lock': 'Account locked by administrator.',
    'trial_abuse': 'Multiple trial activations detected from the same device.'
  };
  return reasons[code] || 'Security violation detected. Your account has been locked.';
}

function contactSupport() {
  const fingerprint = security.getDeviceFingerprint() || '';
  const reason = document.getElementById('lock-reason')?.textContent || '';
  const timestamp = document.getElementById('lock-timestamp')?.textContent || '';

  const subject = encodeURIComponent('Account Lock - Medical Exam Room Pro');
  const body = encodeURIComponent(
    `My account is locked. Please help.\n\n` +
    `Device Fingerprint: ${fingerprint}\n` +
    `Lock Reason: ${reason}\n` +
    `${timestamp}\n\n` +
    `My Details:\n` +
    `Name: \n` +
    `Email: \n` +
    `Phone: \n\n` +
    `Please unlock my account.`
  );
  window.location.href = `mailto:support@medvix.co.ke?subject=${subject}&body=${body}`;
}

function callSupport() {
  window.location.href = 'tel:+254720420855';
}

async function clearLocalData() {
  const confirmed = await ui.showConfirmationDialog(
    'Clear Local Data',
    'WARNING: This will delete all local data including exam progress and saved questions. Only do this if instructed by support. Continue?',
    'critical'
  );
  if (!confirmed) return;

  ui.showLoading('Clearing data...');
  try {
    await db.clearDatabase();
    localStorage.clear();
    sessionStorage.clear();
    await auth.logout(); // ensure tokens are gone
    ui.hideLoading();
    ui.showToast('Local data cleared. Redirecting...', 'success');
    router.navigateTo('index');
  } catch (error) {
    ui.hideLoading();
    ui.showToast('Failed to clear data: ' + error.message, 'error');
  }
}

export function destroy() {
  // Cleanup if needed
}