// public/service-worker.js
const CACHE_VERSION = 'v3.1';
const CACHE_NAME = `medexam-${CACHE_VERSION}`;

// ====== DECRYPTION KEY (MUST match encrypt-json.js) ======
const SECRET_KEY = 'MedHubSecretKey2026!!32bytesXXKE'; // 32 bytes

// ====== HELPER: hex to Uint8Array ======
function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

// ====== HELPER: string to Uint8Array ======
function strToBytes(str) {
    return new TextEncoder().encode(str);
}

// ====== DECRYPT FUNCTION (using Web Crypto API) ======
async function decryptData(encryptedText) {
    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 2) {
            // Not encrypted – return as‑is
            return encryptedText;
        }
        const iv = hexToBytes(parts[0]);
        const ciphertext = hexToBytes(parts[1]);

        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            strToBytes(SECRET_KEY),
            { name: 'AES-CBC', length: 256 },
            false,
            ['decrypt']
        );

        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv: iv },
            cryptoKey,
            ciphertext
        );

        return new TextDecoder().decode(decrypted);
    } catch (error) {
        console.warn('[SW] Decryption failed, returning raw:', error);
        return encryptedText; // fallback to raw (e.g. manifest or plain JSON)
    }
}

// ====== ASSETS TO CACHE ======
const STATIC_ASSETS = [
    // Application shell
    '/',
    '/index.html',
    '/manifest.json',

    // Assets
    '/assets/images/logo 1.png',
    '/assets/images/logo-144x144.png',
    '/assets/images/logo.jpeg',
    '/assets/images/logo.png',
    '/assets/images/qr-code.jpeg',

    // Global CSS
    '/css/common.css',

    // Page‑specific CSS (all)
    '/css/ai.css',
    '/css/content.css',
    '/css/exam-room.css',
    '/css/exam-settings.css',
    '/css/forgot-password.css',
    '/css/free-trial.css',
    '/css/locked.css',
    '/css/login.css',
    '/css/notes.css',
    '/css/notifications.css',
    '/css/payment.css',
    '/css/performance.css',
    '/css/privacy.css',
    '/css/profile.css',
    '/css/results.css',
    '/css/shared-note.css',
    '/css/signup.css',
    '/css/subject-specific.css',
    '/css/subjects.css',
    '/css/subscription.css',
    '/css/terms.css',
    '/css/viewer.css',
    '/css/welcome.css',

    // Font Awesome (if served from /css/ – adjust if from /libs/)
    '/css/fa-brands-400.woff2',
    '/css/fa-regular-400.woff2',
    '/css/fa-solid-900.woff2',
    '/css/fa-v4compatibility.woff2',

    // Core scripts (shared)
    '/scripts/app.js',
    '/scripts/auth.js',
    '/scripts/db.js',
    '/scripts/page-loader.js',
    '/scripts/page-manager.js',
    '/scripts/router.js',
    '/scripts/ui.js',
    '/scripts/utils.js',
    '/scripts/events.js',
    '/scripts/updates.js',
    '/scripts/security.js',
    '/scripts/sync.js',
    '/scripts/subscription.js',
    '/scripts/notifications.js',
    '/scripts/referral.js',
    '/scripts/timeVerifier.js',
    '/scripts/convex-client.js',
    '/scripts/exam-engine.js',
    '/scripts/questions.js',
    '/scripts/analytics.js',
    '/scripts/performance-rating-v2.js',
    '/scripts/performance-ai.js',
    '/scripts/pdf-engine.js',
    '/scripts/content.js',
    '/scripts/resource-browser.js',
    '/scripts/viewer.js',
    '/scripts/exam-chat.js',
    '/scripts/timer.js',
    '/scripts/validation.js',
    '/scripts/help.js',
    '/scripts/offline.js',

    // Page‑specific scripts (all pages)
    '/scripts/pages/ai.js',
    '/scripts/pages/exam-room.js',
    '/scripts/pages/exam-settings.js',
    '/scripts/pages/forgot-password.js',
    '/scripts/pages/free-trial.js',
    '/scripts/pages/locked.js',
    '/scripts/pages/login.js',
    '/scripts/pages/notes.js',
    '/scripts/pages/payment.js',
    '/scripts/pages/performance.js',
    '/scripts/pages/profile.js',
    '/scripts/pages/resource-browser.js',
    '/scripts/pages/results.js',
    '/scripts/pages/shared-exam.js',
    '/scripts/pages/shared-note.js',
    '/scripts/pages/signup.js',
    '/scripts/pages/subject-specific.js',
    '/scripts/pages/subjects.js',
    '/scripts/pages/subscription.js',
    '/scripts/pages/welcome.js',

    // Page HTML fragments (all pages)
    '/pages/ai.html',
    '/pages/exam-room.html',
    '/pages/exam-settings.html',
    '/pages/forgot-password.html',
    '/pages/free-trial.html',
    '/pages/locked.html',
    '/pages/login.html',
    '/pages/notes.html',
    '/pages/notifications.html',
    '/pages/payment.html',
    '/pages/performance.html',
    '/pages/privacy.html',
    '/pages/profile.html',
    '/pages/resource-browser.html',
    '/pages/results.html',
    '/pages/shared-exam.html',
    '/pages/shared-note.html',
    '/pages/signup.html',
    '/pages/subject-specific.html',
    '/pages/subjects.html',
    '/pages/subscription.html',
    '/pages/terms.html',
    '/pages/welcome.html',

    // Offline fallback
    '/pages/offline.html',

    // Libraries (if served from /libs/)
    '/libs/quill/quill.snow.css',
    '/libs/quill/quill.min.js',
    '/libs/chart/chart.min.js',
    '/libs/pdfkit.standalone.js',
    '/libs/pdfjs/pdf.min.js',
    '/libs/pdfjs/pdf.worker.min.js',
    '/libs/fontawesome/css/all.min.css',
    '/libs/fontawesome/webfonts/fa-brands-400.woff2',
    '/libs/fontawesome/webfonts/fa-regular-400.woff2',
    '/libs/fontawesome/webfonts/fa-solid-900.woff2',
    '/libs/fontawesome/webfonts/fa-v4compatibility.woff2',
];

// ====== FILES THAT MUST NEVER BE CACHED ======
const EXCLUDED_PATHS = [
    // Shared exam pages are dynamic and should not be cached
    '/pages/shared-exam.html',
    '/pages/shared-note.html',
    // Manifest (handled separately)
];

function isExcluded(url) {
    return EXCLUDED_PATHS.includes(url.pathname);
}

// ====== INSTALL ======
self.addEventListener('install', event => {
    console.log(`[SW] Install ${CACHE_VERSION}`);
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return Promise.allSettled(
                STATIC_ASSETS.map(url =>
                    fetch(url)
                        .then(response => {
                            if (!response.ok) throw new Error(`HTTP ${response.status}`);
                            return cache.put(url, response);
                        })
                        .catch(err => console.warn(`[SW] Failed to cache ${url}:`, err.message))
                )
            );
        }).then(() => self.skipWaiting())
    );
});

// ====== ACTIVATE ======
self.addEventListener('activate', event => {
    console.log(`[SW] Activate ${CACHE_VERSION}`);
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// ====== FETCH ======
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Ignore cross‑origin (except external libraries)
    if (url.origin !== self.location.origin &&
        !url.href.includes('fonts.googleapis.com') &&
        !url.href.includes('cdn.quilljs.com')) {
        return;
    }

    // 1. Special handler for encrypted JSON files (questions)
    if (url.pathname.endsWith('.json') &&
        url.origin === self.location.origin &&
        !url.pathname.includes('manifest.json') &&
        !url.pathname.includes('assetlinks.json')) {

        event.respondWith(handleJsonRequest(event.request));
        return;
    }

    // 2. Excluded paths → network only
    if (isExcluded(url)) {
        event.respondWith(fetch(event.request));
        return;
    }

    // 3. All other static assets → cache‑first
    event.respondWith(
        caches.match(event.request)
            .then(cached => {
                if (cached) return cached;
                // fallback to network
                return fetch(event.request);
            })
            .catch(() => {
                // If navigation fails, serve offline page
                if (event.request.mode === 'navigation') {
                    return caches.match('/pages/offline.html');
                }
                return new Response('Offline content not available.', { status: 404 });
            })
    );
});

// ====== JSON REQUEST HANDLER (cache‑first + decryption) ======
async function handleJsonRequest(request) {
    const cache = await caches.open(CACHE_NAME);

    try {
        // 1) Try cache first
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            const encryptedText = await cachedResponse.text();
            const decryptedText = await decryptData(encryptedText);
            return new Response(decryptedText, {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 2) Fallback to network
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const clonedResponse = networkResponse.clone();
            const encryptedText = await clonedResponse.text();

            // Cache the encrypted version (as-is)
            const bodyToCache = encryptedText;
            await cache.put(request, new Response(bodyToCache, {
                headers: { 'Content-Type': 'application/octet-stream' }
            }));

            // Decrypt and return
            const decryptedText = await decryptData(encryptedText);
            return new Response(decryptedText, {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 3) If all fails
        return new Response(JSON.stringify({ error: 'Offline: unable to load data' }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        console.error('[SW] JSON handler error:', error);
        return new Response(JSON.stringify({ error: 'Service error' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}