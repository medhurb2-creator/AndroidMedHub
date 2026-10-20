// scripts/pages/offline.js
import * as router from '../router.js';
import * as redirect from '../redirect.js';

let $;

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  // ── Read the pending redirect context (if any) ───────────────────
  // If a gated page sent the user here because a network call failed,
  // the return stack still holds their original destination. We use
  // that to (a) show a hint about what they were reaching for and
  // (b) make the Retry button pop the chain instead of dumping them
  // on the home page.
  //
  // Offline does NOT register a state adapter and does NOT push
  // itself onto the return stack — it is a status page, not a
  // resolver. Pushing here would corrupt any chain the caller was
  // already holding.
  let ctx = { returnTo: null, reason: null, hasContext: false };
  try {
    ctx = redirect.readRedirectContext();
  } catch (err) {
    console.warn('[Offline] Could not read redirect context:', err);
  }

  // ── Render the "what were you trying to do" hint ────────────────
  // Optional: the page HTML may or may not contain a hint element.
  // If it does, we fill it in; if not, we do nothing. Both are valid.
  if (ctx.hasContext && ctx.returnTo) {
    const hintEl = document.getElementById('offline-return-hint');
    if (hintEl) {
      // Extract a human-readable page name from the pending URL.
      //   "/exam-room/123?q=4" → "exam-room"
      //   "/shared-note?token=abc" → "shared-note"
      let pretty = 'your page';
      try {
        const pathOnly = String(ctx.returnTo).split(/[?#]/)[0];
        const segments = pathOnly.replace(/^\/+/, '').split('/').filter(Boolean);
        // First segment is the page name; prefer it if it looks sane.
        if (segments.length && /^[a-z][\w-]*$/i.test(segments[0])) {
          pretty = segments[0].replace(/-/g, ' ');
        }
      } catch { /* keep default */ }

      hintEl.textContent = `You were trying to open ${pretty}.`;
      hintEl.style.display = 'block';
    }
  }

  // ── Retry button ─────────────────────────────────────────────────
  // If a redirect chain is pending, pop it — the user lands back on
  // the page that sent them here, which will re-run its own network
  // call and (hopefully) succeed now that the network is back.
  //
  // Otherwise fall through to the default landing behaviour that
  // was in place before: go to the app root.
  const retryBtn = $('#retryBtn');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      try {
        if (redirect.hasReturn()) {
          redirect.consumeAndReturn('index');
          return;
        }
        // Also honour a returnTo that only lives in the URL (survives
        // a full reload even when the session-storage stack was
        // cleared).
        if (ctx.hasContext && ctx.returnTo) {
          router.navigateTo(ctx.returnTo);
          return;
        }
      } catch (err) {
        console.warn('[Offline] Retry resolution failed, falling back:', err);
      }

      router.navigateTo('index');
    });
  }

  console.log('[Offline] Initialized', ctx.hasContext ? `(pending return: ${ctx.returnTo})` : '(no pending return)');
}

export function destroy() {
  // No adapter registered, no timers, no listeners outside the page
  // DOM — nothing to tear down. The page-manager removes the DOM.
}