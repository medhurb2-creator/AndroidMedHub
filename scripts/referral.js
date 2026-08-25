// frontend-user/scripts/referral.js

/**
 * Referral System Module – Convex Integration
 * Handles referral dashboard, code validation, withdrawals, and agent features.
 * All authenticated calls include the JWT token.
 * Implements caching for offline use (IndexedDB with localStorage fallback).
 * Always fetches fresh data when online and updates cache.
 */

import * as utils from './utils.js';
import * as ui from './ui.js';
import * as auth from './auth.js';
import * as router from './router.js';
import { convexHttpClient } from './convex-client.js';
import { getToken } from './auth.js';
import * as db from './db.js';

// ==================== CONSTANTS ====================

const STORAGE_KEY_REFERRAL_CODE = 'referral_code';
const STORAGE_KEY_REFERRAL_DATA = 'referral_data';
const STORAGE_KEY_AGENT_DATA = 'agent_data';

// Base URL for referral links (production)
const BASE_URL = 'https://medhub.edgeone.app';

// ==================== TOKEN ERROR HANDLER ====================

function handleTokenError(error) {
    const message = error.message || error.toString();
    if (message && (
        message.includes('invalid_token') ||
        message.includes('session_expired') ||
        message.includes('verify authentication token') ||
        message.includes('Failed to verify authentication token') ||
        message.includes('Unauthorized')
    )) {
        console.warn('[Referral] Token invalid, logging out...');
        utils.removeLocalStorage('accessToken');
        utils.removeLocalStorage('sessionId');
        auth.clearUser();
        ui.showToast('Session expired. Please login again.', 'warning');
        router.navigateTo('login'); // clean URL
        return true;
    }
    return false;
}

// ==================== CACHE HELPERS ====================

/**
 * Save referral data to IndexedDB (or localStorage fallback)
 * @param {string} key - 'referral' or 'agent'
 * @param {Object} data - the data to cache
 */
async function saveCachedData(key, data) {
    const cacheData = {
        data,
        timestamp: Date.now()
    };
    try {
        if (typeof db.saveReferralData === 'function') {
            await db.saveReferralData(key, cacheData);
        } else {
            utils.setLocalStorage(`referral_cache_${key}`, cacheData);
        }
    } catch (e) {
        // Fallback to localStorage
        utils.setLocalStorage(`referral_cache_${key}`, cacheData);
    }
}

/**
 * Retrieve cached referral data
 * @param {string} key - 'referral' or 'agent'
 * @returns {Object|null} cached data or null
 */
async function getCachedData(key) {
    try {
        let cacheData = null;
        if (typeof db.getReferralData === 'function') {
            cacheData = await db.getReferralData(key);
        } else {
            cacheData = utils.getLocalStorage(`referral_cache_${key}`, null);
        }
        if (cacheData && cacheData.data) {
            return cacheData.data;
        }
    } catch (e) {
        // Fallback to localStorage
        const fallback = utils.getLocalStorage(`referral_cache_${key}`, null);
        if (fallback && fallback.data) {
            return fallback.data;
        }
    }
    return null;
}

// ==================== URL REFERRAL DETECTION ====================

export function detectReferralFromURL() {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref && ref.length >= 6) {
        utils.setLocalStorage(STORAGE_KEY_REFERRAL_CODE, ref);
        console.log('[Referral] Detected referral code from URL:', ref);
        return ref;
    }
    return null;
}

export function getStoredReferralCode() {
    return utils.getLocalStorage(STORAGE_KEY_REFERRAL_CODE, null);
}

export function clearStoredReferralCode() {
    utils.removeLocalStorage(STORAGE_KEY_REFERRAL_CODE);
}

// ==================== VALIDATE REFERRAL CODE ====================

export async function validateReferralCode(referralCode) {
    if (!referralCode || referralCode.length < 6) {
        return { valid: false, referrerName: null, isAgent: false };
    }

    try {
        const result = await convexHttpClient.action("referrals/queries:validateReferralCode", {
            referralCode
        });
        if (result.success && result.data) {
            return {
                valid: result.data.valid,
                referrerName: result.data.referrerName || null,
                isAgent: result.data.isAgent || false
            };
        }
        return { valid: false, referrerName: null, isAgent: false };
    } catch (err) {
        console.warn('[Referral] Validation error:', err);
        return { valid: false, referrerName: null, isAgent: false };
    }
}

// ==================== GET REFERRAL DASHBOARD (with cache) ====================

/**
 * Get the user's referral dashboard data.
 * Always returns fresh data when online, updates cache, and falls back to cache when offline.
 * @returns {Promise<Object>} { referralCode, balance, totalEarned, referrals, count, successful, isAgent }
 */
export async function getReferralDashboard() {
    const token = getToken();
    if (!token) {
        throw new Error('Not authenticated');
    }

    const isOnline = navigator.onLine;

    // Try to fetch fresh data if online
    if (isOnline) {
        try {
            const result = await convexHttpClient.action("referrals/queries:getReferralDashboard", {
                token
            });
            if (result.success && result.data) {
                // Cache the fresh data
                await saveCachedData('referral', result.data);
                return result.data;
            }
            throw new Error(result.message || 'Failed to load referral dashboard');
        } catch (err) {
            console.error('[Referral] Dashboard error:', err);
            if (handleTokenError(err)) {
                // Token error, will redirect
                return {};
            }
            // If fetch fails (network error), fallback to cache
            console.warn('[Referral] Fetch failed, falling back to cache');
        }
    }

    // Offline or fetch failed – return cached data
    const cached = await getCachedData('referral');
    if (cached) {
        console.log('[Referral] Using cached referral data');
        return cached;
    }

    // No cache and offline/error
    throw new Error('No cached data available and offline');
}

// ==================== GET AGENT DASHBOARD (with cache) ====================

export async function getAgentDashboard() {
    const token = getToken();
    if (!token) {
        throw new Error('Not authenticated');
    }

    const isOnline = navigator.onLine;

    if (isOnline) {
        try {
            const result = await convexHttpClient.action("referrals/queries:getAgentDashboard", {
                token
            });
            if (result.success && result.data) {
                await saveCachedData('agent', result.data);
                return result.data;
            }
            throw new Error(result.message || 'Failed to load agent dashboard');
        } catch (err) {
            console.error('[Referral] Agent dashboard error:', err);
            if (handleTokenError(err)) return {};
            console.warn('[Referral] Agent fetch failed, falling back to cache');
        }
    }

    const cached = await getCachedData('agent');
    if (cached) {
        console.log('[Referral] Using cached agent data');
        return cached;
    }

    throw new Error('No cached agent data available and offline');
}

// ==================== REQUEST WITHDRAWAL ====================

export async function requestWithdrawal(amount, phoneNumber) {
    const token = getToken();
    if (!token) {
        throw new Error('Not authenticated');
    }

    if (!amount || amount <= 0) {
        throw new Error('Please enter a valid amount');
    }
    if (amount < 100) {
        throw new Error('Minimum withdrawal is KSh 100');
    }

    const digits = phoneNumber.replace(/\D/g, '');
    if (!(digits.length === 12 && digits.startsWith('254')) &&
        !(digits.length === 10 && digits.startsWith('07')) &&
        !(digits.length === 9 && digits.startsWith('7'))) {
        throw new Error('Please enter a valid Kenyan phone number');
    }

    let formattedPhone;
    if (digits.length === 10 && digits.startsWith('07')) {
        formattedPhone = '254' + digits.substring(1);
    } else if (digits.length === 9 && digits.startsWith('7')) {
        formattedPhone = '254' + digits;
    } else if (digits.length === 12 && digits.startsWith('254')) {
        formattedPhone = digits;
    } else {
        throw new Error('Invalid phone number format');
    }

    try {
        // ✅ Fixed: Use `.action` instead of `.mutation` because backend is an action
        const result = await convexHttpClient.action("referrals/mutations:requestWithdrawal", {
            token,
            amount,
            phoneNumber: formattedPhone
        });
        if (result.success) {
            return result.data;
        }
        throw new Error(result.message || 'Withdrawal request failed');
    } catch (err) {
        console.error('[Referral] Withdrawal error:', err);
        if (handleTokenError(err)) throw new Error('Session expired. Please login again.');
        throw err;
    }
}

// ==================== GENERATE REFERRAL LINK ====================

export function generateReferralLink(referralCode) {
    return `${BASE_URL}/?ref=${encodeURIComponent(referralCode)}`;
}

export function copyReferralLink(referralCode) {
    const link = generateReferralLink(referralCode);
    navigator.clipboard?.writeText(link).then(() => {
        ui.showToast('Referral link copied!', 'success');
    }).catch(() => {
        const textarea = document.createElement('textarea');
        textarea.value = link;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        ui.showToast('Referral link copied!', 'success');
    });
}

export function shareReferralLink(referralCode) {
    const link = generateReferralLink(referralCode);
    const shareData = {
        title: 'Join MedHub and ace your medical exams!',
        text: 'Use my referral link to join MedHub and get started with premium medical exam prep:',
        url: link
    };

    // 1. Try Capacitor Share (if available)
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share) {
        window.Capacitor.Plugins.Share.share({
            title: shareData.title,
            text: shareData.text,
            url: shareData.url,
            dialogTitle: 'Share Referral Link'
        }).catch(() => {
            // Fallback to Web Share or clipboard
            fallbackShare(shareData);
        });
    }
    // 2. Try Web Share API
    else if (navigator.share) {
        navigator.share(shareData).catch(() => {
            fallbackShare(shareData);
        });
    }
    // 3. Fallback to clipboard
    else {
        fallbackShare(shareData);
    }
}

// Helper fallback for share
function fallbackShare(shareData) {
    copyReferralLink(shareData.url.split('?ref=')[1]); // extract code from URL
}

// ==================== EXPOSE GLOBALLY ====================

window.referral = {
    detectReferralFromURL,
    getStoredReferralCode,
    clearStoredReferralCode,
    validateReferralCode,
    getReferralDashboard,
    getAgentDashboard,
    requestWithdrawal,
    generateReferralLink,
    copyReferralLink,
    shareReferralLink
};