// scripts/pages/welcome.js

import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';

let cleanupCurrentPage = null;

/**

* Initialize the welcome page.
* 
* Expected page elements:
* #loginBtn
* #signupBtn
* #guestBtn       (optional)
* #backHomeBtn
* #themeToggle
* 
* The page may omit optional elements without throwing errors.
  */
  export async function init(context) {
  // Protect against repeated initialization without destruction.
  cleanupCurrentPage?.();
  cleanupCurrentPage = null;

const root = context?.root;

if (!root || typeof root.querySelector !== 'function') {
console.error('[Welcome] Missing or invalid page root.');
return;
}

// Apply the application's existing theme.
ui.applyTheme();

// Already authenticated users should continue to their destination.
if (auth.checkAuth()) {
redirect.consumeAndReturn('subjects');
return;
}

const $ = (selector) => root.querySelector(selector);

// Track listeners so they can be removed when the SPA leaves this page.
const removers = [];

function listen(element, eventName, handler) {
if (!element) return;

element.addEventListener(eventName, handler);

removers.push(() => {
  element.removeEventListener(eventName, handler);
});

}

function cleanup() {
while (removers.length > 0) {
const remove = removers.pop();

  try {
    remove();
  } catch {
    // Cleanup should not prevent other listeners from being removed.
  }
}

}

cleanupCurrentPage = cleanup;

// ---------------------------------------------------------------
// PENDING REDIRECT CONTEXT
// ---------------------------------------------------------------
// Priority:
//   1. Canonical redirect module context.
//   2. Legacy sessionStorage fallback.
//
// The welcome page forwards existing context; it does not create
// a new redirect-chain entry.
// ---------------------------------------------------------------

let moduleCtx = {
hasContext: false,
returnTo: null,
reason: null
};

try {
const result = redirect.readRedirectContext();

if (result && typeof result === 'object') {
  moduleCtx = result;
}

} catch (error) {
console.warn('[Welcome] Could not read redirect context.', error);
}

let pendingRedirectParam = null;

if (
moduleCtx.hasContext &&
typeof moduleCtx.returnTo === 'string' &&
moduleCtx.returnTo.startsWith('/')
) {
pendingRedirectParam = moduleCtx.returnTo;
} else {
// Legacy fallback for older code paths.
try {
const legacy = sessionStorage.getItem('redirectAfterLogin');

  if (typeof legacy === 'string' && legacy.startsWith('/')) {
    pendingRedirectParam = legacy;
  }
} catch {
  // Storage can be unavailable in restricted browser contexts.
}

}

/**

* Build an auth route while preserving the user's destination.
* 
* Example:
* login?returnTo=%2Fresource-browser&redirect_reason=auth
* 
* If no pending destination exists, use the plain route.
  */
  function buildAuthUrl(base) {
  if (!pendingRedirectParam) {
  return base;
  }

const params = new URLSearchParams();

params.set('returnTo', pendingRedirectParam);

if (
  typeof moduleCtx.reason === 'string' &&
  moduleCtx.reason.length > 0
) {
  params.set('redirect_reason', moduleCtx.reason);
}

return `${base}?${params.toString()}`;

}

// ---------------------------------------------------------------
// ELEMENT REFERENCES
// ---------------------------------------------------------------

const loginBtn = $('#loginBtn');
const signupBtn = $('#signupBtn');
const guestBtn = $('#guestBtn');
const backHomeBtn = $('#backHomeBtn');
const themeToggle = $('#themeToggle');

// ---------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------
// Do not use navigateWithReturn here. Welcome is the entry point
// to authentication, not the destination to return to afterward.
// ---------------------------------------------------------------

listen(loginBtn, 'click', () => {
router.navigateTo(buildAuthUrl('login'));
});

// ---------------------------------------------------------------
// SIGNUP
// ---------------------------------------------------------------

listen(signupBtn, 'click', () => {
router.navigateTo(buildAuthUrl('signup'));
});

// ---------------------------------------------------------------
// GUEST / CONTINUE
// ---------------------------------------------------------------
// This retains the existing behavior: navigate to subjects.
// Actual guest access depends on the subjects page's auth gate.
// ---------------------------------------------------------------

listen(guestBtn, 'click', () => {
router.navigateTo('subjects');
});

// ---------------------------------------------------------------
// BACK TO HOME
// ---------------------------------------------------------------

listen(backHomeBtn, 'click', () => {
router.navigateTo('index');
});

// ---------------------------------------------------------------
// THEME TOGGLE
// ---------------------------------------------------------------
// Let the existing UI module remain the source of truth for theme
// state. The CSS supports the theme selectors used by the app.
// ---------------------------------------------------------------

if (themeToggle) {
listen(themeToggle, 'click', () => {
ui.toggleTheme();

  // Update the button's accessible state if the UI module applies
  // a recognizable theme class or data-theme attribute.
  const isDark = getCurrentTheme(root);

  themeToggle.setAttribute(
    'aria-pressed',
    isDark ? 'true' : 'false'
  );
});

// Synchronize accessibility state on initial render.
themeToggle.setAttribute(
  'aria-pressed',
  getCurrentTheme(root) ? 'true' : 'false'
);

}
}

/**

* Detect common theme conventions without changing application state.
* 
* Adjust this helper if ui.js uses a different theme convention.
  */
  function getCurrentTheme(root) {
  const html = document.documentElement;
  const body = document.body;

return (
html.classList.contains('dark') ||
body.classList.contains('dark') ||
root.classList.contains('dark') ||
html.dataset.theme === 'dark' ||
body.dataset.theme === 'dark' ||
root.dataset.theme === 'dark'
);
}

/**

* Called by the SPA when navigating away from the welcome page.
  */
  export function destroy() {
  cleanupCurrentPage?.();
  cleanupCurrentPage = null;
  }