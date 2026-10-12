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

// === STORAGE ===
import * as layout        from './db/layout.js';
import * as contentStore  from './db/content-store.js';
import * as storage       from './db/app-storage.js';

// ============================================================
// NATIVE PLUGINS — SYNCHRONOUS LOOKUP (Java-registered)
// ============================================================
let FileOpen = null;
let MedvixApp = null;
let MedvixOrientation = null;

function importCapacitor() {
    if (typeof window.Capacitor === 'undefined') {
        console.log('[App] Native bridge not available, skipping plugin lookup.');
        return;
    }

    const plugins = window.Capacitor.Plugins || {};

    FileOpen          = plugins.FileOpen          || null;
    MedvixApp         = plugins.MedvixApp         || null;
    MedvixOrientation = plugins.MedvixOrientation || null;

    console.log(
        '[App] Native plugins:',
        'FileOpen:',          !!FileOpen,
        'MedvixApp:',         !!MedvixApp,
        'MedvixOrientation:', !!MedvixOrientation,
        'MedVixStorage:',     !!window.MedVixStorage,
    );
}

// ============================================================
// DEVICE IDENTITY WARM-UP
// ============================================================
let _deviceWarmPromise = null;

function warmDeviceIdentity() {
    if (_deviceWarmPromise) return _deviceWarmPromise;

    const t0 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();

    _deviceWarmPromise = security.buildDeviceIdentity()
        .then(({ deviceId, deviceInfo }) => {
            const t1 = (typeof performance !== 'undefined' && performance.now)
                ? performance.now()
                : Date.now();
            const ms = Math.round(t1 - t0);
            console.log(
                `[Device] Ready in ${ms}ms → ${deviceId}` +
                (deviceInfo?.platform ? ` (${deviceInfo.platform})` : '')
            );
            return { deviceId, deviceInfo };
        })
        .catch((err) => {
            console.warn('[Device] Warm-up failed:', err);
            return null;
        });

    return _deviceWarmPromise;
}

// ============================================================
// STORAGE — BOOT INIT + LEGACY BLOB MIGRATION
// ============================================================
const MIGRATION_KEY = 'medvix.storage.migrated.v13';

/**
 * Register app-facing namespaces and scaffold the base directory
 * tree. Idempotent.
 */
function initStorageLayout() {
    layout.registerNamespace('resources', {
        description: 'Learning materials: textbooks, past papers, references',
    });
    layout.registerNamespace('media', {
        description: 'Media: anatomy models, diagrams, audio',
    });
    layout.registerNamespace('user', {
        description: 'User-generated content: exports, notes',
    });

    if (!storage.isNativeStorageAvailable()) {
        console.log('[Storage] Native bridge unavailable — storage runs in IDB-only mode');
        return false;
    }

    if (layout.scaffoldDirectories()) {
        layout.persistLayoutDescriptor();
        console.log(
            '[Storage] Layout ready v' + layout.getLayoutVersion() +
            ' (' + storage.getStorageRootType() + ')' +
            ' — ' + layout.getRegisteredNamespaces().length + ' namespaces'
        );
        return true;
    }

    console.warn('[Storage] Scaffold failed');
    return false;
}

function _idbReadKeys(database, storeName) {
    return new Promise((resolve, reject) => {
        const store = database.transaction(storeName, 'readonly').objectStore(storeName);
        const req = store.getAllKeys();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
    });
}

function _idbReadOne(database, storeName, key) {
    return new Promise((resolve, reject) => {
        const store = database.transaction(storeName, 'readonly').objectStore(storeName);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function migrateLegacyBlobs() {
    if (utils.getLocalStorage(MIGRATION_KEY)) return;

    if (!storage.isNativeStorageAvailable()) {
        utils.setLocalStorage(MIGRATION_KEY, 'web-noop:' + Date.now());
        return;
    }

    console.log('[Storage] Starting legacy blob migration (v13)...');
    const t0 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();

    let migratedFiles = 0;
    let migratedThumbs = 0;
    let migratedAssets = 0;
    let failed = 0;

    try {
        const database = await db.initDatabase();

        const fileKeys = await _idbReadKeys(database, 'files');
        for (const key of fileKeys) {
            let record;
            try {
                record = await _idbReadOne(database, 'files', key);
            } catch (e) {
                failed++;
                continue;
            }
            if (!record || !record.blob) continue;
            if (record.location === 'disk') continue;

            try {
                if (String(record.id).startsWith('thumb_')) {
                    const id = String(record.id).slice(6);
                    await db.saveThumbnailBlob(id, record.blob);
                    migratedThumbs++;
                } else {
                    await db.saveFileBlob(record.id, record.blob);
                    migratedFiles++;
                }
            } catch (e) {
                console.warn('[Storage] Migration failed for id', record.id, e);
                failed++;
            }
        }

        const assetKeys = await _idbReadKeys(database, 'publicAssets');
        for (const key of assetKeys) {
            let record;
            try {
                record = await _idbReadOne(database, 'publicAssets', key);
            } catch (e) {
                failed++;
                continue;
            }
            if (!record || !record.blob) continue;
            if (record.location === 'disk') continue;

            try {
                await db.savePublicAsset(record.key, record.blob, record.metadata || {});
                migratedAssets++;
            } catch (e) {
                console.warn('[Storage] Migration failed for asset', record.key, e);
                failed++;
            }
        }
    } catch (e) {
        console.warn('[Storage] Migration could not start:', e);
        return;
    }

    const t1 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();
    const ms = Math.round(t1 - t0);

    console.log(
        `[Storage] Migration done in ${ms}ms — ` +
        `files: ${migratedFiles}, thumbnails: ${migratedThumbs}, ` +
        `assets: ${migratedAssets}, failed: ${failed}`
    );

    utils.setLocalStorage(MIGRATION_KEY, {
        at: Date.now(),
        files: migratedFiles,
        thumbnails: migratedThumbs,
        assets: migratedAssets,
        failed,
    });
}

async function migrateStorageRoots() {
    if (!storage.isNativeStorageAvailable()) {
        return { ok: false, moved: 0, failed: 0, reason: 'Native storage unavailable' };
    }
    if (!window.MedVixStorage?.listFilesInRoot || !window.MedVixStorage?.relocateToOtherRoot) {
        return { ok: false, moved: 0, failed: 0, reason: 'Migration not supported in this build' };
    }

    const from = storage.getStorageRootType();

    let roots = [];
    try {
        const raw = window.MedVixStorage.getAvailableRoots?.();
        roots = raw ? JSON.parse(raw) : [];
    } catch { roots = []; }

    const other = roots.find(r => r.type !== from && r.available);
    if (!other) {
        return { ok: false, moved: 0, failed: 0, reason: 'No alternate storage location available' };
    }

    let list = [];
    try {
        const raw = window.MedVixStorage.listFilesInRoot(from, 'content');
        list = raw ? JSON.parse(raw) : [];
    } catch { list = []; }

    if (list.length === 0) {
        window.MedVixStorage.setPreferredRoot(other.type);
        return { ok: true, moved: 0, failed: 0, from, to: other.type };
    }

    let moved = 0;
    let failed = 0;
    let processed = 0;

    for (const rel of list) {
        try {
            if (window.MedVixStorage.relocateToOtherRoot(rel)) moved++;
            else failed++;
        } catch {
            failed++;
        }

        if (++processed % 10 === 0) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (failed === 0) {
        window.MedVixStorage.setPreferredRoot(other.type);
        return { ok: true, moved, failed: 0, from, to: other.type };
    }

    return {
        ok: false,
        moved,
        failed,
        from,
        to: other.type,
        reason: `${failed} file${failed === 1 ? '' : 's'} could not be moved. Preference unchanged.`,
    };
}

async function deleteAllLocalData() {
    await db.clearDatabase();
    try {
        if (window.MedVixStorage?.deleteDirectory) {
            window.MedVixStorage.deleteDirectory('content');
            window.MedVixStorage.deleteDirectory('cache');
        }
    } catch { /* ignore */ }
    return { ok: true };
}

// ============================================================
// APP-LEVEL STATE
// ============================================================
let pendingAppUrl = null;
let appInitialized = false;
let appAuthenticated = false;
let referralCode = null;
let redirectTarget = null;

// ============================================================
// FIRST-LAUNCH GATE — install-referrer deferred deep link
// ============================================================
// The Play Install Referrer is only meaningful on the very first
// launch after install. Every subsequent launch it returns null
// (sometimes after a slow round-trip), so we gate the deferred
// deep-link poll behind a persistent flag.
const FIRST_LAUNCH_KEY = 'medvix.firstLaunch.v1';

function isFirstLaunch() {
    return !utils.getLocalStorage(FIRST_LAUNCH_KEY);
}

function markLaunched() {
    try {
        utils.setLocalStorage(FIRST_LAUNCH_KEY, Date.now());
    } catch { /* ignore */ }
}

// ============================================================
// FILE-OPEN — EXTERNAL FILE INTENTS (ANDROID)
// ============================================================
const PENDING_FILE_KEY = 'pendingFileOpen';

let fileLaunchPending = false;
let _fileListenerRegistered = false;

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

function registerFileListener() {
    if (_fileListenerRegistered) return;
    if (!FileOpen || typeof FileOpen.addListener !== 'function') return;

    FileOpen.addListener('fileOpen', (payload) => {
        if (!payload || !payload.path) return;
        console.log('[FileOpen] Live file:', payload.name || '(unnamed)');

        _stashFilePayload(payload);

        if (!appInitialized) {
            fileLaunchPending = true;
            return;
        }

        navigateTo('viewer');
    });

    _fileListenerRegistered = true;
}

// ============================================================
// DEEP LINK — EXTRACT THE PATH
// ============================================================
function extractDeepLinkPath(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;

    if (rawUrl.startsWith('content://') || rawUrl.startsWith('file://')) {
        return { kind: 'file', url: rawUrl };
    }

    try {
        const u = new URL(rawUrl);

        if (u.protocol === 'http:' || u.protocol === 'https:') {
            return {
                kind: 'route',
                path: u.pathname + u.search + u.hash,
            };
        }

        if (u.protocol) {
            const host     = u.hostname || '';
            const pathPart = u.pathname || '';
            const suffix   = (u.search || '') + (u.hash || '');

            if (!host && !pathPart) {
                return { kind: 'route', path: '/' + suffix };
            }

            const combined = '/' + host + pathPart + suffix;
            return { kind: 'route', path: combined };
        }
    } catch { /* fall through */ }

    const path = rawUrl.startsWith('/') ? rawUrl : '/' + rawUrl;
    return { kind: 'route', path };
}

// ============================================================
// DEEP LINK — COLD START ROUTE
// ============================================================
function resolveInitialRoute() {
    if (pendingAppUrl) {
        const link = extractDeepLinkPath(pendingAppUrl);
        if (link) {
            if (link.kind === 'file') {
                try {
                    sessionStorage.setItem(PENDING_FILE_KEY, JSON.stringify({
                        path: link.url,
                        name: 'Document',
                        mimeType: null,
                        size: 0,
                    }));
                } catch { /* ignore */ }
                return 'viewer';
            }

            const qIdx = link.path.indexOf('?');
            const hIdx = link.path.indexOf('#');
            let splitIdx = link.path.length;
            if (qIdx >= 0 && qIdx < splitIdx) splitIdx = qIdx;
            if (hIdx >= 0 && hIdx < splitIdx) splitIdx = hIdx;

            const pathPart = link.path.slice(0, splitIdx);
            const suffix   = link.path.slice(splitIdx);

            const route = pathPart.replace(/^\//, '');
            if (route) return route + suffix;

            if (suffix) {
                const def = appAuthenticated ? 'subjects' : 'welcome';
                return def + suffix;
            }
        }
    }

    if (fileLaunchPending) {
        console.log('[App] Initial route: viewer (file intent)');
        return 'viewer';
    }

    return appAuthenticated ? 'subjects' : 'welcome';
}

// ============================================================
// DEEP LINK — WARM START DISPATCH
// ============================================================
function dispatchDeepLink(rawUrl) {
    const link = extractDeepLinkPath(rawUrl);
    if (!link) return;

    if (link.kind === 'file') {
        try {
            sessionStorage.setItem(PENDING_FILE_KEY, JSON.stringify({
                path: link.url,
                name: 'Document',
                mimeType: null,
                size: 0,
            }));
        } catch { /* ignore */ }
        navigateTo('viewer');
        return;
    }

    const route = link.path.replace(/^\//, '');
    if (route) navigateTo(route);
}

// ============================================================
// DEEP LINK — CAPTURE (MedvixApp plugin)
// ============================================================
async function captureLaunchUrl() {
    if (!MedvixApp || typeof MedvixApp.getLaunchUrl !== 'function') return;
    try {
        const result = await MedvixApp.getLaunchUrl();
        if (result && result.url) {
            console.log('[DeepLink] getLaunchUrl:', result.url);
            if (!pendingAppUrl) pendingAppUrl = result.url;
        }
    } catch {
        console.warn('[DeepLink] Could not obtain launch URL');
    }
}

let _appUrlListenerRegistered = false;
function registerAppUrlListener() {
    if (_appUrlListenerRegistered) return;
    if (!MedvixApp || typeof MedvixApp.addListener !== 'function') return;
    MedvixApp.addListener('appUrlOpen', ({ url }) => {
        if (!url) return;
        console.log('[DeepLink] appUrlOpen:', url);
        if (appInitialized) {
            dispatchDeepLink(url);
        } else if (!pendingAppUrl) {
            pendingAppUrl = url;
        }
    });
    _appUrlListenerRegistered = true;
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

function drainEarlyQueue() {
    const early = window.__deepLink;
    if (!early || !Array.isArray(early.queue) || early.queue.length === 0) return;
    const urls = early.queue.splice(0);
    for (const url of urls) {
        Promise.resolve().then(() => dispatchDeepLink(url));
    }
}

let _pendingDeepLinkPromise = null;

function capturePendingDeepLink() {
    if (_pendingDeepLinkPromise) return _pendingDeepLinkPromise;

    if (!MedvixApp || typeof MedvixApp.getPendingDeepLink !== 'function') {
        _pendingDeepLinkPromise = Promise.resolve(null);
        return _pendingDeepLinkPromise;
    }

    _pendingDeepLinkPromise = (async () => {
        const start = Date.now();
        let delay = 200;

        while (Date.now() - start < 6000) {
            try {
                const res = await MedvixApp.getPendingDeepLink();

                if (res && res.url) {
                    console.log('[DeepLink] Deferred route from referrer:', res.url);
                    return res.url;
                }

                if (res && res.checked) {
                    return null;
                }
            } catch (err) {
                console.warn('[DeepLink] getPendingDeepLink failed:', err);
                return null;
            }

            await new Promise((r) => setTimeout(r, delay));
            delay = Math.min(delay * 2, 1500);
        }

        console.warn('[DeepLink] Referrer poll timed out');
        return null;
    })();

    return _pendingDeepLinkPromise;
}

// ============================================================
// ORIENTATION — SPLASH-ONLY PORTRAIT LOCK
// ============================================================
async function lockSplashOrientation() {
    if (!MedvixOrientation || typeof MedvixOrientation.lock !== 'function') return;
    try {
        await MedvixOrientation.lock({ orientation: 'portrait' });
        console.log('[App] Splash orientation locked to portrait');
    } catch {
        console.warn('[App] Splash orientation lock not available');
    }
}

async function releaseSplashOrientation() {
    if (!MedvixOrientation || typeof MedvixOrientation.unlock !== 'function') return;
    try {
        await MedvixOrientation.unlock();
        console.log('[App] Splash orientation released');
    } catch {
        console.warn('[App] Splash orientation release failed');
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

let _playUpdateListenerWired = false;
async function runPlayUpdateCheck() {
    if (!appUpdate.isAppUpdateSupported()) {
        console.log('[PlayUpdate] Not running on native / plugin unavailable');
        return;
    }

    let currentVersionCode = 0;
    try {
        if (MedvixApp && typeof MedvixApp.getInfo === 'function') {
            const info = await MedvixApp.getInfo();
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

    if (!_playUpdateListenerWired) {
        _playUpdateListenerWired = true;
        appUpdate.onAppUpdate('downloaded', () => {
            console.log('[PlayUpdate] Download complete – showing restart banner');
            showFlexibleUpdateBanner();
        });
    }

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
    const splashCss = document.getElementById('medvex-splash-css');
    if (splashCss) splashCss.remove();

    document.documentElement.classList.remove('app-ready', 'medvex-app-ready');
    document.body.classList.remove('splash-active', 'medvex-splash-active');

    progressFill = null;

    releaseSplashOrientation().catch(() => {});

    if (splash) {
        splash.style.opacity = '0';
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                splash.remove();
                resolve();
            };
            splash.addEventListener('transitionend', finish, { once: true });
            // Fallback shortened from 400ms → 300ms. transitionend still
            // wins when it fires; this only pays out on missed events.
            setTimeout(finish, 300);
        });
    }

    console.log('[Splash] Splash completely destroyed.');
}

// ============================================================
// TIMEOUT HELPER
// ============================================================
function withTimeout(promise, ms = 8000, controller = null) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => {
                if (controller) {
                    try { controller.abort(); } catch { /* ignore */ }
                }
                reject(new Error('Network timeout'));
            }, ms)
        ),
    ]);
}

// ============================================================
// INITIALIZATION
// ============================================================
export async function initializeApp() {
    const ok = await initializeAppLocal();
    if (ok) return initializeNetworkPhase();
}

async function initializeAppLocal() {
    console.log('[App] Local init...');
    updateProgress(5);

    warmDeviceIdentity();

    try {
        if (!utils.getLocalStorage('accessToken')) {
            const urlToCheck = pendingAppUrl || undefined;
            const refCode = referral.detectReferralFromURL(urlToCheck);
            if (refCode) {
                console.log('[App] Referral code detected:', refCode);
            }
        }
        updateProgress(15);

        const savedSettings = utils.getLocalStorage('appSettings', null);
        if (savedSettings) ui.setAppSettings(savedSettings);
        updateProgress(30);

        if (!timeVerifier.verifyTime()) {
            console.warn('[App] Time verification failed — aborting local init');
            return false;
        }
        updateProgress(50);

        await Promise.all([
            auth.initUser(),
            subscription.initSubscription(),
        ]);
        updateProgress(70);

        console.log('[App] Local init complete. User:', auth.getUser());
        return true;
    } catch (e) {
        console.warn('[App] Local init error, using fallback', e);
        try { auth.fallbackLoadUser(); } catch { /* ignore */ }
        try { subscription.fallbackLoadSubscription(); } catch { /* ignore */ }
        return false;
    }
}

async function initializeNetworkPhase() {
    const token = utils.getLocalStorage('accessToken');
    if (!token || !navigator.onLine) {
        console.log('[App] Offline or no token – skipping network init');
        return;
    }

    if (notifications && typeof notifications.init === 'function') {
        try { notifications.init(); } catch (e) {
            console.warn('[App] notifications.init failed', e);
        }
    }

    if (!utils.getLocalStorage('accessToken')) {
        const refCode = referral.detectReferralFromURL(pendingAppUrl || undefined);
        if (refCode) {
            referral.validateReferralCode(refCode)
                .then(result => {
                    if (!result.valid) {
                        console.warn('[App] Referral invalid, clearing');
                        referral.clearStoredReferralCode();
                    }
                })
                .catch(() => { /* ignore */ });
        }
    }

    let validToken = false;
    try {
        console.log('[App] Online with token – silent refresh...');
        const ac = new AbortController();
        const refreshed = await withTimeout(auth.refreshSession(ac.signal), 4000, ac);
        if (refreshed) {
            validToken = true;
            console.log('[App] Token refreshed');
        }
    } catch (err) {
        console.warn('[App] Session refresh error:', err);
    }

    if (!validToken) return;

    try {
        const ac1 = new AbortController();
        const ac2 = new AbortController();
        await Promise.all([
            withTimeout(sync.syncUserData(ac1.signal), 5000, ac1),
            withTimeout(sync.triggerFullSync(ac2.signal), 5000, ac2),
        ]);
        console.log('[App] Sync complete');
    } catch (err) {
        console.warn('[App] Data sync timed out', err);
    }
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
// FIRST-RENDER WAIT
// ============================================================
function waitForFirstRender() {
    const appRoot = document.getElementById('app-root');
    if (!appRoot || appRoot.children.length) return Promise.resolve();
    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            if (appRoot.children.length > 0) {
                observer.disconnect();
                resolve();
            }
        });
        observer.observe(appRoot, { childList: true });
    });
}

// ============================================================
// DEFERRED WORK
// ============================================================
function scheduleDeferredWork() {
    setTimeout(() => {
        try { initStorageLayout(); }
        catch (e) { console.warn('[Storage] initStorageLayout failed', e); }
    }, 0);

    runPlayUpdateCheck().catch(e => console.warn('[PlayUpdate]', e));

    try { updates.registerUpdateListener(); }
    catch (e) { console.warn('[App] registerUpdateListener failed', e); }

    initializeNetworkPhase().catch(e => console.warn('[App] network init', e));

    setTimeout(() => {
        migrateLegacyBlobs().catch((e) =>
            console.warn('[Storage] Migration failed:', e)
        );
    }, 2000);

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
}

// ============================================================
// SPA BOOTSTRAP
// ============================================================
async function bootstrap() {
    const t0 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();

    try {
        warmDeviceIdentity();
        consumeEarlyDeepLink();
        importCapacitor();

        // --- Apply saved theme BEFORE any await ---
        // Prevents a light flash on dark-mode cold starts. Idempotent
        // with the same read inside initializeAppLocal().
        const savedSettings = utils.getLocalStorage('appSettings', null);
        if (savedSettings) ui.setAppSettings(savedSettings);
        if (ui.applyTheme)    ui.applyTheme();
        if (ui.syncStatusBar) ui.syncStatusBar();

        registerFileListener();
        registerAppUrlListener();

        // --- Run local init in parallel with native captures ---
        // initializeAppLocal() only logs a referral hint from pendingAppUrl;
        // the real validation happens in initializeNetworkPhase(), which
        // re-reads pendingAppUrl after captures have settled.
        const capturesPromise  = Promise.all([captureLaunchFile(), captureLaunchUrl()]);
        const localInitPromise = initializeAppLocal();

        // --- Deferred install-referrer poll: first launch only ---
        const firstLaunch = isFirstLaunch();
        const deferredDeepLinkPromise = firstLaunch
            ? capturePendingDeepLink()
            : Promise.resolve(null);

        lockSplashOrientation().catch(() => {});

        // Captures must settle before we can read pendingAppUrl /
        // fileLaunchPending for referral badge + route resolution.
        await capturesPromise;

        referralCode = pendingAppUrl
            ? referral.detectReferralFromURL(pendingAppUrl)
            : referral.detectReferralFromURL();
        if (referralCode) {
            const badge = document.getElementById('referralBadge');
            const codeSpan = document.getElementById('refBadgeCode');
            if (badge && codeSpan) {
                badge.style.display = 'block';
                codeSpan.textContent = referralCode;
            }
        }

        const localOk = await localInitPromise;

        appAuthenticated = auth.checkAuth();
        appInitialized = true;

        // --- First-launch only: short race on the deferred deep link ---
        // The late-dispatch .then() below still honors a slow-arriving
        // referrer, so a short timeout is safe on first launch and we
        // skip the wait entirely on every subsequent launch.
        if (firstLaunch) {
            if (!pendingAppUrl) {
                const raceResult = await Promise.race([
                    deferredDeepLinkPromise,
                    new Promise((resolve) => setTimeout(() => resolve(null), 400)),
                ]);

                if (typeof raceResult === 'string' && raceResult) {
                    pendingAppUrl = raceResult;
                    console.log(
                        '[DeepLink] Deferred route adopted before route resolution:',
                        raceResult
                    );
                }
            }
            markLaunched();
        }

        redirectTarget = resolveInitialRoute();
        console.log('[App] Initial route:', redirectTarget,
                    '| authed:', appAuthenticated,
                    '| fileLaunch:', fileLaunchPending,
                    '| deepLink:', !!pendingAppUrl);

        const currentFull = window.location.pathname + window.location.search + window.location.hash;
        if (redirectTarget && redirectTarget !== currentFull) {
            const fullTarget = redirectTarget.startsWith('/') ? redirectTarget : '/' + redirectTarget;
            try { window.history.replaceState({}, '', fullTarget); }
            catch (err) { console.warn('[App] history.replaceState failed:', err); }
        }

        initRouter();
        drainEarlyQueue();

        deferredDeepLinkPromise.then((url) => {
            if (!url) return;
            if (pendingAppUrl) return;
            if (!appInitialized) return;
            console.log('[DeepLink] Deferred route arrived late — dispatching:', url);
            dispatchDeepLink(url);
        });

        if (window.__deepLink) window.__deepLink.frozen = true;

        await waitForFirstRender();
        await destroySplash();

        const t1 = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        console.log(`[Boot] First paint + splash teardown: ${Math.round(t1 - t0)}ms`);

        if (localOk) {
            scheduleDeferredWork();
        } else {
            console.warn('[App] Local init failed — running deferred work anyway');
            scheduleDeferredWork();
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

        try { await releaseSplashOrientation(); } catch {}

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

    warmDeviceIdentity,
    getDeviceId: security.getDeviceId,
    getDeviceInfo: security.getDeviceInfo,
    getCachedDeviceId: security.getCachedDeviceId,
    getCachedDeviceInfo: security.getCachedDeviceInfo,

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

    setSubscription: subscription.setSubscription,
    getSubscription: subscription.getSubscription,
    hasActiveSubscription: subscription.hasActiveSubscription,
    clearSubscription: subscription.clearSubscription,
    refreshSubscription: subscription.refreshSubscription,

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
    triggerFullSync: sync.triggerFullSync,
    syncData: sync.syncData,
    syncExamResults: sync.syncExamResults,
    syncUserProfile: sync.syncUserProfile,
    syncSubscription: sync.syncSubscription,

    events: events.events,

    checkPlayUpdate: runPlayUpdateCheck,
    applyPlayUpdate: appUpdate.applyDownloadedUpdate,
    isPlayUpdateSupported: appUpdate.isAppUpdateSupported,

    extractDeepLinkPath,
    dispatchDeepLink,
    capturePendingDeepLink,

    isFileLaunchPending: () => fileLaunchPending,
    stashFilePayload: _stashFilePayload,

    lockSplashOrientation,
    releaseSplashOrientation,

    // First-launch helpers (useful for QA / devtools)
    isFirstLaunch,
    markLaunched,

    storageRoot:           () => window.MedVixStorage?.getRoot?.()           || null,
    storageRootType:       () => window.MedVixStorage?.getRootType?.()       || 'unavailable',
    storageAvailable:      () => !!window.MedVixStorage?.isAvailable?.()    ,
    storagePreferredRoot:  () => window.MedVixStorage?.getPreferredRoot?.()  || 'internal',
    storageAvailableRoots: () => {
        try {
            const raw = window.MedVixStorage?.getAvailableRoots?.();
            return raw ? JSON.parse(raw) : [];
        } catch { return []; }
    },
    storageSetPreferredRoot: (type) =>
        !!window.MedVixStorage?.setPreferredRoot?.(type),

    storageStats:      () => contentStore.getStorageStats(),
    storageClearCache: () => contentStore.clearCache(),

    storageMigrateRoots: migrateStorageRoots,
    storageDeleteAll:    deleteAllLocalData,

    storageLayoutDescriptor:     () => layout.readLayoutDescriptor(),
    storageRegisteredNamespaces: () => layout.getRegisteredNamespaces(),
    storageMigrationRan:         () => !!utils.getLocalStorage(MIGRATION_KEY),
    storageMigrateLegacyBlobs:   () => migrateLegacyBlobs(),
};