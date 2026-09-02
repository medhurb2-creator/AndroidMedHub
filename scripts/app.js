// scripts/app.js

// ============================================================
// IMPORTS – Core modules
// ============================================================
import * as utils from './utils.js';
import * as db from './db.js';
import { convexHttpClient } from './convex-client.js';
import * as subscription from './subscription.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import * as notifications from './notifications.js';
import * as referral from './referral.js';
import * as timeVerifier from './timeVerifier.js';
import * as ui from './ui.js';
import * as security from './security.js';
import { initRouter, navigateTo } from './router.js';
import * as updates from './updates.js';
import * as events from './events.js';

// ============================================================
// CAPACITOR IMPORTS (dynamic, only when available)
// ============================================================
let App, ScreenOrientation;

async function importCapacitor() {
    if (typeof window.Capacitor === 'undefined') {
        console.log('[App] Capacitor not available, skipping native modules.');
        return;
    }
    try {
        const appModule = await import('@capacitor/app');
        App = appModule.App;
        const screenModule = await import('@capacitor/screen-orientation');
        ScreenOrientation = screenModule.ScreenOrientation;
        console.log('[App] Capacitor modules loaded.');
    } catch (e) {
        console.warn('[App] Capacitor modules not available:', e);
    }
}

// ============================================================
// DEEP‑LINK & REFERRAL STATE
// ============================================================
let pendingAppUrl = null;
let appInitialized = false;
let appAuthenticated = false;
let referralCode = null;
let redirectTarget = null;
let screenOrientation = null;

// ============================================================
// DEEP‑LINK HELPERS
// ============================================================
function normalizeMedVixUrl(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'medvex.edgeone.app') {
            console.warn('[DeepLink] Rejected external URL:', url);
            return null;
        }
        return parsed.pathname + parsed.search + parsed.hash;
    } catch (_) {
        console.error('[DeepLink] Invalid URL:', url);
        return null;
    }
}

function isRootDestination(destination) {
    try {
        const parsed = new URL(destination, 'https://medvex.edgeone.app');
        return parsed.pathname === '/' || parsed.pathname === '/index.html';
    } catch {
        return false;
    }
}

// ============================================================
// CAPACITOR DEEP‑LINK CAPTURE
// ============================================================
async function captureLaunchUrl() {
    if (!App) return;
    try {
        const result = await App.getLaunchUrl();
        if (result?.url) {
            console.log('[DeepLink] Launch URL:', result.url);
            const normalized = normalizeMedVixUrl(result.url);
            if (normalized) {
                pendingAppUrl = normalized;
                console.log('[DeepLink] Pending destination:', pendingAppUrl);
            }
        }
    } catch (_) {
        console.warn('[DeepLink] Could not obtain launch URL');
    }
}

function registerAppUrlListener() {
    if (!App) return;
    App.addListener('appUrlOpen', ({ url }) => {
        console.log('[DeepLink] App URL opened:', url);
        const destination = normalizeMedVixUrl(url);
        if (!destination) return;
        if (appInitialized) {
            processDestination(destination);
        } else {
            pendingAppUrl = destination;
        }
    });
}

// ============================================================
// DESTINATION PROCESSOR (runs only after app is initialized)
// ============================================================
function processDestination(destination) {
    if (!destination) return;
    if (isRootDestination(destination)) {
        console.log('[DeepLink] Root destination – handled by referral logic.');
        return;
    }
    console.log('[DeepLink] Processing destination:', destination);
    if (appAuthenticated) {
        console.log('[DeepLink] Authenticated → navigating to:', destination);
        navigateTo(destination);
    } else {
        console.log('[DeepLink] Auth required – storing for later.');
        sessionStorage.setItem('redirectAfterLogin', destination);
        // The bootstrap will redirect to welcome (or login) after router init
    }
}

// ============================================================
// ORIENTATION LOCK
// ============================================================
async function initOrientation() {
    if (!ScreenOrientation) return;
    try {
        screenOrientation = ScreenOrientation;
        await screenOrientation.lock({ orientation: 'portrait' });
        console.log('[App] Orientation locked');
    } catch (_) {
        console.warn('[App] Orientation lock not available');
    }
}

// ============================================================
// SAFE REDIRECT (used only before router is ready – fallback)
// ============================================================
function safeRedirect(targetPath) {
    if (screenOrientation) {
        screenOrientation.unlock().catch(() => {});
    }
    let target = targetPath;
    // Clean URL for SPA router
    if (target.startsWith('/pages/')) {
        target = target.replace('/pages/', '');
    }
    if (target.endsWith('.html')) {
        target = target.replace('.html', '');
    }
    // Append referral code if present
    if (referralCode && !target.includes('ref=')) {
        const sep = target.includes('?') ? '&' : '?';
        target += sep + 'ref=' + encodeURIComponent(referralCode);
    }
    console.log('[App] Redirecting (safe) to:', target);
    // Use router if available, otherwise set window.location (should rarely happen)
    if (typeof navigateTo === 'function') {
        navigateTo(target);
    } else {
        window.location.href = target;
    }
}

// ============================================================
// PROGRESS BAR HELPER
// ============================================================
let progressFill = null;
let progressResolve = null;

function getProgressFill() {
    if (!progressFill) {
        progressFill = document.getElementById('progressFill');
    }
    return progressFill;
}

function updateProgress(percent) {
    const el = getProgressFill();
    if (el) {
        el.style.width = Math.min(100, Math.max(0, percent)) + '%';
    }
}

function completeProgress() {
    updateProgress(100);
}

// ============================================================
// COMPLETE SPLASH CLEANUP
// ============================================================
async function destroySplash() {
    console.log('[Splash] Destroying splash resources...');

    const splash = document.getElementById('app-bootstrap');

    // 1. Fade out the splash
    if (splash) {
        splash.style.opacity = '0';

        // Allow the CSS opacity transition to complete.
        await new Promise(resolve => setTimeout(resolve, 500));

        // 2. Remove splash DOM completely
        splash.remove();
    }

    // 3. Remove splash CSS completely
    const splashCss = document.getElementById('medvex-splash-css');

    if (splashCss) {
        splashCss.remove();
        console.log('[Splash] Splash CSS removed.');
    }

    // 4. Remove splash-related document classes
    document.documentElement.classList.remove(
        'app-ready',
        'medvex-app-ready'
    );

    // 5. Remove any splash-related body classes
    document.body.classList.remove(
        'splash-active',
        'medvex-splash-active'
    );

    // 6. Clear splash-specific JS references
    progressFill = null;
    progressResolve = null;

    console.log('[Splash] Splash completely destroyed.');
}

// ============================================================
// TIMEOUT HELPER
// ============================================================
function withTimeout(promise, ms = 8000) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Network timeout')), ms)
        )
    ]);
}

// ============================================================
// INITIALIZATION (with progress steps)
// ============================================================
export async function initializeApp() {
    console.log('[App] Initializing...');
    updateProgress(5);

    try {
        // 1. Check for referral code in URL
        if (!utils.getLocalStorage('accessToken')) {
            const urlToCheck = pendingAppUrl 
                ? 'https://medvex.edgeone.app' + pendingAppUrl 
                : undefined;
            const refCode = referral.detectReferralFromURL(urlToCheck);
            if (refCode) {
                console.log('[App] Referral code detected from URL:', refCode);
                referral.validateReferralCode(refCode).then(result => {
                    if (result.valid) {
                        console.log('[App] Referral code is valid, referrer:', result.referrerName);
                    } else {
                        console.warn('[App] Referral code is invalid, clearing');
                        referral.clearStoredReferralCode();
                    }
                });
            }
        }
        updateProgress(15);

        const token = utils.getLocalStorage('accessToken');
        console.log('[App] Token from localStorage:', token ? 'exists' : 'none');

        // 2. Load user
        await auth.initUser();
        updateProgress(30);

        // 3. Load subscription
        await subscription.initSubscription();
        updateProgress(45);

        // 4. Load app settings
        const savedSettings = utils.getLocalStorage('appSettings', null);
        if (savedSettings) {
            ui.setAppSettings(savedSettings);
        }
        updateProgress(55);

        // 5. Time verification
        if (!timeVerifier.verifyTime()) {
            return;
        }
        updateProgress(65);

        // 6. Silent token refresh
        let validToken = false;
        if (token && navigator.onLine) {
            console.log('[App] Online with token – attempting silent refresh...');
            try {
                const refreshed = await withTimeout(auth.refreshSession(), 8000);
                if (refreshed) {
                    validToken = true;
                    console.log('[App] Token refreshed successfully');
                } else {
                    console.warn('[App] Could not refresh session – using cached data');
                }
            } catch (err) {
                console.warn('[App] Session refresh error (timeout or other):', err);
            }
        } else {
            console.log('[App] Offline or no token – using cached data only');
        }
        updateProgress(75);

        if (validToken) {
            console.log('[App] Syncing fresh data with valid token...');
            try {
                await withTimeout(sync.syncUserData(), 8000);
                await withTimeout(sync.triggerFullSync(), 8000);
            } catch (err) {
                console.warn('[App] Data sync timed out – using cached data', err);
            }
        } else {
            console.log('[App] No valid token – using cached data only');
        }
        updateProgress(85);

        if (notifications && typeof notifications.init === 'function') {
            notifications.init();
        }
        updateProgress(95);

        console.log('[App] Loaded user:', auth.getUser());
    } catch (e) {
        console.warn('[App] Initialization error, using localStorage fallback', e);
        auth.fallbackLoadUser();
        subscription.fallbackLoadSubscription();
    }

    // 7. Register service worker update listener
    updates.registerUpdateListener();

    // 8. Mark progress as complete
    completeProgress();
}

// ============================================================
// GLOBAL LISTENER FOR TIME TAMPER
// ============================================================
window.addEventListener('time-tamper-detected', async () => {
    console.warn('[App] Time tamper detected – logging out');
    await auth.clearUser();
    navigateTo('login?error=time_tamper');
});

// ============================================================
// SPA BOOTSTRAP
// ============================================================
async function bootstrap() {
    try {
        // 1. Load Capacitor modules (if available)
        await importCapacitor();

        // 2. Capture launch URL and register listener
        await captureLaunchUrl();
        registerAppUrlListener();

        // 3. Orientation lock
        await initOrientation();

        // 4. Detect referral from URL or storage
        let initialReferral = null;
        if (pendingAppUrl) {
            const fullUrl = 'https://medvex.edgeone.app' + pendingAppUrl;
            initialReferral = referral.detectReferralFromURL(fullUrl);
        } else {
            initialReferral = referral.detectReferralFromURL();
        }
        referralCode = initialReferral;
        if (referralCode) {
            const badge = document.getElementById('referralBadge');
            const codeSpan = document.getElementById('refBadgeCode');
            if (badge && codeSpan) {
                badge.style.display = 'block';
                codeSpan.textContent = referralCode;
            }
        }

        // 5. Initialize the core application (this updates progress)
        await initializeApp();

        // 6. Set authentication state
        appAuthenticated = auth.checkAuth();
        appInitialized = true;

        // 7. Determine redirect target
        let target;

        if (pendingAppUrl) {
            const destination = pendingAppUrl;
            console.log('[App] Incoming deep-link:', destination);

            if (isRootDestination(destination)) {
                // Root: go to subjects or welcome, but preserve query/hash
                const parsed = new URL(destination, 'https://medvex.edgeone.app');
                target = appAuthenticated ? 'subjects' : 'welcome';
                if (parsed.search) {
                    target += parsed.search;
                }
                if (parsed.hash) {
                    target += parsed.hash;
                }
            } else {
                if (appAuthenticated) {
                    target = destination;
                } else {
                    sessionStorage.setItem('redirectAfterLogin', destination);
                    target = 'welcome';
                }
            }
        } else {
            target = appAuthenticated ? 'subjects' : 'welcome';
        }

        redirectTarget = target;
        console.log('[App] Target determined:', target, '| loggedIn:', appAuthenticated);

        // 8. Apply theme
        if (ui.applyTheme) ui.applyTheme();

        // 9. Set the URL via history API (so the router loads the intended page)
        const currentFull = window.location.pathname + window.location.search + window.location.hash;
        if (target && target !== currentFull) {
            // Ensure target is a full path (starts with /)
            const fullTarget = target.startsWith('/') ? target : '/' + target;
            window.history.replaceState({}, '', fullTarget);
        }

        // 10. Start the router – this loads the page based on the current URL
        initRouter();

        // 11. Wait for the first page to be rendered
        const appRoot = document.getElementById('app-root');
        if (appRoot && !appRoot.children.length) {
            await new Promise((resolve) => {
                const observer = new MutationObserver(() => {
                    if (appRoot.children.length > 0) {
                        observer.disconnect();
                        resolve();
                    }
                });
                observer.observe(appRoot, { childList: true });
            });
        }

        // 12. Application is ready – completely destroy splash
        await destroySplash();

        // 13. Register service worker
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/service-worker.js');
        }
    } catch (error) {
        console.error('[App] Bootstrap failed:', error);

        // Completely destroy splash even when bootstrap fails.
        const splash = document.getElementById('app-bootstrap');

        if (splash) {
            splash.remove();
        }

        const splashCss = document.getElementById('medvex-splash-css');

        if (splashCss) {
            splashCss.remove();
        }

        document.documentElement.classList.remove(
            'app-ready',
            'medvex-app-ready'
        );

        document.body.classList.remove(
            'splash-active',
            'medvex-splash-active'
        );

        progressFill = null;
        progressResolve = null;

        const appRoot = document.getElementById('app-root');

        if (appRoot) {
            appRoot.innerHTML = `
                <section class="page error-page" data-page="error">
                    <h1>Application Error</h1>
                    <p>${error.message || 'Unknown error'}</p>
                    <button onclick="router.navigateTo('welcome')">
                        Go to Welcome
                    </button>
                </section>
            `;
        }
    }
}

bootstrap();

// ============================================================
// EXPOSE GLOBALLY
// ============================================================
import * as examEngine from './exam-engine.js';
import * as payment from './payment.js';

window.app = {
    initializeApp,
    setAuthToken: auth.setAuthToken,
    checkAuth: auth.checkAuth,
    setUser: auth.setUser,
    getUser: auth.getUser,
    clearUser: auth.clearUser,
    setSubscription: subscription.setSubscription,
    getSubscription: subscription.getSubscription,
    hasActiveSubscription: subscription.hasActiveSubscription,
    clearSubscription: subscription.clearSubscription,
    setExamState: examEngine.setExamState,
    getExamState: examEngine.getExamState,
    clearExamState: examEngine.clearExamState,
    setExamConfig: examEngine.setExamConfig,
    getExamConfig: examEngine.getExamConfig,
    clearExamConfig: examEngine.clearExamConfig,
    setAppSetting: ui.setAppSetting,
    getAppSetting: ui.getAppSetting,
    toggleTheme: ui.toggleTheme,
    setSelectedPlan: payment.setSelectedPlan,
    getSelectedPlan: payment.getSelectedPlan,
    setCurrentTransaction: payment.setCurrentTransaction,
    getCurrentTransaction: payment.getCurrentTransaction,
    checkForUpdates: updates.checkForUpdates,
    skipWaitingAndReload: updates.skipWaitingAndReload,
    syncUserData: sync.syncUserData,
    refreshSubscription: subscription.refreshSubscription,
    triggerFullSync: sync.triggerFullSync,
    syncData: sync.syncData,
    syncExamResults: sync.syncExamResults,
    syncUserProfile: sync.syncUserProfile,
    syncSubscription: sync.syncSubscription,
    events: events.events
};