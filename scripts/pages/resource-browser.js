// scripts/pages/resource-browser.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as auth from '../auth.js';
import * as subscription from '../subscription.js';
import * as resourceBrowser from '../resource-browser.js';

let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  if (!auth.checkAuth()) {
    router.navigateTo('login');
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const subject = params.get('subject');
  const type = params.get('type');

  if (!subject || !type) {
    ui.showToast('Invalid resource request', 'error');
    router.navigateTo('subjects');
    return;
  }

  // ---------------------------------------------------------------------------
  // Initialize the subscription manager BEFORE the resource browser.
  //
  // The Open handler in resource-browser.js calls
  // subscription.hasActiveSubscription() to decide whether a premium
  // catalogue resource should open in preview mode (unsubscribed) or in full
  // (subscribed). hasActiveSubscription() reads from the subscription
  // manager's in-memory state, IndexedDB, and localStorage.
  //
  // Without an explicit init, the manager's in-memory state is empty on a
  // fresh session, and the fallback chain can return stale local data. On
  // page load we want the freshest truth from the backend (when online and
  // authenticated), which is exactly what initSubscription() obtains.
  //
  // This is idempotent — the subscription manager handles repeated calls —
  // and cannot fail the page: any network error falls back to cached state.
  // ---------------------------------------------------------------------------
  try {
    await subscription.initSubscription();
  } catch (err) {
    // Never block the resource browser on a subscription hiccup. The Open
    // handler will still work with whatever cached state is available.
    console.warn('[ResourceBrowser] subscription init failed; continuing with cached state', err);
  }

  // Attach event listeners
  const backBtn = $('#backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => router.navigateTo('subjects'));
  }
  const themeBtn = $('#themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', ui.toggleTheme);
  }

  // Expose globals for viewer.js
  window.docMap = resourceBrowser.docMap;
  window.showViewer = resourceBrowser.showViewer;
  window.closeViewer = resourceBrowser.closeViewer;

  // ⚡ Force refresh: pass true to skip cache and call backend
  await resourceBrowser.initResourceBrowser(subject, type, true);

  console.log('[ResourceBrowser] Initialized (forced fresh load)');
}

export function destroy() {
  // Cleanup if needed
}