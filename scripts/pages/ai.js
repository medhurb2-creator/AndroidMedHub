// scripts/pages/ai.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as subscription from '../subscription.js';
import * as utils from '../utils.js';
import AIChatUI from '../ai-chat-ui.js';
import ai from '../ai.js';

let $;
let chatUI;
let updateHeaderOffset;  // store reference for cleanup

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  // Apply theme
  ui.applyTheme();

  // --- Dynamic header offset ---
  updateHeaderOffset = function() {
    const header = $('#topBar');
    if (!header) return;
    const headerHeight = header.offsetHeight;
    document.documentElement.style.setProperty('--header-height', headerHeight + 'px');
    const appHeight = window.innerHeight - headerHeight;
    document.documentElement.style.setProperty('--app-height', appHeight + 'px');
  };

  window.addEventListener('resize', updateHeaderOffset);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateHeaderOffset);
    window.visualViewport.addEventListener('scroll', updateHeaderOffset);
  }

  // --- Ensure auth ---
  if (!auth.checkAuth()) {
    router.navigateTo('login');
    return;
  }

  // ============================================================
  // ✅ Use cached subscription – no backend calls
  // ============================================================
  let sub = null;
  try {
    sub = await subscription.getSubscription(); // returns cached object
  } catch (err) {
    console.warn('[AI] Failed to get subscription:', err);
    sub = null;
  }

  // --- Update subscription status ---
  const statusEl = $('#header-status');
  const subscribeBtn = $('#subscribeBtn');

  if (sub && sub.isActive) {
    const remaining = await subscription.formatRemainingTime(); // uses cached expiry
    statusEl.innerHTML =
      `<span class="status-text">${sub.plan} · expires ${utils.formatDate(sub.expiryDate)} (${remaining})</span>`;
    subscribeBtn.style.display = 'none';
  } else {
    // Check trial eligibility (only if no active subscription)
    let trialEligible = false;
    try {
      trialEligible = await subscription.checkTrialEligibility();
    } catch (err) {
      console.warn('[AI] Trial eligibility check failed:', err);
    }

    if (trialEligible) {
      statusEl.innerHTML =
        `<span class="status-text">No active plan</span><button class="trial-btn" id="trialBtn">Start Trial</button>`;
      const trialBtn = $('#trialBtn');
      if (trialBtn) trialBtn.addEventListener('click', () => router.navigateTo('free-trial'));
    } else {
      statusEl.innerHTML =
        `<span class="status-text">No active plan</span><span class="status-text" style="color: var(--danger);">Subscribe</span>`;
    }
    subscribeBtn.style.display = 'inline-block';
  }

  updateHeaderOffset();

  // --- Initialize chat UI ---
  chatUI = new AIChatUI();
  await chatUI.init();

  // --- Hide shimmer, show real content ---
  const shimmer = $('#shimmer-content');
  const real = $('#real-content');
  shimmer.classList.add('hidden');
  real.classList.add('visible');

  updateHeaderOffset();
  requestAnimationFrame(updateHeaderOffset);

  // --- Attach event listeners ---
  attachEventListeners(context);

  // --- Expose some functions globally for inline use ---
  window.aiPage = {
    updateHeaderOffset,
  };

  console.log('[AI] Initialized');
}

// ==================== EVENT LISTENERS ====================
function attachEventListeners(context) {
  // Header buttons
  const subjectsBtn = $('#subjectsBtn');
  if (subjectsBtn) {
    subjectsBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  const notesBtn = $('#notesBtn');
  if (notesBtn) {
    notesBtn.addEventListener('click', () => router.navigateTo('notes'));
  }

  const profileBtn = $('#profileBtn');
  if (profileBtn) {
    profileBtn.addEventListener('click', () => router.navigateTo('profile'));
  }

  const subscribeBtn = $('#subscribeBtn');
  if (subscribeBtn) {
    subscribeBtn.addEventListener('click', () => router.navigateTo('subscription'));
  }

  const performanceLink = $('#performanceLink');
  if (performanceLink) {
    performanceLink.addEventListener('click', (e) => {
      e.preventDefault();
      router.navigateTo('performance');
    });
  }

  // Theme toggle (header)
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  // Theme toggle (modal)
  const themeToggleModal = $('#themeToggleModal');
  if (themeToggleModal) {
    themeToggleModal.addEventListener('click', ui.toggleTheme);
  }

  // Settings modal
  const settingsBtn = $('#settingsBtn');
  const settingsModal = $('#settingsModal');
  const closeModalBtn = $('#closeModalBtn');

  if (settingsBtn && settingsModal && closeModalBtn) {
    settingsBtn.addEventListener('click', () => {
      settingsModal.style.display = 'flex';
    });
    closeModalBtn.addEventListener('click', () => {
      settingsModal.style.display = 'none';
    });
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) {
        settingsModal.style.display = 'none';
      }
    });
  }

  // Clear history
  const clearHistoryBtn = $('#clearHistoryBtn');
  if (clearHistoryBtn) {
    clearHistoryBtn.addEventListener('click', () => {
      if (confirm('Clear all chat history?')) {
        ui.showToast('Chat history cleared.', 'info');
        // Optionally clear actual history here
      }
    });
  }

  // Model selector
  const modelSelect = $('#modelSelect');
  const currentModelSpan = $('#currentModel');
  if (modelSelect && currentModelSpan) {
    modelSelect.addEventListener('change', () => {
      currentModelSpan.textContent = modelSelect.value;
    });
  }

  // Sidebar menu toggle
  const menuToggle = $('#menuToggle');
  const sidebar = $('#sidebar');
  if (menuToggle && sidebar) {
    menuToggle.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }
}

export function destroy() {
  // Cleanup: remove event listeners if needed
  if (chatUI && typeof chatUI.destroy === 'function') {
    chatUI.destroy();
  }
  // Remove resize listener
  if (updateHeaderOffset) {
    window.removeEventListener('resize', updateHeaderOffset);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', updateHeaderOffset);
      window.visualViewport.removeEventListener('scroll', updateHeaderOffset);
    }
  }
}