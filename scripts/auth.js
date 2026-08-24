// scripts/auth.js

/**
 * Authentication Handler – Convex Integration
 * Uses Convex backend for authentication when online.
 * Supports session management (single-device enforcement) and device tracking.
 * Includes referral code support during registration.
 */

import * as ui from './ui.js';
import * as utils from './utils.js';
import * as security from './security.js';
import * as db from './db.js';
import * as sync from './sync.js';
import * as subscription from './subscription.js';
import * as examEngine from './exam-engine.js';
import { convexHttpClient } from './convex-client.js';
import { navigateTo } from './router.js';  // ← for clean navigation

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
    console.log('[Auth] Setting user:', user._id);
    currentUser = user;

    try {
        await db.saveUser(user);
        console.log('[Auth] User saved to IndexedDB');
    } catch (e) {
        console.warn('[Auth] IndexedDB save failed, using localStorage', e);
    }
    utils.setLocalStorage('user', user);
    console.log('[Auth] User set and saved to both storages');
}

export async function initUser() {
    console.log('[Auth] Initializing user...');
    let userFromDB = null;
    try {
        userFromDB = await db.getUser();
        console.log('[Auth] User from IndexedDB:', userFromDB ? userFromDB._id : 'none');
    } catch (e) {
        console.warn('[Auth] Failed to load from IndexedDB', e);
    }

    const userFromStorage = utils.getLocalStorage('user', null);
    if (userFromDB) {
        currentUser = userFromDB;
        console.log('[Auth] Loaded user from IndexedDB:', currentUser);
    } else if (userFromStorage) {
        currentUser = userFromStorage;
        if (userFromStorage) {
            try {
                await db.saveUser(userFromStorage);
                console.log('[Auth] Restored user from localStorage to IndexedDB');
            } catch (e) {}
        }
    } else {
        currentUser = null;
    }
    return currentUser;
}

export function fallbackLoadUser() {
    currentUser = utils.getLocalStorage('user', null);
}

export async function clearUser() {
    console.log('[Auth] Clearing user');
    currentUser = null;
    try {
        await db.deleteAllUsers();
        console.log('[Auth] User deleted from IndexedDB');
    } catch (e) {
        console.warn('[Auth] IndexedDB delete failed', e);
    }
    utils.removeLocalStorage('user');
    clearToken();
}

export function checkAuth() {
    const token = getToken();
    const hasUser = !!currentUser;
    console.log('[Auth] checkAuth: token exists?', !!token, 'user exists?', hasUser);
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
    if (error.data?.message) return error.data.message;
    if (error.message) return error.message;
    return 'An unknown error occurred';
}

// ==================== TOKEN ERROR HANDLER ====================

async function handleTokenError(error) {
    const message = error?.message || error?.toString() || '';

    const isTokenError =
        message.includes('invalid_token') ||
        message.includes('session_expired') ||
        message.includes('verify authentication token') ||
        message.includes('Failed to verify authentication token') ||
        message.includes('Unauthorized') ||
        message.includes('authentication failed') ||
        message.includes('token') ||
        message.includes('JWT verification error') ||
        message.includes('jwt expired') ||
        message.includes('TokenExpiredError');

    if (!isTokenError) {
        return false;
    }

    if (!navigator.onLine) {
        console.warn('[Auth] Token expired while offline. Keeping local session.');
        return true;
    }

    console.warn('[Auth] Access token invalid/expired. Attempting refresh...');
    const refreshed = await refreshSession();

    if (refreshed) {
        console.log('[Auth] Token refreshed successfully.');
        return true;
    }

    console.warn('[Auth] Persistent session could not be refreshed.');
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

export async function refreshSession() {
    if (!navigator.onLine) {
        console.log('[Auth] Offline — cannot refresh token.');
        return false;
    }

    const sessionId = utils.getLocalStorage('sessionId');

    if (!sessionId) {
        console.warn('[Auth] No sessionId available for refresh.');
        return false;
    }

    try {
        const result = await convexHttpClient.action(
            "auth/actions:refreshSession",
            { sessionId }
        );

        if (!result || !result.success || !result.data?.token) {
            console.warn('[Auth] Session refresh failed:', result?.message);
            return false;
        }

        setToken(result.data.token);
        console.log('[Auth] JWT silently refreshed.');
        return true;
    } catch (error) {
        console.warn('[Auth] Session refresh error:', error);
        return false;
    }
}

// ==================== LOGIN ====================

export async function login(identifier, password, deviceInfo) {
    console.log('[Auth] Login attempt:', identifier);
    requireOnline();

    try {
        const deviceInfoObj = typeof deviceInfo === 'object' && deviceInfo !== null
            ? deviceInfo
            : { platform: deviceInfo || 'web' };

        const result = await convexHttpClient.action("auth/actions:login", {
            identifier,
            password,
            deviceFingerprint: deviceInfoObj.deviceFingerprint,
            deviceInfo: {
                platform: deviceInfoObj.platform || 'web',
                lastIp: deviceInfoObj.lastIp
            }
        });

        if (!result.success) {
            throw new Error(result.message);
        }

        const { token, userId, name, email, sessionId, isNewDevice } = result.data;
        setToken(token);
        await setUser({ _id: userId, name, email });
        security.setDeviceFingerprint(deviceInfoObj.deviceFingerprint);

        if (sessionId) {
            utils.setLocalStorage('sessionId', sessionId);
        }

        if (isNewDevice) {
            ui.showToast('New device detected. You are now logged in on this device.', 'info', 4000);
        }

        await sync.syncUserData();

        // ✅ Refresh subscription immediately after login
        try {
            await subscription.refreshSubscription();
            console.log('[Auth] Subscription refreshed after login.');
        } catch (subErr) {
            console.warn('[Auth] Could not refresh subscription after login:', subErr);
        }

        console.log('[Auth] Login successful:', email);
        return { _id: userId, name, email };
    } catch (error) {
        console.error('[Auth] Login failed', error);
        const msg = getErrorMessage(error);
        throw new Error(msg);
    }
}

// ==================== REGISTER ====================

export async function register(userData) {
    console.log('[Auth] Register attempt:', userData.email);
    requireOnline();

    try {
        let referralCode = userData.referralCode || getStoredReferralCode();
        const isAgent = userData.isAgent || false;
        const agentVerified = userData.agentVerified || false;

        const deviceInfoObj = typeof userData.deviceInfo === 'object' && userData.deviceInfo !== null
            ? userData.deviceInfo
            : { platform: userData.deviceInfo || 'web' };

        const result = await convexHttpClient.action("auth/actions:register", {
            name: userData.name,
            email: userData.email.toLowerCase(),
            phone: userData.phone,
            password: userData.password,
            securityQuestions: userData.securityQuestions.map(q => ({
                question: q.question,
                answer: q.answer
            })),
            deviceFingerprint: userData.deviceFingerprint,
            deviceInfo: {
                platform: deviceInfoObj.platform || 'web',
                lastIp: deviceInfoObj.lastIp
            },
            referralCode: referralCode || undefined,
            isAgent: isAgent,
            agentVerified: agentVerified
        });

        if (!result.success) {
            throw new Error(result.message);
        }

        const { token, userId, name, email, referralCode: userReferralCode, isAgent: userIsAgent } = result.data;
        setToken(token);
        await setUser({ _id: userId, name, email, referralCode: userReferralCode, isAgent: userIsAgent });
        security.setDeviceFingerprint(userData.deviceFingerprint);

        clearStoredReferralCode();

        await sync.syncUserData();

        // ✅ Refresh subscription immediately after registration
        try {
            await subscription.refreshSubscription();
            console.log('[Auth] Subscription refreshed after registration.');
        } catch (subErr) {
            console.warn('[Auth] Could not refresh subscription after registration:', subErr);
        }

        console.log('[Auth] Registration successful:', email);
        return { _id: userId, name, email, referralCode: userReferralCode, isAgent: userIsAgent };
    } catch (error) {
        console.error('[Auth] Registration failed', error);
        const msg = getErrorMessage(error);
        throw new Error(msg);
    }
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
    try {
        const result = await convexHttpClient.query("auth/queries:getSecurityQuestions", { identifier });
        if (!result.success) {
            throw new Error(result.message);
        }
        return result.data.questions;
    } catch (error) {
        console.error('[Auth] Failed to get security questions', error);
        const msg = getErrorMessage(error);
        if (msg.includes('User not found')) {
            throw new Error('User not found');
        }
        throw new Error(msg || 'Failed to retrieve security questions');
    }
}

export async function verifySecurityAnswers(identifier, answers) {
    requireOnline();
    try {
        const result = await convexHttpClient.action("auth/actions:verifySecurityAnswers", {
            identifier,
            answers
        });
        if (!result.success) {
            throw new Error(result.message);
        }
        sessionStorage.setItem('resetToken', result.data.resetToken);
        return result.data.resetToken;
    } catch (error) {
        console.error('[Auth] Verify answers failed', error);
        const msg = getErrorMessage(error);
        throw new Error(msg);
    }
}

export async function resetPassword(identifier, newPassword) {
    const resetToken = sessionStorage.getItem('resetToken');
    if (!resetToken) throw new Error('No reset token. Please restart the process.');

    requireOnline();
    try {
        const result = await convexHttpClient.action("auth/actions:resetPassword", {
            identifier,
            newPassword,
            resetToken
        });
        if (!result.success) {
            throw new Error(result.message);
        }
        sessionStorage.removeItem('resetToken');
        ui.showToast('Password reset successfully. Please login.', 'success');
        // ✅ Clean SPA redirect
        setTimeout(() => {
            navigateTo('login');
        }, 2000);
    } catch (error) {
        console.error('[Auth] Reset password failed', error);
        throw new Error(getErrorMessage(error) || 'Password reset failed');
    }
}

// ==================== PROFILE MANAGEMENT ====================

export async function updateProfile(updates) {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    try {
        const result = await convexHttpClient.action("users/mutations:updateProfile", {
            token: getToken(),
            ...updates
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.includes('token')) {
                await handleTokenError(new Error(result.message));
                return;
            }
            throw new Error(result.message);
        }
        await setUser(result.data.user);
        return result.data.user;
    } catch (error) {
        console.error('[Auth] Update profile failed', error);
        if (await handleTokenError(error)) return;
        throw new Error(getErrorMessage(error) || 'Update failed');
    }
}

export async function changePassword({ currentPassword, newPassword }) {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    try {
        const result = await convexHttpClient.action("auth/actions:changePassword", {
            token: getToken(),
            currentPassword,
            newPassword
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.includes('token')) {
                await handleTokenError(new Error(result.message));
                return;
            }
            throw new Error(result.message);
        }
        ui.showToast('Password changed successfully. You have been logged out from other devices.', 'success');
    } catch (error) {
        console.error('[Auth] Change password failed', error);
        if (await handleTokenError(error)) return;
        throw new Error(getErrorMessage(error) || 'Password change failed');
    }
}

export async function updatePreferences(preferences) {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    try {
        const result = await convexHttpClient.action("users/mutations:updatePreferences", {
            token: getToken(),
            ...preferences
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.includes('token')) {
                await handleTokenError(new Error(result.message));
                return;
            }
            throw new Error(result.message);
        }
        await setUser(result.data.user);
    } catch (error) {
        console.error('[Auth] Update preferences failed', error);
        if (await handleTokenError(error)) return;
        throw new Error(getErrorMessage(error) || 'Update preferences failed');
    }
}

export async function exportData() {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    try {
        const result = await convexHttpClient.action("users/actions:exportData", {
            token: getToken()
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.includes('token')) {
                await handleTokenError(new Error(result.message));
                return;
            }
            throw new Error(result.message);
        }
        const { downloadUrl, fileName } = result.data;
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = fileName || `medical-exam-data-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        ui.showToast('Export started', 'success');
    } catch (error) {
        console.error('[Auth] Export data failed', error);
        if (await handleTokenError(error)) return;
        throw new Error(getErrorMessage(error) || 'Export failed');
    }
}

export async function deleteAccount(password) {
    requireOnline();
    const user = getUser();
    if (!user) throw new Error('Not authenticated');

    try {
        const result = await convexHttpClient.action("users/mutations:deleteAccount", {
            token: getToken(),
            password
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.includes('token')) {
                await handleTokenError(new Error(result.message));
                return;
            }
            throw new Error(result.message);
        }
        await logout();
        ui.showToast('Account deleted', 'info');
    } catch (error) {
        console.error('[Auth] Delete account failed', error);
        if (await handleTokenError(error)) return;
        const msg = getErrorMessage(error);
        if (msg.includes('Invalid password')) {
            throw new Error('Password incorrect');
        }
        throw new Error(msg || 'Account deletion failed');
    }
}

// ==================== SESSION MANAGEMENT ====================

export function startSession() {
    console.log('[Auth] Persistent session active. No frontend auto-logout timer.');
}

export function extendSession() {
    startSession();
}

// ==================== DEVICE MANAGEMENT ====================

export async function getDevices() {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    try {
        const result = await convexHttpClient.query("users/queries:getDevices", { token });
        if (!result.success) {
            throw new Error(result.message);
        }
        return result.data.devices;
    } catch (error) {
        console.error('[Auth] Failed to fetch devices', error);
        throw new Error(getErrorMessage(error) || 'Failed to fetch devices');
    }
}

export async function logoutDevice(fingerprint) {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    try {
        const result = await convexHttpClient.action("users/mutations:logoutDevice", {
            token,
            fingerprint
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.includes('token')) {
                await handleTokenError(new Error(result.message));
                return;
            }
            throw new Error(result.message);
        }
        ui.showToast('Device logged out', 'success');
    } catch (error) {
        console.error('[Auth] Logout device failed', error);
        if (await handleTokenError(error)) return;
        throw new Error(getErrorMessage(error) || 'Failed to logout device');
    }
}

export async function logoutAllDevices() {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    try {
        const result = await convexHttpClient.action("users/mutations:logoutAllDevices", { token });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.includes('token')) {
                await handleTokenError(new Error(result.message));
                return;
            }
            throw new Error(result.message);
        }
        ui.showToast('All other devices logged out', 'success');
    } catch (error) {
        console.error('[Auth] Logout all devices failed', error);
        if (await handleTokenError(error)) return;
        throw new Error(getErrorMessage(error) || 'Failed to logout all devices');
    }
}

// ==================== EXPOSE GLOBALLY ====================

window.auth = {
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
    getDevices,
    logoutDevice,
    logoutAllDevices,
    // Additional exports used by app.js and other modules
    setToken,
    clearToken,
    getUser,
    setUser,
    initUser,
    fallbackLoadUser,
    clearUser,
    checkAuth
};