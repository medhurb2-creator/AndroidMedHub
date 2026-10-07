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

// === GOOGLE PLAY IN-APP UPDATE ===
import * as appUpdate from './app-update.js';

// ============================================================
// CAPACITOR IMPORTS (dynamic, only when available)
// ============================================================
let App, ScreenOrientation, FileOpen;

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

        // FileOpen is a CUSTOM Capacitor plugin, not an npm package.
        // It registers itself in `window.Capacitor.Plugins.FileOpen` when
        // the native Android side loads it (via MainActivity + the plugin's
        // own JS bootstrap). We grab the reference here so every subsequent
        // call site has a stable handle.
        FileOpen = (window.Capacitor.Plugins && window.Capacitor.Plugins.FileOpen) || null;
        if (FileOpen) {
            console.log('[App] FileOpen plugin available');
        } else {
            console.log('[App] FileOpen plugin not registered');
        }

        console.log('[App] Capacitor modules loaded.');
    } catch (e) {
        console.warn('[App] Capacitor modules not available:', e);
    }
}

// ============================================================
// APP-LEVEL STATE
// ============================================================
let pendingAppUrl = null;
let appInitialized = false;
let appAuthenticated = false;
let referralCode = null;
let redirectTarget = null;
let screenOrientation = null;

// ============================================================
// FILE-OPEN — EXTERNAL FILE INTENTS (ANDROID)
// ============================================================
//
// When the OS hands MedVix a file — a PDF, image, or text file the user
// tapped in Files, Gmail, or Chrome — the FileOpen plugin copies the
// bytes into the app cache and delivers a payload:
//
//   { path: string, name: string, mimeType: string|null, size?: number }
//
// Two delivery paths:
//
//   • Cold start — the app was launched BY the intent. The payload is
//     stashed by the native side and retrieved via `getPendingFile()`
//     after JS boots. `captureLaunchFile()` reads it once, before the
//     initial route is resolved.
//
//   • Warm start — the app is already running. The plugin fires a
//     `fileOpen` event. `registerFileListener()` handles it: stash the
//     payload, then either dispatch a page-level event (chrome already
//     mounted) or navigate to the host page.
//
// In both cases, the payload is written to `sessionStorage.pendingFileOpen`
// and the app routes to `resource-browser`. That page's init() calls
// `viewer.openPendingFile()`, which drains the stash and loads the file
// through the standard viewer pipeline. External files never require auth
// — the user chose the file; it just opens.

const PENDING_FILE_KEY = 'pendingFileOpen';

/** True once a cold-start file has been detected. @private */
let fileLaunchPending = false;

/** Idempotence flag for the warm-start listener. @private */
let _fileListenerRegistered = false;

/**
 * True when the currently mounted page is the resource browser — the
 * page that hosts the viewer chrome. Used to decide whether a warm-start
 * file should trigger a navigation (chrome not mounted) or a page-level
 * reload (chrome already mounted).
 *
 * @private
 * @returns {boolean}
 */
function _isOnResourceBrowser() {
    try {
        const root = document.getElementById('app-root');
        if (!root) return false;
        const section = root.querySelector('section[data-page]');
        return !!(section && section.dataset.page === 'resource-browser');
    } catch {
        return false;
    }
}

/**
 * Write an external file payload to sessionStorage in the shape
 * `viewer.openPendingFile()` expects. Idempotent — a second call replaces
 * the previous payload, which is correct when a new file arrives before
 * the previous one has been drained.
 *
 * @private
 * @param {{ path: string, name?: string, mimeType?: string|null, size?: number }} payload
 */
function _stashFilePayload(payload) {
    if (!payload || !payload.path) return;
    try {
        sessionStorage.setItem(PENDING_FILE_KEY, JSON.stringify({
            path: payload.path,
            name: payload.name || 'Document',
            mimeType: payload.mimeType || null,
            size: payload.size || 0,
        }));
    } catch (err) {
        console.warn('[FileOpen] Could not stash payload:', err);
    }
}

/**
 * Read the cold-start file payload from the FileOpen plugin. Called once
 * during bootstrap, before route resolution. If a payload exists, the
 * initial route is forced to `resource-browser`.
 *
 * @private
 * @returns {Promise<void>}
 */
async function captureLaunchFile() {
    if (!FileOpen || typeof FileOpen.getPendingFile !== 'function') return;
    try {
        const payload = await FileOpen.getPendingFile();
        if (payload && payload.path) {
            console.log('[FileOpen] Cold-start file:', payload.name || '(unnamed)');
            _stashFilePayload(payload);
            fileLaunchPending = true;
        }
    } catch (err) {
        console.warn('[FileOpen] getPendingFile failed:', err);
    }
}

/**
 * Register the warm-start `fileOpen` listener. Called once during bootstrap.
 * Idempotent.
 *
 * @private
 */
function registerFileListener() {
    if (_fileListenerRegistered) return;
    if (!FileOpen || typeof FileOpen.addListener !== 'function') return;

    FileOpen.addListener('fileOpen', (payload) => {
        if (!payload || !payload.path) return;
        console.log('[FileOpen] Live file:', payload.name || '(unnamed)');

        _stashFilePayload(payload);

        if (!appInitialized) {
            // Arrived during bootstrap — resolveInitialRoute() will pick it up.
            fileLaunchPending = true;
            return;
        }

        if (_isOnResourceBrowser()) {
            // Chrome already mounted. Dispatch an event the page listens
            // for so it drains the stash without a full re-mount.
            try {
                document.dispatchEvent(new CustomEvent('native:file-arrived'));
            } catch { /* ignore */ }
        } else {
            // Some other page is mounted. Navigate to the host page;
            // page-manager will run its init(), which drains the stash.
            navigateTo('resource-browser');
        }
    });

    _fileListenerRegistered = true;
}

// ============================================================
// DEEP LINK — EXTRACT THE PATH
// ============================================================
//
// A deep link is a share link. Someone sends a URL, the receiver taps
// it, the app opens to that path. That is the whole contract.
//
// No origin check. No domain whitelist. No auth gate. No decision to
// make. Whatever the OS gave us, we extract a path from it and go.

function extractDeepLinkPath(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;

    // Android file intents — the URL itself is the payload. These route
    // to the viewer's file pipeline instead of a page.
    if (rawUrl.startsWith('content://') || rawUrl.startsWith('file://')) {
        return { kind: 'file', url: rawUrl };
    }

    // Absolute URL → take path + query + hash. Origin ignored.
    try {
        const u = new URL(rawUrl);

        // ── Standard web schemes (http/https) ─────────────────────────
        if (u.protocol === 'http:' || u.protocol === 'https:') {
            return {
                kind: 'route',
                path: u.pathname + u.search + u.hash,
            };
        }

        // ── Custom app schemes (medvix://, myapp://, etc.) ────────────
        // Two shapes both matter:
        //
        //   medvix://exam/123?tab=recent   → host='exam', path='/123'
        //   medvix://?code=oauth_test      → host='',     path='',  query='?code=…'
        //
        // The second form is common for OAuth callbacks and password
        // resets. Falling through to the bare-path branch turns it into
        // `/medvix://?…`, which the router fetches as a page and 404s.
        if (u.protocol) {
            const host     = u.hostname || '';
            const pathPart = u.pathname || '';
            const suffix   = (u.search || '') + (u.hash || '');

            // Query-only custom scheme — route to app root, keep query.
            if (!host && !pathPart) {
                return { kind: 'route', path: '/' + suffix };
            }

            const combined = '/' + host + pathPart + suffix;
            return { kind: 'route', path: combined };
        }
    } catch {
        // Not a parseable URL — fall through to bare-path handling.
    }

    // Bare path — `/exam/123`, `exam/123`, `?code=x`.
    const path = rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl;
    return { kind: 'route', path };
}

// ============================================================
// DEEP LINK — COLD START ROUTE
// ============================================================
//
// Called exactly once during bootstrap. Priority order:
//
//   1. External file intent — the OS handed us a file. Route to the
//      viewer host page unconditionally. No auth check.
//   2. Deep link — a URL the user tapped. Extract the path and route
//      to it verbatim. No auth check.
//   3. Fallback — no deep link, no file. Auth-based default.

function resolveInitialRoute() {
    // ── External file intent (highest priority) ────────────────────────
    if (fileLaunchPending) {
        console.log('[App] Initial route: resource-browser (file intent)');
        return 'resource-browser';
    }

    // ── Deep link wins over the default route ──────────────────────────
    if (pendingAppUrl) {
        const link = extractDeepLinkPath(pendingAppUrl);
        if (link) {
            if (link.kind === 'file') {
                // Defensive fallback: if a content:// URI reached this
                // path via @capacitor/app (unusual but possible on some
                // Android builds), stash it and route to the host page.
                try { sessionStorage.setItem(PENDING_FILE_KEY, JSON.stringify({ path: link.url, name: 'Document', mimeType: null, size: 0 })); } catch {}
                return 'resource-browser';
            }

            // Split path from query/hash so a deep link with NO route
            // segment (e.g. `medvix://?code=oauth`) still lands on a
            // real page. Otherwise the URL bar becomes `/?code=…` and
            // initRouter()'s bare-root guard returns early — blank
            // screen on OAuth callbacks.
            const qIdx = link.path.indexOf('?');
            const hIdx = link.path.indexOf('#');
            let splitIdx = link.path.length;
            if (qIdx >= 0 && qIdx < splitIdx) splitIdx = qIdx;
            if (hIdx >= 0 && hIdx < splitIdx) splitIdx = hIdx;

            const pathPart = link.path.slice(0, splitIdx);
            const suffix   = link.path.slice(splitIdx); // '?query', '#hash', or both

            const route = pathPart.replace(/^\//, '');
            if (route) return route + suffix;

            // No route segment, but query/hash present — fall back to
            // the default page and keep the suffix in the URL bar.
            if (suffix) {
                const def = appAuthenticated ? 'subjects' : 'welcome';
                return def + suffix;
            }
        }
    }

    // ── No deep link → auth-based default ───────────────────────────────
    return appAuthenticated ? 'subjects' : 'welcome';
}

// ============================================================
// DEEP LINK — WARM START DISPATCH
// ============================================================

function dispatchDeepLink(rawUrl) {
    const link = extractDeepLinkPath(rawUrl);
    if (!link) return;

    if (link.kind === 'file') {
        try { sessionStorage.setItem(PENDING_FILE_KEY, JSON.stringify({ path: link.url, name: 'Document', mimeType: null, size: 0 })); } catch {}
        navigateTo('resource-browser');
        return;
    }

    const route = link.path.replace(/^\//, '');
    if (route) navigateTo(route);
}

// ============================================================
// DEEP LINK — CAPTURE
// ============================================================

async function captureLaunchUrl() {
    if (!App) return;
    try {
        const result = await App.getLaunchUrl();
        if (result && result.url) {
            console.log('[DeepLink] getLaunchUrl:', result.url);
            if (!pendingAppUrl) pendingAppUrl = result.url;
        }
    } catch {
        console.warn('[DeepLink] Could not obtain launch URL');
    }
}

function registerAppUrlListener() {
    if (!App) return;
    App.addListener('appUrlOpen', ({ url }) => {
        if (!url) return;
        console.log('[DeepLink] appUrlOpen:', url);
        if (appInitialized) {
            dispatchDeepLink(url);
        } else if (!pendingAppUrl) {
            pendingAppUrl = url;
        }
    });
}

function consumeEarlyDeepLink() {
    const early = window.__deepLink;
    if (!early || typeof early !== 'object') return;

    if (!pendingAppUrl && early.launch) {
        console.log('[DeepLink] Using early launch URL:', early.launch);
        pendingAppUrl = early.launch;
    }
    if (Array.isArray(early.queue) && early.queue.length > 0) {
        if (!pendingAppUrl) pendingAppUrl = early.queue.shift();
    }
}

/**
 * Drain warm-start URLs captured by the early (index.html) listener
 * before app.js's own listener was registered.
 *
 * Called once, AFTER initRouter() has mounted the initial route. Any
 * URL left in the queue is a "the app was already opening" case that
 * arrived too late for resolveInitialRoute() — dispatching them now
 * layers them on top of the initial mount, matching what a user would
 * see if the app had already been running.
 */
function drainEarlyQueue() {
    const early = window.__deepLink;
    if (!early || !Array.isArray(early.queue) || early.queue.length === 0) return;
    const urls = early.queue.splice(0);
    for (const url of urls) {
        Promise.resolve().then(() => dispatchDeepLink(url));
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
    } catch {
        console.warn('[App] Orientation lock not available');
    }
}

// ============================================================
// GOOGLE PLAY IN-APP UPDATE
// ============================================================
function showFlexibleUpdateBanner() {
    const banner = window.MedVixUpdateBanner;
    if (!banner) {
        console.warn('[PlayUpdate] Banner helper not available');
        return;
    }

    const btn = document.getElementById('play-update-restart');
    if (btn && !btn.dataset.wired) {
        btn.dataset.wired = '1';
        btn.addEventListener('click', async () => {
            banner.setBusy(true);
            try {
                await appUpdate.applyDownloadedUpdate();
            } catch (e) {
                console.error('[PlayUpdate] completeUpdate failed', e);
                banner.setBusy(false);
            }
        });
    }

    banner.show();
}

async function runPlayUpdateCheck() {
    if (!appUpdate.isAppUpdateSupported()) {
        console.log('[PlayUpdate] Not running on native / plugin unavailable');
        return;
    }

    let currentVersionCode = 0;
    try {
        if (App && typeof App.getInfo === 'function') {
            const info = await App.getInfo();
            currentVersionCode = parseInt(info.build, 10) || 0;
            console.log(
                `[PlayUpdate] Running v${info.version} (versionCode ${currentVersionCode})`
            );
        }
    } catch (e) {
        console.warn('[PlayUpdate] Could not read app version:', e);
    }

    if (!currentVersionCode) {
        console.warn('[PlayUpdate] No versionCode — skipping update policy');
        return;
    }

    appUpdate.onAppUpdate('downloaded', () => {
        console.log('[PlayUpdate] Download complete – showing restart banner');
        showFlexibleUpdateBanner();
    });

    try {
        const result = await appUpdate.runUpdatePolicy({
            currentVersionCode,
            onFlexibleReady: showFlexibleUpdateBanner,
        });
        console.log('[PlayUpdate] Policy result:', result.action);
    } catch (e) {
        console.warn('[PlayUpdate] Policy check failed:', e);
    }
}

// ============================================================
// SAFE REDIRECT (fallback if router fails)
// ============================================================
function safeRedirect(targetPath) {
    if (screenOrientation) {
        screenOrientation.unlock().catch(() => {});
    }
    let target = targetPath;
    if (target.startsWith('/pages/')) target = target.replace('/pages/', '');
    if (target.endsWith('.html')) target = target.replace('.html', '');
    if (referralCode && !target.includes('ref=')) {
        const sep = target.includes('?') ? '&' : '?';
        target += sep + 'ref=' + encodeURIComponent(referralCode);
    }
    console.log('[App] Redirecting (safe) to:', target);
    if (typeof navigateTo === 'function') {
        navigateTo(target);
    } else {
        window.location.href = target;
    }
}

// ============================================================
// PROGRESS BAR
// ============================================================
let progressFill = null;

function getProgressFill() {
    if (!progressFill) progressFill = document.getElementById('progressFill');
    return progressFill;
}

function updateProgress(percent) {
    const el = getProgressFill();
    if (el) el.style.width = Math.min(100, Math.max(0, percent)) + '%';
}

function completeProgress() {
    updateProgress(100);
}

// ============================================================
// SPLASH CLEANUP
// ============================================================
async function destroySplash() {
    console.log('[Splash] Destroying splash resources...');

    const splash = document.getElementById('app-bootstrap');
    if (splash) {
        splash.style.opacity = '0';
        await new Promise(resolve => setTimeout(resolve, 500));
        splash.remove();
    }

    const splashCss = document.getElementById('medvex-splash-css');
    if (splashCss) splashCss.remove();

    document.documentElement.classList.remove('app-ready', 'medvex-app-ready');
    document.body.classList.remove('splash-active', 'medvex-splash-active');

    progressFill = null;
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
// INITIALIZATION
// ============================================================
export async function initializeApp() {
    console.log('[App] Initializing...');
    updateProgress(5);

    try {
        // 1. Referral code detection
        if (!utils.getLocalStorage('accessToken')) {
            const urlToCheck = pendingAppUrl || undefined;
            const refCode = referral.detectReferralFromURL(urlToCheck);
            if (refCode) {
                console.log('[App] Referral code detected:', refCode);
                referral.validateReferralCode(refCode).then(result => {
                    if (result.valid) {
                        console.log('[App] Referral valid:', result.referrerName);
                    } else {
                        console.warn('[App] Referral invalid, clearing');
                        referral.clearStoredReferralCode();
                    }
                });
            }
        }
        updateProgress(15);

        const token = utils.getLocalStorage('accessToken');
        console.log('[App] Token:', token ? 'exists' : 'none');

        // 2. Load user
        await auth.initUser();
        updateProgress(30);

        // 3. Load subscription
        await subscription.initSubscription();
        updateProgress(45);

        // 4. Load app settings
        const savedSettings = utils.getLocalStorage('appSettings', null);
        if (savedSettings) ui.setAppSettings(savedSettings);
        updateProgress(55);

        // 5. Time verification
        if (!timeVerifier.verifyTime()) return;
        updateProgress(65);

        // 6. Silent token refresh
        let validToken = false;
        if (token && navigator.onLine) {
            console.log('[App] Online with token – silent refresh...');
            try {
                const refreshed = await withTimeout(auth.refreshSession(), 8000);
                if (refreshed) {
                    validToken = true;
                    console.log('[App] Token refreshed');
                }
            } catch (err) {
                console.warn('[App] Session refresh error:', err);
            }
        } else {
            console.log('[App] Offline or no token – cached data only');
        }
        updateProgress(75);

        // 7. Sync
        if (validToken) {
            try {
                await withTimeout(sync.syncUserData(), 8000);
                await withTimeout(sync.triggerFullSync(), 8000);
            } catch (err) {
                console.warn('[App] Data sync timed out', err);
            }
        }
        updateProgress(85);

        // 8. Notifications
        if (notifications && typeof notifications.init === 'function') {
            notifications.init();
        }
        updateProgress(95);

        console.log('[App] Loaded user:', auth.getUser());
    } catch (e) {
        console.warn('[App] Init error, using fallback', e);
        auth.fallbackLoadUser();
        subscription.fallbackLoadSubscription();
    }

    updates.registerUpdateListener();
    completeProgress();
}

// ============================================================
// GLOBAL TIME TAMPER LISTENER
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
        // ── 1. Read the deep link captured by index.html ────────────────
        consumeEarlyDeepLink();

        // ── 2. Load Capacitor modules + plugin handles ──────────────────
        await importCapacitor();

        // ── 3. Capture cold-start file intent (Android ACTION_VIEW) ─────
        // Runs BEFORE the deep-link capture so a file intent takes
        // priority in resolveInitialRoute().
        await captureLaunchFile();
        registerFileListener();

        // ── 4. Backup capture of URL-based deep links ──────────────────
        await captureLaunchUrl();
        registerAppUrlListener();

        // ── 5. Orientation lock ─────────────────────────────────────────
        await initOrientation();

        // ── 6. Play update check ────────────────────────────────────────
        await runPlayUpdateCheck();

        // ── 7. Referral detection ───────────────────────────────────────
        let initialReferral = null;
        if (pendingAppUrl) {
            initialReferral = referral.detectReferralFromURL(pendingAppUrl);
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

        // ── 8. Core init (auth, subscription, sync) ─────────────────────
        await initializeApp();

        // ── 9. Auth state is only used as a fallback for the default
        //       landing page. It never gates a deep link or a file.
        appAuthenticated = auth.checkAuth();
        appInitialized = true;

        // ── 10. Resolve the initial route ───────────────────────────────
        // Priority: external file > deep link > auth-based default.
        // No auth gate is applied to file intents or deep links.
        redirectTarget = resolveInitialRoute();
        console.log('[App] Initial route:', redirectTarget,
                    '| authed:', appAuthenticated,
                    '| fileLaunch:', fileLaunchPending);

        // ── 11. Apply theme ─────────────────────────────────────────────
        if (ui.applyTheme) ui.applyTheme();

        // ── 12. Set the URL bar to match the resolved route ─────────────
        const currentFull = window.location.pathname + window.location.search + window.location.hash;
        if (redirectTarget && redirectTarget !== currentFull) {
            const fullTarget = redirectTarget.startsWith('/') ? redirectTarget : '/' + redirectTarget;
            try {
                window.history.replaceState({}, '', fullTarget);
            } catch (err) {
                console.warn('[App] history.replaceState failed:', err);
            }
        }

        // ── 13. Start the router ────────────────────────────────────────
        // Mounts the initial route exactly once. The drain step below is
        // deliberately placed AFTER this so a queue entry cannot tear
        // down the just-mounted page and mount twice.
        initRouter();

        // ── 14. Drain any warm-start URLs captured during bootstrap ─────
        // Only URLs past the first (which resolveInitialRoute already
        // consumed via pendingAppUrl) reach here. Each dispatches on its
        // own microtask so the initial mount has time to settle.
        drainEarlyQueue();

        // ── 15. Freeze the early queue ──────────────────────────────────
        // From this point, app.js's own appUrlOpen listener owns every
        // URL. The early (index.html) listener keeps its handler attached
        // — Capacitor does not offer a synchronous remove — but the
        // freeze flag stops it from buffering into a queue nothing drains.
        if (window.__deepLink) window.__deepLink.frozen = true;

        // ── 16. Wait for the first render ───────────────────────────────
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

        // ── 17. Destroy splash ──────────────────────────────────────────
        await destroySplash();

        // ── 18. Register service worker ─────────────────────────────────
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/service-worker.js');
        }
    } catch (error) {
        console.error('[App] Bootstrap failed:', error);

        const splash = document.getElementById('app-bootstrap');
        if (splash) splash.remove();
        const splashCss = document.getElementById('medvex-splash-css');
        if (splashCss) splashCss.remove();

        document.documentElement.classList.remove('app-ready', 'medvex-app-ready');
        document.body.classList.remove('splash-active', 'medvex-splash-active');

        progressFill = null;

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

    // Auth
    setToken: auth.setToken,
    clearToken: auth.clearToken,
    checkAuth: auth.checkAuth,
    setUser: auth.setUser,
    getUser: auth.getUser,
    clearUser: auth.clearUser,
    initUser: auth.initUser,
    fallbackLoadUser: auth.fallbackLoadUser,
    refreshSession: auth.refreshSession,
    loginWithGoogle: auth.loginWithGoogle,
    linkGoogleAccount: auth.linkGoogleAccount,

    // Subscription
    setSubscription: subscription.setSubscription,
    getSubscription: subscription.getSubscription,
    hasActiveSubscription: subscription.hasActiveSubscription,
    clearSubscription: subscription.clearSubscription,
    refreshSubscription: subscription.refreshSubscription,

    // Exam
    setExamState: examEngine.setExamState,
    getExamState: examEngine.getExamState,
    clearExamState: examEngine.clearExamState,
    setExamConfig: examEngine.setExamConfig,
    getExamConfig: examEngine.getExamConfig,
    clearExamConfig: examEngine.clearExamConfig,

    // UI
    setAppSetting: ui.setAppSetting,
    getAppSetting: ui.getAppSetting,
    toggleTheme: ui.toggleTheme,

    // Payment
    setSelectedPlan: payment.setSelectedPlan,
    getSelectedPlan: payment.getSelectedPlan,
    setCurrentTransaction: payment.setCurrentTransaction,
    getCurrentTransaction: payment.getCurrentTransaction,

    // Updates
    checkForUpdates: updates.checkForUpdates,
    skipWaitingAndReload: updates.skipWaitingAndReload,

    // Sync
    syncUserData: sync.syncUserData,
    triggerFullSync: sync.triggerFullSync,
    syncData: sync.syncData,
    syncExamResults: sync.syncExamResults,
    syncUserProfile: sync.syncUserProfile,
    syncSubscription: sync.syncSubscription,

    // Events
    events: events.events,

    // Play update
    checkPlayUpdate: runPlayUpdateCheck,
    applyPlayUpdate: appUpdate.applyDownloadedUpdate,
    isPlayUpdateSupported: appUpdate.isAppUpdateSupported,

    // Deep-link debug helpers
    extractDeepLinkPath,
    dispatchDeepLink,

    // File-intent debug helpers
    isFileLaunchPending: () => fileLaunchPending,
    stashFilePayload: _stashFilePayload,
};