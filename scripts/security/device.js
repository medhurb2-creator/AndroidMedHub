// security/device.js

/**
 * Cross-platform MedVix device identity.
 *
 * One interface — getDeviceId() / getDeviceInfo() — over three sources:
 *
 *   Android (MedvixDevicePlugin)  → ANDROID_ID + Build metadata
 *   iOS (future)                  → identifierForVendor (plugin pending)
 *   Web / PWA / Windows           → crypto.randomUUID() persisted locally
 *
 * ─── WHY A CUSTOM PLUGIN INSTEAD OF @capacitor/device ─────────────────────
 * @capacitor/device is loaded via `await import('@capacitor/device')`. On
 * some cold starts — stale APK, missed `cap sync`, WebView asset cache
 * miss — that dynamic import never resolves. The promise hangs, the
 * caller hangs, and the auth flow never reaches the network. There is no
 * timeout that catches it because the timeout wraps the method call, not
 * the import that precedes it.
 *
 * MedvixDevicePlugin is registered directly with the Capacitor bridge in
 * MainActivity. The JS side reaches it via
 * `window.Capacitor.Plugins.MedvixDevice` — a synchronous property
 * lookup. If the plugin isn't registered, the lookup returns undefined
 * and the fallback runs immediately. No import. No hang.
 *
 * ─── DEVICEINFO SHAPE ─────────────────────────────────────────────────────
 * deviceInfo is deliberately minimal. It exists to power the "which devices
 * are logged in" list and nothing else. The five fields are:
 *
 *   platform    'android' | 'ios' | 'web' | 'windows'
 *   model       "Samsung Galaxy S23" / "iPhone 14" / null
 *   osName      "Android" | "iOS" | "Windows" | "macOS" | "Linux" | null
 *   osVersion   "14" / "17.2" / null
 *   appVersion  "2.4.1" / null
 *
 * Everything else the plugin returns — manufacturer, sdkVersion,
 * isVirtual — is intentionally dropped. If a future feature needs one of
 * those, add it back here; do not re-broaden the default payload.
 *
 * ─── FALLBACK CONTRACT ────────────────────────────────────────────────────
 * getDeviceId() and getDeviceInfo() are *total functions*. They never reject
 * and never return null. If the native plugin is unavailable, unresponsive,
 * or returns empty data, a locally-derived identity is produced instead.
 * The resulting ID lives in the same `dv_…` namespace and is stable across
 * restarts (it is derived from a persisted raw UUID).
 *
 * Every native call is bounded by NATIVE_TIMEOUT_MS. If the bridge does not
 * answer in time, the app continues with the fallback rather than hanging.
 *
 * ─── IDENTITY STABILITY ───────────────────────────────────────────────────
 * deviceId is a *stable device identity signal* for subscription
 * authorization, not an immutable hardware fingerprint. Platform semantics
 * apply:
 *
 *   Android: identifier is ANDROID_ID (Settings.Secure.ANDROID_ID), read
 *            by MedvixDevicePlugin. Changes on app signing-key change
 *            (debug vs release!) and on factory reset.
 *   iOS:     identifier is identifierForVendor. Changes when all vendor
 *            apps are uninstalled, or on device wipe.
 *   Windows: installation identity persisted in local storage. Cleared on
 *            app-data reset.
 *   Web:     crypto.randomUUID() persisted in local storage. Cleared when
 *            the user clears site data.
 *
 * The backend MUST tolerate occasional drift — this module does not attempt
 * to hide it.
 *
 * The raw platform identifier never leaves this module. Callers only ever
 * see the derived `dv_…` MedVix ID and the normalized metadata object.
 */

import * as utils from '../utils.js';

const RAW_KEY       = 'medvix.device.raw';        // persistent fallback UUID
const ID_KEY        = 'medvix.device.id';         // cached derived MedVix ID
const ID_SOURCE_KEY = 'medvix.device.id.source';  // 'native' | 'local' | 'fallback'
const INFO_KEY      = 'medvix.device.info';       // cached normalized info
const INFO_SOURCE_KEY = 'medvix.device.info.source';

const ID_NAMESPACE = 'medvix.device.v1';

// How long to wait for a native plugin call before giving up and using
// the local fallback. MedvixDevicePlugin answers in under 20 ms on every
// device we've tested; 1.5 s is generous headroom and keeps the worst
// case small enough to be absorbed by the boot splash.
const NATIVE_TIMEOUT_MS = 1500;

// Form guard for cached IDs. Anything else is treated as corrupt and
// re-derived.
const MEDVIX_ID_RE = /^dv_[0-9a-f]{32}$/;

let _deviceId    = null;
let _deviceInfo  = null;
let _appVersion  = null;
let _pendingId   = null;
let _pendingInfo = null;

// Where the current _deviceId / _deviceInfo came from.
//   'native'   — resolved via MedvixDevicePlugin on Android
//   'local'    — resolved from browser / OS APIs (expected on web / windows)
//   'fallback' — we were on a native platform but the plugin failed
let _idSource   = null;
let _infoSource = null;

// ---------------------------------------------------------------- crypto ---

function randomUuid() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    if (globalThis.crypto?.getRandomValues) {
        crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input) {
    if (globalThis.crypto?.subtle) {
        try {
            const buf = new TextEncoder().encode(input);
            const digest = await crypto.subtle.digest('SHA-256', buf);
            return [...new Uint8Array(digest)]
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');
        } catch { /* fall through */ }
    }
    return fnv1aRepeat(input);
}

// Non-secure-context fallback. Produces 64 hex chars so downstream slicing
// behaves identically to the SHA-256 path. NOT cryptographically strong —
// exists only so a plain-HTTP dev server does not throw.
function fnv1aRepeat(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0').repeat(8);
}

async function deriveMedvixId(source) {
    const hex = await sha256Hex(`${ID_NAMESPACE}:${source}`);
    return `dv_${hex.slice(0, 32)}`;
}

// --------------------------------------------------- native plugin access ---

/**
 * Synchronous access to MedvixDevicePlugin. If the plugin is registered
 * with the Capacitor bridge, this returns an object with getDeviceId() and
 * getDeviceInfo(). If not, undefined.
 *
 * No dynamic import. No await. No hang path.
 */
function getDevicePlugin() {
    try {
        const C = globalThis.Capacitor;
        if (!C?.isNativePlatform?.()) return null;
        return C.Plugins?.MedvixDevice ?? null;
    } catch {
        return null;
    }
}

/**
 * Synchronous platform detection. Reads the platform tag Capacitor
 * injects into the WebView before any JS runs. No import, no await.
 */
function runtime() {
    try {
        const C = globalThis.Capacitor;
        if (!C?.isNativePlatform?.()) return 'web';
        return C.getPlatform?.() || 'web';
    } catch {
        return 'web';
    }
}

// ------------------------------------------------------------- utilities ---

/**
 * Reject a promise if it doesn't settle within `ms`. Used to bound every
 * native plugin call — a registered plugin with a broken bridge channel
 * must never freeze the app.
 */
function withTimeout(promise, ms, label) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`[device] ${label} timed out after ${ms}ms`)),
            ms
        );
        Promise.resolve(promise).then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); }
        );
    });
}

function isValidMedvixId(id) {
    return typeof id === 'string' && MEDVIX_ID_RE.test(id);
}

/**
 * Bounded call to a MedvixDevicePlugin method. Never throws — returns
 * null on timeout or error.
 */
async function safePluginCall(label, fn) {
    try {
        return await withTimeout(fn(), NATIVE_TIMEOUT_MS, label);
    } catch (err) {
        console.warn(`[device] ${label} failed`, err);
        return null;
    }
}

// ------------------------------------------------------------- app info ----

export function setAppVersion(v) { _appVersion = v; }
export function getAppVersion() { return _appVersion; }

// -------------------------------------------------------- sync accessors ---
//
// Some callers (telemetry, offline queues) need the deviceId without an
// await. It's only safe to call these AFTER initializeDevice() has run at
// least once. Returns null if not yet resolved.

export function getCachedDeviceId()   { return _deviceId; }
export function getCachedDeviceInfo() { return _deviceInfo; }

// Fallback / source observability. Useful for support tooling and diagnostics.
export function deviceIdIsFallback()   { return _idSource   === 'fallback'; }
export function deviceInfoIsFallback() { return _infoSource === 'fallback'; }
export function getDeviceIdSource()    { return _idSource;   }
export function getDeviceInfoSource()  { return _infoSource; }

// ------------------------------------------------------------- fallbacks ---
//
// The contract of this module is that getDeviceId() and getDeviceInfo()
// ALWAYS resolve — never reject, never return null. When the preferred
// source (native plugin) is unavailable, these helpers produce a locally
// derived identity that is stable across restarts and structurally
// identical to the native-derived one.
//
// The raw UUID lives under RAW_KEY and survives normal app restarts. It is
// only cleared by clearDeviceData({ clearWebIdentity: true }).

function getOrCreateRawUuid(platformTag) {
    let raw = utils.getLocalStorage(RAW_KEY);
    if (typeof raw !== 'string' || raw.length < 8) {
        raw = `${platformTag}-${randomUuid()}`;
        utils.setLocalStorage(RAW_KEY, raw);
    }
    return raw;
}

async function fallbackDeviceId(platformTag) {
    // The platform tag is included in the derivation input so that the same
    // physical device yields a different ID on Android vs. web — matching
    // the native path's `${rt}:${identifier}` convention. If native later
    // starts working, the ID will change; the backend must tolerate that.
    const raw = getOrCreateRawUuid(platformTag);
    return deriveMedvixId(`${platformTag}:${raw}`);
}

function fallbackDeviceInfo(platformTag, reason) {
    const knownPlatform = platformTag && platformTag !== 'web' ? platformTag : null;
    const osNameByPlatform = { android: 'Android', ios: 'iOS', windows: 'Windows' };

    return {
        platform:   knownPlatform || 'web',
        model:      null,
        osName:     knownPlatform
                        ? (osNameByPlatform[knownPlatform] ?? null)
                        : detectWebOsName(),
        osVersion:  null,
        appVersion: getAppVersion(),
        // Diagnostic fields — only present on the fallback path.
        _fallback:       true,
        _fallbackReason: reason || 'native-plugin-unavailable',
    };
}

// -------------------------------------------------------------- device ID --

export async function getDeviceId() {
    if (_pendingId) return _pendingId;
    if (_deviceId)  return _deviceId;

    const cached       = utils.getLocalStorage(ID_KEY);
    const cachedSource = utils.getLocalStorage(ID_SOURCE_KEY);

    // Trust authoritative caches: native resolution from a previous run, or
    // a local (web / windows) resolution whose inputs cannot have changed.
    if (isValidMedvixId(cached) && (cachedSource === 'native' || cachedSource === 'local')) {
        _deviceId = cached;
        _idSource = cachedSource;
        return _deviceId;
    }

    // Discard corrupt or unknown cache entries.
    if (cached && !isValidMedvixId(cached)) {
        utils.removeLocalStorage(ID_KEY);
        utils.removeLocalStorage(ID_SOURCE_KEY);
    } else if (isValidMedvixId(cached) && cachedSource === 'fallback') {
        // A previous run fell back on a native platform. Seed the sync
        // accessor with the previous value, but still attempt native
        // resolution this launch — the plugin may have been registered
        // since the last run.
        _deviceId = cached;
        _idSource = 'fallback';
    }

    _pendingId = (async () => {
        try {
            const { id, source } = await resolveDeviceId();
            _deviceId = id;
            _idSource = source;
            utils.setLocalStorage(ID_KEY, id);
            utils.setLocalStorage(ID_SOURCE_KEY, source);
            return id;
        } catch (err) {
            console.error('[device] resolveDeviceId threw unexpectedly', err);
            const id = await fallbackDeviceId('web');
            _deviceId = id;
            _idSource = 'fallback';
            utils.setLocalStorage(ID_KEY, id);
            utils.setLocalStorage(ID_SOURCE_KEY, 'fallback');
            return id;
        } finally {
            _pendingId = null;
        }
    })();

    return _pendingId;
}

async function resolveDeviceId() {
    const rt = runtime();

    // Android — native ANDROID_ID via MedvixDevicePlugin.
    if (rt === 'android') {
        const plugin = getDevicePlugin();

        if (plugin?.getDeviceId) {
            const res = await safePluginCall('MedvixDevice.getDeviceId',
                () => plugin.getDeviceId());

            const identifier = res?.deviceId;
            if (typeof identifier === 'string' && identifier.length > 0) {
                return {
                    id:     await deriveMedvixId(`android:${identifier}`),
                    source: 'native',
                };
            }
            console.warn('[device] MedvixDevice.getDeviceId() returned empty identifier');
        } else {
            console.warn('[device] MedvixDevice plugin not registered, using fallback');
        }

        // Native path failed. Fallback keeps the platform tag so the same
        // physical device produces a stable fallback ID in the same namespace.
        return {
            id:     await fallbackDeviceId('android'),
            source: 'fallback',
        };
    }

    // iOS — pending plugin. Falls back to local UUID for now.
    if (rt === 'ios') {
        return {
            id:     await fallbackDeviceId('ios'),
            source: 'fallback',
        };
    }

    // Windows — installation identity persisted in local storage.
    if (rt === 'windows') {
        return {
            id:     await fallbackDeviceId('windows'),
            source: 'local',
        };
    }

    // Web / PWA — the expected path.
    return {
        id:     await fallbackDeviceId('web'),
        source: 'local',
    };
}

// ------------------------------------------------------------ device info --

export async function getDeviceInfo() {
    if (_deviceInfo) return _deviceInfo;

    // Reuse cached *authoritative* info. Info cached from a fallback path is
    // discarded so we re-attempt the preferred source this launch.
    const cachedRaw    = utils.getLocalStorage(INFO_KEY);
    const cachedSource = utils.getLocalStorage(INFO_SOURCE_KEY);

    if (cachedRaw) {
        try {
            const cached = JSON.parse(cachedRaw);
            if (cached && typeof cached === 'object' && !cached._fallback) {
                _deviceInfo = cached;
                _infoSource = cachedSource || (cached.platform === 'web' || cached.platform === 'windows'
                    ? 'local'
                    : 'native');
                return _deviceInfo;
            }
        } catch {
            utils.removeLocalStorage(INFO_KEY);
            utils.removeLocalStorage(INFO_SOURCE_KEY);
        }
    }

    if (_pendingInfo) return _pendingInfo;

    _pendingInfo = (async () => {
        try {
            const { info, source } = await resolveDeviceInfo();
            _deviceInfo = info;
            _infoSource = source;
            utils.setLocalStorage(INFO_KEY, JSON.stringify(info));
            utils.setLocalStorage(INFO_SOURCE_KEY, source);
            return info;
        } catch (err) {
            console.error('[device] resolveDeviceInfo threw unexpectedly', err);
            const info = fallbackDeviceInfo('web', 'unexpected-error');
            _deviceInfo = info;
            _infoSource = 'fallback';
            utils.setLocalStorage(INFO_KEY, JSON.stringify(info));
            utils.setLocalStorage(INFO_SOURCE_KEY, 'fallback');
            return info;
        } finally {
            _pendingInfo = null;
        }
    })();

    return _pendingInfo;
}

async function resolveDeviceInfo() {
    const rt = runtime();

    if (rt === 'android') {
        const plugin = getDevicePlugin();

        if (plugin?.getDeviceInfo) {
            // Single bounded call. MedvixDevicePlugin returns the full
            // payload in one bridge round-trip — ID, platform, model,
            // osName, osVersion, sdkVersion, isVirtual. We trim to the
            // five fields the UI consumes.
            const res = await safePluginCall('MedvixDevice.getDeviceInfo',
                () => plugin.getDeviceInfo());

            if (res && typeof res === 'object') {
                return {
                    info:   normalizeNativeInfo(res),
                    source: 'native',
                };
            }
            console.warn('[device] MedvixDevice.getDeviceInfo() returned non-object');
        }

        // Native failed — fall back but preserve the platform tag so
        // downstream code still sees platform:'android'.
        return {
            info:   fallbackDeviceInfo('android', 'native-plugin-unavailable'),
            source: 'fallback',
        };
    }

    if (rt === 'ios') {
        return {
            info:   fallbackDeviceInfo('ios', 'native-plugin-unavailable'),
            source: 'fallback',
        };
    }

    if (rt === 'windows') {
        return { info: normalizeWindowsInfo(), source: 'local' };
    }

    return { info: normalizeWebInfo(), source: 'local' };
}

/**
 * Normalize the shape returned by MedvixDevicePlugin.getDeviceInfo() into
 * the minimal MedVix internal info object.
 *
 * Only the five fields needed to render the "which devices are logged in"
 * list are kept. The plugin also returns deviceId, manufacturer,
 * sdkVersion, and isVirtual — those are intentionally dropped here. If a
 * future feature needs one of them, add it back deliberately rather than
 * re-broadening the default payload.
 */
function normalizeNativeInfo(res) {
    return {
        platform:   'android',
        model:      res.model     ?? null,
        osName:     res.osName    ?? 'Android',
        osVersion:  res.osVersion ?? null,
        appVersion: getAppVersion(),
    };
}

function normalizeWindowsInfo() {
    return {
        platform:   'windows',
        model:      null,
        osName:     'Windows',
        osVersion:  null,
        appVersion: getAppVersion(),
    };
}

function normalizeWebInfo() {
    return {
        platform:   'web',
        model:      null,
        osName:     detectWebOsName(),
        osVersion:  null,
        appVersion: getAppVersion(),
    };
}

function detectWebOsName() {
    const ua = navigator.userAgent;
    if (/Windows/.test(ua))          return 'Windows';
    if (/Android/.test(ua))          return 'Android';
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
    if (/Mac OS X/.test(ua))         return 'macOS';
    if (/Linux/.test(ua))            return 'Linux';
    return null;
}

// -------------------------------------------------------------- lifecycle --

export async function initializeDevice(opts = {}) {
    if (opts.appVersion) _appVersion = opts.appVersion;
    // Promise.all is safe here: neither getter rejects by contract.
    await Promise.all([getDeviceId(), getDeviceInfo()]);
    return { deviceId: _deviceId, deviceInfo: _deviceInfo };
}

export async function refreshDeviceInfo() {
    _deviceInfo = null;
    _infoSource = null;
    utils.removeLocalStorage(INFO_KEY);
    utils.removeLocalStorage(INFO_SOURCE_KEY);
    return getDeviceInfo();
}

/**
 * Clear in-memory state and cached derived artifacts.
 *
 * Does NOT destroy the underlying identity by default:
 *   - native: deviceId comes from ANDROID_ID, so it survives
 *     (though it may legitimately drift — see ANDROID_ID semantics)
 *   - web: the raw UUID in RAW_KEY survives, so the same dv_… regenerates
 *
 * Pass { clearWebIdentity: true } only for an intentional "reset this browser
 * installation" operation — e.g. the user explicitly asks for a new device
 * identity, or support is rotating a compromised one.
 */
export function clearDeviceData({ clearWebIdentity = false } = {}) {
    _deviceId    = null;
    _deviceInfo  = null;
    _pendingId   = null;
    _pendingInfo = null;
    _idSource    = null;
    _infoSource  = null;

    utils.removeLocalStorage(ID_KEY);
    utils.removeLocalStorage(ID_SOURCE_KEY);
    utils.removeLocalStorage(INFO_KEY);
    utils.removeLocalStorage(INFO_SOURCE_KEY);

    if (clearWebIdentity) {
        utils.removeLocalStorage(RAW_KEY);
    }
}