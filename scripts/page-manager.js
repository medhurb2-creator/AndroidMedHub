// scripts/page-manager.js

/**
 * Page Manager
 * ============================================================================
 *
 * Loads pages into #app-root. Owns the lifecycle: HTML fetch, CSS injection,
 * module init, and teardown on navigation.
 *
 * No auth gate at this layer.
 *   The page-manager does not decide whether a page is allowed to load.
 *   It hands the page everything it needs — `authRequired`, `isAuthenticated`,
 *   a `requireAuth()` helper — and lets the page's own `init()` decide what
 *   to do. This is what lets deep links land on a route unconditionally and
 *   still allow the target page to redirect to login (with a `returnTo`) if
 *   the page itself wants that behaviour.
 *
 * No origin checks, no URL rewriting, no scheme inspection.
 *   Whatever the caller passes as `pageName` is what gets loaded. The router
 *   upstream has already normalized it. If the caller passed a path that
 *   doesn't resolve to a real page, the error page fires — that is the only
 *   failure mode.
 */

import { loadPage } from './page-loader.js';
import * as auth from './auth.js';
import * as router from './router.js';

// State
let currentPage = null;               // { name, root, cleanup, module, scriptPath }
let abortController = null;
let cleanupFunctions = [];

/**
 * Navigate to a page.
 *
 * @param {string} pageName - The page name (e.g. 'dashboard', 'exam/123')
 * @param {Object} params - Dynamic route parameters
 * @param {URLSearchParams} query - Query parameters
 * @param {string} hash - URL hash fragment
 * @returns {Promise<void>}
 */
export async function navigateTo(pageName, params = {}, query = new URLSearchParams(), hash = '') {
    // 1. Tear down the current page first.
    if (currentPage) {
        await destroyCurrentPage();
    }

    // 2. Fresh AbortController for this navigation.
    abortController = new AbortController();
    const signal = abortController.signal;

    try {
        // 3. Resolve the page's HTML, metadata, and pre-imported module.
        const pageMeta = await loadPage(pageName);

        // 4. Load the page's stylesheet (if any).
        if (pageMeta.style) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = pageMeta.style;
            link.dataset.page = pageName;
            document.head.appendChild(link);
        }

        // 5. Inject the page's HTML.
        const appRoot = document.getElementById('app-root');
        appRoot.innerHTML = pageMeta.html;

        // 6. Set the document title.
        document.title = pageMeta.title || 'MedVix';

        // 7. The module — used for init() and destroy() lifecycle.
        const module = pageMeta.module;

        // 8. Build the context. Every decision the page might want to make
        //    about itself is available here.
        //
        //    `authRequired`  — the value of the section's data-auth attribute.
        //    `isAuthenticated` — current auth state, read at nav time.
        //    `requireAuth()` — helper the page calls to trigger a login
        //                      redirect if it decides it needs to. Returns
        //                      true if authenticated, false if the redirect
        //                      was scheduled.
        //
        //    Pages that don't call `requireAuth()` are never gated.
        const context = {
            root: appRoot.querySelector('section[data-page]'),
            page: pageName,
            path: `/${pageName}`,
            query,
            params,
            hash,
            signal,
            authRequired: pageMeta.auth === 'required',
            isAuthenticated: auth.checkAuth(),
            requireAuth: (redirectBase = 'login') => {
                if (auth.checkAuth()) return true;

                const queryString = query && typeof query.toString === 'function'
                    ? query.toString()
                    : '';
                const returnTo = encodeURIComponent(
                    pageName + (queryString ? '?' + queryString : '')
                );
                const target = `${redirectBase}?returnTo=${returnTo}`;

                // Defer so the page's init can finish before navigation.
                Promise.resolve().then(() => {
                    try { router.navigateTo(target); } catch { /* ignore */ }
                });

                return false;
            },
            router: {
                navigateTo,
                goBack: () => window.history.back(),
            },
        };

        // 9. Call the page's init (if it defines one).
        let pageCleanup = null;
        if (typeof module.init === 'function') {
            pageCleanup = await module.init(context);
            if (typeof pageCleanup === 'function') {
                cleanupFunctions.push(pageCleanup);
            }
        }

        // 10. Remember what we mounted so destroyCurrentPage can tear it down.
        currentPage = {
            name: pageName,
            root: context.root,
            cleanup: cleanupFunctions,
            module,
            scriptPath: pageMeta.script,
        };

        console.log(`[PageManager] Page "${pageName}" loaded successfully.`);

    } catch (err) {
        console.error('[PageManager] Error loading page:', err);

        // Fallback: render the error page. This fires on 404s (missing HTML
        // or missing page module) and on any throw from init().
        const appRoot = document.getElementById('app-root');
        if (appRoot) {
            appRoot.innerHTML = `
                <section class="page error-page" data-page="error" data-title="Error">
                    <header class="page-header">
                        <h1>Something went wrong</h1>
                    </header>
                    <main class="page-content">
                        <p id="error-message">${(err && err.message) || 'Unknown error'}</p>
                        <button data-action="go-home" onclick="router.navigateTo('subjects')">Go to Dashboard</button>
                    </main>
                </section>
            `;
        }
        document.title = 'Error';
    }
}

/**
 * Destroy the current page — call the module's destroy hook, run cleanup
 * functions returned from init(), abort in-flight fetches, remove page CSS,
 * and clear the DOM.
 *
 * @returns {Promise<void>}
 */
async function destroyCurrentPage() {
    // Snapshot the reference and clear global state immediately so that
    // reentrant navigations cannot double-destroy.
    const page = currentPage;
    if (!page) {
        console.warn('[PageManager] destroyCurrentPage called but no current page exists.');
        return;
    }
    currentPage = null;
    cleanupFunctions = [];

    // 1. Module destroy hook.
    if (page.module && typeof page.module.destroy === 'function') {
        try {
            await page.module.destroy();
        } catch (e) {
            console.warn('[PageManager] Destroy error:', e);
        }
    }

    // 2. Cleanup functions returned by init().
    if (Array.isArray(page.cleanup)) {
        for (const fn of page.cleanup) {
            try {
                if (typeof fn === 'function') fn();
            } catch (e) {
                console.warn('[PageManager] Cleanup error:', e);
            }
        }
    }

    // 3. Abort any pending fetches tied to this page's signal.
    if (abortController) {
        abortController.abort();
        abortController = null;
    }

    // 4. Remove page-specific stylesheets.
    document.querySelectorAll(`link[data-page="${page.name}"]`).forEach(el => el.remove());

    // 5. Clear the DOM.
    const appRoot = document.getElementById('app-root');
    if (appRoot) appRoot.innerHTML = '';
}

/**
 * Programmatically go back in history.
 * @returns {void}
 */
export function goBack() {
    window.history.back();
}