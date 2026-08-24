// scripts/subscription.js

/**
 * Subscription Management – Backend‑Integrated
 * Handles free trial, subscription plans, expiry checks, eligibility,
 * and free topics for non-subscribers.
 * Stores subscription data in IndexedDB via db.js.
 * All operations that require backend updates will be done through Convex.
 *
 * UI remains unchanged – uses local PLANS constant for display.
 * Backend is used only for eligibility, trial start, status, and purchase.
 */

import * as utils from './utils.js';
import * as db from './db.js';
import * as ui from './ui.js';
import * as payment from './payment.js';
import { convexHttpClient } from './convex-client.js';
import { getToken, logout } from './auth.js';
import * as security from './security.js';
import * as timeVerifier from './timeVerifier.js';
import { navigateTo } from './router.js';  // ✅ import router for SPA navigation

// ==================== CONSTANTS ====================

const PLANS = {
    trial: {
        id: 'trial',
        name: 'Free Trial',
        price: 0,
        duration: 3 * 60 * 60 * 1000,
        durationText: '3 hours',
        features: [
            'Full access to all subjects',
            'All exam modes',
            'Detailed analytics',
            'No payment required'
        ],
        limitations: [
            'Time‑limited (3 hours)',
            'One trial per user',
            'No certificate generation'
        ],
        ctaText: 'Start Free Trial',
        ctaColor: 'primary'
    },
    monthly: {
        id: 'monthly',
        name: 'Monthly Plan',
        price: 300,
        duration: 30 * 24 * 60 * 60 * 1000,
        durationText: '30 days',
        features: [
            'Unlimited access',
            'All 8 subjects',
            'Detailed analytics',
            'Certificate generation',
            'Priority support'
        ],
        ctaText: 'Subscribe – KES 300',
        ctaColor: 'success',
        popular: false
    },
    quarterly: {
        id: 'quarterly',
        name: 'Quarterly Plan',
        price: 850,
        duration: 90 * 24 * 60 * 60 * 1000,
        durationText: '3 months',
        features: [
            'Unlimited access',
            'All 8 subjects',
            'Detailed analytics',
            'Certificate generation',
            'Priority support',
            'Save KES 50'
        ],
        savings: 'Save KES 50',
        ctaText: 'Subscribe – KES 850',
        ctaColor: 'success',
        popular: true
    },
    yearly: {
        id: 'yearly',
        name: 'Yearly Plan',
        price: 2100,
        duration: 365 * 24 * 60 * 60 * 1000,
        durationText: '1 year',
        features: [
            'Unlimited access',
            'All 8 subjects',
            'Detailed analytics',
            'Certificate generation',
            'Priority support',
            'Save KES 1,500'
        ],
        savings: 'Save KES 1,500',
        ctaText: 'Subscribe – KES 2,100',
        ctaColor: 'success'
    }
};

const FREE_TOPICS = {
    anatomy: ['back', 'introduction-anatomy', 'cross-sectional-anatomy'],
    physiology: ['introduction-homeostasis', 'body-fluids-compartments', 'membrane-physiology'],
    biochemistry: ['nucleic-acids', 'bioenergetics', 'metabolism-overview'],
    histology: ['introduction-histology', 'cell-structure', 'adipose-tissue'],
    embryology: ['introduction-embryology', 'gametogenesis', 'fertilization'],
    pathology: ['adaptations', 'intracellular-accumulations', 'hemodynamic-disorders'],
    pharmacology: ['drug-metabolism', 'drug-interactions', 'pharmacodynamics'],
    microbiology: ['bacterial-structure', 'bacterial-physiology', 'sterilization-disinfection']
};

// ==================== STATE ====================

let subscriptionStatus = null;

// ==================== HELPERS ====================

function requireOnline() {
    if (!navigator.onLine) {
        throw new Error('You need to be online to perform this action.');
    }
}

// ==================== SUBSCRIPTION MANAGEMENT ====================

/**
 * Get the current subscription from memory (fast) or from storage.
 * This function always returns the cached value if available; otherwise loads from storage.
 * @returns {Promise<Object|null>}
 */
export async function getSubscription() {
    // If we already have it in memory, return it immediately
    if (subscriptionStatus !== null) return subscriptionStatus;

    // Try IndexedDB
    try {
        const cached = await db.getSubscription();
        if (cached) {
            subscriptionStatus = cached;
            return cached;
        }
    } catch (e) {
        console.warn('[Subscription] Failed to load from IndexedDB, falling back to localStorage', e);
    }

    // Try localStorage
    const local = utils.getLocalStorage('subscription', null);
    if (local) {
        subscriptionStatus = local;
        return local;
    }

    return null;
}

/**
 * Set the subscription in memory, IndexedDB, and localStorage.
 * @param {Object} sub - subscription object
 */
export async function setSubscription(sub) {
    if (!sub) return;
    subscriptionStatus = sub;
    try {
        await db.saveSubscription(sub);
    } catch (e) {
        console.warn('[Subscription] IndexedDB save failed, using localStorage', e);
    }
    utils.setLocalStorage('subscription', sub);
}

/**
 * Clear the subscription from memory and storage.
 */
export async function clearSubscription() {
    subscriptionStatus = null;
    try {
        await db.deleteSubscription();
    } catch (e) {
        console.warn('[Subscription] IndexedDB delete failed', e);
    }
    utils.removeLocalStorage('subscription');
}

// ==================== INITIALIZATION ====================

export async function initSubscription() {
    console.log('[Subscription] Initializing...');
    const token = getToken();

    // If online and we have a token, always try to get the freshest data from backend
    if (navigator.onLine && token) {
        console.log('[Subscription] Online & authenticated – fetching fresh subscription from backend...');
        const sub = await getSubscriptionStatus(true); // force refresh
        if (sub) {
            subscriptionStatus = sub;
            console.log('[Subscription] Loaded fresh from backend:', sub);
        } else {
            subscriptionStatus = null;
            console.log('[Subscription] No active subscription from backend.');
        }
    } else {
        // Offline or no token – just use cached data
        console.log('[Subscription] Offline or not authenticated – loading from cache...');
        const sub = await getSubscriptionStatus(false);
        subscriptionStatus = sub;
    }

    return subscriptionStatus;
}

export function fallbackLoadSubscription() {
    subscriptionStatus = utils.getLocalStorage('subscription', null);
    console.log('[Subscription] Fallback loaded from localStorage:', subscriptionStatus);
}

// ==================== SUBSCRIPTION STATUS ====================

/**
 * Fetch subscription status from backend (if online and allowed), otherwise return cached.
 * @param {boolean} forceRefresh - if true, forces a backend fetch even if online
 * @returns {Promise<Object|null>}
 */
export async function getSubscriptionStatus(forceRefresh = false) {
    // If we're online and (forceRefresh or we don't have a cached value), try backend
    if (navigator.onLine && (forceRefresh || subscriptionStatus === null)) {
        try {
            const token = getToken();
            if (!token) return null;

            const result = await convexHttpClient.action("subscriptions/queries:getSubscriptionStatus", { token });
            if (result && result.success && result.data) {
                const backendSub = result.data;
                const now = timeVerifier.getSafeTimestamp();
                if (now === null) {
                    console.warn('[Subscription] Time tamper detected, returning null');
                    return null;
                }
                const isActive = backendSub.isActive !== undefined
                    ? backendSub.isActive
                    : (backendSub.expiryDate && backendSub.expiryDate > now);
                const normalizedSub = {
                    _id: backendSub._id,
                    plan: backendSub.plan,
                    isActive: isActive,
                    expiryDate: backendSub.expiryDate,
                    status: backendSub.status,
                    startDate: backendSub.startDate,
                    autoRenew: backendSub.autoRenew ?? false,
                    paymentMethod: backendSub.paymentMethod ?? null,
                };
                await setSubscription(normalizedSub);
                timeVerifier.resetTimeVerifier();
                return normalizedSub;
            } else if (result && !result.success) {
                if (result.error === 'invalid_token' || result.message?.toLowerCase().includes('token')) {
                    console.warn('[Subscription] Token invalid, logging out.');
                    await logout();
                    navigateTo('login');  // ✅ use SPA navigation
                    return null;
                }
                console.warn('[Subscription] Backend returned error:', result.message);
            }
        } catch (err) {
            console.warn('[Subscription] Failed to fetch from backend, using cache', err);
        }
    }

    // Return from cache (memory, IndexedDB, localStorage)
    return await getSubscription();
}

// ==================== ACTIVE CHECKS ====================

/**
 * Check if the user has an active subscription (or trial).
 * Always uses the cached subscription and safe timestamp.
 * @returns {Promise<boolean>}
 */
export async function hasActiveSubscription() {
    const now = timeVerifier.getSafeTimestamp();
    if (now === null) {
        console.warn('[Subscription] Time tamper detected, returning false');
        return false;
    }

    const sub = await getSubscription();
    if (!sub) return false;

    const { isActive, expiryDate } = sub;
    // If isActive is explicitly set, use it; otherwise fallback to expiry check
    if (isActive !== undefined && isActive !== null) {
        return isActive && (expiryDate ? expiryDate > now : true);
    }
    // Fallback: check expiry only
    return expiryDate ? expiryDate > now : false;
}

export async function isTrialActive() {
    const now = timeVerifier.getSafeTimestamp();
    if (now === null) return false;
    const sub = await getSubscription();
    return sub && sub.plan === 'trial' && sub.isActive && (sub.expiryDate ? sub.expiryDate > now : false);
}

export async function isPaidSubscription() {
    const now = timeVerifier.getSafeTimestamp();
    if (now === null) return false;
    const sub = await getSubscription();
    return sub && sub.plan !== 'trial' && sub.isActive && (sub.expiryDate ? sub.expiryDate > now : false);
}

// ==================== TRIAL MANAGEMENT ====================

export async function checkTrialEligibility() {
    requireOnline();
    try {
        const token = getToken();
        if (!token) throw new Error('Not authenticated');
        const deviceFingerprint = security.getDeviceFingerprint();
        const result = await convexHttpClient.action("subscriptions/queries:checkTrialEligibility", {
            token,
            deviceFingerprint
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.toLowerCase().includes('token')) {
                await logout();
                navigateTo('login');  // ✅ SPA navigation
                throw new Error('Session expired.');
            }
            throw new Error(result.message);
        }
        return result.data.eligible;
    } catch (err) {
        console.error('Trial eligibility check failed:', err);
        throw new Error('Could not verify trial eligibility');
    }
}

export async function startFreeTrial({ deviceFingerprint }) {
    requireOnline();
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    try {
        const result = await convexHttpClient.action("subscriptions/actions:startFreeTrial", {
            token,
            deviceFingerprint
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.toLowerCase().includes('token')) {
                await logout();
                navigateTo('login');  // ✅ SPA navigation
                throw new Error('Session expired.');
            }
            throw new Error(result.message);
        }
        const subscriptionData = result.data;
        const normalizedSub = {
            _id: subscriptionData.subscriptionId,
            plan: subscriptionData.plan,
            isActive: true,
            expiryDate: subscriptionData.expiryDate,
            status: 'active'
        };
        await setSubscription(normalizedSub);
        timeVerifier.resetTimeVerifier();
        return normalizedSub;
    } catch (err) {
        console.error('Free trial start failed:', err);
        throw new Error(err.message || 'Could not start trial');
    }
}

export async function getTrialRemaining() {
    const now = timeVerifier.getSafeTimestamp();
    if (now === null) return null;
    const sub = await getSubscription();
    if (!sub || sub.plan !== 'trial' || !sub.isActive) return null;
    const expiry = sub.expiryDate;
    if (!expiry) return null;
    const remainingMs = expiry - now;
    if (remainingMs <= 0) return null;
    return utils.formatTime(Math.floor(remainingMs / 1000));
}

// ==================== PLAN MANAGEMENT ====================

export async function getSubscriptionPlans() {
    return Object.values(PLANS);
}

export function selectPlan(planId) {
    const plan = Object.values(PLANS).find(p => p.id === planId);
    payment.setSelectedPlan(plan);
}

export function setCustomPlan(amount) {
    const plan = {
        id: 'custom',
        name: 'Custom Amount',
        price: amount,
        duration: amount,
        durationText: 'Custom',
        features: ['Pay as you wish', 'Flexible access'],
        ctaText: `Pay KES ${amount}`,
        ctaColor: 'primary'
    };
    payment.setSelectedPlan(plan);
}

export async function purchaseSubscription(planId, phoneNumber, customAmount = null) {
    requireOnline();
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    try {
        const result = await convexHttpClient.action("subscriptions/actions:purchaseSubscription", {
            token,
            planName: planId,
            deviceFingerprint: security.getDeviceFingerprint(),
            phoneNumber,
            customAmount,
        });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.toLowerCase().includes('token')) {
                await logout();
                navigateTo('login');  // ✅ SPA navigation
                throw new Error('Session expired.');
            }
            throw new Error(result.message);
        }
        return result.data;
    } catch (err) {
        console.error('Purchase failed:', err);
        throw new Error(err.message || 'Purchase failed');
    }
}

export async function cancelSubscription() {
    requireOnline();
    const sub = await getSubscription();
    if (!sub) throw new Error('No active subscription');
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    try {
        const result = await convexHttpClient.action("subscriptions/actions:cancelSubscription", { token });
        if (!result.success) {
            if (result.error === 'invalid_token' || result.message?.toLowerCase().includes('token')) {
                await logout();
                navigateTo('login');  // ✅ SPA navigation
                throw new Error('Session expired.');
            }
            throw new Error(result.message);
        }
        // Refresh status after cancellation
        await getSubscriptionStatus(true);
        return { success: true };
    } catch (err) {
        console.error('Cancel failed:', err);
        throw new Error(err.message || 'Cancel failed');
    }
}

// ==================== FREE TOPICS ====================

export function isTopicFree(subject, topicId) {
    return FREE_TOPICS[subject]?.includes(topicId) ?? false;
}

export function areAllTopicsFree(config) {
    if (!config || !config.subject || !config.topics || config.topics.length === 0) return false;
    return config.topics.every(t => isTopicFree(config.subject, t.id));
}

// ==================== ACCESS CONTROL ====================

export async function canTakeExam(config) {
    if (await hasActiveSubscription()) return true;
    return areAllTopicsFree(config);
}

export async function canViewAnalytics() {
    return await hasActiveSubscription();
}

export async function canExportResults() {
    return await isPaidSubscription();
}

// ==================== TIME CALCULATIONS ====================

export async function calculateRemainingTime() {
    const now = timeVerifier.getSafeTimestamp();
    if (now === null) return 0;
    const sub = await getSubscription();
    if (!sub || !sub.isActive) return 0;
    const expiry = sub.expiryDate;
    if (!expiry) return 0;
    return Math.max(0, Math.floor((expiry - now) / 1000));
}

export async function formatRemainingTime() {
    const seconds = await calculateRemainingTime();
    if (seconds <= 0) return 'Expired';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}

export async function isExpiringSoon(hours = 24) {
    const seconds = await calculateRemainingTime();
    return seconds > 0 && seconds < hours * 3600;
}

export async function activatePlan(subscriptionData) {
    await setSubscription(subscriptionData);
    timeVerifier.resetTimeVerifier();
    return subscriptionData;
}

// ==================== SYNC ====================

export async function syncSubscription(forceOnline = false) {
    return getSubscriptionStatus(forceOnline);
}

export async function refreshSubscription() {
    return await syncSubscription(true);
}

// ==================== EXPOSE GLOBALLY ====================

window.subscription = {
    getSubscriptionStatus,
    hasActiveSubscription,
    isTrialActive,
    isPaidSubscription,
    checkTrialEligibility,
    startFreeTrial,
    getTrialRemaining,
    getSubscriptionPlans,
    selectPlan,
    setCustomPlan,
    purchaseSubscription,
    cancelSubscription,
    isTopicFree,
    areAllTopicsFree,
    canTakeExam,
    canViewAnalytics,
    canExportResults,
    calculateRemainingTime,
    formatRemainingTime,
    isExpiringSoon,
    syncSubscription,
    setSubscription,
    getSubscription,
    clearSubscription,
    initSubscription,
    fallbackLoadSubscription,
    refreshSubscription
};