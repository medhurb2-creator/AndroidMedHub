// scripts/pages/referral.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as referral from '../referral.js';
import * as referralUI from '../referral-ui.js';

let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // Shimmer is already visible.
  const overlay = $('#shimmer-overlay');
  const mainContent = $('#main-content');

  // ── Auth gate ────────────────────────────────────────────────────
  // Round-trip through login so the user comes back to the same
  // sub-view of the referral dashboard after authenticating.
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to view your referrals', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  // ── State adapter ────────────────────────────────────────────────
  // Registered before any redirect can fire. Captures whatever sub-
  // view state referralUI exposes via the DOM. None of this state
  // lives in this module — the dashboard is fully owned by
  // referralUI — so we read it defensively and no-op on anything
  // that isn't present.
  //
  // Form inputs, if any, with ids are captured automatically by the
  // module's UI snapshot. This adapter is purely for class-flag /
  // modal-visible state inside the dashboard.
  redirect.registerStateAdapter('referral', {
    capture: () => {
      const activeSubTab =
        document.querySelector('#dashboard-container .sub-tab.active') ||
        document.querySelector('#dashboard-container .tab.active') ||
        document.querySelector('#dashboard-container [data-subview].active');

      const activeModal =
        document.querySelector('#share-modal[style*="flex"]') ||
        document.querySelector('#share-modal.show') ||
        document.querySelector('#share-modal.active') ||
        document.querySelector('#referral-share-modal[style*="flex"]');

      // Extract the sub-tab key from whichever selector matched.
      let subTabKey = null;
      if (activeSubTab) {
        subTabKey =
          activeSubTab.dataset?.subview ||
          activeSubTab.dataset?.tab ||
          activeSubTab.getAttribute?.('data-subview') ||
          activeSubTab.id ||
          null;
      }

      return {
        subTabKey,
        shareModalOpen: !!activeModal,
      };
    },

    restore: (data) => {
      if (!data) return;

      // Re-apply the sub-tab selection if the dashboard exposes a
      // click target for it. This fires the click so referralUI's
      // own listener runs — trying to fake the class change here
      // would desync its internal state.
      if (data.subTabKey) {
        const candidates = document.querySelectorAll(
          '#dashboard-container .sub-tab, #dashboard-container .tab, #dashboard-container [data-subview]'
        );
        for (const el of candidates) {
          const key =
            el.dataset?.subview ||
            el.dataset?.tab ||
            el.getAttribute?.('data-subview') ||
            el.id;
          if (key === data.subTabKey) {
            try { el.click(); } catch { /* ignore */ }
            break;
          }
        }
      }

      // Re-open the share modal if it was open. We try both a
      // class-based and a style-based restore, in that order,
      // because referralUI may use either.
      if (data.shareModalOpen) {
        const modal =
          document.getElementById('share-modal') ||
          document.getElementById('referral-share-modal');
        if (modal) {
          if (modal.classList.contains('show') ||
              modal.classList.contains('active') ||
              modal.dataset?.visible === 'true') {
            // Already shown by referralUI — nothing to do.
          } else {
            modal.style.display = 'flex';
          }
        }
      }
    },
  });

  // Update header status
  try {
    const data = await referral.getReferralDashboard();
    const isAgent = data.isAgent || false;
    const statusEl = $('#header-status');
    statusEl.innerHTML = isAgent ? '⭐ Agent' : '👤 User';
  } catch (err) {
    // ignore
  }

  // Render dashboard
  const container = $('#dashboard-container');
  await referralUI.renderDashboard(container);

  // Hide shimmer, show main content with fade
  overlay.classList.add('hidden');
  mainContent.classList.add('show');

  // Remove overlay from DOM after transition
  setTimeout(() => {
    overlay.style.display = 'none';
  }, 500);

  // Attach event listeners
  attachEventListeners(context);

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a completed round trip.
  // Pop so the stack doesn't grow on subsequent redirects. Covers
  // the case where the returning page used history.back().
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
    console.warn('[Referral] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Restores sub-tab and share-modal state via the adapter. Form
  // fields with ids (none in the current HTML, but future-proofing)
  // are restored automatically by the UI snapshot.
  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[Referral] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

  console.log('[Referral] Initialized');
}

function attachEventListeners(context) {
  // Back to Subjects buttons
  const backSubjectsBtn = $('#backSubjectsBtn');
  if (backSubjectsBtn) {
    backSubjectsBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }
  const backSubjectsFooterBtn = $('#backSubjectsFooterBtn');
  if (backSubjectsFooterBtn) {
    backSubjectsFooterBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  // Profile button
  const profileBtn = $('#profileBtn');
  if (profileBtn) {
    profileBtn.addEventListener('click', () => router.navigateTo('profile'));
  }

  // Theme toggle
  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }
}

export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's DOM.
  try { redirect.unregisterStateAdapter('referral'); } catch { /* ignore */ }
}