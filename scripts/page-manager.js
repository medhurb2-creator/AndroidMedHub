// scripts/page-manager.js

import { loadPage } from './page-loader.js';
import * as auth from './auth.js';
import * as ui from './ui.js';
import * as router from './router.js';

// State
let currentPage = null;               // { name, root, cleanup, module, scriptPath }
let abortController = null;
let cleanupFunctions = [];

/**
 * Navigate to a new page.
 * @param {string} pageName - The page name (e.g., 'dashboard')
 * @param {Object} params - Dynamic route parameters (e.g., { id: '123' })
 * @param {URLSearchParams} query - Query parameters
 * @param {string} hash - URL hash fragment
 */
export async function navigateTo(pageName, params = {}, query = new URLSearchParams(), hash = '') {
    // 1. Destroy the current page (if any)
    if (currentPage) {
        await destroyCurrentPage();
    }

    // 2. Create a new AbortController for this page
    abortController = new AbortController();
    const signal = abortController.signal;

    try {
        // 3. Load the page HTML and metadata, and get the pre-imported module
        const pageMeta = await loadPage(pageName);

        // 4. Authentication check
        if (pageMeta.auth === 'required') {
            if (!auth.checkAuth()) {
                const returnTo = encodeURIComponent(pageName);
                router.navigateTo(`login?returnTo=${returnTo}`);
                return;
            }
        }

        // 5. Load page-specific CSS if provided
        if (pageMeta.style) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = pageMeta.style;
            link.dataset.page = pageName;
            document.head.appendChild(link);
        }

        // 6. Inject the page's HTML into the app root
        const appRoot = document.getElementById('app-root');
        appRoot.innerHTML = pageMeta.html;

        // 7. Set the page title
        document.title = pageMeta.title || 'MedVix';

        // 8. Use the already imported module from pageMeta
        const module = pageMeta.module;

        // 9. Prepare the context object for the page
        const context = {
            root: appRoot.querySelector('section[data-page]'),
            page: pageName,
            path: `/${pageName}`,
            query: query,
            params: params,
            hash: hash,
            signal: signal,
            router: {
                navigateTo: navigateTo,
                goBack: () => window.history.back(),
            },
        };

        // 10. Call the page's init function, if it exists
        let pageCleanup = null;
        if (typeof module.init === 'function') {
            pageCleanup = await module.init(context);
            if (typeof pageCleanup === 'function') {
                cleanupFunctions.push(pageCleanup);
            }
        }

        // 11. Store the current page state, including the module
        currentPage = {
            name: pageName,
            root: context.root,
            cleanup: cleanupFunctions,
            module: module,
            scriptPath: pageMeta.script,
        };

        console.log(`[PageManager] Page "${pageName}" loaded successfully.`);

    } catch (err) {
        console.error('[PageManager] Error loading page:', err);
        // 12. On error, load the error page
        const appRoot = document.getElementById('app-root');
        appRoot.innerHTML = `
            <section class="page error-page" data-page="error" data-title="Error">
                <header class="page-header">
                    <h1>Something went wrong</h1>
                </header>
                <main class="page-content">
                    <p id="error-message">${err.message || 'Unknown error'}</p>
                    <button data-action="go-home" onclick="router.navigateTo('subjects')">Go to Dashboard</button>
                </main>
            </section>
        `;
        document.title = 'Error';
    }
}

/**
 * Destroy the current page – call cleanup, abort requests, remove DOM and CSS.
 */
async function destroyCurrentPage() {
    // Store a local reference and immediately clear the global state to prevent reentrancy.
    const page = currentPage;
    if (!page) {
        console.warn('[PageManager] destroyCurrentPage called but no current page exists.');
        return;
    }
    currentPage = null;
    cleanupFunctions = [];

    // 1. Call the page's destroy function using the stored module
    if (page.module && typeof page.module.destroy === 'function') {
        try {
            await page.module.destroy();
        } catch (e) {
            console.warn('[PageManager] Destroy error:', e);
        }
    }

    // 2. Execute any cleanup functions returned by init()
    if (Array.isArray(page.cleanup)) {
        for (const fn of page.cleanup) {
            try {
                if (typeof fn === 'function') fn();
            } catch (e) {
                console.warn('[PageManager] Cleanup error:', e);
            }
        }
    }

    // 3. Abort any pending fetch requests (AbortController)
    if (abortController) {
        abortController.abort();
        abortController = null;
    }

    // 4. Remove page-specific CSS
    document.querySelectorAll(`link[data-page="${page.name}"]`).forEach(el => el.remove());

    // 5. Clear the DOM from app-root
    const appRoot = document.getElementById('app-root');
    if (appRoot) {
        appRoot.innerHTML = '';
    }
}

/**
 * Programmatically go back in history.
 */
export function goBack() {
    window.history.back();
}