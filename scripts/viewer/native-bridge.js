// frontend-user/scripts/viewer/native-bridge.js

/**
 * Universal Document Viewer — Native Bridge
 * ============================================================================
 *
 * Every native call the viewer needs, over a single module. No dynamic
 * imports. No `@capacitor/*` packages. Every plugin is a Medvix Java
 * plugin, accessed synchronously via `window.Capacitor.Plugins.*`.
 *
 * Backed by:
 *   MedvixApp         — backButton, appStateChange, appUrlOpen events;
 *                       getLaunchUrl(), getInfo(), exitApp()
 *   MedvixStatusBar   — enterFullscreen, exitFullscreen, setVisible,
 *                       setColor, setLightIcons
 *   MedvixKeepAwake   — keepAwake, allowSleep
 *   MedvixShare       — share, shareFile
 *   MedvixHaptics     — light, medium, heavy, vibrate  (NOT used here —
 *                       exported for other modules; the viewer does not
 *                       vibrate for any reason)
 *
 * Design contract:
 *   1. No function ever throws — broken plugin → silent no-op.
 *   2. Register functions return a SYNCHRONOUS unsubscribe.
 *   3. Fullscreen state is tracked locally. The native isFullscreen query
 *      is async, and the viewer needs a synchronous check in the back
 *      button priority chain.
 *
 * @module viewer/native-bridge
 */

'use strict';

import { isNative, isWeb, getSafeAreaInsets } from './platform.js';

// ============================================================================
// 0. NATIVE PLUGIN ACCESS
// ============================================================================

/** Synchronous access to a Medvix plugin. Returns null if not registered. */
function plugin(name) {
  try {
    const C = globalThis.Capacitor;
    if (!C?.isNativePlatform?.()) return null;
    return C.Plugins?.[name] ?? null;
  } catch {
    return null;
  }
}

/** Safe call — never throws, always resolves. */
async function safeCall(pluginName, method, args) {
  const p = plugin(pluginName);
  if (!p || typeof p[method] !== 'function') return null;
  try { return await p[method](args); }
  catch { return null; }
}

// ============================================================================
// 1. BACK BUTTON / LIFECYCLE
// ============================================================================

/**
 * Register a handler for the hardware/gesture back button.
 *
 *   Android — intercepts the system back button via MedvixApp.
 *             If `onBack()` returns true, the event is consumed. If it
 *             returns false, the app exits.
 *   Web     — binds the Escape key as a development proxy. Same
 *             consumption semantics.
 *
 * @param {() => boolean} onBack
 * @returns {() => void}  unsubscribe
 */
export function registerBackButton(onBack) {
  if (typeof onBack !== 'function') return () => {};

  if (isWeb()) {
    const handler = (e) => {
      if (e.key !== 'Escape') return;
      try { if (onBack() === true) e.preventDefault(); } catch { /* ignore */ }
    };
    try { window.addEventListener('keydown', handler); } catch { /* ignore */ }
    return () => { try { window.removeEventListener('keydown', handler); } catch { /* ignore */ } };
  }

  const p = plugin('MedvixApp');
  let disposed = false;
  let nativeUnsub = null;

  (async () => {
    try {
      if (!p || typeof p.addListener !== 'function') return;
      const sub = await p.addListener('backButton', () => {
        try { if (onBack() === true) return; } catch { /* ignore */ }
        try { p.exitApp && p.exitApp(); } catch { /* ignore */ }
      });
      if (disposed) { try { sub.remove(); } catch { /* ignore */ } return; }
      nativeUnsub = () => { try { sub.remove(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  })();

  return () => { disposed = true; if (nativeUnsub) nativeUnsub(); };
}

/**
 * Register a handler for app foreground/background transitions.
 *
 *   Android — fires from MedvixApp's appStateChange event.
 *   Web     — bridged from `document.visibilitychange`.
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
      Promise.resolve().then(onVis);
    } catch { /* ignore */ }
    return () => { try { document.removeEventListener('visibilitychange', onVis); } catch { /* ignore */ } };
  }

  const p = plugin('MedvixApp');
  let disposed = false;
  let nativeUnsub = null;

  (async () => {
    try {
      if (!p || typeof p.addListener !== 'function') return;
      const sub = await p.addListener('appStateChange', (state) => {
        try { handler({ isActive: !!state.isActive }); } catch { /* ignore */ }
      });
      if (disposed) { try { sub.remove(); } catch { /* ignore */ } return; }
      nativeUnsub = () => { try { sub.remove(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  })();

  return () => { disposed = true; if (nativeUnsub) nativeUnsub(); };
}

// ============================================================================
// 2. INTENTS
// ============================================================================

/**
 * Register a handler for URLs/files delivered to the app by the OS.
 *
 *   Android — fires from MedvixApp's appUrlOpen event, and checks
 *             getLaunchUrl() for the cold-start payload.
 *   Web     — silent no-op.
 *
 * @param {(url: string) => void} handler
 * @returns {() => void}  unsubscribe
 */
export function registerAppUrlOpen(handler) {
  if (typeof handler !== 'function') return () => {};
  if (!isNative()) return () => {};

  const p = plugin('MedvixApp');
  let disposed = false;
  let nativeUnsub = null;

  (async () => {
    try {
      if (!p || typeof p.addListener !== 'function') return;
      const sub = await p.addListener('appUrlOpen', (event) => {
        if (event && typeof event.url === 'string') {
          try { handler(event.url); } catch { /* ignore */ }
        }
      });
      try {
        const launch = await p.getLaunchUrl();
        if (!disposed && launch && typeof launch.url === 'string') {
          try { handler(launch.url); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      if (disposed) { try { sub.remove(); } catch { /* ignore */ } return; }
      nativeUnsub = () => { try { sub.remove(); } catch { /* ignore */ } };
    } catch { /* ignore */ }
  })();

  return () => { disposed = true; if (nativeUnsub) nativeUnsub(); };
}

// ============================================================================
// 3. FULLSCREEN / IMMERSIVE
// ============================================================================

/** Local fullscreen tracker — updated by enter/exit, queried synchronously. */
let _fullscreen = false;

/**
 * Enter immersive fullscreen. Hides status bar + navigation bar on the
 * Android side via MedvixStatusBar.
 *
 * @returns {Promise<void>}
 */
export async function enterFullscreen() {
  _fullscreen = true;
  await safeCall('MedvixStatusBar', 'enterFullscreen');
}

/**
 * Exit fullscreen. Restores status bar + navigation bar.
 *
 * @returns {Promise<void>}
 */
export async function exitFullscreen() {
  _fullscreen = false;
  await safeCall('MedvixStatusBar', 'exitFullscreen');
}

/**
 * Whether the viewer is currently in fullscreen / immersive mode.
 *
 * Synchronous — reads the local flag. Correct because enter/exit are the
 * only ways the state can change, and both update the flag before calling
 * the native method.
 *
 * @returns {boolean}
 */
export function isFullscreen() {
  return _fullscreen;
}

// ============================================================================
// 4. STATUS BAR
// ============================================================================

/**
 * Configure the status bar.
 *
 * @param {{ visible?: boolean, style?: 'dark'|'light', color?: string }} [opts]
 * @returns {Promise<void>}
 */
export async function setStatusBarStyle(opts) {
  const o = opts || {};
  if (typeof o.visible === 'boolean') {
    await safeCall('MedvixStatusBar', 'setVisible', { visible: o.visible });
  }
  if (typeof o.color === 'string') {
    await safeCall('MedvixStatusBar', 'setColor', { color: o.color });
  }
  if (o.style === 'dark') {
    await safeCall('MedvixStatusBar', 'setLightIcons', { light: false });
  } else if (o.style === 'light') {
    await safeCall('MedvixStatusBar', 'setLightIcons', { light: true });
  }
}

// ============================================================================
// 5. KEEP AWAKE
// ============================================================================

/**
 * Prevent the screen from sleeping while the viewer is open.
 * Idempotent — repeated calls while awake are cheap no-ops.
 *
 * @returns {Promise<void>}
 */
export async function keepAwake() {
  await safeCall('MedvixKeepAwake', 'keepAwake');
}

/**
 * Re-allow screen sleep. Counterpart to `keepAwake()`.
 * @returns {Promise<void>}
 */
export async function allowSleep() {
  await safeCall('MedvixKeepAwake', 'allowSleep');
}

// ============================================================================
// 6. SHARE / OPEN-WITH
// ============================================================================

/**
 * Share text or a link via the system share sheet.
 *
 * @param {{ title?: string, text?: string, url?: string, dialogTitle?: string }} opts
 * @returns {Promise<void>}
 */
export async function share(opts) {
  const o = opts || {};
  await safeCall('MedvixShare', 'share', {
    title:       o.title,
    text:        o.text,
    url:         o.url,
    dialogTitle: o.dialogTitle || 'Share',
  });
}

/**
 * Share a Blob via the system share sheet.
 *
 * The blob is base64-encoded in JS, passed to MedvixShare.shareFile,
 * which writes it to the app cache and fires the chooser with the
 * content:// URI attached.
 *
 * @param {{
 *   blob: Blob,
 *   filename?: string,
 *   title?: string,
 *   text?: string,
 *   dialogTitle?: string,
 * }} opts
 * @returns {Promise<boolean>} true when the file was handed off
 */
export async function shareFile(opts) {
  const o = opts || {};
  if (!o.blob) return false;
  const filename = o.filename || 'document.pdf';

  try {
    const base64 = await _blobToBase64(o.blob);
    const result = await safeCall('MedvixShare', 'shareFile', {
      base64,
      filename,
      mimeType:    o.blob.type || 'application/octet-stream',
      title:       o.title,
      text:        o.text,
      dialogTitle: o.dialogTitle || 'Share',
    });
    return !!(result && result.shared);
  } catch {
    return false;
  }
}

/**
 * Read a Blob as base64 (payload only, no data-URI prefix).
 * @private
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
    } catch (err) { reject(err); }
  });
}

// ============================================================================
// 7. HAPTICS
// ============================================================================
//
// Exported for use elsewhere in the app. THE VIEWER DOES NOT CALL THESE.
// No navigation feedback, no page-snap vibration, no gesture haptics —
// the document viewer is silent. If a future feature needs haptics
// (destructive-action confirmations, form validation, etc.), import the
// functions from this module and call them from that feature's code.
//
// Kept here so every native call in the app goes through one module and
// one set of Medvix plugins.

/** @returns {Promise<void>} */
export async function vibrate(pattern) {
  const ms = typeof pattern === 'number' ? pattern : 20;
  await safeCall('MedvixHaptics', 'vibrate', { duration: ms });
}

/** Light impact. @returns {Promise<void>} */
export async function hapticLight()  { await safeCall('MedvixHaptics', 'light');  }

/** Medium impact. @returns {Promise<void>} */
export async function hapticMedium() { await safeCall('MedvixHaptics', 'medium'); }

/** Heavy impact. @returns {Promise<void>} */
export async function hapticHeavy()  { await safeCall('MedvixHaptics', 'heavy');  }

// ============================================================================
// 8. ENVIRONMENT SUBSCRIPTIONS
// ============================================================================

/**
 * Subscribe to color-scheme changes (light ↔ dark).
 *
 * @param {(scheme: 'light'|'dark') => void} handler
 * @returns {() => void}  unsubscribe
 */
export function onColorSchemeChange(handler) {
  if (typeof handler !== 'function') return () => {};
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  try {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = (event) => {
      try { handler(event.matches ? 'dark' : 'light'); } catch { /* ignore */ }
    };
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
 * Fires once on subscribe with the initial value.
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
 * Subscribe to safe-area changes (rotation, notch relocation, gesture-bar
 * relocation). Fires once on subscribe. Fires only on genuine change.
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
 * Wire every native-only feature the viewer needs. Returns a single
 * teardown function that unsubscribes everything.
 *
 * The viewer does not use haptics. This bootstrap wires back button,
 * app state, file intents, color scheme, network status, and the
 * document loaded/destroyed keep-awake cycle. No vibration anywhere.
 *
 * @param {import('./core.js').ViewerCore} core
 * @returns {() => void}  teardown
 */
export function setupNativeBridge(core) {
  if (!core || typeof core.getBus !== 'function') return () => {};

  const teardowns = [];
  let bus = null;
  try { bus = core.getBus(); } catch { /* ignore */ }

  // Event name constants — duplicated from core.js to keep this module
  // cycle-free. Values must match core.js's Events object exactly.
  const EV = Object.freeze({
    PREVIEW_SUBSCRIBE_REQUESTED: 'preview:subscribe-requested',
    LOCAL_FILE_OPEN_REQUESTED:   'local-file:open-requested',
    DOCUMENT_LOADED:             'document:loaded',
    DOCUMENT_DESTROYED:          'document:destroyed',
  });

  // ── Back button — drawer → search → fullscreen → exit ────────────────
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
      if (state.isActive === false && typeof scheduler.pause === 'function')  scheduler.pause();
      if (state.isActive === true  && typeof scheduler.resume === 'function') scheduler.resume();
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
      const stored = (() => { try { return localStorage.getItem('viewer-theme'); } catch { return null; } })();
      if (stored === 'light' || stored === 'dark') {
        document.body.classList.toggle('dark-theme', stored === 'dark');
      }
    } catch { /* ignore */ }
  }));

  // ── Online/offline → bus event for UI toasts ─────────────────────────
  teardowns.push(onNetworkStatusChange((online) => {
    if (online) return;
    try {
      if (bus && typeof bus.emit === 'function') {
        bus.emit('network:offline', {});
      }
    } catch { /* ignore */ }
  }));

  // ── Document lifecycle → keep-awake cycle ────────────────────────────
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
 * Test-only: force-release the wake lock.
 * @private
 */
export async function __forceReleaseWakeLockForTests() {
  await allowSleep();
}