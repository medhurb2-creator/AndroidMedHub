// security/device.js

/**
 * Cross-platform MedVix device identity.
 *
 * One interface — getDeviceId() / getDeviceInfo() — over three sources:
 *
 *   Android / iOS (Capacitor native) → @capacitor/device → platform identifier
 *   Windows native                   → Windows system identifier (plugin pending)
 *   Web / PWA                        → crypto.randomUUID() persisted locally
 *
 * Capacitor packages are loaded lazily. A pure web build that never installs
 * @capacitor/core or @capacitor/device works unchanged.
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
 * Everything else the @capacitor/device plugin returns — manufacturer,
 * architecture, isVirtual, webViewVersion, androidSDKVersion, battery,
 * language — is intentionally dropped. If a future feature needs one of
 * those, add it back here; do not re-broaden the default payload.
 *
 * ─── @capacitor/device CONTRACT (verified via node_modules inspection) ────
 * The plugin exposes four asynchronous methods on the `Device` proxy:
 *
 *   Device.getId()            → { identifier: string }
 *   Device.getInfo()          → DeviceInfo
 *   Device.getBatteryInfo()   → BatteryInfo
 *   Device.getLanguageCode()  → { value: string }
 *   Device.getLanguageTag()   → { value: string }
 *
 * Only getId() and getInfo() are used on the primary path. getBatteryInfo()
 * is exposed via getBatteryInfo() below for on-demand callers, but is NOT
 * part of initializeDevice() or buildDeviceIdentity().
 *
 * The plugin is auto-registered by the Capacitor bridge via the
 * @CapacitorPlugin(name = "Device") annotation on DevicePlugin.java — no
 * MainActivity.java edits are required. No AndroidManifest permissions are
 * needed: getInfo() and getId() use public Android APIs.
 *
 * ─── FALLBACK CONTRACT ────────────────────────────────────────────────────
 * getDeviceId() and getDeviceInfo() are *total functions*. They never reject
 * and never return null. If the native bridge is unavailable, unresponsive,
 * or returns empty data, a locally-derived identity is produced instead. The
 * resulting ID lives in the same `dv_…` namespace and is stable across
 * restarts (it is derived from a persisted raw UUID).
 *
 * Every native call is bounded by NATIVE_TIMEOUT_MS. If the bridge does not
 * answer in time — the classic failure mode after a missed `cap sync`, where
 * Device.getId() returns `UNAVAILABLE: "Device" plugin is not implemented on
 * android` — the app continues with the fallback rather than hanging.
 *
 * ─── IDENTITY STABILITY ───────────────────────────────────────────────────
 * deviceId is a *stable device identity signal* for subscription authorization,
 * not an immutable hardware fingerprint. Platform semantics apply:
 *
 *   Android: identifier is ANDROID_ID (Build → Settings.Secure.ANDROID_ID).
 *            Changes on app signing-key change (debug vs release!) and on
 *            factory reset.
 *   iOS:     identifier is identifierForVendor. Changes when all vendor apps
 *            are uninstalled, or on device wipe.
 *   Windows: installation identity persisted in local storage. Cleared on
 *            app-data reset. To be replaced by
 *            SystemIdentification.GetSystemIdForPublisher() once the
 *            Windows shell exists.
 *   Web:     crypto.randomUUID() persisted in local storage. Cleared when
 *            the user clears site data.
 *
 * The backend MUST tolerate occasional drift — this module does not attempt
 * to hide it.
 *
 * The raw platform identifier never leaves this module. Callers only ever see
 * the derived `dv_…` MedVix ID and the normalized metadata object.
 */

import * as utils from '../utils.js';

const RAW_KEY       = 'medvix.device.raw';        // persistent fallback UUID
const ID_KEY        = 'medvix.device.id';         // cached derived MedVix ID
const ID_SOURCE_KEY = 'medvix.device.id.source';  // 'native' | 'local' | 'fallback'
const INFO_KEY      = 'medvix.device.info';       // cached normalized info
const INFO_SOURCE_KEY = 'medvix.device.info.source';

const ID_NAMESPACE = 'medvix.device.v1';

// How long to wait for a native bridge call before giving up and using the
// local fallback. A healthy WebView <-> Java bridge answers in well under
// 200 ms; 1.5 s is generous headroom and keeps the worst case small enough
// to be absorbed by the boot splash even on a completely broken bridge.
const NATIVE_TIMEOUT_MS = 1500;

// Form guard for cached IDs. Anything else is treated as corrupt and re-derived.
const MEDVIX_ID_RE = /^dv_[0-9a-f]{32}$/;

let _deviceId    = null;
let _deviceInfo  = null;
let _appVersion  = null;
let _pendingId   = null;
let _pendingInfo = null;

// Where the current _deviceId / _deviceInfo came from.
//   'native'   — resolved via @capacitor/device on Android/iOS
//   'local'    — resolved from browser / OS APIs (expected on web / windows)
//   'fallback' — we were on a native platform but the native bridge failed
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

// --------------------------------------------------- capacitor lazy load ---

let _capacitor;      // undefined = not probed yet, null = unavailable
let _devicePlugin;   // same convention

async function loadCapacitor() {
    if (_capacitor !== undefined) return _capacitor;

    if (globalThis.Capacitor) {
        _capacitor = globalThis.Capacitor;
        return _capacitor;
    }

    try {
        const mod = await import(/* @vite-ignore */ '@capacitor/core');
        _capacitor = mod?.Capacitor ?? null;
    } catch {
        _capacitor = null;
    }
    return _capacitor;
}

async function loadDevicePlugin() {
    if (_devicePlugin !== undefined) return _devicePlugin;

    try {
        const mod = await import(/* @vite-ignore */ '@capacitor/device');
        _devicePlugin = mod?.Device ?? null;
    } catch {
        _devicePlugin = null;
    }
    return _devicePlugin;
}

async function runtime() {
    const C = await loadCapacitor();
    if (!C?.isNativePlatform?.()) return 'web';
    return C.getPlatform?.() || 'web';
}

// ------------------------------------------------------------- utilities ---

/**
 * Reject a promise if it doesn't settle within `ms`. Used to bound every
 * native bridge call — a hung WebView <-> Java channel must never freeze
 * the app.
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

/** Safe wrapper for any Device plugin method — never throws. */
async function safeDeviceCall(label, fn) {
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
// source (native bridge) is unavailable, these helpers produce a locally
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
        _fallbackReason: reason || 'native-bridge-unavailable',
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
        // resolution this launch — the bridge may have been fixed (e.g.
        // after running `npx cap sync android`).
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
    const rt = await runtime();

    // Android / iOS — platform identifier via @capacitor/device.
    // Device.getId() → { identifier: string } per the plugin's TS defs.
    // On Android this is ANDROID_ID (Settings.Secure.ANDROID_ID); on iOS
    // it is identifierForVendor. See the stability notes at the top.
    if (rt === 'android' || rt === 'ios') {
        const Device = await loadDevicePlugin();

        if (Device?.getId) {
            const res = await safeDeviceCall('Device.getId', () => Device.getId());

            // Some plugin versions return { identifier }, others a raw
            // string. Handle both defensively.
            const identifier =
                typeof res === 'string' ? res : res?.identifier;

            if (typeof identifier === 'string' && identifier.length > 0) {
                return {
                    id:     await deriveMedvixId(`${rt}:${identifier}`),
                    source: 'native',
                };
            }
            console.warn('[device] Device.getId() returned empty identifier');
        } else {
            console.warn('[device] @capacitor/device unavailable, using fallback');
        }

        // Native path failed. Fallback keeps the platform tag so the same
        // physical device produces a stable fallback ID in the same namespace.
        return {
            id:     await fallbackDeviceId(rt),
            source: 'fallback',
        };
    }

    // Windows — installation identity fallback. A user uninstall or app-data
    // reset produces a new deviceId here. Replace with
    // SystemIdentification.GetSystemIdForPublisher() via a Capacitor plugin
    // once the Windows shell exists; keep the derivation identical.
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
    const rt = await runtime();

    if (rt === 'android' || rt === 'ios') {
        const Device = await loadDevicePlugin();

        if (Device?.getInfo) {
            // Single bounded call. No supplementary battery/language queries
            // — those were removed because the device-list UI does not use
            // them, and they doubled the serial wait on a broken bridge.
            const info = await safeDeviceCall('Device.getInfo', () => Device.getInfo());

            if (info && typeof info === 'object') {
                return {
                    info:   normalizeCapacitorInfo(info, rt),
                    source: 'native',
                };
            }
            console.warn('[device] Device.getInfo() returned non-object');
        }

        // Native failed — fall back but preserve the platform tag so
        // downstream code still sees platform:'android' / 'ios'.
        return {
            info:   fallbackDeviceInfo(rt, 'native-bridge-unavailable'),
            source: 'fallback',
        };
    }

    if (rt === 'windows') {
        return { info: normalizeWindowsInfo(), source: 'local' };
    }

    return { info: normalizeWebInfo(), source: 'local' };
}

/**
 * Normalize the shape returned by @capacitor/device's Device.getInfo() into
 * the minimal MedVix internal info object.
 *
 * Only the five fields needed to render the "which devices are logged in"
 * list are kept. Everything else the plugin returns — manufacturer,
 * architecture, isVirtual, webViewVersion, androidSDKVersion, operatingSystem
 * (redundant with platform), and the supplementary battery/language data — is
 * intentionally dropped. If a future feature needs one of those, add it back
 * here deliberately rather than re-broadening the default payload.
 */
function normalizeCapacitorInfo(info, rt) {
    const osNameMap = { android: 'Android', ios: 'iOS' };

    // info.platform is the authoritative platform string from the plugin
    // ('android' | 'ios'). Fall back to `rt` (Capacitor.getPlatform()) if the
    // plugin omits it — should be identical.
    const platform = (typeof info.platform === 'string' && info.platform)
        ? info.platform
        : rt;

    return {
        platform,
        model:      info.model     ?? null,
        osName:     osNameMap[platform] ?? info.operatingSystem ?? null,
        osVersion:  info.osVersion ?? null,
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

// ------------------------------------------------------------- battery -----

/**
 * Standalone battery accessor. Not part of the primary initializeDevice()
 * flow — call this lazily when the UI actually needs it (e.g. a power-save
 * banner). Returns null on web, on failure, or if the native bridge is
 * unavailable.
 *
 * Kept as an export so existing callers do not break. Not referenced by
 * resolveDeviceInfo() or buildDeviceIdentity().
 */
export async function getBatteryInfo() {
    const rt = await runtime();
    if (rt !== 'android' && rt !== 'ios') return null;

    const Device = await loadDevicePlugin();
    if (!Device?.getBatteryInfo) return null;

    const res = await safeDeviceCall('Device.getBatteryInfo', () => Device.getBatteryInfo());
    if (!res || typeof res !== 'object') return null;

    return {
        batteryLevel: typeof res.batteryLevel === 'number' ? res.batteryLevel : null,
        isCharging:   typeof res.isCharging   === 'boolean' ? res.isCharging  : null,
    };
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
 *   - native: deviceId comes from the platform identifier, so it survives
 *     (though it may legitimately drift — see ANDROID_ID / IDFV semantics)
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