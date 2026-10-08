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
//
// All native plugins are accessed via window.Capacitor.Plugins.<Name>.
// This is a synchronous property lookup — if the plugin isn't
// registered, the lookup returns undefined and every caller's guard
// fires. There is no dynamic import() in this file, so there is no
// code path that can silently hang waiting for a module chunk to load.
//
// Registered in MainActivity.onCreate():
//
//   AppUpdatePlugin          → not accessed from JS here; used by app-update.js
//   FileOpenPlugin           → FileOpen
//   MedvixDevicePlugin       → MedvixDevice (used via security/device.js)
//   MedvixAppPlugin          → MedvixApp
//   MedvixOrientationPlugin  → MedvixOrientation
//
// window.MedVixStorage is registered via addJavascriptInterface()
// immediately after super.onCreate() in MainActivity. It is not a
// Capacitor plugin — see the storage layer for why.

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
//
// security/device.js resolves deviceId + deviceInfo lazily. The first
// caller may hit the native bridge (up to NATIVE_TIMEOUT_MS) or fall
// back to a locally-derived UUID. If that first caller is auth.login(),
// the user stares at the spinner while the bridge is probed.
//
// warmDeviceIdentity() kicks off the same promise auth later awaits.
// security/device.js dedupes via its internal _pendingId / _pendingInfo,
// so calling this early costs nothing and the login path becomes a
// synchronous cache hit.
//
// Fire-and-forget. Never throws. Idempotent — safe to call from both
// bootstrap() and initializeApp().

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
            // buildDeviceIdentity() is contractually total — it never
            // rejects. If a future change breaks that, log and resolve
            // to null so bootstrap never hangs on this.
            console.warn('[Device] Warm-up failed:', err);
            return null;
        });

    return _deviceWarmPromise;
}

// ============================================================
// STORAGE — BOOT INIT + LEGACY BLOB MIGRATION
// ============================================================
//
// On Android, blob storage moved from IndexedDB to disk in v13. The
// DB layer (scripts/db.js) already routes new writes through the
// native bridge and falls back to IDB automatically. This block
// handles two things that only the boot sequence can do:
//
//   1. Register app-facing namespaces and scaffold the on-disk
//      directory tree. Synchronous. Runs once at boot.
//
//   2. Sweep legacy IDB blobs — anything written before v13 with a
//      .blob field — out to disk. Async, fire-and-forget with a
//      small delay so the initial render is not blocked. Marked in
//      localStorage so it runs at most once per install.
//
// Neither step is required for correctness. If the storage bridge is
// unavailable (web dev build) both are no-ops. If the migration is
// interrupted, reads still work — db.js's getters check disk first
// and fall back to IDB, so legacy blobs remain accessible until the
// next boot retries the sweep.

const MIGRATION_KEY = 'medvix.storage.migrated.v13';

/**
 * Register app-facing namespaces and scaffold the base directory
 * tree. Called from bootstrap. Idempotent — re-registering an
 * existing namespace is a no-op.
 */
function initStorageLayout() {
    // Namespaces for content the app itself manages. The DB layer
    // registers its own internal namespaces ('files', 'public-assets')
    // when scripts/db.js is first imported.
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

/**
 * One-time sweep of legacy IDB blobs to disk.
 *
 * Reads every record in the 'files' and 'publicAssets' stores. Any
 * record that still holds a raw Blob (written before v13) is re-saved
 * through db.js's public API, which routes it to disk and replaces
 * the IDB record with a metadata-only stub.
 *
 * Records that are already metadata (location: 'disk') or that have
 * no .blob field are skipped. So this is idempotent — safe to run
 * after a partial migration, and safe to call on a fresh install
 * where there is nothing to migrate.
 *
 * Errors on individual records are logged and skipped. The migration
 * marker is set regardless so a single bad blob doesn't cause the
 * sweep to re-run on every boot. Reads of un-migrated blobs still
 * work via the disk-miss → IDB fallback in db.js.
 */
async function migrateLegacyBlobs() {
    // Marker check — only run once per install.
    if (utils.getLocalStorage(MIGRATION_KEY)) return;

    // Native bridge is required — migration is meaningless without disk.
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

        // ── Sweep 'files' store ──────────────────────────────────────
        // Records can be:
        //   * id starting 'thumb_'    → legacy thumbnail blob
        //   * id starting anything    → legacy file blob
        //   * location === 'disk'     → already metadata; skip
        //   * no .blob field          → already metadata; skip
        const filesStore = database
            .transaction('files', 'readonly')
            .objectStore('files');

        const allFiles = await new Promise((resolve, reject) => {
            const req = filesStore.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror   = () => reject(req.error);
        });

        for (const record of allFiles) {
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

        // ── Sweep 'publicAssets' store ───────────────────────────────
        const assetsStore = database
            .transaction('publicAssets', 'readonly')
            .objectStore('publicAssets');

        const allAssets = await new Promise((resolve, reject) => {
            const req = assetsStore.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror   = () => reject(req.error);
        });

        for (const record of allAssets) {
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
        // Couldn't even open the DB — try again next boot.
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

    // Set the marker even if some records failed. The point is to
    // avoid pausing boot on every launch. Un-migrated blobs stay
    // readable through the disk-miss fallback in db.js.
    utils.setLocalStorage(MIGRATION_KEY, {
        at: Date.now(),
        files: migratedFiles,
        thumbnails: migratedThumbs,
        assets: migratedAssets,
        failed,
    });
}

/**
 * Root-to-root migration. Moves every file under content/ from the
 * current write root to the other one, then commits the preference.
 *
 * Called by the Storage tab in Settings → Profile. Also safe to call
 * from any other UI that wants to offer the same control.
 *
 * Reads stay working throughout — the native bridge checks both roots
 * on every get, so a partially-completed migration never strands a
 * file. The preference is committed only after every file has landed;
 * otherwise the user is told how many files could not be moved and
 * can retry — already-moved files skip via the dest.exists() guard
 * inside relocateToOtherRoot.
 *
 * @returns {Promise<{ ok: boolean, moved: number, failed: number,
 *                     from?: string, to?: string, reason?: string }>}
 */
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

    // Enumerate every file under content/ in the source root.
    let list = [];
    try {
        const raw = window.MedVixStorage.listFilesInRoot(from, 'content');
        list = raw ? JSON.parse(raw) : [];
    } catch { list = []; }

    if (list.length === 0) {
        // Nothing to move. Commit the preference so new writes go to
        // the other root.
        window.MedVixStorage.setPreferredRoot(other.type);
        return { ok: true, moved: 0, failed: 0, from, to: other.type };
    }

    let moved = 0;
    let failed = 0;

    for (const rel of list) {
        try {
            if (window.MedVixStorage.relocateToOtherRoot(rel)) moved++;
            else failed++;
        } catch {
            failed++;
        }
    }

    if (failed === 0) {
        // All files landed. Commit the preference so new writes go to
        // the other root from now on.
        window.MedVixStorage.setPreferredRoot(other.type);
        return { ok: true, moved, failed: 0, from, to: other.type };
    }

    // Partial. Leave the preference unchanged — reads still find every
    // file because the bridge checks both roots.
    return {
        ok: false,
        moved,
        failed,
        from,
        to: other.type,
        reason: `${failed} file${failed === 1 ? '' : 's'} could not be moved. Preference unchanged.`,
    };
}

/**
 * Wipe all local data: every IndexedDB store, plus every on-disk
 * content/ and cache/ directory under the current write root.
 *
 * Called by the Storage tab in Settings → Profile. Also safe to call
 * from anywhere else that wants a full local reset.
 *
 * The user stays logged in. This is a device-scoped wipe, not an
 * account deletion — the account-level delete lives on the Security
 * tab and calls into auth.deleteAccount().
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
async function deleteAllLocalData() {
    // 1. Clear every IndexedDB store. db.clearDatabase() also wipes
    //    the on-disk content/ and cache/ trees via the native bridge.
    await db.clearDatabase();

    // 2. Belt-and-braces: if the native bridge exposes the low-level
    //    directory wipes, call them directly in case a partial IDB
    //    clear left something behind.
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
//
// When the OS hands the app a file — a PDF, image, or text file the
// user tapped in Files, Gmail, or Chrome — the FileOpen Java plugin
// copies the bytes into the app cache and delivers a payload:
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
//     `fileOpen` event. `registerFileListener()` stashes the payload
//     and routes to the viewer page.
//
// In both cases the payload is written to `sessionStorage.pendingFileOpen`
// and the app navigates to `pages/viewer.html`. That page's init()
// calls `viewer.openPendingFile()`, which drains the stash and loads the
// file through the standard viewer pipeline.
//
// External files NEVER require auth. The user chose the file; it just
// opens. Internal catalogue resources still route through
// resource-browser.html's embedded viewer overlay — they never reach
// this path.

const PENDING_FILE_KEY = 'pendingFileOpen';

/** True once a cold-start file has been detected. @private */
let fileLaunchPending = false;

/** Idempotence flag for the warm-start listener. @private */
let _fileListenerRegistered = false;

/**
 * Write an external file payload to sessionStorage in the shape
 * `viewer.openPendingFile()` expects. Idempotent — a second call
 * replaces the previous payload, which is correct when a new file
 * arrives before the previous one has been drained.
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
 * Read the cold-start file payload from the FileOpen plugin. Called
 * once during bootstrap, before route resolution. If a payload exists,
 * the initial route is forced to `viewer`.
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
 * Register the warm-start `fileOpen` listener. Called once during
 * bootstrap. Idempotent.
 *
 * Every external file — cold or warm — routes to `viewer`. If the user
 * is already on the viewer page, `navigateTo('viewer')` destroys the
 * current mount and reloads the page, which drains the new payload.
 * That's exactly what should happen when a second file arrives while
 * one is on screen.
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
            // Arrived during bootstrap — resolveInitialRoute() picks it up.
            fileLaunchPending = true;
            return;
        }

        // App is fully booted. Navigate to the dedicated viewer page.
        // Page-manager will destroy whatever page is currently mounted
        // (including a previous viewer mount) and reload viewer.html,
        // whose init drains the new payload.
        navigateTo('viewer');
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
// Called exactly once during bootstrap. Priority order (highest first):
//
//   1. Deep link URL — a share link the user tapped, or an OAuth
//      callback. This is the "greatest" path; it wins over everything.
//
//   2. External file intent — the OS handed us a file via ACTION_VIEW.
//      Routes to the viewer page. No auth check.
//
//   3. Auth-based default — no deep link, no file. Authed users land
//      on `subjects`; unauthed land on `welcome`.

function resolveInitialRoute() {
    // ── 1. Deep link URL (highest priority) ────────────────────────────
    if (pendingAppUrl) {
        const link = extractDeepLinkPath(pendingAppUrl);
        if (link) {
            if (link.kind === 'file') {
                // Defensive: a content:// URI delivered through the
                // MedvixApp plugin rather than FileOpen. Route to viewer.
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

    // ── 2. External file intent ────────────────────────────────────────
    if (fileLaunchPending) {
        console.log('[App] Initial route: viewer (file intent)');
        return 'viewer';
    }

    // ── 3. Auth-based default ──────────────────────────────────────────
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

function registerAppUrlListener() {
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
// ORIENTATION — SPLASH-ONLY PORTRAIT LOCK
// ============================================================
//
// The splash screen holds the device in portrait so the boot animation
// always renders upright. As soon as the app is fully mounted and the
// splash is torn down, the lock is released — from that point the OS is
// free to rotate based on the sensor and the user's auto-rotate setting.

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

    // Release the splash-only portrait lock. The OS is now free to
    // rotate based on the sensor and the user's auto-rotate setting.
    await releaseSplashOrientation();

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

    // Defensive warm-up. If some entry point calls initializeApp()
    // without going through bootstrap(), device resolution still
    // gets kicked off here. Idempotent — dedupes via the module-level
    // _deviceWarmPromise and security/device.js's own _pendingId.
    warmDeviceIdentity();

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
        // ── 0. Warm device identity (fire-and-forget) ───────────────────
        //
        // Fired FIRST, before any other work, so it overlaps with
        // plugin lookups, file capture, Play update check, auth init,
        // subscription load, session refresh, and sync. By the time
        // the user reaches the login form, `_deviceId` and
        // `_deviceInfo` are already resident and auth.login() never
        // waits on the bridge.
        warmDeviceIdentity();

        // ── 1. Read the deep link captured by index.html ────────────────
        consumeEarlyDeepLink();

        // ── 2. Load native plugin handles (synchronous) ─────────────────
        importCapacitor();

        // ── 2b. Storage: register namespaces + scaffold directories ─────
        //
        // Synchronous. Registers the app-facing namespaces ('resources',
        // 'media', 'user') and creates the on-disk tree. Idempotent —
        // safe on every boot, no-op after the first.
        initStorageLayout();

        // ── 3. Lock splash orientation (portrait for boot) ──────────────
        // Fired before any awaits so the splash animation is always
        // upright. Released inside destroySplash().
        await lockSplashOrientation();

        // ── 4. Capture cold-start file intent (Android ACTION_VIEW) ─────
        // Runs BEFORE the deep-link capture so a file intent takes
        // priority in resolveInitialRoute().
        await captureLaunchFile();
        registerFileListener();

        // ── 5. Backup capture of URL-based deep links ──────────────────
        await captureLaunchUrl();
        registerAppUrlListener();

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
        // Priority: deep link > external file > auth-based default.
        // No auth gate is applied to file intents or deep links.
        redirectTarget = resolveInitialRoute();
        console.log('[App] Initial route:', redirectTarget,
                    '| authed:', appAuthenticated,
                    '| fileLaunch:', fileLaunchPending,
                    '| deepLink:', !!pendingAppUrl);

        // ── 11. Apply theme ─────────────────────────────────────────────
        // Sets the dark-theme class and calls syncStatusBar() so the
        // native status bar matches the theme before the first paint
        // of the routed page.
        if (ui.applyTheme) ui.applyTheme();

        // ── 11b. Sync the native status bar explicitly ──────────────────
        // applyTheme() already calls syncStatusBar(), but on cold boot
        // the CSS may not have been fully evaluated when setTheme()
        // ran, so re-running it here ensures the tokens resolve after
        // the stylesheet is live. Idempotent — a second call is free.
        if (ui.syncStatusBar) ui.syncStatusBar();

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
        // — the Java bridge does not offer a synchronous remove — but
        // the freeze flag stops it from buffering into a queue nothing
        // drains.
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

        // ── 17. Destroy splash (releases orientation lock) ──────────────
        await destroySplash();

        // ── 18. Legacy blob migration (fire-and-forget, delayed) ────────
        //
        // Runs once per install. Sweeps any IDB blobs written before the
        // v13 split out to disk. Delayed slightly so the initial render
        // completes and the user is interacting before the sweep starts.
        //
        // Idempotent — checks a localStorage marker. Never blocks boot.
        // Failures on individual records are logged and skipped; the
        // disk-miss → IDB fallback in db.js keeps un-migrated blobs
        // readable on every subsequent launch.
        setTimeout(() => {
            migrateLegacyBlobs().catch((e) =>
                console.warn('[Storage] Migration failed:', e)
            );
        }, 2000);

        // ── 19. Register service worker ─────────────────────────────────
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

        // Best-effort orientation release even on the error path, so a
        // failed boot doesn't leave the user stuck in portrait.
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