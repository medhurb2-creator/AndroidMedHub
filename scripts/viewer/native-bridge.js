// frontend-user/scripts/viewer/native-bridge.js

/**
 * Universal Document Viewer — Native Bridge
 * ============================================================================
 *
 * Every Capacitor plugin call in the viewer goes through this file. No other
 * module imports `@capacitor/*` plugins directly — only `platform.js` (which
 * owns `@capacitor/core`) and this file (which owns every plugin).
 *
 * Design contract:
 *
 *   1. `npm run dev` works with zero plugins loaded. Every function has a
 *      web fallback (browser API) or a silent no-op.
 *
 *   2. `npx cap run android` uses the real plugin. Every plugin is loaded via
 *      dynamic `import()` so Vite tree-shakes it out of the web bundle.
 *
 *   3. No function ever throws. A broken/missing plugin returns a default
 *      (false, no-op unsubscribe, resolved Promise).
 *
 *   4. Register functions return a SYNCHRONOUS unsubscribe function. The
 *      internal plugin registration is async; the returned unsub handles the
 *      disposal race correctly (registering late, unsubscribing early).
 *
 *   5. `setupNativeBridge(core)` is the one-shot bootstrap. It wires every
 *      listener the viewer needs and returns a single teardown function.
 *
 * Exports:
 *   ── Back button / lifecycle ──────────────────────────────────────────
 *     registerBackButton(onBack)
 *     onAppStateChange(handler)
 *
 *   ── Intents ──────────────────────────────────────────────────────────
 *     registerAppUrlOpen(handler)
 *
 *   ── Fullscreen / immersive ───────────────────────────────────────────
 *     enterFullscreen()
 *     exitFullscreen()
 *     isFullscreen()
 *
 *   ── Status bar ───────────────────────────────────────────────────────
 *     setStatusBarStyle({ visible, style, color })
 *
 *   ── Screen ───────────────────────────────────────────────────────────
 *     keepAwake()
 *     allowSleep()
 *
 *   ── Share / open-with ────────────────────────────────────────────────
 *     share({ title, text, url, dialogTitle })
 *     shareFile({ blob, filename, title, text, dialogTitle })
 *
 *   ── Haptics ──────────────────────────────────────────────────────────
 *     vibrate(patternOrMs)
 *     hapticLight()
 *     hapticMedium()
 *     hapticHeavy()
 *
 *   ── Environment subscriptions ────────────────────────────────────────
 *     onColorSchemeChange(handler)
 *     onNetworkStatusChange(handler)
 *     onSafeAreaChange(handler)
 *
 *   ── Bootstrap ────────────────────────────────────────────────────────
 *     setupNativeBridge(core)
 *
 * Import discipline:
 *   • `./platform.js` — the only viewer import (cycle-free leaf).
 *   • No imports from core, utils, or any sibling subsystem.
 *
 * @module viewer/native-bridge
 */

'use strict';

import { isNative, isWeb, prefersDarkMode, getSafeAreaInsets } from './platform.js';

// ============================================================================
// 1. BACK BUTTON / LIFECYCLE
// ============================================================================

/**
 * Register a handler for the hardware/gesture back button.
 *
 *   Android — intercepts the system back button. If `onBack()` returns true,
 *             the event is consumed. If it returns false, the app exits.
 *   Web     — binds the Escape key as a development proxy. Same consumption
 *             semantics: `onBack()` returning true suppresses default.
 *
 * The returned unsubscribe function is synchronous and safe to call even if
 * the native listener has not finished registering yet.
 *
 * @param {() => boolean} onBack
 * @returns {() => void}  unsubscribe
 */
export function registerBackButton(onBack) {
  if (typeof onBack !== 'function') return () => {};

  if (isWeb()) {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      try {
        if (onBack() === true) e.preventDefault();
      } catch { /* swallow — never let a handler break the key listener */ }
    };
    try {
      window.addEventListener('keydown', handler);
    } catch { /* ignore */ }
    return () => {
      try { window.removeEventListener('keydown', handler); } catch { /* ignore */ }
    };
  }

  // Native path — async registration with disposal race handling.
  let disposed = false;
  /** @type {null | (() => void)} */
  let nativeUnsub = null;

  (async () => {
    try {
      const { App } = await import('@capacitor/app');
      if (disposed) return;

      const sub = await App.addListener('backButton', () => {
        try {
          if (onBack() === true) return;
        } catch { /* ignore */ }
        try { App.exitApp(); } catch { /* ignore */ }
      });

      if (disposed) {
        try { sub.remove(); } catch { /* ignore */ }
        return;
      }
      nativeUnsub = () => { try { sub.remove(); } catch { /* ignore */ } };
    } catch { /* plugin unavailable — no back button handling */ }
  })();

  return () => {
    disposed = true;
    if (nativeUnsub) nativeUnsub();
  };
}

/**
 * Register a handler for app foreground/background transitions.
 *
 *   Android — fires when the app moves between foreground and background.
 *   Web     — bridged from `document.visibilitychange`. The handler receives
 *             `{ isActive: true }` on focus and `{ isActive: false }` on blur.
 *
 * Used by the viewer to pause render scheduling when backgrounded and
 * re-validate cache state when resumed.
 *
 * @param {(state: { isActive: boolean }) => void} handler
 * @returns {() => void}  unsubscribe
 */
export function onAppStateChange(handler) {
  if (typeof handler !== 'function') return () => {};

  if (isWeb()) {
    const onVis = () => {
      try { handler({ isActive: document.visibilityState === 'visible' }); }
      catch { /* ignore */ }
    };
    try {
      document.addEventListener('visibilitychange', onVis);
      // Fire once so the subscriber sees the initial state.
      Promise.resolve().then(onVis);
    } catch { /* ignore */ }
    return () => {
      try { document.removeEventListener('visibilitychange', onVis); } catch { /* ignore */ }
    };
  }

  let disposed = false;
  /** @type {null | (() => void)} */
  let nativeUnsub = null;

  (async () => {
    try {
      const { App } = await import('@capacitor/app');
      if (disposed) return;

      const sub = await App.addListener('appStateChange', (state) => {
        try { handler({ isActive: !!state.isActive }); } catch { /* ignore */ }
      });

      if (disposed) {
        try { sub.remove(); } catch { /* ignore */ }
        return;
      }
      nativeUnsub = () => { try { sub.remove(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  })();

  return () => {
    disposed = true;
    if (nativeUnsub) nativeUnsub();
  };
}

// ============================================================================
// 2. INTENTS (Android app-url-open)
// ============================================================================

/**
 * Register a handler for URLs/files delivered to the app by the OS — the
 * "Open with…" flow, share intents, and cold-start payloads.
 *
 *   Android — fires when the app is launched or resumed with a URL. Also
 *             checks `App.getLaunchUrl()` for the cold-start payload.
 *   Web     — silent no-op. `npm run dev` uses the file picker instead
 *             (`Events.LOCAL_FILE_OPEN_REQUESTED`).
 *
 * The handler receives the raw URL string. Consumers (typically `core.js`)
 * are responsible for fetching or reading it.
 *
 * @param {(url: string) => void} handler
 * @returns {() => void}  unsubscribe
 */
export function registerAppUrlOpen(handler) {
  if (typeof handler !== 'function') return () => {};
  if (!isNative()) return () => {};

  let disposed = false;
  /** @type {null | (() => void)} */
  let nativeUnsub = null;

  (async () => {
    try {
      const { App } = await import('@capacitor/app');
      if (disposed) return;

      const sub = await App.addListener('appUrlOpen', (event) => {
        if (event && typeof event.url === 'string') {
          try { handler(event.url); } catch { /* ignore */ }
        }
      });

      // Check the launch URL — fires when the app was launched cold from a
      // file-open intent, in which case `appUrlOpen` may not fire.
      try {
        const launch = await App.getLaunchUrl();
        if (!disposed && launch && typeof launch.url === 'string') {
          try { handler(launch.url); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }

      if (disposed) {
        try { sub.remove(); } catch { /* ignore */ }
        return;
      }
      nativeUnsub = () => { try { sub.remove(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  })();

  return () => {
    disposed = true;
    if (nativeUnsub) nativeUnsub();
  };
}

// ============================================================================
// 3. FULLSCREEN / IMMERSIVE
// ============================================================================

/**
 * Enter fullscreen.
 *
 *   Android — hides the system status bar (immersive mode).
 *   Web     — uses the Fullscreen API on the viewer root element.
 *
 * @returns {Promise<void>}
 */
export async function enterFullscreen() {
  if (isNative()) {
    try {
      const { StatusBar } = await import('@capacitor/status-bar');
      await StatusBar.setOverlaysWebView({ overlay: true });
      await StatusBar.hide();
      return;
    } catch { /* fall through to web path */ }
  }
  try {
    const el = document.getElementById('viewer')
      || document.querySelector('.viewer-container')
      || document.documentElement;
    if (!el) return;
    const p = el.requestFullscreen ? el.requestFullscreen() : null;
    if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
  } catch { /* ignore */ }
}

/**
 * Exit fullscreen. Counterpart to `enterFullscreen()`.
 * @returns {Promise<void>}
 */
export async function exitFullscreen() {
  if (isNative()) {
    try {
      const { StatusBar } = await import('@capacitor/status-bar');
      await StatusBar.show();
      return;
    } catch { /* fall through */ }
  }
  try {
    if (document.fullscreenElement) {
      const p = document.exitFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => { /* ignore */ });
    }
  } catch { /* ignore */ }
}

/**
 * Whether the viewer is currently in fullscreen / immersive mode.
 *
 *   Android — always `true`. Immersive mode has no "off" until the user
 *             exits it explicitly; the viewer tracks its own state.
 *   Web     — reflects `document.fullscreenElement`.
 *
 * @returns {boolean}
 */
export function isFullscreen() {
  if (isNative()) return true;
  try { return !!document.fullscreenElement; } catch { return false; }
}

// ============================================================================
// 4. STATUS BAR
// ============================================================================

/**
 * Configure the Android status bar.
 *
 *   Android — delegates to the StatusBar plugin.
 *   Web     — silent no-op.
 *
 * @param {{ visible?: boolean, style?: 'dark'|'light', color?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function setStatusBarStyle(opts) {
  if (!isNative()) return;
  const o = opts || {};
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    if (typeof o.visible === 'boolean') {
      if (o.visible) await StatusBar.show();
      else await StatusBar.hide();
    }
    if (o.style === 'dark') await StatusBar.setStyle({ style: Style.Dark });
    else if (o.style === 'light') await StatusBar.setStyle({ style: Style.Light });
    if (typeof o.color === 'string') {
      try { await StatusBar.setBackgroundColor({ color: o.color }); } catch { /* iOS-only */ }
    }
  } catch { /* ignore */ }
}

// ============================================================================
// 5. KEEP AWAKE
// ============================================================================

/** @type {any} */ let _wakeLock = null;

/**
 * Prevent the screen from sleeping while the viewer is open.
 *
 *   Android — uses the KeepAwake community plugin.
 *   Web     — uses the Wake Lock API where available (Chrome, Edge). Other
 *             browsers no-op silently.
 *
 * Idempotent — repeated calls while awake are cheap no-ops.
 *
 * @returns {Promise<void>}
 */
export async function keepAwake() {
  if (isNative()) {
    try {
      const { KeepAwake } = await import('@capacitor-community/keep-awake');
      await KeepAwake.keepAwake();
      return;
    } catch { /* fall through */ }
  }
  try {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && _wakeLock === null) {
      _wakeLock = await navigator.wakeLock.request('screen');
      // The lock is released automatically when the tab is hidden. Clear
      // our handle so a subsequent keepAwake() re-acquires cleanly.
      _wakeLock.addEventListener('release', () => { _wakeLock = null; });
    }
  } catch { /* ignore */ }
}

/**
 * Re-allow screen sleep. Counterpart to `keepAwake()`.
 * @returns {Promise<void>}
 */
export async function allowSleep() {
  if (isNative()) {
    try {
      const { KeepAwake } = await import('@capacitor-community/keep-awake');
      await KeepAwake.allowSleep();
      return;
    } catch { /* fall through */ }
  }
  try {
    if (_wakeLock) {
      await _wakeLock.release();
      _wakeLock = null;
    }
  } catch { _wakeLock = null; }
}

// ============================================================================
// 6. SHARE / OPEN-WITH
// ============================================================================

/**
 * Share text or a link via the system share sheet.
 *
 *   Android — Capacitor Share plugin (system chooser).
 *   Web     — `navigator.share()` if available (mobile Chrome), else
 *             clipboard write of the URL.
 *
 * @param {{ title?: string, text?: string, url?: string, dialogTitle?: string }} opts
 * @returns {Promise<void>}
 */
export async function share(opts) {
  const o = opts || {};
  if (isNative()) {
    try {
      const { Share } = await import('@capacitor/share');
      await Share.share({
        title: o.title,
        text: o.text,
        url: o.url,
        dialogTitle: o.dialogTitle || 'Share',
      });
      return;
    } catch { /* fall through */ }
  }
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      await navigator.share({ title: o.title, text: o.text, url: o.url });
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard && o.url) {
      await navigator.clipboard.writeText(o.url);
    }
  } catch { /* ignore */ }
}

/**
 * Share a Blob (e.g. a rendered page export, a downloaded PDF) via the
 * system share sheet.
 *
 *   Android — writes the blob to the app's cache directory via the
 *             Filesystem plugin, then shares the resulting `file://` URI.
 *   Web     — uses the Web Share API with `files: [File]` where supported;
 *             otherwise falls back to a download-triggered anchor.
 *
 * @param {{
 *   blob: Blob,
 *   filename?: string,
 *   title?: string,
 *   text?: string,
 *   dialogTitle?: string,
 * }} opts
 * @returns {Promise<boolean>} true when the file was shared/handed off
 */
export async function shareFile(opts) {
  const o = opts || {};
  if (!o.blob) return false;
  const filename = o.filename || 'document.pdf';

  if (isNative()) {
    try {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');

      // Read the blob as base64 for the Filesystem plugin's write API.
      const base64 = await _blobToBase64(o.blob);
      const result = await Filesystem.writeFile({
        path: filename,
        data: base64,
        directory: Directory.Cache,
      });

      await Share.share({
        title: o.title,
        text: o.text,
        url: result.uri,
        dialogTitle: o.dialogTitle || 'Share',
      });
      return true;
    } catch { /* fall through to web path */ }
  }

  // Web path.
  try {
    const file = new File([o.blob], filename, { type: o.blob.type || 'application/octet-stream' });
    if (navigator && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: o.title, text: o.text });
      return true;
    }
    // Fallback: trigger a download.
    const url = URL.createObjectURL(o.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* ignore */ } }, 1000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a Blob as base64 (payload only, no data-URI prefix).
 * @private
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function _blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(blob);
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================================
// 7. HAPTICS
// ============================================================================

/**
 * Trigger a vibration.
 *
 *   Android — Capacitor Haptics plugin (via `vibrate` for compatibility).
 *   Web     — `navigator.vibrate()` where available; silent no-op otherwise.
 *
 * @param {number | number[]} pattern  Duration in ms, or on/off pattern.
 * @returns {Promise<void>}
 */
export async function vibrate(pattern) {
  if (isNative()) {
    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
      // Map a numeric duration to an impact; patterns aren't natively
      // supported, so fall back to medium impact.
      if (typeof pattern === 'number' && pattern >= 30) {
        const style = pattern >= 60 ? ImpactStyle.Heavy
          : pattern >= 20 ? ImpactStyle.Medium
          : ImpactStyle.Light;
        await Haptics.impact({ style });
        return;
      }
      await Haptics.impact({ style: ImpactStyle.Medium });
      return;
    } catch { /* fall through */ }
  }
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch { /* ignore */ }
}

/** Light impact — tap confirmations. @returns {Promise<void>} */
export async function hapticLight() {
  if (isNative()) {
    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
      await Haptics.impact({ style: ImpactStyle.Light });
      return;
    } catch { /* fall through */ }
  }
  try { navigator.vibrate && navigator.vibrate(10); } catch { /* ignore */ }
}

/** Medium impact — page snap, drawer open. @returns {Promise<void>} */
export async function hapticMedium() {
  if (isNative()) {
    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
      await Haptics.impact({ style: ImpactStyle.Medium });
      return;
    } catch { /* fall through */ }
  }
  try { navigator.vibrate && navigator.vibrate(20); } catch { /* ignore */ }
}

/** Heavy impact — destructive actions. @returns {Promise<void>} */
export async function hapticHeavy() {
  if (isNative()) {
    try {
      const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
      await Haptics.impact({ style: ImpactStyle.Heavy });
      return;
    } catch { /* fall through */ }
  }
  try { navigator.vibrate && navigator.vibrate(40); } catch { /* ignore */ }
}

// ============================================================================
// 8. ENVIRONMENT SUBSCRIPTIONS
// ============================================================================

/**
 * Subscribe to color-scheme changes (light ↔ dark).
 *
 *   Android — via `matchMedia('(prefers-color-scheme: dark)')`, which the
 *             WebView keeps in sync with the system setting.
 *   Web     — same, using the standard media-query listener.
 *
 * The handler receives the new scheme.
 *
 * @param {(scheme: 'light'|'dark') => void} handler
 * @returns {() => void}  unsubscribe
 */
export function onColorSchemeChange(handler) {
  if (typeof handler !== 'function') return () => {};
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  try {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event) => {
      try { handler(event.matches ? 'dark' : 'light'); } catch { /* ignore */ }
    };
    // `addEventListener` is the modern API; older WebViews only had
    // `addListener`. Try modern first, fall back to legacy.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', listener);
      return () => { try { mql.removeEventListener('change', listener); } catch { /* ignore */ } };
    }
    if (typeof mql.addListener === 'function') {
      mql.addListener(listener);
      return () => { try { mql.removeListener(listener); } catch { /* ignore */ } };
    }
  } catch { /* ignore */ }
  return () => {};
}

/**
 * Subscribe to network status changes (online ↔ offline).
 *
 *   Android — WebView fires `online` / `offline` events, which reflect the
 *             OS-level network state.
 *   Web     — same events.
 *
 * The handler receives the current state. Fires once on subscribe with the
 * initial value.
 *
 * @param {(online: boolean) => void} handler
 * @returns {() => void}  unsubscribe
 */
export function onNetworkStatusChange(handler) {
  if (typeof handler !== 'function') return () => {};
  if (typeof window === 'undefined') return () => {};

  const onOnline = () => { try { handler(true); } catch { /* ignore */ } };
  const onOffline = () => { try { handler(false); } catch { /* ignore */ } };

  try {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // Fire once with the current state.
    Promise.resolve().then(() => {
      const online = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
      try { handler(online); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }

  return () => {
    try { window.removeEventListener('online', onOnline); } catch { /* ignore */ }
    try { window.removeEventListener('offline', onOffline); } catch { /* ignore */ }
  };
}

/**
 * Subscribe to safe-area changes (device rotation, notch relocation on
 * foldables, gesture-bar relocation).
 *
 * The handler receives the current insets. Fires once on subscribe.
 *
 * Both platforms use the same detection: `orientationchange` and `resize`
 * events, then re-read the CSS `env()` values. There is no dedicated native
 * plugin for this because `env(safe-area-inset-*)` is already kept in sync
 * by the WebView.
 *
 * @param {(insets: { top: number, right: number, bottom: number, left: number }) => void} handler
 * @returns {() => void}  unsubscribe
 */
export function onSafeAreaChange(handler) {
  if (typeof handler !== 'function') return () => {};
  if (typeof window === 'undefined') return () => {};

  let last = '';
  let rafId = null;

  const fire = () => {
    rafId = null;
    try {
      const insets = getSafeAreaInsets();
      // Only fire on genuine change — resize fires on every pixel of a
      // desktop window drag, and we don't want to spam the handler.
      const key = `${insets.top}|${insets.right}|${insets.bottom}|${insets.left}`;
      if (key === last) return;
      last = key;
      handler(insets);
    } catch { /* ignore */ }
  };

  const schedule = () => {
    if (rafId !== null) return;
    try { rafId = requestAnimationFrame(fire); }
    catch { fire(); }
  };

  try {
    window.addEventListener('orientationchange', schedule);
    window.addEventListener('resize', schedule);
    // Initial fire on next frame.
    schedule();
  } catch { /* ignore */ }

  return () => {
    try { window.removeEventListener('orientationchange', schedule); } catch { /* ignore */ }
    try { window.removeEventListener('resize', schedule); } catch { /* ignore */ }
    if (rafId !== null) {
      try { cancelAnimationFrame(rafId); } catch { /* ignore */ }
      rafId = null;
    }
  };
}

// ============================================================================
// 9. BOOTSTRAP
// ============================================================================

/**
 * Wire every native-only feature the viewer needs, connected to the core's
 * event bus. Returns a single teardown function that unsubscribes everything.
 *
 * Behaviour on web (`npm run dev`):
 *   • Back button → Escape key → same drawer/search/fullscreen close chain.
 *   • App state → visibilitychange → pause render scheduler when hidden.
 *   • Color scheme → applies `body.dark-theme` when the OS flips.
 *   • Everything else is a no-op or runs through a browser fallback.
 *
 * Behaviour on Android:
 *   • Hardware back button, immersive mode, keep-awake, file intents, and
 *     system share sheet all flow through the corresponding plugins.
 *
 * Safe to call once per viewer lifetime. Idempotent — calling twice
 * registers the listeners twice, so wire it from `_doInit` only.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {() => void}  teardown
 */
export function setupNativeBridge(core) {
  if (!core || typeof core.getBus !== 'function') return () => {};

  /** @type {Array<() => void>} */
  const teardowns = [];

  /** @type {any} */ let bus = null;
  /** @type {any} */ let Events = null;
  try {
    bus = core.getBus();
    // Events is not exported from core at runtime for this module — the
    // caller passes them through `core.getState().get('__events')` in some
    // builds. Instead we import them lazily by name-string, which is safe
    // because event names are frozen constants. Rather than depend on
    // core's internals, we accept string event names here.
  } catch { /* ignore */ }

  // ── Helper: get an Events constant without importing core. ────────────
  // The viewer's event names are the exact literals in core.js's Events
  // object. Duplicating the three we need keeps this file cycle-free.
  const EV = Object.freeze({
    PREVIEW_SUBSCRIBE_REQUESTED: 'preview:subscribe-requested',
    LOCAL_FILE_OPEN_REQUESTED: 'local-file:open-requested',
    DOCUMENT_LOADED: 'document:loaded',
    DOCUMENT_DESTROYED: 'document:destroyed',
  });

  // ── Back button ──────────────────────────────────────────────────────
  // Priority order: drawer → search → fullscreen → exit.
  teardowns.push(registerBackButton(() => {
    try {
      const drawer = document.getElementById('viewer-outline-drawer');
      if (drawer && drawer.classList.contains('open')) {
        drawer.classList.remove('open');
        const scrim = document.getElementById('viewer-drawer-scrim');
        if (scrim) scrim.classList.remove('open');
        const btn = document.getElementById('viewer-outline-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
        return true;
      }
      const searchBar = document.getElementById('viewer-search-bar');
      if (searchBar && searchBar.classList.contains('active')) {
        searchBar.classList.remove('active');
        return true;
      }
      if (isFullscreen()) {
        // Fire and forget — the caller's promise is handled internally.
        exitFullscreen().catch(() => {});
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }));

  // ── App state → render scheduler pause/resume ────────────────────────
  teardowns.push(onAppStateChange((state) => {
    try {
      const scheduler = core.getScheduler && core.getScheduler();
      if (!scheduler) return;
      if (state.isActive === false && typeof scheduler.pause === 'function') {
        scheduler.pause();
      } else if (state.isActive === true && typeof scheduler.resume === 'function') {
        scheduler.resume();
      }
    } catch { /* ignore */ }
  }));

  // ── File intents → LOCAL_FILE_OPEN_REQUESTED ─────────────────────────
  teardowns.push(registerAppUrlOpen((url) => {
    try {
      if (bus && typeof bus.emit === 'function') {
        bus.emit(EV.LOCAL_FILE_OPEN_REQUESTED, { url });
      }
    } catch { /* ignore */ }
  }));

  // ── Color scheme → body.dark-theme ───────────────────────────────────
  teardowns.push(onColorSchemeChange((scheme) => {
    try {
      const isDark = scheme === 'dark';
      document.body.classList.toggle('dark-theme', isDark);
      // If the user has not explicitly chosen a theme, system preference
      // wins. If they have, we respect their choice — the storage key is
      // managed by ui-internal.js.
      const stored = (() => { try { return localStorage.getItem('viewer-theme'); } catch { return null; } })();
      if (stored === 'light' || stored === 'dark') {
        document.body.classList.toggle('dark-theme', stored === 'dark');
      }
    } catch { /* ignore */ }
  }));

  // ── Online/offline → bus event for UI toasts (if wired) ──────────────
  teardowns.push(onNetworkStatusChange((online) => {
    if (online) return;
    try {
      // The viewer's UI owns the toast; we just signal. Currently a
      // memory-pressure toast is throttled in ui-internal.js — network
      // is analogous. Fire an event the UI can subscribe to.
      if (bus && typeof bus.emit === 'function') {
        bus.emit('network:offline', {});
      }
    } catch { /* ignore */ }
  }));

  // ── Document loaded → keep screen awake ──────────────────────────────
  // Subscribes to the bus if available, so it survives across documents
  // without re-registering on every open.
  if (bus && typeof bus.on === 'function') {
    try {
      const offLoaded = bus.on(EV.DOCUMENT_LOADED, () => { keepAwake().catch(() => {}); });
      if (typeof offLoaded === 'function') teardowns.push(offLoaded);
    } catch { /* ignore */ }
    try {
      const offDestroyed = bus.on(EV.DOCUMENT_DESTROYED, () => { allowSleep().catch(() => {}); });
      if (typeof offDestroyed === 'function') teardowns.push(offDestroyed);
    } catch { /* ignore */ }
  }

  // ── Compose teardown ─────────────────────────────────────────────────
  return () => {
    for (const fn of teardowns.splice(0)) {
      try { fn(); } catch { /* ignore */ }
    }
  };
}

// ============================================================================
// 10. TEST HOOK
// ============================================================================

/**
 * Test-only: force-release the wake lock. Call between tests that simulate
 * a document close without going through the full teardown path.
 *
 * @private
 * @returns {Promise<void>}
 */
export async function __forceReleaseWakeLockForTests() {
  await allowSleep();
}