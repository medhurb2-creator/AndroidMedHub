// scripts/security.js

/**
 * Security & Anti-Cheating Module – OFFLINE FRIENDLY
 *
 * Responsibilities:
 *   - Cross-platform device identity (delegated to ./security/device.js)
 *   - Time manipulation detection (server time comes from Convex)
 *   - Account locking after repeated violations
 *   - Session validation via the Convex backend
 *   - Device management (delegates to auth/actions:*)
 *
 * All backend calls go through `convexHttpClient` — no third-party endpoints.
 */

import * as utils from './utils.js';
import * as ui from './ui.js';
import * as auth from './auth.js';
import * as router from './router.js';
import * as db from './db.js';
import { convexHttpClient } from './convex-client.js';

import {
    getDeviceId,
    getDeviceInfo,
    getCachedDeviceId,
    getCachedDeviceInfo,
    initializeDevice,
    refreshDeviceInfo,
    clearDeviceData,
    setAppVersion,
} from './security/device.js';

// Re-export device identity so the rest of the app can continue to pull it
// from security.js during the migration. Prefer importing from
// './security/device.js' directly in new code.
export {
    getDeviceId,
    getDeviceInfo,
    getCachedDeviceId,
    getCachedDeviceInfo,
    initializeDevice,
    refreshDeviceInfo,
    clearDeviceData,
};

// Constants
const MAX_TIME_DRIFT_MS = 10 * 60 * 1000;   // 10 minutes tolerance
const WARNING_THRESHOLD_MS = 3 * 60 * 1000;  // 3 minutes – show warning
const LOCK_THRESHOLD_COUNT = 3;              // number of violations before lock
const LOCK_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24 hours
const SERVER_TIME_CACHE_TTL = 60 * 1000;     // 1 minute

let serverTimeCache = null;
let serverTimeCacheExpiry = 0;

// ==================== DEVICE IDENTITY (CANONICAL SHAPE) ====================

/**
 * Build the canonical device identity payload for auth actions.
 *
 * Every backend action (login, register, googleSignIn, linkGoogleAccount,
 * removeDeviceAndContinue, etc.) expects:
 *
 *     { deviceId, deviceInfo }
 *
 * `deviceId` is the stable MedVix identifier (`dv_…`). `deviceInfo` is the
 * normalized metadata object produced by ./security/device.js and stored
 * verbatim by the backend.
 *
 * @returns {Promise<{ deviceId: string, deviceInfo: object }>}
 */
export async function buildDeviceIdentity() {
    const [deviceId, deviceInfo] = await Promise.all([
        getDeviceId(),
        getDeviceInfo(),
    ]);
    return { deviceId, deviceInfo };
}

// ==================== DEPRECATED ALIASES ====================

/**
 * @deprecated Use getDeviceId() or buildDeviceIdentity() instead.
 * The value returned here is the same as the new deviceId.
 */
export async function getDeviceFingerprint() {
    return getDeviceId();
}

/**
 * @deprecated No-op kept for compatibility. Device identity is derived
 * on-device; there's nothing to set from the server.
 */
export function setDeviceFingerprint(fp) {
    if (fp) utils.setLocalStorage('deviceFingerprint', fp);
}

// ==================== SESSION HELPERS ====================

export function getSessionId() {
    return utils.getLocalStorage('sessionId') || null;
}

export async function validateSessionWithBackend() {
    const token = utils.getLocalStorage('accessToken');
    if (!token) return false;
    try {
        const result = await convexHttpClient.action('auth/actions:verifyToken', { token });
        return !!result?.success;
    } catch {
        return false;
    }
}

// ==================== TIME MANIPULATION DETECTION ====================

/**
 * Get server time from Convex.
 *
 * The backend exposes `system/queries:getServerTime`, which returns the
 * authoritative `Date.now()`. Falls back to the HTTP Date header of the
 * same Convex deployment if the query fails.
 *
 * @returns {Promise<number|null>} server timestamp in ms, or null when offline
 */
async function getServerTime() {
    if (serverTimeCache && Date.now() < serverTimeCacheExpiry) {
        return serverTimeCache;
    }

    if (!navigator.onLine) return null;

    // ---- Preferred: Convex backend query ----
    try {
        const result = await convexHttpClient.query('system/queries:getServerTime');
        if (result?.success && typeof result.data?.serverTime === 'number') {
            serverTimeCache = result.data.serverTime;
            serverTimeCacheExpiry = Date.now() + SERVER_TIME_CACHE_TTL;
            return serverTimeCache;
        }
    } catch (e) {
        console.warn('[Security] Convex time unavailable, falling back', e?.message || e);
    }

    // ---- Fallback: Date header of the Convex HTTP endpoint ----
    try {
        const convexUrl = convexHttpClient?.url || '';
        const healthUrl = convexUrl.replace('.convex.cloud', '.convex.site') + '/';
        const res = await fetch(healthUrl, {
            method: 'HEAD',
            signal: AbortSignal.timeout(3000),
        });
        const header = res.headers.get('Date');
        if (header) {
            const t = new Date(header).getTime();
            if (!Number.isNaN(t)) {
                serverTimeCache = t;
                serverTimeCacheExpiry = Date.now() + SERVER_TIME_CACHE_TTL;
                return t;
            }
        }
    } catch (e) {
        console.warn('[Security] Convex Date header unavailable');
    }

    return null;
}

/**
 * Detect time manipulation by comparing client time with server time.
 * If offline, assumes valid and returns warning action.
 * @returns {Promise<Object>} { valid, drift, message, action: 'ok'|'warn'|'block'|'lock' }
 */
export async function detectTimeManipulation() {
    const serverTime = await getServerTime();
    if (!serverTime) {
        return {
            valid: true,
            drift: 0,
            message: 'Offline mode – time not verified. Please ensure your device time is correct.',
            action: 'warn',
        };
    }

    const clientTime = Date.now();
    const drift = Math.abs(clientTime - serverTime);

    if (drift > MAX_TIME_DRIFT_MS) {
        await recordViolation('time_manipulation', drift);
        const count = await getViolationCount('time_manipulation');

        if (count >= LOCK_THRESHOLD_COUNT) {
            return {
                valid: false,
                drift,
                message: 'Your device time is significantly off. Account locked for security.',
                action: 'lock',
            };
        }
        return {
            valid: false,
            drift,
            message: 'Your device time does not match our servers. Please enable automatic time sync to continue.',
            action: 'block',
        };
    }

    if (drift > WARNING_THRESHOLD_MS) {
        return {
            valid: true,
            drift,
            message: 'Your device time is slightly off. For accurate exam timing, please enable automatic time sync.',
            action: 'warn',
        };
    }

    return { valid: true, drift: 0, message: '', action: 'ok' };
}

export async function validateClientTime(clientTime) {
    const serverTime = await getServerTime();
    if (!serverTime) return true;
    return Math.abs(clientTime - serverTime) <= MAX_TIME_DRIFT_MS;
}

export async function getSafeTimestamp() {
    const serverTime = await getServerTime();
    if (serverTime) return serverTime;
    ui.showToast('Using device time – could not verify with server', 'warning', 4000);
    return Date.now();
}

/**
 * Check time consistency on app start and periodically.
 * Also validates the session if online.
 * @returns {Promise<boolean>} true if time is acceptable and session valid (or offline)
 */
export async function checkTimeConsistency() {
    const result = await detectTimeManipulation();

    if (result.action === 'lock') {
        await lockAccount('time_manipulation', result.drift);
        ui.showToast(result.message, 'error', 0);
        router.navigateTo('locked?reason=time_manipulation');
        return false;
    }
    if (result.action === 'block') {
        ui.showToast(result.message, 'warning', 0);
        ui.setAppSetting('timeBlocked', true);
        return false;
    }
    if (result.action === 'warn') {
        ui.showToast(result.message, 'warning', 5000);
        ui.setAppSetting('timeBlocked', false);
    } else {
        ui.setAppSetting('timeBlocked', false);
    }

    // If online, validate the session via the Convex backend
    if (navigator.onLine) {
        const token = utils.getLocalStorage('accessToken');
        if (token) {
            try {
                const verifyResult = await convexHttpClient.action('auth/actions:verifyToken', { token });
                if (!verifyResult?.success) {
                    ui.showToast('Your session has expired or been revoked. Please login again.', 'warning');
                    await auth.clearUser();
                    utils.removeLocalStorage('accessToken');
                    utils.removeLocalStorage('sessionId');
                    router.navigateTo('login');
                    return false;
                }
            } catch (err) {
                console.warn('[Security] Session validation error:', err);
            }
        }
    }

    return true;
}

// ==================== VIOLATION TRACKING ====================

async function recordViolation(type, details) {
    const now = Date.now();
    const violations = await getViolations();
    const recent = violations.filter(v => (now - v.timestamp) < LOCK_WINDOW_MS);
    recent.push({ type, timestamp: now, details });
    await db.saveSecurityViolations(recent);
}

async function getViolationCount(type) {
    const violations = await getViolations();
    const now = Date.now();
    return violations.filter(
        v => v.type === type && (now - v.timestamp) < LOCK_WINDOW_MS
    ).length;
}

async function getViolations() {
    return (await db.getSecurityViolations()) || [];
}

// ==================== ACCOUNT LOCKING ====================

async function clearSubscriptionIfPresent() {
    try {
        const mod = await import(/* @vite-ignore */ './subscription.js');
        if (typeof mod?.clearSubscription === 'function') {
            await mod.clearSubscription();
        }
    } catch {
        // subscription module not present — nothing to clean
    }
}

async function lockAccount(reason, details) {
    await db.saveLockStatus({
        locked: true,
        reason,
        details,
        timestamp: Date.now(),
    });

    await auth.clearUser();
    await clearSubscriptionIfPresent();
    utils.removeLocalStorage('accessToken');
    utils.removeLocalStorage('sessionId');
}

export async function getLockStatus() {
    return (await db.getLockStatus()) || { locked: false };
}

// ==================== SECURITY EVENT LOGGING ====================

/**
 * Log a security event.
 *
 * Sends to Convex via `security/actions:logSecurityEvent` when online,
 * queues for later sync otherwise. The device ID is attached automatically.
 */
export async function logSecurityEvent(event, details) {
    const deviceId = await getDeviceId();

    const logEntry = {
        event,
        timestamp: Date.now(),
        deviceId,
        sessionId: getSessionId(),
        details,
    };

    await db.addSecurityLog(logEntry);

    if (navigator.onLine && auth.checkAuth()) {
        try {
            await convexHttpClient.action('security/actions:logSecurityEvent', {
                token: utils.getLocalStorage('accessToken'),
                event,
                details,
                deviceId,
            });
        } catch {
            await db.addToSyncQueue('security_log', logEntry);
        }
    } else {
        await db.addToSyncQueue('security_log', logEntry);
    }
}

// ==================== SESSION VALIDATION ====================

export async function validateSession() {
    const lockStatus = await getLockStatus();
    if (lockStatus.locked) return false;

    const timeOk = await checkTimeConsistency();
    if (!timeOk) return false;

    const user = auth.getUser();
    if (user && user.deviceId) {
        const currentId = await getDeviceId();
        if (user.deviceId !== currentId) {
            ui.showToast('New device detected. Please verify your identity.', 'warning', 5000);
        }
    }
    return true;
}

// ==================== INITIALIZATION ====================

/**
 * Initialize security subsystems.
 * @param {Object} [options]
 * @param {string} [options.appVersion] – current app version, stored with device info
 */
export async function initSecurity(options = {}) {
    if (options.appVersion) setAppVersion(options.appVersion);

    await initializeDevice({ appVersion: options.appVersion });
    await checkTimeConsistency();

    setInterval(() => {
        checkTimeConsistency();
    }, 5 * 60 * 1000);
}

// ==================== DEVICE MANAGEMENT (delegates to auth actions) ====================

/**
 * Get the list of active devices for the current user.
 * Delegates to `auth/actions:listActiveDevices`.
 *
 * @returns {Promise<{ devices: Array, maxDevices: number, devicesUsed: number, overLimit: boolean }>}
 */
export async function getUserDevices() {
    try {
        const token = utils.getLocalStorage('accessToken');
        if (!token) return { devices: [], maxDevices: 1, devicesUsed: 0, overLimit: false };

        const currentDeviceId = await getDeviceId();
        const result = await convexHttpClient.action('auth/actions:listActiveDevices', {
            token,
            currentDeviceId,
        });
        if (!result?.success) {
            return { devices: [], maxDevices: 1, devicesUsed: 0, overLimit: false };
        }
        return result.data;
    } catch (err) {
        console.warn('[security] getUserDevices failed', err);
        return { devices: [], maxDevices: 1, devicesUsed: 0, overLimit: false };
    }
}

/**
 * Remove a specific device from the current user's account.
 * Delegates to `auth/actions:removeOtherDevice`.
 *
 * @param {string} deviceId
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export async function logoutDevice(deviceId) {
    try {
        const token = utils.getLocalStorage('accessToken');
        if (!token) return { success: false, message: 'Not authenticated' };

        const currentDeviceId = await getDeviceId();
        const result = await convexHttpClient.action('auth/actions:removeOtherDevice', {
            token,
            deviceId,
            currentDeviceId,
        });

        if (!result?.success) {
            return { success: false, message: result?.message || 'Failed to remove device' };
        }
        return { success: true };
    } catch (err) {
        console.warn('[security] logoutDevice failed', err);
        return { success: false, message: err?.message || 'Failed to remove device' };
    }
}

/**
 * Log out from all other devices except the current one.
 * Delegates to `auth/actions:removeOtherDevices`.
 *
 * @returns {Promise<{ success: boolean, message?: string }>}
 */
export async function logoutAllOtherDevices() {
    try {
        const token = utils.getLocalStorage('accessToken');
        if (!token) return { success: false, message: 'Not authenticated' };

        const currentSessionId = getSessionId();
        if (!currentSessionId) return { success: false, message: 'No active session' };

        const result = await convexHttpClient.action('auth/actions:removeOtherDevices', {
            token,
            currentSessionId,
        });

        if (!result?.success) {
            return { success: false, message: result?.message || 'Failed to log out other devices' };
        }
        return { success: true, message: result.data?.message };
    } catch (err) {
        console.warn('[security] logoutAllOtherDevices failed', err);
        return { success: false, message: err?.message || 'Failed to log out other devices' };
    }
}

// ==================== EXPOSE GLOBALLY ====================

window.security = {
    // Canonical device identity helper (for auth actions)
    buildDeviceIdentity,

    // Device identity (new)
    getDeviceId,
    getDeviceInfo,
    getCachedDeviceId,
    getCachedDeviceInfo,
    initializeDevice,
    refreshDeviceInfo,
    clearDeviceData,

    // Device identity (deprecated aliases)
    getDeviceFingerprint,
    setDeviceFingerprint,

    // Sessions
    getSessionId,
    validateSessionWithBackend,

    // Time
    detectTimeManipulation,
    validateClientTime,
    getSafeTimestamp,
    checkTimeConsistency,

    // Events & validation
    logSecurityEvent,
    validateSession,
    getLockStatus,

    // Device management
    getUserDevices,
    logoutDevice,
    logoutAllOtherDevices,
};