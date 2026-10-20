// scripts/pages/notifications.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as notifications from '../notifications.js';

let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ── Auth gate ────────────────────────────────────────────────────
  // Round-trip through login. When the user signs in, login pops the
  // return stack and lands them back here with the notifications UI
  // rebuilt.
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to view notifications', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  // ── State adapter ────────────────────────────────────────────────
  // Registered before any redirect can fire. Captures the filter,
  // sort, and search state that lives in the notifications module
  // (or in the DOM, as a fallback). The search input already has an
  // id, so the automatic UI snapshot covers its value — the adapter
  // just re-applies it through the module so the list filters
  // correctly on return.
  //
  // NOTE: the previous "category" dimension (chips) has been removed
  // from the page entirely, so there is no category state to capture
  // or restore here.
  redirect.registerStateAdapter('notifications', {
    capture: () => {
      // Prefer the module's own getters so we snapshot exactly what
      // it considers active. Fall back to DOM inspection if those
      // getters aren't exposed by this build.
      const activeFilterBtn =
        document.querySelector('.filter-btn.active') ||
        document.querySelector('.filter-btn[aria-pressed="true"]');
      const sortSelect = document.getElementById('sortSelect');
      const searchInput = document.getElementById('searchInput');

      return {
        filter:
          (typeof notifications.getFilter === 'function' && notifications.getFilter()) ||
          (activeFilterBtn ? activeFilterBtn.dataset.filter : null),
        sort:
          (typeof notifications.getSort === 'function' && notifications.getSort()) ||
          (sortSelect ? sortSelect.value : null),
        search:
          (typeof notifications.getSearch === 'function' && notifications.getSearch()) ||
          (searchInput ? searchInput.value : ''),
        listScroll:
          context.root?.scrollTop || window.scrollY || 0,
      };
    },

    restore: (data) => {
      if (!data) return;

      // Re-apply filters in the order the module expects. Each call
      // is guarded so a missing setter on an older build does not
      // abort the whole restore.
      try {
        if (data.filter && typeof notifications.setFilter === 'function') {
          notifications.setFilter(data.filter);
        }
      } catch (e) { console.warn('[Notifications] restore filter failed:', e); }

      try {
        if (data.sort && typeof notifications.setSort === 'function') {
          notifications.setSort(data.sort);
        }
      } catch (e) { console.warn('[Notifications] restore sort failed:', e); }

      try {
        if (typeof data.search === 'string' && typeof notifications.setSearch === 'function') {
          notifications.setSearch(data.search);
        }
      } catch (e) { console.warn('[Notifications] restore search failed:', e); }

      // Restore scroll on the notifications list. Runs after a tick
      // so the list has re-rendered with the restored filters.
      if (typeof data.listScroll === 'number' && data.listScroll > 0) {
        requestAnimationFrame(() => {
          try { window.scrollTo(0, data.listScroll); } catch { /* ignore */ }
        });
      }
    },
  });

  // Initialize notifications core module (if not already)
  notifications.init();

  // Load notifications (respects cooldown)
  await notifications.loadNotifications(false);

  // Expose notifications globally for inline calls (if any)
  window.notifications = notifications;

  // Attach event listeners
  attachEventListeners(context);

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a just-completed round
  // trip. Pop the entry so the stack does not grow on subsequent
  // redirects. Covers the case where the returning page used
  // history.back() instead of consumeAndReturn().
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
    console.warn('[Notifications] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // UI snapshot restores the search input value and scroll; the
  // adapter above re-applies filter and sort through the module so
  // the notification list renders with the correct subset.
  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[Notifications] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

  console.log('[NotificationsPage] Initialized');
}

function attachEventListeners(context) {
  // Back button — plain navigation. The user is done with this page;
  // there is nothing to return to.
  const backBtn = $('#backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }

  // Mark all read
  const markAllReadBtn = $('#markAllReadBtn');
  if (markAllReadBtn) {
    markAllReadBtn.addEventListener('click', notifications.markAllRead);
  }

  // Settings button (go to profile)
  const settingsBtn = $('#settingsBtn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => router.navigateTo('profile'));
  }

  // Filter tabs — the only filter dimension left after chips were
  // removed. Five tabs: All / Unread / Pinned / Archived / Important.
  context.root.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      notifications.setFilter(btn.dataset.filter);
    });
  });

  // Sort select
  const sortSelect = $('#sortSelect');
  if (sortSelect) {
    sortSelect.addEventListener('change', () => {
      notifications.setSort(sortSelect.value);
    });
  }

  // Search input
  const searchInput = $('#searchInput');
  const clearSearch = $('#clearSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      notifications.setSearch(e.target.value);
      if (clearSearch) {
        clearSearch.classList.toggle('visible', e.target.value.length > 0);
      }
    });
  }
  if (clearSearch) {
    clearSearch.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      notifications.setSearch('');
      clearSearch.classList.remove('visible');
    });
  }

  // Refresh / retry buttons
  const refreshEmptyBtn = $('#refreshEmptyBtn');
  if (refreshEmptyBtn) {
    refreshEmptyBtn.addEventListener('click', () => notifications.loadNotifications(true));
  }
  const retryBtn = $('#retryBtn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => notifications.loadNotifications(true));
  }

  // Floating buttons
  const scrollTopBtn = $('#scrollTopBtn');
  if (scrollTopBtn) {
    scrollTopBtn.addEventListener('click', () => {
      context.root.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  const helpBtn = $('#helpBtn');
  if (helpBtn) {
    helpBtn.addEventListener('click', notifications.openHelp);
  }

  // Compose button (admin) – future
  // const composeBtn = $('#composeBtn');
  // logic to show/hide could be added later
}

export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's DOM.
  try { redirect.unregisterStateAdapter('notifications'); } catch { /* ignore */ }
  // Notifications core module handles its own cleanup.
}