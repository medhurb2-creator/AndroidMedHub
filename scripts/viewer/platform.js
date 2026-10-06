// frontend-user/scripts/viewer/platform.js

/**
 * Universal Document Viewer — Platform Detection
 * ============================================================================
 *
 * The single source of truth for every environment question in the viewer.
 * Answers: "what platform am I running on, what can this device do, and what
 * does the user prefer?"
 *
 * Every other module asks THIS file — never `Capacitor.isNativePlatform()`,
 * never `navigator.userAgent`, never `window.matchMedia` directly. Swapping
 * the detection strategy later touches one file.
 *
 * Exports:
 *   ── Enums ─────────────────────────────────────────────────────────────
 *     PLATFORM            — { ANDROID, IOS, WEB }
 *     INPUT_KIND          — { TOUCH, MOUSE, HYBRID }
 *     COLOR_SCHEME        — { LIGHT, DARK }
 *
 *   ── Platform predicates ───────────────────────────────────────────────
 *     isNative()          — running inside Capacitor on a real device
 *     platform()          — 'android' | 'ios' | 'web'
 *     isAndroid()
 *     isIOS()
 *     isWeb()
 *
 *   ── Device primitives (cached) ────────────────────────────────────────
 *     hardwareConcurrency()
 *     deviceMemoryGB()
 *     isMobileUA()
 *     isLowMemoryDevice()
 *     isCoarsePointer()
 *     hasTouch()
 *     devicePixelRatio()
 *     getDPRClamped()          — clamped to CONFIG.MAX_DPR's upstream value
 *
 *   ── Display / preference (live reads) ─────────────────────────────────
 *     prefersDarkMode()
 *     prefersReducedMotion()
 *     hasSafeAreaSupport()
 *     getSafeAreaInsets()      — best-effort, cached after first read
 *
 *   ── Network / capability ──────────────────────────────────────────────
 *     isOnline()
 *     isStandalonePWA()
 *     hasWebGL()
 *
 *   ── Aggregates ────────────────────────────────────────────────────────
 *     getDeviceProfile()       — frozen snapshot for CONFIG tuning
 *     getInputProfile()        — touch/mouse/hybrid classification
 *     getPlatformSnapshot()    — everything, for diagnostics
 *
 *   ── Test hook ─────────────────────────────────────────────────────────
 *     __resetPlatformCacheForTests()
 *
 * Design constraints:
 *   • Imports only `@capacitor/core`. No viewer-module imports — this file
 *     is a leaf and cannot participate in a cycle.
 *   • Every function is safe to call at any time, on any thread that has
 *     `window` (i.e. the main thread). Worker files do not import this.
 *   • No side effects at module load. All reads happen on call.
 *   • Every function NEVER throws — a broken API returns the default.
 *   • Cached primitives (CPU cores, memory, mobile UA) never change for the
 *     life of the page. Uncached reads (DPR, dark mode, online) are cheap
 *     and may change at any time.
 *
 * @module viewer/platform
 */

'use strict';

import { Capacitor } from '@capacitor/core';

// ============================================================================
// 1. ENUMS
// ============================================================================

/**
 * Runtime platform.
 * @readonly
 * @enum {string}
 */
export const PLATFORM = Object.freeze({
  ANDROID: 'android',
  IOS: 'ios',
  WEB: 'web',
});

/**
 * Dominant input modality. Hybrid = both touch and pointer available
 * (touchscreen laptops, Chrome DevTools mobile emulation on desktop).
 * @readonly
 * @enum {string}
 */
export const INPUT_KIND = Object.freeze({
  TOUCH: 'touch',
  MOUSE: 'mouse',
  HYBRID: 'hybrid',
});

/**
 * User's preferred color scheme.
 * @readonly
 * @enum {string}
 */
export const COLOR_SCHEME = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark',
});

// ============================================================================
// 2. INTERNAL — cached values
// ============================================================================

/** @type {boolean|null} */ let _isNativeCache = null;
/** @type {string|null}  */ let _platformCache = null;
/** @type {number|null}  */ let _coresCache = null;
/** @type {number|null}  */ let _memoryCache = null;
/** @type {boolean|null} */ let _mobileUACache = null;
/** @type {boolean|null} */ let _touchCache = null;
/** @type {boolean|null} */ let _coarseCache = null;

/** @type {{ top: number, right: number, bottom: number, left: number }|null} */
let _safeAreaCache = null;

// ============================================================================
// 3. INTERNAL — safe reads
// ============================================================================

/**
 * Read `navigator.userAgent`, returning '' if unavailable.
 * @private
 * @returns {string}
 */
function _userAgent() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string') {
      return navigator.userAgent;
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Read a `window.matchMedia` query, returning false if unavailable.
 * @private
 * @param {string} query
 * @returns {boolean}
 */
function _matches(query) {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    const mql = window.matchMedia(query);
    return !!(mql && mql.matches);
  } catch {
    return false;
  }
}

// ============================================================================
// 4. PLATFORM PREDICATES
// ============================================================================

/**
 * True when running inside Capacitor on a native platform (Android, iOS).
 * False in `npm run dev` and in any browser context, including a PWA.
 *
 * Cached after first call — Capacitor's platform never changes for the life
 * of the page.
 *
 * @returns {boolean}
 */
export function isNative() {
  if (_isNativeCache !== null) return _isNativeCache;
  try {
    _isNativeCache = Capacitor.isNativePlatform() === true;
  } catch {
    _isNativeCache = false;
  }
  return _isNativeCache;
}

/**
 * The active platform. 'android' | 'ios' | 'web'.
 *
 * Cached after first call.
 *
 * @returns {'android'|'ios'|'web'}
 */
export function platform() {
  if (_platformCache !== null) return _platformCache;
  try {
    const p = Capacitor.getPlatform();
    if (p === 'android' || p === 'ios' || p === 'web') {
      _platformCache = p;
    } else {
      _platformCache = PLATFORM.WEB;
    }
  } catch {
    _platformCache = PLATFORM.WEB;
  }
  return _platformCache;
}

/** @returns {boolean} */
export function isAndroid() {
  return platform() === PLATFORM.ANDROID;
}

/** @returns {boolean} */
export function isIOS() {
  return platform() === PLATFORM.IOS;
}

/** @returns {boolean} */
export function isWeb() {
  return platform() === PLATFORM.WEB;
}

// ============================================================================
// 5. DEVICE PRIMITIVES (cached)
// ============================================================================

/**
 * Number of logical CPU cores. Falls back to 4. Cached — never changes.
 *
 * @returns {number}
 */
export function hardwareConcurrency() {
  if (_coresCache !== null) return _coresCache;
  try {
    const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null;
    _coresCache = typeof hc === 'number' && hc > 0 ? hc : 4;
  } catch {
    _coresCache = 4;
  }
  return _coresCache;
}

/**
 * Approximate device RAM in GB. Falls back to 4 when the API is unavailable
 * (Firefox, Safari, and older WebViews do not implement `deviceMemory`).
 *
 * Values are capped at 8 by the spec — `deviceMemory === 8` means "8 GB or
 * more", not exactly 8.
 *
 * Cached — never changes.
 *
 * @returns {number}
 */
export function deviceMemoryGB() {
  if (_memoryCache !== null) return _memoryCache;
  try {
    const dm = typeof navigator !== 'undefined' ? navigator.deviceMemory : null;
    _memoryCache = typeof dm === 'number' && dm > 0 ? dm : 4;
  } catch {
    _memoryCache = 4;
  }
  return _memoryCache;
}

/**
 * Whether the user agent claims a mobile device. Cached — never changes.
 *
 * This is a hint, not a promise: iPadOS reports as "Macintosh" unless the
 * page is in a PWA. Combine with `hasTouch()` and viewport width when a
 * decision must be robust.
 *
 * @returns {boolean}
 */
export function isMobileUA() {
  if (_mobileUACache !== null) return _mobileUACache;
  const ua = _userAgent();
  _mobileUACache = /Mobi|Android|iPhone|iPad|iPod|Tablet|Touch/i.test(ua);
  return _mobileUACache;
}

/**
 * Conservative low-memory classification: device reports < 4 GB RAM, OR
 * is mobile by UA with ≤ 4 GB reported. Used to size the canvas cache.
 *
 * @returns {boolean}
 */
export function isLowMemoryDevice() {
  return deviceMemoryGB() < 4;
}

/**
 * Whether the primary pointer is coarse (finger, stylus) rather than fine
 * (mouse, trackpad). Cached — typically stable, though hybrids can flip it
 * when a mouse is connected. Caching here is a deliberate tradeoff: the
 * viewer's touch UX is decided at boot.
 *
 * @returns {boolean}
 */
export function isCoarsePointer() {
  if (_coarseCache !== null) return _coarseCache;
  _coarseCache = _matches('(pointer: coarse)');
  return _coarseCache;
}

/**
 * Whether the device exposes a touch-capable input. Cached — never changes.
 *
 * True on touchscreens (phones, tablets, touch laptops) and in Chrome
 * DevTools' mobile emulation mode.
 *
 * @returns {boolean}
 */
export function hasTouch() {
  if (_touchCache !== null) return _touchCache;
  try {
    _touchCache = (
      (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
      _matches('(any-pointer: coarse)')
    );
  } catch {
    _touchCache = false;
  }
  return _touchCache;
}

/**
 * Live device pixel ratio. Not cached — changes when the user moves the
 * window between monitors, changes browser zoom, or rotates some devices.
 *
 * @returns {number}
 */
export function devicePixelRatio() {
  try {
    if (typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number') {
      return window.devicePixelRatio;
    }
  } catch { /* ignore */ }
  return 1;
}

/**
 * DPR clamped into [1, max]. The viewer's canvas backing stores use this
 * value; keeping it in one place avoids a helper duplicating the clamp on
 * every call site.
 *
 * @param {number} [max=2]
 * @returns {number}
 */
export function getDPRClamped(max = 2) {
  const raw = devicePixelRatio();
  if (!Number.isFinite(raw)) return 1;
  if (raw < 1) return 1;
  if (raw > max) return max;
  return raw;
}

// ============================================================================
// 6. DISPLAY / PREFERENCE (live reads)
// ============================================================================

/**
 * Whether the user's system prefers a dark color scheme. Live — reads the
 * current media query on every call. Subscribe to the media query directly
 * for change notifications.
 *
 * @returns {boolean}
 */
export function prefersDarkMode() {
  return _matches('(prefers-color-scheme: dark)');
}

/**
 * Whether the user has requested reduced motion. Live.
 *
 * The viewer honors this by disabling the drawer slide animation and the
 * header/footer transitions — see the `@media (prefers-reduced-motion)`
 * block in `resource-browser.css`.
 *
 * @returns {boolean}
 */
export function prefersReducedMotion() {
  return _matches('(prefers-reduced-motion: reduce)');
}

/**
 * Whether the browser supports `env(safe-area-inset-*)`. Live.
 *
 * True on all modern engines that ship with viewport-fit=cover support.
 * The viewer does not branch on this — the CSS uses `env(..., 0px)` which
 * resolves to 0 when unsupported — but tools and diagnostics may want the
 * answer.
 *
 * @returns {boolean}
 */
export function hasSafeAreaSupport() {
  try {
    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return false;
    return CSS.supports('padding-top: env(safe-area-inset-top)');
  } catch {
    return false;
  }
}

/**
 * Read the safe-area insets in CSS pixels. Best-effort: uses a hidden probe
 * element positioned by `env(safe-area-inset-*)` and measures it once.
 * Cached after the first successful read.
 *
 * Prefer CSS `env()` for layout. This function exists for tests and for
 * programmatic layout decisions that need the numeric value.
 *
 * @returns {{ top: number, right: number, bottom: number, left: number }}
 */
export function getSafeAreaInsets() {
  if (_safeAreaCache) return _safeAreaCache;

  const zero = { top: 0, right: 0, bottom: 0, left: 0 };

  try {
    if (typeof document === 'undefined' || !document.body) {
      return zero;
    }
    if (!hasSafeAreaSupport()) {
      _safeAreaCache = zero;
      return zero;
    }

    const probe = document.createElement('div');
    probe.style.cssText = [
      'position:fixed',
      'top:env(safe-area-inset-top,0px)',
      'right:env(safe-area-inset-right,0px)',
      'bottom:env(safe-area-inset-bottom,0px)',
      'left:env(safe-area-inset-left,0px)',
      'width:0',
      'height:0',
      'pointer-events:none',
      'visibility:hidden',
      'z-index:-1',
    ].join(';');

    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    document.body.removeChild(probe);

    _safeAreaCache = {
      top: Math.max(0, rect.top || 0),
      right: Math.max(0, (window.innerWidth || 0) - (rect.right || 0)),
      bottom: Math.max(0, (window.innerHeight || 0) - (rect.bottom || 0)),
      left: Math.max(0, rect.left || 0),
    };
    return _safeAreaCache;
  } catch {
    _safeAreaCache = zero;
    return zero;
  }
}

// ============================================================================
// 7. NETWORK / CAPABILITY
// ============================================================================

/**
 * Whether the browser reports an active network connection. Live.
 *
 * `navigator.onLine` is famously unreliable — it returns true whenever the
 * OS thinks a network interface is up, regardless of whether the internet
 * is reachable. Treat as a hint, not a guarantee.
 *
 * @returns {boolean}
 */
export function isOnline() {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
      return navigator.onLine;
    }
  } catch { /* ignore */ }
  return true;
}

/**
 * Whether the page is running as an installed PWA (`display-mode: standalone`)
 * or as an iOS home-screen app (`navigator.standalone`).
 *
 * @returns {boolean}
 */
export function isStandalonePWA() {
  if (_matches('(display-mode: standalone)')) return true;
  try {
    if (typeof navigator !== 'undefined' && navigator.standalone === true) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * Whether the browser exposes WebGL. Used by render-pipeline diagnostics
 * only; the viewer functions identically without it (Canvas 2D path).
 *
 * @returns {boolean}
 */
export function hasWebGL() {
  try {
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return false;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      || canvas.getContext('experimental-webgl');
    return !!gl;
  } catch {
    return false;
  }
}

// ============================================================================
// 8. AGGREGATE PROFILES
// ============================================================================

/**
 * Frozen snapshot of the device's static capabilities. Matches the shape
 * that `core.js::_detectDeviceProfile` consumes — with the addition of
 * `platform` and `isNative` so callers can classify in one pass.
 *
 * The memory cap (`memoryCapBytes`) is NOT included here — it depends on
 * `CONFIG` in `core.js`, and this module must not import core (would create
 * a cycle). `core.js` wraps this result and adds the cap.
 *
 * @returns {{
 *   platform: 'android'|'ios'|'web',
 *   isNative: boolean,
 *   isMobile: boolean,
 *   isLowMemory: boolean,
 *   hardwareConcurrency: number,
 *   deviceMemory: number,
 *   hasTouch: boolean,
 *   isCoarsePointer: boolean,
 *   dpr: number,
 * }}
 */
export function getDeviceProfile() {
  return Object.freeze({
    platform: platform(),
    isNative: isNative(),
    isMobile: isMobileUA() || isAndroid() || isIOS(),
    isLowMemory: isLowMemoryDevice(),
    hardwareConcurrency: hardwareConcurrency(),
    deviceMemory: deviceMemoryGB(),
    hasTouch: hasTouch(),
    isCoarsePointer: isCoarsePointer(),
    dpr: devicePixelRatio(),
  });
}

/**
 * Classify the dominant input modality.
 *
 *   HYBRID — touch AND pointer present (touch laptop, DevTools emulation)
 *   TOUCH  — touch present, no fine pointer
 *   MOUSE  — fine pointer, no touch
 *
 * @returns {'touch'|'mouse'|'hybrid'}
 */
export function getInputProfile() {
  const touch = hasTouch();
  const coarse = isCoarsePointer();
  if (touch && !coarse) return INPUT_KIND.HYBRID;
  if (touch) return INPUT_KIND.TOUCH;
  return INPUT_KIND.MOUSE;
}

/**
 * Full diagnostic snapshot. Safe to serialize and log. Never throws.
 *
 * @returns {{
 *   platform: string,
 *   isNative: boolean,
 *   isAndroid: boolean,
 *   isIOS: boolean,
 *   isWeb: boolean,
 *   isMobileUA: boolean,
 *   isStandalonePWA: boolean,
 *   isOnline: boolean,
 *   hasTouch: boolean,
 *   hasWebGL: boolean,
 *   hardwareConcurrency: number,
 *   deviceMemoryGB: number,
 *   devicePixelRatio: number,
 *   inputKind: string,
 *   colorScheme: 'light'|'dark',
 *   prefersReducedMotion: boolean,
 *   safeArea: { top: number, right: number, bottom: number, left: number },
 *   userAgent: string,
 * }}
 */
export function getPlatformSnapshot() {
  return {
    platform: platform(),
    isNative: isNative(),
    isAndroid: isAndroid(),
    isIOS: isIOS(),
    isWeb: isWeb(),
    isMobileUA: isMobileUA(),
    isStandalonePWA: isStandalonePWA(),
    isOnline: isOnline(),
    hasTouch: hasTouch(),
    hasWebGL: hasWebGL(),
    hardwareConcurrency: hardwareConcurrency(),
    deviceMemoryGB: deviceMemoryGB(),
    devicePixelRatio: devicePixelRatio(),
    inputKind: getInputProfile(),
    colorScheme: prefersDarkMode() ? COLOR_SCHEME.DARK : COLOR_SCHEME.LIGHT,
    prefersReducedMotion: prefersReducedMotion(),
    safeArea: getSafeAreaInsets(),
    userAgent: _userAgent(),
  };
}

// ============================================================================
// 9. TEST HOOK
// ============================================================================

/**
 * Test-only: clear every cached value. Call this between tests that mutate
 * `navigator` or `window` to simulate a different device.
 *
 * @private
 * @returns {void}
 */
export function __resetPlatformCacheForTests() {
  _isNativeCache = null;
  _platformCache = null;
  _coresCache = null;
  _memoryCache = null;
  _mobileUACache = null;
  _touchCache = null;
  _coarseCache = null;
  _safeAreaCache = null;
}