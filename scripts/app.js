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
 *
 * NOTE: this does synchronous native bridge work (mkdir per namespace).
 * It is NOT awaited on the critical path — see scheduleDeferredWork().
 * If any page needs these namespaces before the deferred tick, call
 * this function directly from that page's init.
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

// ── CHANGED ──
// Small IDB helpers so we can stream records one at a time instead of
// pulling every blob into memory with getAll(). Each call opens its own
// short-lived transaction, which is the safe pattern when the handler
// itself awaits other async work.
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

        // ── Sweep 'files' store — one record at a time ──────────────
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

        // ── Sweep 'publicAssets' store — one record at a time ───────
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

// ── CHANGED ──
// Yields to the event loop every N relocations so the synchronous
// bridge loop does not lock the UI thread for the whole migration.
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

        // Yield every 10 relocations. relocateToOtherRoot is a
        // synchronous JS-bridge call; without this the UI thread
        // freezes for the duration of the loop.
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

// ── CHANGED ── idempotent listener registration
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

// ── CHANGED ── guard against double-registration of the downloaded
// listener; the Play Store check may be run more than once per session.
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
// SAFE REDIRECT (fallback if router fails)
// ============================================================
function safeRedirect(targetPath) {
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
// ── CHANGED ──
// Removed the hardcoded 500 ms sleep. We now wait for the opacity
// transition to actually finish (or 400 ms, whichever is sooner) and
// fire the orientation release without awaiting it.
// ============================================================
async function destroySplash() {
    console.log('[Splash] Destroying splash resources...');

    const splash = document.getElementById('app-bootstrap');
    const splashCss = document.getElementById('medvex-splash-css');
    if (splashCss) splashCss.remove();

    document.documentElement.classList.remove('app-ready', 'medvex-app-ready');
    document.body.classList.remove('splash-active', 'medvex-splash-active');

    progressFill = null;

    // Fire-and-forget. The OS doesn't need our ack to rotate.
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
            setTimeout(finish, 400);
        });
    }

    console.log('[Splash] Splash completely destroyed.');
}

// ============================================================
// TIMEOUT HELPER
// ── CHANGED ──
// Optional AbortController. When the timeout fires we abort the
// underlying request so it doesn't linger in the connection pool.
// Callers must thread `signal` through their fetch to benefit;
// without it the behaviour is unchanged.
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
// ── CHANGED ──
// Split into two phases:
//   • initializeAppLocal()    — synchronous + local IDB reads only.
//                               Fast, awaited before the router mounts.
//   • initializeNetworkPhase() — refresh + sync. Deferred to after
//                               the first paint. Fire-and-forget.
//
// initializeApp() is retained for backwards compatibility — it calls
// both in sequence. New callers should prefer the split.
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
        // 1. Referral code detection (sync). Validation is a network
        //    call — see initializeNetworkPhase for the deferred version.
        if (!utils.getLocalStorage('accessToken')) {
            const urlToCheck = pendingAppUrl || undefined;
            const refCode = referral.detectReferralFromURL(urlToCheck);
            if (refCode) {
                console.log('[App] Referral code detected:', refCode);
            }
        }
        updateProgress(15);

        // 2. App settings (sync localStorage read).
        const savedSettings = utils.getLocalStorage('appSettings', null);
        if (savedSettings) ui.setAppSettings(savedSettings);
        updateProgress(30);

        // 3. Time verification (sync). Bail out of local init if the
        //    device clock looks tampered — matches previous behaviour.
        if (!timeVerifier.verifyTime()) {
            console.warn('[App] Time verification failed — aborting local init');
            return false;
        }
        updateProgress(50);

        // 4. Auth + subscription in parallel. Both read from local
        //    storage; running them together halves the wait.
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

    // Notifications — fire-and-forget. They do not gate anything.
    if (notifications && typeof notifications.init === 'function') {
        try { notifications.init(); } catch (e) {
            console.warn('[App] notifications.init failed', e);
        }
    }

    // Referral validation — best-effort network check.
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

    // Silent token refresh. 4 s is plenty — anything longer means the
    // network is broken and we're better off with cached data.
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

    // Sync — both calls run together, both capped at 5 s.
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
// ── CHANGED ── extracted so scheduleDeferredWork can be called
// after the observer resolves.
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
// ── CHANGED ── everything that used to block the boot path.
// Called once, after the splash has been torn down and the user is
// looking at a real page.
// ============================================================
function scheduleDeferredWork() {
    // Storage namespaces — synchronous bridge work. Push it to the
    // next tick so the current frame finishes cleanly first.
    setTimeout(() => {
        try { initStorageLayout(); }
        catch (e) { console.warn('[Storage] initStorageLayout failed', e); }
    }, 0);

    // Play Store round-trip — the single biggest source of boot delay.
    // Fire it and forget it.
    runPlayUpdateCheck().catch(e => console.warn('[PlayUpdate]', e));

    // Update listener (service-worker updates) — register once.
    try { updates.registerUpdateListener(); }
    catch (e) { console.warn('[App] registerUpdateListener failed', e); }

    // Network phase — refresh, sync, referral validation.
    initializeNetworkPhase().catch(e => console.warn('[App] network init', e));

    // Legacy blob migration — already delayed, keep the delay.
    setTimeout(() => {
        migrateLegacyBlobs().catch((e) =>
            console.warn('[Storage] Migration failed:', e)
        );
    }, 2000);

    // Service worker — never blocks anything.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/service-worker.js').catch(() => {});
    }
}

// ============================================================
// SPA BOOTSTRAP
// ── CHANGED ── reordered so first paint depends on almost nothing.
// ============================================================
async function bootstrap() {
    const t0 = (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();

    try {
        // ── 0. Fire-and-forget warm-ups ─────────────────────────────────
        warmDeviceIdentity();

        // ── 1. Consume early deep link captured by index.html ───────────
        consumeEarlyDeepLink();

        // ── 2. Synchronous plugin handle lookup ─────────────────────────
        importCapacitor();

        // ── 3. Register listeners BEFORE capturing launch intents ───────
        // A warm-start event that fires while we're awaiting
        // captureLaunchFile() would otherwise be lost.
        registerFileListener();
        registerAppUrlListener();

        // ── 4. Capture cold-start file + URL in parallel ────────────────
        // Both are quick native round-trips. Running them together
        // halves the wait versus the original serial order.
        await Promise.all([captureLaunchFile(), captureLaunchUrl()]);

        // ── 5. Splash orientation — fire-and-forget ─────────────────────
        // The splash HTML already renders portrait via CSS; this just
        // tells the OS not to rotate the window during boot. No need
        // to await it.
        lockSplashOrientation().catch(() => {});

        // ── 6. Referral detection (sync) ────────────────────────────────
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

        // ── 7. Local-only init (no network) ─────────────────────────────
        const localOk = await initializeAppLocal();

        // ── 8. Resolve auth state from cache ────────────────────────────
        appAuthenticated = auth.checkAuth();
        appInitialized = true;

        // ── 9. Resolve the initial route ────────────────────────────────
        redirectTarget = resolveInitialRoute();
        console.log('[App] Initial route:', redirectTarget,
                    '| authed:', appAuthenticated,
                    '| fileLaunch:', fileLaunchPending,
                    '| deepLink:', !!pendingAppUrl);

        // ── 10. Theme + status bar ──────────────────────────────────────
        if (ui.applyTheme) ui.applyTheme();
        if (ui.syncStatusBar) ui.syncStatusBar();

        // ── 11. Set the URL bar to match the resolved route ─────────────
        const currentFull = window.location.pathname + window.location.search + window.location.hash;
        if (redirectTarget && redirectTarget !== currentFull) {
            const fullTarget = redirectTarget.startsWith('/') ? redirectTarget : '/' + redirectTarget;
            try { window.history.replaceState({}, '', fullTarget); }
            catch (err) { console.warn('[App] history.replaceState failed:', err); }
        }

        // ── 12. Start the router ────────────────────────────────────────
        initRouter();

        // ── 13. Drain warm-start URLs buffered during bootstrap ─────────
        drainEarlyQueue();

        // ── 14. Freeze the early queue ──────────────────────────────────
        if (window.__deepLink) window.__deepLink.frozen = true;

        // ── 15. Wait for the first render ───────────────────────────────
        await waitForFirstRender();

        // ── 16. Destroy splash (fast) ───────────────────────────────────
        await destroySplash();

        const t1 = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        console.log(`[Boot] First paint + splash teardown: ${Math.round(t1 - t0)}ms`);

        // ── 17. Everything non-critical, deferred ───────────────────────
        // Play update, network refresh, sync, storage layout,
        // migration, service worker — none of it gates the user.
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

    // Device identity (warm-up + direct access)
    warmDeviceIdentity,
    getDeviceId: security.getDeviceId,
    getDeviceInfo: security.getDeviceInfo,
    getCachedDeviceId: security.getCachedDeviceId,
    getCachedDeviceInfo: security.getCachedDeviceInfo,

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

    // Orientation debug helpers
    lockSplashOrientation,
    releaseSplashOrientation,

    // ── Storage — root info ────────────────────────────────────────────
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

    // ── Storage — content operations ───────────────────────────────────
    storageStats:      () => contentStore.getStorageStats(),
    storageClearCache: () => contentStore.clearCache(),

    // ── Storage — high-level actions ───────────────────────────────────
    storageMigrateRoots: migrateStorageRoots,
    storageDeleteAll:    deleteAllLocalData,

    // ── Storage — diagnostics ──────────────────────────────────────────
    storageLayoutDescriptor:     () => layout.readLayoutDescriptor(),
    storageRegisteredNamespaces: () => layout.getRegisteredNamespaces(),
    storageMigrationRan:         () => !!utils.getLocalStorage(MIGRATION_KEY),
    storageMigrateLegacyBlobs:   () => migrateLegacyBlobs(),
};