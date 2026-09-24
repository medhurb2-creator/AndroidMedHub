// scripts/auth/google.js

/**
 * Google Identity Services (GIS) Wrapper
 * --------------------------------------
 * Loads Google's GIS library once, renders the official Google button into a
 * container, and hands the resulting Google ID token back to the caller via
 * a callback.
 *
 * This module does NOT authenticate the user against MedVix.
 * It only obtains a Google ID token (a signed JWT) that the caller then sends
 * to the MedVix backend for verification.
 *
 * Usage:
 *   import { initGoogleSignIn, disableGoogleAutoSelect } from '../auth/google.js';
 *
 *   await initGoogleSignIn({
 *     container: document.getElementById('google-container'),
 *     text: 'continue_with',           // or 'signup_with' / 'signin_with'
 *     onCredential: async (response) => {
 *       const idToken = response.credential;
 *       // send idToken to your backend
 *     },
 *   });
 *
 * Public API:
 *   - initGoogleSignIn(opts)         → load GIS, render button, register callback
 *   - disableGoogleAutoSelect()      → clear Google's local account hint
 *   - promptGoogleOneTap()           → (optional) show Google One Tap
 *   - GOOGLE_WEB_CLIENT_ID           → the OAuth web client ID used
 *   - isGisReady()                   → whether GIS has finished loading
 */

// ============================================================
// CONSTANTS
// ============================================================

/**
 * Google OAuth 2.0 Web Client ID.
 * This value is public and safe to ship in frontend code.
 * It is NOT a client secret.
 *
 * To use a different environment (e.g. staging), change this constant
 * or inject it via `window.MEDVIX_GOOGLE_CLIENT_ID`.
 */
export const GOOGLE_WEB_CLIENT_ID =
  (typeof window !== 'undefined' && window.MEDVIX_GOOGLE_CLIENT_ID) ||
  '811569563531-s9dhe1v0jvgdo0ii48ce7h933l07pq9k.apps.googleusercontent.com';

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';
const GIS_SCRIPT_ID = 'medvix-gis-script';

// ============================================================
// MODULE STATE
// ============================================================

let gisLoaded = false;
let gisLoadPromise = null;
let gisInitialized = false;
let currentCallback = null;
let currentNonce = null;

// ============================================================
// SCRIPT LOADING
// ============================================================

/**
 * Load the Google Identity Services script exactly once.
 * Safe to call multiple times; subsequent calls return the same promise.
 *
 * @returns {Promise<void>}
 */
function loadGisScript() {
  if (gisLoaded && window.google?.accounts?.id) {
    return Promise.resolve();
  }
  if (gisLoadPromise) {
    return gisLoadPromise;
  }

  gisLoadPromise = new Promise((resolve, reject) => {
    // If the script tag already exists (e.g. from a previous SPA navigation),
    // wait for the `google` global to appear.
    const existing = document.getElementById(GIS_SCRIPT_ID);

    if (existing) {
      if (window.google?.accounts?.id) {
        gisLoaded = true;
        resolve();
        return;
      }
      // Script element is present but not yet executed — poll briefly.
      let attempts = 0;
      const maxAttempts = 50; // 50 * 100ms = 5s
      const poll = setInterval(() => {
        attempts += 1;
        if (window.google?.accounts?.id) {
          clearInterval(poll);
          gisLoaded = true;
          resolve();
        } else if (attempts >= maxAttempts) {
          clearInterval(poll);
          reject(new Error('Timed out waiting for Google Identity Services'));
        }
      }, 100);
      return;
    }

    // Inject a fresh script tag.
    const script = document.createElement('script');
    script.id = GIS_SCRIPT_ID;
    script.src = GIS_SCRIPT_SRC;
    script.async = true;
    script.defer = true;

    script.onload = () => {
      gisLoaded = true;
      // GIS script defines `window.google.accounts.id` synchronously on load.
      if (!window.google?.accounts?.id) {
        reject(new Error('Google Identity Services loaded but API is missing'));
        return;
      }
      resolve();
    };

    script.onerror = () => {
      gisLoadPromise = null; // allow retry
      reject(new Error('Failed to load Google Identity Services'));
    };

    document.head.appendChild(script);
  });

  return gisLoadPromise;
}

// ============================================================
// INTERNAL HELPERS
// ============================================================

/**
 * Generate a random nonce (used to protect against token replay).
 * Uses crypto.getRandomValues when available, falls back to Math.random.
 *
 * @returns {string}
 */
function generateNonce() {
  try {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return (
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 10)
    );
  }
}

/**
 * Handle the credential response delivered by Google.
 * Forwards the raw response to the currently registered callback.
 *
 * @param {Object} response - { credential, clientId, select_by }
 */
function handleCredentialResponse(response) {
  if (!response || !response.credential) {
    console.warn('[Google] Credential response missing a token');
    return;
  }
  if (typeof currentCallback !== 'function') {
    console.warn('[Google] No onCredential callback registered');
    return;
  }
  try {
    currentCallback(response);
  } catch (err) {
    console.error('[Google] onCredential callback threw:', err);
  }
}

/**
 * Ensure the container element is visible and has non-zero width.
 * GIS will not render a button into a 0-width element.
 *
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function isRenderable(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  return el.offsetWidth > 0 || el.getBoundingClientRect().width > 0;
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Whether the Google Identity Services library is ready to use.
 * @returns {boolean}
 */
export function isGisReady() {
  return gisLoaded && !!window.google?.accounts?.id;
}

/**
 * Initialise Google Sign-In and render the official Google button.
 *
 * @param {Object} opts
 * @param {HTMLElement|string} opts.container
 *        The element (or element ID) into which the button will be rendered.
 * @param {Function} opts.onCredential
 *        Called with the raw Google response object once the user completes
 *        sign-in. The ID token is available as `response.credential`.
 * @param {'continue_with'|'signin_with'|'signup_with'} [opts.text='continue_with']
 *        Button label variant.
 * @param {'outline'|'filled_blue'|'filled_black'} [opts.theme='outline']
 *        Button theme.
 * @param {'large'|'medium'|'small'} [opts.size='large']
 *        Button size.
 * @param {'rectangular'|'pill'|'circle'|'square'} [opts.shape='rectangular']
 *        Button shape.
 * @param {number} [opts.width] 
 *        Button width in pixels. Defaults to the container's width.
 * @param {boolean} [opts.useNonce=false]
 *        If true, a nonce will be generated and passed to Google.
 *        The same nonce should be validated by the backend.
 * @returns {Promise<void>}
 */
export async function initGoogleSignIn(opts = {}) {
  const {
    container,
    onCredential,
    text = 'continue_with',
    theme = 'outline',
    size = 'large',
    shape = 'rectangular',
    width,
    useNonce = false,
  } = opts;

  // Resolve the container.
  const el =
    typeof container === 'string'
      ? document.getElementById(container)
      : container;

  if (!el) {
    console.warn('[Google] Container element not found');
    return;
  }

  if (typeof onCredential !== 'function') {
    console.warn('[Google] onCredential callback is required');
    return;
  }

  // Store the callback so handleCredentialResponse can forward to it.
  currentCallback = onCredential;

  // Ensure the GIS library is loaded.
  try {
    await loadGisScript();
  } catch (err) {
    console.error('[Google] Failed to load GIS library:', err);
    return;
  }

  if (!window.google?.accounts?.id) {
    console.error('[Google] GIS API is not available after load');
    return;
  }

  // GIS does not like being initialised multiple times with different
  // callbacks in the same page load, but it *does* support re-init with
  // the same client_id. We re-init every time so the callback is always
  // the latest one registered by the current page.
  try {
    const initConfig = {
      client_id: GOOGLE_WEB_CLIENT_ID,
      callback: handleCredentialResponse,
      auto_select: false,
      cancel_on_tap_outside: true,
      ux_mode: 'popup',
    };

    if (useNonce) {
      currentNonce = generateNonce();
      initConfig.nonce = currentNonce;
    }

    window.google.accounts.id.initialize(initConfig);
    gisInitialized = true;
  } catch (err) {
    console.error('[Google] Failed to initialise GIS:', err);
    return;
  }

  // Clear any previous button before rendering.
  el.innerHTML = '';

  // GIS requires a real, laid-out element. If the container is inside a
  // hidden step, wait one frame for layout to settle.
  if (!isRenderable(el)) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  // Render the official Google button.
  try {
    window.google.accounts.id.renderButton(el, {
      type: 'standard',
      theme,
      size,
      text,
      shape,
      logo_alignment: 'left',
      width: width || Math.min(el.clientWidth || 320, 400),
    });
  } catch (err) {
    console.error('[Google] Failed to render button:', err);
  }
}

/**
 * Show the Google One Tap prompt.
 * Only call this when the user has not just signed out.
 */
export function promptGoogleOneTap() {
  if (!window.google?.accounts?.id || !gisInitialized) {
    console.warn('[Google] Cannot prompt One Tap: GIS not initialised');
    return;
  }
  try {
    window.google.accounts.id.prompt();
  } catch (err) {
    console.warn('[Google] One Tap prompt failed:', err);
  }
}

/**
 * Disable Google's account auto-select for this browser session.
 * Call this after a sign-out, or after a failed/linked-account flow,
 * so Google does not auto-pick the previous account next time.
 */
export function disableGoogleAutoSelect() {
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch (err) {
    // Non-fatal.
    console.warn('[Google] disableAutoSelect failed:', err);
  }
}

/**
 * Cancel any in-progress GIS operations (e.g. close the One Tap prompt).
 * Safe to call even if GIS was never initialised.
 */
export function cancelGoogleSignIn() {
  try {
    window.google?.accounts?.id?.cancel();
  } catch {
    // ignore
  }
}

/**
 * Read the last-generated nonce (if `useNonce: true` was passed).
 * Send this to the backend along with the ID token so it can verify
 * that the token was not replayed.
 *
 * @returns {string|null}
 */
export function getLastNonce() {
  return currentNonce;
}

/**
 * Reset the module's internal state.
 * Mostly useful in tests or when the SPA is torn down between pages.
 */
export function _resetGoogleModule() {
  gisInitialized = false;
  currentCallback = null;
  currentNonce = null;
}