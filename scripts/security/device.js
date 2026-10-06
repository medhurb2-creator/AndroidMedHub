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
 * deviceId is a *stable device identity signal* for subscription authorization —
 * not an immutable hardware fingerprint. Platform semantics apply: Android
 * ANDROID_ID changes on signing-key change or factory reset; the Windows
 * system identifier has its own scope; web UUIDs disappear when site data is
 * cleared. The backend must tolerate occasional drift.
 *
 * The raw platform identifier never leaves this module. Callers only ever see
 * the derived `dv_…` MedVix ID and the normalized metadata object.
 */

import * as utils from '../utils.js';

const RAW_KEY   = 'medvix.device.raw';   // web/windows-fallback persistent raw UUID
const ID_KEY    = 'medvix.device.id';    // cached derived MedVix ID
const INFO_KEY  = 'medvix.device.info';  // cached normalized info

const ID_NAMESPACE = 'medvix.device.v1';

let _deviceId   = null;
let _deviceInfo = null;
let _appVersion = null;
let _pending    = null;

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

// ------------------------------------------------------------- app info ----

export function setAppVersion(v) { _appVersion = v; }
export function getAppVersion() { return _appVersion; }

// -------------------------------------------------------- sync ID access ---
//
// Some callers (telemetry, offline queues) need the deviceId without an
// await. It's only safe to call this AFTER initializeDevice() has run at
// least once. Returns null if not yet resolved.

export function getCachedDeviceId() {
    return _deviceId;
}

export function getCachedDeviceInfo() {
    return _deviceInfo;
}

// -------------------------------------------------------------- device ID --

export async function getDeviceId() {
    if (_deviceId) return _deviceId;

    // Reuse the derived ID across restarts. On native this is an optimization;
    // on web it is the difference between keeping the same identity and
    // re-deriving it from the stored raw UUID every launch.
    const cached = utils.getLocalStorage(ID_KEY);
    if (cached) {
        _deviceId = cached;
        return _deviceId;
    }

    if (_pending) return _pending;

    _pending = (async () => {
        try {
            _deviceId = await resolveDeviceId();
        } finally {
            _pending = null;
        }
        if (_deviceId) utils.setLocalStorage(ID_KEY, _deviceId);
        return _deviceId;
    })();

    return _pending;
}

async function resolveDeviceId() {
    const rt = await runtime();

    // Android / iOS — platform identifier via @capacitor/device.
    if (rt === 'android' || rt === 'ios') {
        const Device = await loadDevicePlugin();
        if (Device?.getId) {
            try {
                const { identifier } = await Device.getId();
                if (identifier) return deriveMedvixId(`${rt}:${identifier}`);
            } catch (err) {
                console.warn('[device] Device.getId() failed, falling back', err);
            }
        }
    }

    // Windows — installation identity fallback. A user uninstall or app-data
    // reset produces a new deviceId here. Replace with
    // SystemIdentification.GetSystemIdForPublisher() via a Capacitor plugin
    // once the Windows shell exists; keep the derivation identical.
    if (rt === 'windows') {
        let raw = utils.getLocalStorage(RAW_KEY);
        if (!raw) { raw = `win-${randomUuid()}`; utils.setLocalStorage(RAW_KEY, raw); }
        return deriveMedvixId(`windows:${raw}`);
    }

    // Web / PWA (and any native fallback that reached here).
    let raw = utils.getLocalStorage(RAW_KEY);
    if (!raw) { raw = randomUuid(); utils.setLocalStorage(RAW_KEY, raw); }
    return deriveMedvixId(`web:${raw}`);
}

// ------------------------------------------------------------ device info --

export async function getDeviceInfo() {
    if (_deviceInfo) return _deviceInfo;
    _deviceInfo = await resolveDeviceInfo();
    utils.setLocalStorage(INFO_KEY, JSON.stringify(_deviceInfo));
    return _deviceInfo;
}

async function resolveDeviceInfo() {
    const rt = await runtime();

    if (rt === 'android' || rt === 'ios') {
        const Device = await loadDevicePlugin();
        if (Device?.getInfo) {
            try {
                const info = await Device.getInfo();
                return normalizeCapacitorInfo(info, rt);
            } catch (err) {
                console.warn('[device] Device.getInfo() failed, falling back', err);
            }
        }
    }

    if (rt === 'windows') return normalizeWindowsInfo();
    return normalizeWebInfo();
}

function normalizeCapacitorInfo(info, rt) {
    const osNameMap = { android: 'Android', ios: 'iOS' };
    return {
        platform:       rt,
        manufacturer:   info.manufacturer ?? null,
        model:          info.model ?? null,
        osName:         osNameMap[rt] ?? info.operatingSystem ?? null,
        osVersion:      info.osVersion ?? null,
        architecture:   null,
        appVersion:     getAppVersion(),
        browser:        null,
        isVirtual:      info.isVirtual ?? null,
        webViewVersion: info.webViewVersion ?? null,
    };
}

function normalizeWindowsInfo() {
    return {
        platform:     'windows',
        manufacturer: null,
        model:        null,
        osName:       'Windows',
        osVersion:    null,
        architecture: null,
        appVersion:   getAppVersion(),
        browser:      null,
    };
}

function normalizeWebInfo() {
    return {
        platform:          'web',
        manufacturer:      null,
        model:             null,
        osName:            detectWebOsName(),
        osVersion:         null,
        architecture:      null,
        appVersion:        getAppVersion(),
        browser:           detectBrowser(),
        userAgent:         navigator.userAgent,
        language:          navigator.language,
        cpuCores:          navigator.hardwareConcurrency ?? null,
        deviceMemoryGb:    navigator.deviceMemory ?? null,
        screen:            `${screen.width}x${screen.height}`,
        pixelRatio:        window.devicePixelRatio ?? null,
        timezoneOffsetMin: new Date().getTimezoneOffset(),
    };
}

function detectBrowser() {
    const ua = navigator.userAgent;
    if (/Edg\//.test(ua))     return 'Edge';
    if (/OPR\//.test(ua))     return 'Opera';
    if (/Chrome\//.test(ua))  return 'Chrome';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Safari\//.test(ua))  return 'Safari';
    return 'Unknown';
}

function detectWebOsName() {
    const ua = navigator.userAgent;
    if (/Windows/.test(ua))         return 'Windows';
    if (/Android/.test(ua))         return 'Android';
    if (/iPhone|iPad|iPod/.test(ua))return 'iOS';
    if (/Mac OS X/.test(ua))        return 'macOS';
    if (/Linux/.test(ua))           return 'Linux';
    return null;
}

// -------------------------------------------------------------- lifecycle --

export async function initializeDevice(opts = {}) {
    if (opts.appVersion) _appVersion = opts.appVersion;
    await Promise.all([getDeviceId(), getDeviceInfo()]);
    return { deviceId: _deviceId, deviceInfo: _deviceInfo };
}

export async function refreshDeviceInfo() {
    _deviceInfo = null;
    return getDeviceInfo();
}

/**
 * Clear in-memory state and cached derived artifacts.
 *
 * Does NOT destroy the underlying identity by default:
 *   - native: deviceId comes from the platform identifier, so it survives
 *   - web: the raw UUID in RAW_KEY survives, so the same dv_… regenerates
 *
 * Pass { clearWebIdentity: true } only for an intentional "reset this browser
 * installation" operation — e.g. the user explicitly asks for a new device
 * identity, or support is rotating a compromised one.
 */
export function clearDeviceData({ clearWebIdentity = false } = {}) {
    _deviceId   = null;
    _deviceInfo = null;
    _pending    = null;

    utils.removeLocalStorage(ID_KEY);
    utils.removeLocalStorage(INFO_KEY);

    if (clearWebIdentity) {
        utils.removeLocalStorage(RAW_KEY);
    }
}