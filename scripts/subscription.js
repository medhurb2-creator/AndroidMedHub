// scripts/subscription.js

/**
 * Subscription Management – Backend‑Integrated
 *
 * Aligned with the strict backend schema and the new per-user device tables.
 *
 * Plans, trial duration, multi-device discount, and custom-amount penalty
 * are all fetched from `system/queries:getAppConfig` and cached for offline use.
 * There is NO hardcoded price list — the backend is the single source of truth.
 *
 * Backend contracts used here:
 *   system/queries:getAppConfig                    → plans + settings
 *   subscriptions/queries:getSubscriptionStatus    → active subscription + devices
 *   subscriptions/queries:checkTrialEligibility    → { token, deviceId? }
 *   subscriptions/actions:startFreeTrial           → { token, deviceId, deviceInfo }
 *   subscriptions/actions:purchaseSubscription     → { token, planId, phoneNumber,
 *                                                       deviceId, deviceInfo,
 *                                                       deviceCount, customAmount? }
 *   subscriptions/actions:cancelSubscription       → { token }
 */

import * as utils from './utils.js';
import * as db from './db.js';
import * as ui from './ui.js';
import { convexHttpClient } from './convex-client.js';
import { getToken, logout } from './auth.js';
import * as security from './security.js';
import * as timeVerifier from './timeVerifier.js';
import { navigateTo } from './router.js';

// ==================== CACHE KEYS ====================

const CACHE_KEYS = {
    APP_CONFIG: 'appConfig',       // stored in IndexedDB + localStorage
    SUBSCRIPTION: 'subscription',   // stored in IndexedDB + localStorage
};

// ==================== STATE ====================

let subscriptionStatus = null;
let appConfigCache = null;    // in-memory cache of { plans, settings }

// ==================== FREE TOPICS ====================
// Static list — free topics are not backend-configurable in this build.
const FREE_TOPICS = {
    anatomy: ['back', 'introduction-anatomy', 'cross-sectional-anatomy'],
    physiology: ['introduction-homeostasis', 'body-fluids-compartments', 'membrane-physiology'],
    biochemistry: ['nucleic-acids', 'bioenergetics', 'metabolism-overview'],
    histology: ['introduction-histology', 'cell-structure', 'adipose-tissue'],
    embryology: ['introduction-embryology', 'gametogenesis', 'fertilization'],
    pathology: ['adaptations', 'intracellular-accumulations', 'hemodynamic-disorders'],
    pharmacology: ['drug-metabolism', 'drug-interactions', 'pharmacodynamics'],
    microbiology: ['bacterial-structure', 'bacterial-physiology', 'sterilization-disinfection'],
};

// ==================== HELPERS ====================

function requireOnline() {
    if (!navigator.onLine) {
        throw new Error('You need to be online to perform this action.');
    }
}

function isTokenInvalid(result) {
    if (!result) return false;
    return (
        result.error === 'invalid_token' ||
        result.error === 'session_revoked' ||
        result.error === 'session_expired' ||
        (typeof result.message === 'string' &&
            result.message.toLowerCase().includes('token'))
    );
}

async function handleInvalidToken() {
    console.warn('[Subscription] Token invalid — logging out.');
    try { await logout(); } catch {}
    navigateTo('login');
}

// ==================== APP CONFIG (PLANS + SETTINGS) ====================

/**
 * Return the cached app config from memory/IndexedDB/localStorage.
 * Returns null if nothing is cached yet.
 */
async function loadCachedAppConfig() {
    if (appConfigCache) return appConfigCache;

    // IndexedDB
    try {
        const cached = await db.getAppConfig?.();
        if (cached) {
            appConfigCache = cached;
            return cached;
        }
    } catch (e) {
        // db.getAppConfig may not exist in older builds
    }

    // localStorage
    const local = utils.getLocalStorage(CACHE_KEYS.APP_CONFIG, null);
    if (local) {
        appConfigCache = local;
        return local;
    }

    return null;
}

async function saveAppConfig(config) {
    appConfigCache = config;
    try {
        if (typeof db.saveAppConfig === 'function') {
            await db.saveAppConfig(config);
        }
    } catch (e) {
        console.warn('[Subscription] IndexedDB saveAppConfig failed', e);
    }
    utils.setLocalStorage(CACHE_KEYS.APP_CONFIG, config);
}

/**
 * Fetch the app config from the backend and cache it.
 * If the network call fails, returns the cached copy.
 *
 * @param {boolean} forceRefresh – if true, always try the network
 * @returns {Promise<Object|null>} { trialDurationHours, subscriptionPlans, ... }
 */
export async function fetchAppConfig(forceRefresh = false) {
    if (!forceRefresh) {
        const cached = await loadCachedAppConfig();
        if (cached) {
            // Refresh silently in the background when online
            if (navigator.onLine) {
                fetchAndCacheAppConfig().catch(() => {});
            }
            return cached;
        }
    }

    if (!navigator.onLine) {
        return loadCachedAppConfig();
    }

    return fetchAndCacheAppConfig();
}

async function fetchAndCacheAppConfig() {
    try {
        const result = await convexHttpClient.query('system/queries:getAppConfig');
        if (result?.success && result.data) {
            await saveAppConfig(result.data);
            return result.data;
        }
        console.warn('[Subscription] getAppConfig returned failure', result);
    } catch (err) {
        console.warn('[Subscription] Failed to fetch app config', err);
    }
    return loadCachedAppConfig();
}

// ==================== PLAN HELPERS ====================

/**
 * Compute the 2-device price for a given base price using the
 * backend-configured discount percentage.
 *
 * @param {number} basePrice
 * @param {number} discountPercent  e.g. 15 for 15%
 * @returns {number}
 */
function computeTwoDevicePrice(basePrice, discountPercent) {
    const pct = typeof discountPercent === 'number' ? discountPercent : 15;
    return Math.round(basePrice * 2 * (1 - pct / 100));
}

/**
 * Get the current subscription plans, ready for the UI.
 *
 * Each plan object returned has:
 *   { id, name, price, days, durationText,
 *     features[], limitations[], savings?, popular,
 *     ctaText, ctaColor,
 *     deviceOptions: [{ devices: 1, price, label },
 *                     { devices: 2, price, label, featured? }] }
 *
 * Both device tiers are populated from backend data — no hardcoded prices.
 *
 * @returns {Promise<Array>}
 */
export async function getSubscriptionPlans() {
    const config = await fetchAppConfig();
    if (!config || !Array.isArray(config.subscriptionPlans)) {
        // Absolutely no fallback prices here — the caller will see an empty
        // array and can show a "plans unavailable" state.
        return [];
    }

    const discount = config.twoDeviceDiscountPercent ?? 15;

    return config.subscriptionPlans.map((plan) => {
        const basePrice = plan.price;
        const twoDevicePrice = computeTwoDevicePrice(basePrice, discount);

        return {
            id: plan.id,
            name: plan.name,
            price: basePrice,
            days: plan.days,
            durationText: plan.durationText ?? `${plan.days} days`,
            features: plan.features ?? [],
            limitations: plan.limitations ?? [],
            savings: plan.savings ?? null,
            popular: plan.popular ?? false,
            ctaText: plan.ctaText ?? `Subscribe – KES ${basePrice}`,
            ctaColor: plan.ctaColor ?? 'success',
            deviceOptions: [
                {
                    devices: 1,
                    price: basePrice,
                    label: '1 DEVICE',
                    icon: '📱',
                },
                {
                    devices: 2,
                    price: twoDevicePrice,
                    label: '2 DEVICES',
                    icon: '📱 + 💻',
                    featured: true,
                },
            ],
        };
    });
}

/**
 * Get the trial config from the backend cache.
 * Falls back to a safe default only if nothing is cached and offline.
 */
export async function getTrialConfig() {
    const config = await fetchAppConfig();
    if (!config) {
        return { trialDurationHours: 24 };
    }
    return { trialDurationHours: config.trialDurationHours ?? 24 };
}

// ==================== SUBSCRIPTION STATE ====================

export async function getSubscription() {
    if (subscriptionStatus !== null) return subscriptionStatus;

    try {
        const cached = await db.getSubscription();
        if (cached) {
            subscriptionStatus = cached;
            return cached;
        }
    } catch (e) {
        console.warn('[Subscription] IndexedDB subscription load failed', e);
    }

    const local = utils.getLocalStorage(CACHE_KEYS.SUBSCRIPTION, null);
    if (local) {
        subscriptionStatus = local;
        return local;
    }

    return null;
}

export async function setSubscription(sub) {
    if (!sub) return;
    subscriptionStatus = sub;
    try {
        await db.saveSubscription(sub);
    } catch (e) {
        console.warn('[Subscription] IndexedDB save failed, using localStorage', e);
    }
    utils.setLocalStorage(CACHE_KEYS.SUBSCRIPTION, sub);
}

export async function clearSubscription() {
    subscriptionStatus = null;
    try {
        await db.deleteSubscription();
    } catch (e) {
        console.warn('[Subscription] IndexedDB delete failed', e);
    }
    utils.removeLocalStorage(CACHE_KEYS.SUBSCRIPTION);
}

// ==================== INITIALIZATION ====================

export async function initSubscription() {
    console.log('[Subscription] Initializing...');
    const token = getToken();

    // Always fetch/cache plans first — the UI needs them regardless of auth
    await fetchAppConfig(navigator.onLine);

    if (navigator.onLine && token) {
        console.log('[Subscription] Online & authenticated — fetching fresh subscription');
        const sub = await getSubscriptionStatus(true);
        subscriptionStatus = sub ?? null;
    } else {
        console.log('[Subscription] Offline or not authenticated — using cache');
        subscriptionStatus = await getSubscriptionStatus(false);
    }

    return subscriptionStatus;
}

export function fallbackLoadSubscription() {
    subscriptionStatus = utils.getLocalStorage(CACHE_KEYS.SUBSCRIPTION, null);
}

// ==================== SUBSCRIPTION STATUS ====================

/**
 * Fetch the subscription status from the backend (or cache).
 *
 * Backend response shape:
 *   {
 *     _id, userId, plan, isActive, expiryDate, status, startDate,
 *     autoRenew, paymentMethod,
 *     maxDevices, hasTwoDeviceDiscount, devicesUsed,
 *     devices: [{ deviceId, platform, deviceName, isPrimary, registeredAt, lastSeen }]
 *   }
 */
export async function getSubscriptionStatus(forceRefresh = false) {
    if (navigator.onLine && (forceRefresh || subscriptionStatus === null)) {
        try {
            const token = getToken();
            if (!token) return null;

            const result = await convexHttpClient.action(
                'subscriptions/queries:getSubscriptionStatus',
                { token }
            );

            if (result?.success && result.data) {
                const backendSub = result.data;
                const now = timeVerifier.getSafeTimestamp();
                if (now === null) {
                    console.warn('[Subscription] Time tamper detected');
                    return null;
                }

                const isActive =
                    backendSub.isActive !== undefined
                        ? backendSub.isActive
                        : backendSub.expiryDate > now;

                const normalizedSub = {
                    _id: backendSub._id,
                    plan: backendSub.plan,
                    isActive,
                    expiryDate: backendSub.expiryDate,
                    status: backendSub.status,
                    startDate: backendSub.startDate,
                    autoRenew: backendSub.autoRenew ?? false,
                    paymentMethod: backendSub.paymentMethod ?? null,
                    maxDevices: backendSub.maxDevices ?? 1,
                    hasTwoDeviceDiscount: backendSub.hasTwoDeviceDiscount ?? false,
                    devicesUsed: backendSub.devicesUsed ?? 0,
                    devices: backendSub.devices ?? [],
                };
                await setSubscription(normalizedSub);
                timeVerifier.resetTimeVerifier();
                return normalizedSub;
            }

            if (result && !result.success) {
                if (isTokenInvalid(result)) {
                    await handleInvalidToken();
                    return null;
                }
                console.warn('[Subscription] Backend error:', result.message);
            }
        } catch (err) {
            console.warn('[Subscription] Backend fetch failed, using cache', err);
        }
    }

    return getSubscription();
}

// ==================== ACTIVE CHECKS ====================

export async function hasActiveSubscription() {
    const now = timeVerifier.getSafeTimestamp();
    if (now === null) return false;
    const sub = await getSubscription();
    if (!sub) return false;

    const { isActive, expiryDate } = sub;
    if (isActive !== undefined && isActive !== null) {
        return isActive && (expiryDate ? expiryDate > now : true);
    }
    return expiryDate ? expiryDate > now : false;
}

export async function isTrialActive() {
    const now = timeVerifier.getSafeTimestamp();
    if (now === null) return false;
    const sub = await getSubscription();
    return (
        sub &&
        sub.plan === 'trial' &&
        sub.isActive &&
        (sub.expiryDate ? sub.expiryDate > now : false)
    );
}

export async function isPaidSubscription() {
    const now = timeVerifier.getSafeTimestamp();
    if (now === null) return false;
    const sub = await getSubscription();
    return (
        sub &&
        sub.plan !== 'trial' &&
        sub.isActive &&
        (sub.expiryDate ? sub.expiryDate > now : false)
    );
}

// ==================== TRIAL MANAGEMENT ====================

/**
 * Check trial eligibility via the backend.
 *
 * Backend contract (strict validator):
 *   { token, deviceId?, deviceFingerprint? }
 *
 * The backend only needs ONE identifier to run its cross-account
 * trial-abuse checks. We send `deviceId` (the canonical value);
 * `deviceInfo` is intentionally NOT sent — it's not part of the
 * validator and isn't used by the eligibility logic.
 */
export async function checkTrialEligibility() {
    requireOnline();
    try {
        const token = getToken();
        if (!token) throw new Error('Not authenticated');

        const { deviceId } = await security.buildDeviceIdentity();

        const result = await convexHttpClient.action(
            'subscriptions/queries:checkTrialEligibility',
            { token, deviceId }
        );

        if (!result.success) {
            if (isTokenInvalid(result)) {
                await handleInvalidToken();
                throw new Error('Session expired.');
            }
            throw new Error(result.message);
        }
        return result.data.eligible;
    } catch (err) {
        console.error('[Subscription] Trial eligibility check failed:', err);
        throw new Error('Could not verify trial eligibility');
    }
}

/**
 * Start the free trial.
 * Backend contract: { token, deviceId, deviceInfo }
 */
export async function startFreeTrial() {
    requireOnline();
    const token = getToken();
    if (!token) throw new Error('Not authenticated');

    const { deviceId, deviceInfo } = await security.buildDeviceIdentity();

    try {
        const result = await convexHttpClient.action(
            'subscriptions/actions:startFreeTrial',
            { token, deviceId, deviceInfo }
        );

        if (!result.success) {
            if (isTokenInvalid(result)) {
                await handleInvalidToken();
                throw new Error('Session expired.');
            }
            throw new Error(result.message);
        }

        const data = result.data;
        const normalizedSub = {
            _id: data.subscriptionId,
            plan: data.plan,
            isActive: true,
            expiryDate: data.expiryDate,
            status: 'active',
            maxDevices: data.maxDevices ?? 1,
            hasTwoDeviceDiscount: false,
            devicesUsed: 1,
            devices: [],
        };
        await setSubscription(normalizedSub);
        timeVerifier.resetTimeVerifier();
        return normalizedSub;
    } catch (err) {
        console.error('[Subscription] Free trial start failed:', err);
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

// ==================== PLAN SELECTION ====================

/**
 * Select a plan and (optionally) a device tier. Stores the full plan object
 * on the payment module so the payment page knows what to charge.
 *
 * @param {string} planId
 * @param {number} [devices=1]
 */
export async function selectPlan(planId, devices = 1) {
    const plans = await getSubscriptionPlans();
    const plan = plans.find((p) => p.id === planId);
    if (!plan) {
        console.warn('[Subscription] selectPlan: unknown plan', planId);
        return;
    }
    const tier =
        plan.deviceOptions?.find((o) => o.devices === devices) ||
        plan.deviceOptions?.[0];

    const selected = tier
        ? {
            ...plan,
            price: tier.price,
            devices: tier.devices,
            ctaText: `Subscribe – KES ${tier.price.toLocaleString()}`,
        }
        : { ...plan };

    // Delegate to the payment module (it owns selectedPlan persistence)
    const { setSelectedPlan } = await import('./payment.js');
    setSelectedPlan(selected);
}

/**
 * Custom-amount plan. Amount is free-form; backend tariff applies.
 * @param {number} amount
 */
export async function setCustomPlan(amount) {
    const plan = {
        id: 'custom',
        name: 'Custom Amount',
        price: amount,
        days: 0,
        durationText: 'Custom',
        features: ['Pay as you wish', 'Flexible access'],
        limitations: [],
        ctaText: `Pay KES ${amount}`,
        ctaColor: 'primary',
        deviceOptions: [{ devices: 1, price: amount, label: '1 DEVICE' }],
    };
    const { setSelectedPlan } = await import('./payment.js');
    setSelectedPlan(plan);
}

// ==================== PURCHASE ====================

/**
 * Purchase a subscription.
 *
 * Backend contract:
 *   {
 *     token,
 *     planId,           // "monthly" | "quarterly" | "yearly" | "custom"
 *     phoneNumber,
 *     deviceId,
 *     deviceInfo,
 *     deviceCount,      // 1 or 2
 *     customAmount?     // required only for planId === "custom"
 *   }
 *
 * @param {string} planId
 * @param {string} phoneNumber
 * @param {number|null} customAmount
 * @param {number} devices  1 or 2 (defaults to 1)
 */
export async function purchaseSubscription(
    planId,
    phoneNumber,
    customAmount = null,
    devices = 1
) {
    requireOnline();
    const token = getToken();
    if (!token) throw new Error('Not authenticated');

    const { deviceId, deviceInfo } = await security.buildDeviceIdentity();

    const payload = {
        token,
        planId,
        phoneNumber,
        deviceId,
        deviceInfo,
        deviceCount: Math.max(1, Math.min(devices, 2)),
    };
    if (planId === 'custom' && typeof customAmount === 'number') {
        payload.customAmount = customAmount;
    }

    try {
        const result = await convexHttpClient.action(
            'subscriptions/actions:purchaseSubscription',
            payload
        );

        if (!result.success) {
            if (isTokenInvalid(result)) {
                await handleInvalidToken();
                throw new Error('Session expired.');
            }
            throw new Error(result.message);
        }
        return result.data;
    } catch (err) {
        console.error('[Subscription] Purchase failed:', err);
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
        const result = await convexHttpClient.action(
            'subscriptions/actions:cancelSubscription',
            { token }
        );

        if (!result.success) {
            if (isTokenInvalid(result)) {
                await handleInvalidToken();
                throw new Error('Session expired.');
            }
            throw new Error(result.message);
        }
        await getSubscriptionStatus(true);
        return { success: true };
    } catch (err) {
        console.error('[Subscription] Cancel failed:', err);
        throw new Error(err.message || 'Cancel failed');
    }
}

// ==================== FREE TOPICS ====================

export function isTopicFree(subject, topicId) {
    return FREE_TOPICS[subject]?.includes(topicId) ?? false;
}

export function areAllTopicsFree(config) {
    if (!config || !config.subject || !config.topics || config.topics.length === 0) {
        return false;
    }
    return config.topics.every((t) => isTopicFree(config.subject, t.id));
}

// ==================== ACCESS CONTROL ====================

export async function canTakeExam(config) {
    if (await hasActiveSubscription()) return true;
    return areAllTopicsFree(config);
}

export async function canViewAnalytics() {
    return hasActiveSubscription();
}

export async function canExportResults() {
    return isPaidSubscription();
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
    if (forceOnline) {
        // Refresh plans too — they may have changed
        await fetchAppConfig(true);
    }
    return getSubscriptionStatus(forceOnline);
}

export async function refreshSubscription() {
    return syncSubscription(true);
}

// ==================== EXPOSE GLOBALLY ====================

window.subscription = {
    // Plans & config
    fetchAppConfig,
    getSubscriptionPlans,
    getTrialConfig,

    // Status
    getSubscriptionStatus,
    hasActiveSubscription,
    isTrialActive,
    isPaidSubscription,

    // Trial
    checkTrialEligibility,
    startFreeTrial,
    getTrialRemaining,

    // Selection & purchase
    selectPlan,
    setCustomPlan,
    purchaseSubscription,
    cancelSubscription,

    // Access
    isTopicFree,
    areAllTopicsFree,
    canTakeExam,
    canViewAnalytics,
    canExportResults,

    // Time
    calculateRemainingTime,
    formatRemainingTime,
    isExpiringSoon,

    // Sync & lifecycle
    syncSubscription,
    refreshSubscription,
    initSubscription,
    fallbackLoadSubscription,

    // Cache
    setSubscription,
    getSubscription,
    clearSubscription,

    // Helpers
    activatePlan,
};