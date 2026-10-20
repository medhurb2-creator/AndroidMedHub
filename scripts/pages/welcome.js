// scripts/pages/welcome.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';

export async function init(context) {
  ui.applyTheme();

  // ── Already authenticated ────────────────────────────────────────
  // Resolve any pending chain. Welcome is not the target of a
  // redirect — if a chain exists, it points somewhere the user
  // actually wanted to go; pop it. Otherwise land on subjects.
  //
  // (Replaces `app.checkAuth()` — the `window.app` global works but
  // is fragile; every other page uses the imported auth module.)
  if (auth.checkAuth()) {
    redirect.consumeAndReturn('subjects');
    return;
  }

  const $ = (sel) => context.root.querySelector(sel);

  // ── Pending redirect context ─────────────────────────────────────
  // Two sources, checked in order:
  //
  //   1. The redirect module's readRedirectContext() — reads URL
  //      first (?returnTo= / legacy ?redirect=), then the top of
  //      the return stack. This is the canonical source.
  //
  //   2. The legacy sessionStorage key 'redirectAfterLogin' — kept
  //      as a fallback for any older code that still writes to it.
  //
  // Welcome itself never pushes onto the stack; it only forwards
  // whatever context it finds to login/signup so the outer chain
  // survives.
  const moduleCtx = redirect.readRedirectContext();
  let pendingRedirectParam = null;

  if (moduleCtx.hasContext && moduleCtx.returnTo) {
    pendingRedirectParam = moduleCtx.returnTo;
  } else {
    // Legacy fallback — sessionStorage key written by older flows.
    try {
      const legacy = sessionStorage.getItem('redirectAfterLogin');
      if (legacy && legacy.startsWith('/')) pendingRedirectParam = legacy;
    } catch { /* ignore */ }
  }

  // Helper: build a login/signup URL that carries the redirect
  // context forward. If there is no context, it is just the plain
  // route.
  function buildAuthUrl(base) {
    if (!pendingRedirectParam) return base;
    let url = `${base}?returnTo=${encodeURIComponent(pendingRedirectParam)}`;
    if (moduleCtx.reason) {
      url += `&redirect_reason=${encodeURIComponent(moduleCtx.reason)}`;
    }
    return url;
  }

  const loginBtn = $('#loginBtn');
  const signupBtn = $('#signupBtn');
  const guestBtn = $('#guestBtn');
  const backHomeBtn = $('#backHomeBtn');
  const themeToggle = $('#themeToggle');

  // ── Login ────────────────────────────────────────────────────────
  // Plain navigation, NOT navigateWithReturn. Welcome is where the
  // user came FROM to log in; after login they should land on their
  // destination (or subjects), not back on welcome. Any pending
  // chain is preserved by passing it through as a URL param — the
  // login page reads it via readRedirectContext() and pops the
  // chain on success.
  if (loginBtn) {
    loginBtn.addEventListener('click', () => {
      router.navigateTo(buildAuthUrl('login'));
    });
  }

  // ── Signup ───────────────────────────────────────────────────────
  // Same reasoning as login.
  if (signupBtn) {
    signupBtn.addEventListener('click', () => {
      router.navigateTo(buildAuthUrl('signup'));
    });
  }

  // ── Guest ────────────────────────────────────────────────────────
  // Plain navigation. The subjects page has its own auth gate that
  // will round-trip through login — so a guest tapping this button
  // lands on login, and after auth returns to subjects. Whether
  // that's the intended "guest" experience is a product decision;
  // if guests should browse without auth, the subjects page would
  // need a guest mode. Today, this button just forwards to the
  // normal flow.
  if (guestBtn) {
    guestBtn.addEventListener('click', () => {
      router.navigateTo('subjects');
    });
  }

  // ── Back to Home ─────────────────────────────────────────────────
  // Plain navigation. Home is the root; the user is explicitly
  // stepping back from the auth flow.
  if (backHomeBtn) {
    backHomeBtn.addEventListener('click', () => {
      router.navigateTo('index');
    });
  }

  // ── Theme toggle ─────────────────────────────────────────────────
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      ui.toggleTheme();
    });
  }
}

export function destroy() {
  // Welcome registers no state adapter and holds no listeners
  // outside the page DOM. Nothing to tear down.
}