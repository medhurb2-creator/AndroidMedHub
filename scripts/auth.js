// scripts/auth.js

/**
 * Authentication Handler – Convex Integration
 *
 * Backend contract (auth/actions.ts):
 *   - Every auth action expects { deviceId, deviceInfo }
 *     where deviceId is the stable MedVix ID ("dv_…") and
 *     deviceInfo is the normalized metadata blob from security/device.js.
 *   - login / googleSignIn may return DEVICE_LIMIT_REACHED
 *     (structured failure with switchToken + device list)
 *   - removeDeviceAndContinue completes a blocked login
 *   - listActiveDevices / removeOtherDevice / removeOtherDevices
 *     power the Manage Devices page
 *
 * Password flows, Google flows, password reset, profile management,
 * account deletion, offline caching, and referral handling are all preserved.
 */

import * as ui from './ui.js';
import * as utils from './utils.js';
import * as security from './security.js';
import * as db from './db.js';
import * as sync from './sync.js';
import * as subscription from './subscription.js';
import * as examEngine from './exam-engine.js';
import { convexHttpClient } from './convex-client.js';
import { navigateTo } from './router.js';

// ==================== TOKEN MANAGEMENT ====================

export function getToken() {
    return utils.getLocalStorage('accessToken');
}

export function setToken(token) {
    if (token) {
        utils.setLocalStorage('accessToken', token);
    } else {
        utils.removeLocalStorage('accessToken');
        utils.removeLocalStorage('refreshToken');
    }
}

export function clearToken() {
    setToken(null);
}

export function isTokenValid() {
    return !!getToken();
}

// ==================== USER MANAGEMENT ====================

let currentUser = null;

export function getUser() {
    return currentUser;
}

export async function setUser(user) {
    if (!user || !user._id) {
        console.warn('[Auth] setUser called with invalid user', user);
        return;
    }
    currentUser = user;

    try {
        await db.saveUser(user);
    } catch (e) {
        console.warn('[Auth] IndexedDB save failed, using localStorage', e);
    }
    utils.setLocalStorage('user', user);
}

export async function initUser() {
    let userFromDB = null;
    try {
        userFromDB = await db.getUser();
    } catch (e) {
        console.warn('[Auth] Failed to load from IndexedDB', e);
    }

    const userFromStorage = utils.getLocalStorage('user', null);
    if (userFromDB) {
        currentUser = userFromDB;
    } else if (userFromStorage) {
        currentUser = userFromStorage;
        try {
            await db.saveUser(userFromStorage);
        } catch (e) {}
    } else {
        currentUser = null;
    }
    return currentUser;
}

export function fallbackLoadUser() {
    currentUser = utils.getLocalStorage('user', null);
}

export async function clearUser() {
    currentUser = null;
    try {
        await db.deleteAllUsers();
    } catch (e) {
        console.warn('[Auth] IndexedDB delete failed', e);
    }
    utils.removeLocalStorage('user');
    clearToken();
}

export function checkAuth() {
    const token = getToken();
    const hasUser = !!currentUser;
    return !!token && hasUser;
}

// ==================== ONLINE CHECK ====================

function requireOnline() {
    if (!navigator.onLine) {
        throw new Error('You need to be online to perform this action.');
    }
}

// ==================== ERROR HELPERS ====================

function getErrorMessage(error) {
    if (error?.data?.message) return error.data.message;
    if (error?.message) return error.message;
    return 'An unknown error occurred';
}

// ==================== DEVICE IDENTITY ====================

/**
 * Build the device identity payload every auth action expects.
 *
 * Delegates to security.js so deviceId is derived once (cross-platform)
 * and reused across password login, register, Google flows, and
 * device management.
 *
 * @returns {Promise<{ deviceId: string, deviceInfo: object }>}
 */
async function buildDeviceIdentity() {
    if (typeof security.buildDeviceIdentity === 'function') {
        return await security.buildDeviceIdentity();
    }

    // Fallback for older security.js builds
    const deviceId =
        (typeof security.getDeviceId === 'function' && (await security.getDeviceId())) ||
        (typeof security.getDeviceFingerprint === 'function' && (await security.getDeviceFingerprint())) ||
        'unknown';

    const deviceInfo =
        (typeof security.getDeviceInfo === 'function' && (await security.getDeviceInfo())) || {
            platform: navigator.platform || 'web',
            userAgent: navigator.userAgent || '',
        };

    return { deviceId, deviceInfo };
}

// ==================== USER SHAPE NORMALIZER ====================

/**
 * Normalize the flat user shape returned by every auth action into the
 * { _id, name, email, ... } object the rest of the app expects.
 *
 * Backend returns user fields FLAT inside result.data, e.g.:
 *   { token, userId, name, email, username, displayName, sessionId, deviceId }
 */
function normalizeUser(data) {
    if (!data) return null;

    if (data.user && data.user._id) return data.user;

    if (data.userId) {
        return {
            _id: data.userId,
            name: data.name,
            email: data.email,
            username: data.username,
            displayName: data.displayName,
            role: data.role,
            isAgent: data.isAgent,
            referralCode: data.referralCode,
            deviceId: data.deviceId,
        };
    }

    return null;
}

// ==================== TOKEN ERROR HANDLER ====================

async function handleTokenError(error) {
    const message = error?.message || error?.toString() || '';

    // Tight check — avoid false positives from the word "token" appearing
    // in an unrelated validation message.
    const isTokenError =
        message.includes('invalid_token') ||
        message.includes('session_expired') ||
        message.includes('session_revoked') ||
        message.includes('verify authentication token') ||
        message.includes('Failed to verify authentication token') ||
        message.includes('Unauthorized') ||
        message.includes('authentication failed') ||
        message.includes('JWT verification error') ||
        message.includes('jwt expired') ||
        message.includes('TokenExpiredError');

    if (!isTokenError) return false;

    if (!navigator.onLine) {
        console.warn('[Auth] Token expired while offline. Keeping local session.');
        return true;
    }

    const refreshed = await refreshSession();
    if (refreshed) return true;

    clearToken();
    utils.removeLocalStorage('sessionId');

    ui.showToast(
        'Your session could not be restored. Please login again when online.',
        'warning'
    );
    return true;
}

// ==================== REFERRAL HELPERS ====================

function getStoredReferralCode() {
    return utils.getLocalStorage('referral_code', null);
}

function clearStoredReferralCode() {
    utils.removeLocalStorage('referral_code');
}

// ==================== SESSION REFRESH ====================

/**
 * Refresh the JWT using the backend's refreshSession action.
 *
 * The backend accepts the stored sessionId (embedded in the JWT at login
 * time) and, if still valid, issues a fresh 30-day JWT. Device identity
 * is preserved via the deviceId stored in the sessions row.
 */
export async function refreshSession() {
    if (!navigator.onLine) return false;

    const sessionId = utils.getLocalStorage('sessionId');
    if (!sessionId) return false;

    try {
        const result = await convexHttpClient.action(
            'auth/actions:refreshSession',
            { sessionId }
        );

        if (!result?.success || !result.data?.token) {
            return false;
        }

        setToken(result.data.token);
        return true;
    } catch (error) {
        console.warn('[Auth] Session refresh error:', error);
        return false;
    }
}

// ==================== LOGIN ====================

/**
 * Login with email/phone + password.
 *
 * Outcomes:
 *   1. Success → returns the user object.
 *   2. DEVICE_LIMIT_REACHED → throws an error with:
 *        .code = "DEVICE_LIMIT_REACHED"
 *        .deviceLimitPayload = { devices, maxDevices, devicesUsed, switchToken, newDevice, via }
 *      The caller should show the "which device to remove?" modal and then
 *      call removeDeviceAndContinue(switchToken, deviceToRemoveId).
 */
export async function login(identifier, password) {
    requireOnline();

    const { deviceId, deviceInfo } = await buildDeviceIdentity();

    const result = await convexHttpClient.action('auth/actions:login', {
        identifier,
        password,
        deviceId,
        deviceInfo,
    });

    // ---- DEVICE_LIMIT_REACHED ----
    if (result && result.status === 'DEVICE_LIMIT_REACHED') {
        const err = new Error(result.message || 'Device limit reached.');
        err.code = 'DEVICE_LIMIT_REACHED';
        err.deviceLimitPayload = result.data || {};
        throw err;
    }

    if (!result || !result.success) {
        throw new Error(result?.message || 'Login failed');
    }

    const data = result.data || {};
    const {
        token,
        userId,
        name,
        email,
        sessionId,
        isNewDevice,
        role,
        deviceId: serverDeviceId,
    } = data;

    setToken(token);
    await setUser({
        _id: userId,
        name,
        email,
        role,
        deviceId: serverDeviceId || deviceId,
    });

    if (sessionId) utils.setLocalStorage('sessionId', sessionId);
    if (deviceId) security.setDeviceFingerprint(deviceId);

    if (isNewDevice) {
        ui.showToast('New device detected. You are now logged in on this device.', 'info', 4000);
    }

    await sync.syncUserData();

    try {
        await subscription.refreshSubscription();
    } catch (subErr) {
        console.warn('[Auth] Could not refresh subscription after login:', subErr);
    }

    return { _id: userId, name, email };
}

// ==================== REMOVE DEVICE AND CONTINUE ====================

/**
 * Complete a login that was blocked by the device limit.
 *
 * Called after the user picks a device to remove from the
 * DEVICE_LIMIT_REACHED modal. The switchToken proves identity —
 * no password needed.
 */
export async function removeDeviceAndContinue(switchToken, deviceToRemoveId) {
    requireOnline();

    const result = await convexHttpClient.action(
        'auth/actions:removeDeviceAndContinue',
        { switchToken, deviceToRemoveId }
    );

    if (!result || !result.success) {
        throw new Error(result?.message || 'Could not complete login after removing device');
    }

    const data = result.data || {};
    const { token, userId, name, email, sessionId, role, deviceId } = data;

    setToken(token);
    await setUser({ _id: userId, name, email, role, deviceId });

    if (sessionId) utils.setLocalStorage('sessionId', sessionId);

    await sync.syncUserData();

    try {
        await subscription.refreshSubscription();
    } catch (subErr) {
        console.warn('[Auth] Could not refresh subscription after device removal:', subErr);
    }

    return { _id: userId, name, email };
}

// ==================== REGISTER ====================

export async function register(userData) {
    requireOnline();

    let referralCode = userData.referralCode || getStoredReferralCode();
    const isAgent = userData.isAgent || false;
    const agentVerified = userData.agentVerified || false;

    const { deviceId, deviceInfo } = await buildDeviceIdentity();

    const result = await convexHttpClient.action('auth/actions:register', {
        name: userData.name,
        email: userData.email.toLowerCase(),
        phone: userData.phone,
        password: userData.password,
        securityQuestions: userData.securityQuestions.map((q) => ({
            question: q.question,
            answer: q.answer,
        })),
        deviceId,
        deviceInfo,
        referralCode: referralCode || undefined,
        isAgent,
        agentVerified,
    });

    if (!result || !result.success) {
        throw new Error(result?.message || 'Registration failed');
    }

    const data = result.data || {};
    const {
        token,
        userId,
        name,
        email,
        sessionId,
        referralCode: userReferralCode,
        isAgent: userIsAgent,
    } = data;

    setToken(token);
    await setUser({
        _id: userId,
        name,
        email,
        referralCode: userReferralCode,
        isAgent: userIsAgent,
        deviceId,
    });

    if (sessionId) utils.setLocalStorage('sessionId', sessionId);
    if (deviceId) security.setDeviceFingerprint(deviceId);

    clearStoredReferralCode();

    await sync.syncUserData();

    try {
        await subscription.refreshSubscription();
    } catch (subErr) {
        console.warn('[Auth] Could not refresh subscription after registration:', subErr);
    }

    return {
        _id: userId,
        name,
        email,
        referralCode: userReferralCode,
        isAgent: userIsAgent,
    };
}

// ==================== LOGOUT ====================

export async function logout() {
    clearToken();
    utils.removeLocalStorage('sessionId');
    await clearUser();
    await subscription.clearSubscription();
    examEngine.clearExamConfig();
    examEngine.clearExamState();
    ui.showToast('Logged out', 'info');
}

// ==================== PASSWORD RESET ====================

export async function getSecurityQuestions(identifier) {
    requireOnline();
    const result = await convexHttpClient.query('auth/queries:getSecurityQuestions', { identifier });
    if (!result || !result.success) {
        throw new Error(result?.message || 'Failed to retrieve security questions');
    }
    return result.data.questions;
}

export async function verifySecurityAnswers(identifier, answers) {
    requireOnline();
    const result = await convexHttpClient.action('auth/actions:verifySecurityAnswers', {
        identifier,
        answers,
    });
    if (!result || !result.success) {
        throw new Error(result?.message || 'Verification failed');
    }
    sessionStorage.setItem('resetToken', result.data.resetToken);
    return result.data.resetToken;
}

export async function resetPassword(identifier, newPassword) {
    const resetToken = sessionStorage.getItem('resetToken');
    if (!resetToken) throw new Error('No reset token. Please restart the process.');

    requireOnline();
    const result = await convexHttpClient.action('auth/actions:resetPassword', {
        identifier,
        newPassword,
        resetToken,
    });
    if (!result || !result.success) {
        throw new Error(result?.message || 'Password reset failed');
    }
    sessionStorage.removeItem('resetToken');
    ui.showToast('Password reset successfully. Please login.', 'success');
    setTimeout(() => navigateTo('login'), 2000);
}

// ==================== PROFILE MANAGEMENT ====================

export async function updateProfile(updates) {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    const result = await convexHttpClient.action('users/mutations:updateProfile', {
        token: getToken(),
        ...updates,
    });
    if (!result || !result.success) {
        if (result?.error === 'invalid_token' || result?.message?.includes('token')) {
            await handleTokenError(new Error(result.message));
            return;
        }
        throw new Error(result?.message || 'Update failed');
    }
    await setUser(result.data.user);
    return result.data.user;
}

export async function changePassword({ currentPassword, newPassword }) {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    const result = await convexHttpClient.action('auth/actions:changePassword', {
        token: getToken(),
        currentPassword,
        newPassword,
    });
    if (!result || !result.success) {
        if (result?.error === 'invalid_token' || result?.message?.includes('token')) {
            await handleTokenError(new Error(result.message));
            return;
        }
        throw new Error(result?.message || 'Password change failed');
    }
    ui.showToast(
        'Password changed successfully. You have been logged out from other devices.',
        'success'
    );
}

export async function updatePreferences(preferences) {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    const result = await convexHttpClient.action('users/mutations:updatePreferences', {
        token: getToken(),
        ...preferences,
    });
    if (!result || !result.success) {
        if (result?.error === 'invalid_token' || result?.message?.includes('token')) {
            await handleTokenError(new Error(result.message));
            return;
        }
        throw new Error(result?.message || 'Update preferences failed');
    }
    await setUser(result.data.user);
}

export async function exportData() {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    const result = await convexHttpClient.action('users/actions:exportData', {
        token: getToken(),
    });
    if (!result || !result.success) {
        if (result?.error === 'invalid_token' || result?.message?.includes('token')) {
            await handleTokenError(new Error(result.message));
            return;
        }
        throw new Error(result?.message || 'Export failed');
    }
    const { downloadUrl, fileName } = result.data;
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = fileName || `medical-exam-data-${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    ui.showToast('Export started', 'success');
}

// ==================== CLEAR ALL LOCAL DATA ====================

async function clearAllLocalData() {
    try {
        if (typeof db.clearDatabase === 'function') {
            await db.clearDatabase();
        }
    } catch (e) {
        console.warn('[Auth] Failed to clear IndexedDB:', e);
    }

    const localStorageKeys = [
        'accessToken', 'sessionId', 'user', 'subscription',
        'ai_chats', 'ai_usage_count', 'referral_code',
        'sync_state', 'sync_timer', 'deviceFingerprint',
        'examConfig', 'examState', 'selectedPlan',
        'currentTransaction', 'rememberedEmail', 'appSettings',
        'favorite_resources', 'lastExam', 'downloadedExams',
        'securityViolations', 'lockStatus', 'userStats',
        'notes_fallback', 'conversations_fallback',
        'chatHistory_fallback', 'notifications_fallback',
        'publicAssetVersions',
        'referral_cache_referral', 'referral_cache_agent',
        'convex_session',
    ];

    for (const key of localStorageKeys) {
        try { localStorage.removeItem(key); } catch (e) {}
    }

    try { sessionStorage.clear(); } catch (e) {}
}

// ==================== ACCOUNT DELETION ====================

export async function deleteAccount(password) {
    requireOnline();

    const token = getToken();
    if (!token) throw new Error('Not authenticated. Please log in again.');

    const user = getUser();
    if (!user) throw new Error('User data not found. Please log in again.');

    const result = await convexHttpClient.action('users/mutations:deleteAccount', {
        token,
        password,
    });

    if (!result || !result.success) {
        if (result?.error === 'invalid_token' || result?.message?.includes('token')) {
            await handleTokenError(new Error(result.message));
            return;
        }
        const msg = result?.message || 'Account deletion failed';
        if (msg.toLowerCase().includes('password')) {
            throw new Error('The password you entered is incorrect. Please try again.');
        }
        throw new Error(msg);
    }

    await clearAllLocalData();
    currentUser = null;
    clearToken();
    utils.removeLocalStorage('sessionId');
    await subscription.clearSubscription();
    examEngine.clearExamConfig();
    examEngine.clearExamState();

    ui.showToast('Account permanently deleted.', 'success');
    navigateTo('welcome.html');
}

// ==================== SESSION MANAGEMENT ====================

export function startSession() {
    console.log('[Auth] Persistent session active. No frontend auto-logout timer.');
}

export function extendSession() {
    startSession();
}

// ==================== DEVICE MANAGEMENT ====================

/**
 * Get the list of active devices for the current user.
 * Returns { devices, maxDevices, devicesUsed, overLimit }.
 *
 * Old name: getDevices()  (kept as alias below)
 */
export async function listActiveDevices() {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');

    const currentDeviceId = await security.getDeviceId();

    const result = await convexHttpClient.action('auth/actions:listActiveDevices', {
        token,
        currentDeviceId,
    });

    if (!result || !result.success) {
        if (result?.error === 'invalid_token' || result?.message?.includes('token')) {
            await handleTokenError(new Error(result.message));
            return { devices: [], maxDevices: 1, devicesUsed: 0, overLimit: false };
        }
        throw new Error(result?.message || 'Failed to fetch devices');
    }

    return result.data;
}

/**
 * Remove a specific device from the current user's account.
 * Cannot remove the current device (backend rejects that).
 *
 * Old name: logoutDevice(fingerprint)  (kept as alias below)
 */
export async function removeOtherDevice(deviceId) {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');

    const currentDeviceId = await security.getDeviceId();

    const result = await convexHttpClient.action('auth/actions:removeOtherDevice', {
        token,
        deviceId,
        currentDeviceId,
    });

    if (!result || !result.success) {
        if (result?.error === 'invalid_token' || result?.message?.includes('token')) {
            await handleTokenError(new Error(result.message));
            return;
        }
        throw new Error(result?.message || 'Failed to remove device');
    }

    ui.showToast('Device removed', 'success');
    return result.data;
}

/**
 * Log out from all other devices except the current one.
 *
 * Old name: logoutAllDevices()  (kept as alias below)
 */
export async function removeOtherDevices() {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');

    const currentSessionId = utils.getLocalStorage('sessionId');
    if (!currentSessionId) throw new Error('No active session');

    const result = await convexHttpClient.action('auth/actions:removeOtherDevices', {
        token,
        currentSessionId,
    });

    if (!result || !result.success) {
        if (result?.error === 'invalid_token' || result?.message?.includes('token')) {
            await handleTokenError(new Error(result.message));
            return;
        }
        throw new Error(result?.message || 'Failed to log out other devices');
    }

    ui.showToast(result.data.message || 'Other devices logged out', 'success');
    return result.data;
}

// ---- Deprecated aliases (kept so any old callers keep working) ----

export async function getDevices() {
    const result = await listActiveDevices();
    return result.devices;
}

export async function logoutDevice(deviceId) {
    return removeOtherDevice(deviceId);
}

export async function logoutAllDevices() {
    return removeOtherDevices();
}

// ==================== GOOGLE SIGN-IN ====================

/**
 * Send the Google ID token to the backend for verification.
 *
 * Backend response shapes:
 *   1. { success: true,  status: "SUCCESS",
 *        data: { token, userId, name, email, username, displayName,
 *                sessionId, deviceId, isNewDevice } }
 *   2. { success: true,  status: "NEW_ACCOUNT",  data: { token, ... } }
 *   3. { success: false, status: "DEVICE_LIMIT_REACHED",
 *        data: { devices, maxDevices, switchToken, newDevice, via } }
 *   4. { success: false, status: "EXISTING_ACCOUNT_REQUIRES_LINK",
 *        data: { linkToken, email } }
 *   5. { success: false, message: "..." }  for any other error
 */
export async function loginWithGoogle(idToken, referralCode) {
    if (!idToken) throw new Error('Missing Google ID token');
    requireOnline();

    const { deviceId, deviceInfo } = await buildDeviceIdentity();

    const effectiveReferralCode = referralCode || getStoredReferralCode() || undefined;

    const result = await convexHttpClient.action('auth/actions:googleSignIn', {
        idToken,
        deviceId,
        deviceInfo,
        referralCode: effectiveReferralCode,
    });

    if (!result) throw new Error('Google sign-in failed: empty response');

    const status = result.status || result.data?.status;

    // ---- DEVICE LIMIT REACHED ----
    if (status === 'DEVICE_LIMIT_REACHED') {
        const err = new Error(result.message || 'Device limit reached.');
        err.code = 'DEVICE_LIMIT_REACHED';
        err.deviceLimitPayload = result.data || {};
        throw err;
    }

    // ---- LINK REQUIRED ----
    if (status === 'EXISTING_ACCOUNT_REQUIRES_LINK') {
        return {
            ok: false,
            requiresLink: true,
            email: result.data?.email || '',
            linkToken: result.data?.linkToken || null,
            idToken,
            deviceId,
            deviceInfo,
            referralCode: effectiveReferralCode,
        };
    }

    // ---- OTHER FAILURES ----
    if (!result.success) {
        throw new Error(result.message || 'Google sign-in failed');
    }

    // ---- SUCCESS ----
    const data = result.data || {};
    const successStatus = data.status || 'SUCCESS';

    if (successStatus === 'SUCCESS' || successStatus === 'NEW_ACCOUNT') {
        const user = normalizeUser(data);
        setToken(data.token);
        if (data.sessionId) utils.setLocalStorage('sessionId', data.sessionId);
        if (user) await setUser(user);
        if (deviceId) security.setDeviceFingerprint(deviceId);

        clearStoredReferralCode();

        await sync.syncUserData();
        try { await subscription.refreshSubscription(); } catch (e) {}

        return {
            ok: true,
            isNewUser: successStatus === 'NEW_ACCOUNT',
            user,
        };
    }

    throw new Error(data.reason || 'Google sign-in failed');
}

/**
 * Complete the account-linking flow.
 *
 * Backend expects: { linkToken, password, deviceId, deviceInfo }
 */
export async function linkGoogleAccount({
    linkToken,
    password,
    deviceId,
    deviceInfo,
}) {
    requireOnline();

    if (!password) throw new Error('Password is required to link your account.');
    if (!linkToken) throw new Error('Missing link token. Please sign in with Google again.');

    const fallback = await buildDeviceIdentity();
    const effectiveDeviceId = deviceId || fallback.deviceId;
    const info = (deviceInfo && typeof deviceInfo === 'object')
        ? deviceInfo
        : fallback.deviceInfo;

    const payload = {
        linkToken,
        password,
        deviceId: effectiveDeviceId,
        deviceInfo: info,
    };

    const result = await convexHttpClient.action('auth/actions:linkGoogleAccount', payload);

    if (!result || !result.success) {
        throw new Error(result?.message || 'Account linking failed');
    }

    const data = result.data || {};
    const user = normalizeUser(data);

    setToken(data.token);
    if (data.sessionId) utils.setLocalStorage('sessionId', data.sessionId);
    if (user) await setUser(user);
    if (effectiveDeviceId) security.setDeviceFingerprint(effectiveDeviceId);

    clearStoredReferralCode();

    await sync.syncUserData();
    try { await subscription.refreshSubscription(); } catch (e) {}

    return { ok: true, user };
}

// ==================== EXPOSE GLOBALLY ====================

window.auth = {
    // ---- Email / Phone ----
    login,
    register,
    logout,
    refreshSession,
    getSecurityQuestions,
    verifySecurityAnswers,
    resetPassword,
    updateProfile,
    changePassword,
    updatePreferences,
    exportData,
    deleteAccount,
    startSession,
    extendSession,
    getToken,
    isTokenValid,

    // ---- Device management (new names) ----
    listActiveDevices,
    removeOtherDevice,
    removeOtherDevices,
    removeDeviceAndContinue,

    // ---- Device management (deprecated aliases) ----
    getDevices,
    logoutDevice,
    logoutAllDevices,

    // ---- Google Sign-In ----
    loginWithGoogle,
    linkGoogleAccount,

    // ---- Token / User ----
    setToken,
    clearToken,
    getUser,
    setUser,
    initUser,
    fallbackLoadUser,
    clearUser,
    checkAuth,
};