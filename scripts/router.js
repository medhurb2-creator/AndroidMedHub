// scripts/router.js

/**
 * SPA Router — Clean URLs
 * ============================================================================
 *
 * Interprets URL paths and dispatches to page-manager. Static pages, dynamic
 * routes, query strings, and hash fragments are all handled by one parser.
 *
 * Clean URL contract:
 *   The first path segment is always the page name. Everything after it is
 *   either a route token or a key=value pair. Query strings and hash
 *   fragments are separated out first.
 *
 *     exam                    → page exam,   no params
 *     exam/123                → page exam,   { id: '123' }
 *     exam/123/q/4            → page exam,   { id: '123', q: '4' }
 *     exam?token=abc          → page exam,   query: { token: 'abc' }
 *     exam/123?tab=recent     → page exam,   params: { id: '123' }, query: { tab: 'recent' }
 *     notes#section-2         → page notes,  hash: '#section-2'
 *     /pages/subjects.html    → page subjects  (legacy paths normalized)
 *     https://app.medvix.co.ke/exam/123 → page exam, { id: '123' }
 *
 * Deep links:
 *   app.js extracts a path from whatever URL the OS handed it and calls
 *   navigateTo(path). That path goes through the exact same parser as an
 *   internal navigation. There is no separate deep-link route table.
 *
 * No auth gate:
 *   The router does not block navigation. Pages that require auth declare
 *   `data-auth="required"` on their `<section>` element, and the page itself
 *   (via page-manager's context) decides what to do — usually a login
 *   redirect with `returnTo`. This is what allows deep links to land
 *   unconditionally and lets each page own its own access policy.
 *
 * No origin checks:
 *   Whatever path the caller passes is used. Origins, schemes, and hosts
 *   are stripped but never validated. If the OS delivered the URL, the OS
 *   already decided it was for this app.
 */

import { navigateTo as pageManagerNavigate } from './page-manager.js';

// ============================================================
// PATH NORMALIZER
// ============================================================

/**
 * Reduce any URL or route string to a bare, slash-separated path with no
 * scheme, origin, `/pages/` prefix, `.html` suffix, query, or hash.
 *
 * @param {string} raw
 * @returns {string}  e.g. 'exam/123/q/4' — empty string for root
 */
function normalizePath(raw) {
    if (!raw || typeof raw !== 'string') return '';

    let path = raw.trim();

    // Strip scheme + origin (`https://host/path` → `/path`).
    path = path.replace(/^[a-z][a-z0-9+.\-]*:\/\/[^/]+/i, '');

    // Drop hash first — it may contain `/`, `?`, and `=`.
    const hIdx = path.indexOf('#');
    if (hIdx >= 0) path = path.slice(0, hIdx);

    // Drop query next.
    const qIdx = path.indexOf('?');
    if (qIdx >= 0) path = path.slice(0, qIdx);

    // Strip leading slashes and the legacy `/pages/` prefix.
    path = path.replace(/^\/+/, '');
    path = path.replace(/^pages\//, '');

    // Strip `.html` suffix.
    path = path.replace(/\.html$/, '');

    // Collapse duplicate slashes and trim trailing ones.
    path = path.replace(/\/+/g, '/').replace(/\/+$/, '');

    return path;
}

// ============================================================
// QUERY + HASH EXTRACTORS
// ============================================================

/**
 * Extract the query string from a raw URL or route. Returns a URLSearchParams
 * ready to hand to page-manager.
 *
 * @param {string} raw
 * @returns {URLSearchParams}
 */
function extractQuery(raw) {
    if (!raw || typeof raw !== 'string') return new URLSearchParams();

    // Strip hash first so a `?` inside the fragment is not mistaken for the
    // query delimiter.
    let rest = raw;
    const hIdx = rest.indexOf('#');
    if (hIdx >= 0) rest = rest.slice(0, hIdx);

    const qIdx = rest.indexOf('?');
    if (qIdx < 0) return new URLSearchParams();

    return new URLSearchParams(rest.slice(qIdx + 1));
}

/**
 * Extract the hash fragment (including the leading `#`). Returns '' when no
 * fragment is present.
 *
 * @param {string} raw
 * @returns {string}
 */
function extractHash(raw) {
    if (!raw || typeof raw !== 'string') return '';
    const hIdx = raw.indexOf('#');
    if (hIdx < 0) return '';
    return raw.slice(hIdx);
}

// ============================================================
// ROUTE PARSER
// ============================================================
//
// Converts any URL or route string into the four arguments page-manager
// expects: (page, params, query, hash).
//
// Segment mapping:
//   ['exam']                    → page 'exam', params {}
//   ['exam', '123']             → page 'exam', params { id: '123' }
//   ['exam', '123', 'q', '4']   → page 'exam', params { id: '123', q: '4' }
//   ['shared-exam', 'tok']      → page 'shared-exam', params { id: 'tok' }
//
// The single-token case maps to `id` because that is the dominant shape in
// this app. Additional tokens become key/value pairs after the id.
//
// For callers that want a specific param name (e.g. `token` for shared-exam),
// they can rename `params.id` themselves — the parser does not enforce
// per-page conventions.

/**
 * @param {string} raw
 * @returns {{ page: string, params: Record<string, string>, query: URLSearchParams, hash: string }}
 */
export function parseRoute(raw) {
    const path = normalizePath(raw);
    const query = extractQuery(raw);
    const hash = extractHash(raw);

    if (!path) {
        return { page: '', params: {}, query, hash };
    }

    const segments = path.split('/').filter(Boolean);
    const page = segments.shift() || '';

    /** @type {Record<string, string>} */
    const params = {};

    if (segments.length === 1) {
        params.id = segments[0];
    } else if (segments.length > 1) {
        // First extra segment is the primary id; the rest are key/value pairs.
        params.id = segments.shift();
        for (let i = 0; i < segments.length; i += 2) {
            const key = segments[i];
            const val = segments[i + 1] ?? '';
            if (key) params[key] = val;
        }
    }

    return { page, params, query, hash };
}

// ============================================================
// URL BUILDER
// ============================================================

/**
 * Reconstruct a clean URL from a parsed route. Used by navigateTo() before
 * pushing onto the history stack.
 *
 * @param {{ page: string, params?: Record<string, string>, query?: URLSearchParams, hash?: string }} route
 * @returns {string}
 */
function buildUrl(route) {
    const { page, params = {}, query, hash = '' } = route;

    let path = '/' + page;

    if (params.id != null) {
        path += '/' + encodeURIComponent(params.id);
    }
    for (const key of Object.keys(params)) {
        if (key === 'id') continue;
        path += '/' + encodeURIComponent(key) + '/' + encodeURIComponent(params[key]);
    }

    let url = path;

    if (query && typeof query.toString === 'function') {
        const qs = query.toString();
        if (qs) url += '?' + qs;
    }

    if (hash) url += hash;

    return url;
}

// ============================================================
// NAVIGATE
// ============================================================
//
// Accepts either a route string OR a pre-parsed route object. Dispatches to
// page-manager. No auth gate. No origin check. Whatever resolves is loaded.

/**
 * @param {string | { page: string, params?: Record<string, string>, query?: URLSearchParams, hash?: string }} target
 * @param {Record<string, any>} [data]  Optional payload for the next page.
 *                                      Available via getNavData().
 * @returns {void}
 */
export function navigateTo(target, data = {}) {
    let parsed;

    if (typeof target === 'string') {
        parsed = parseRoute(target);
    } else if (target && typeof target === 'object' && typeof target.page === 'string') {
        // Caller already parsed. Normalize missing fields.
        parsed = {
            page: target.page,
            params: target.params || {},
            query: target.query instanceof URLSearchParams
                ? target.query
                : new URLSearchParams(target.query || ''),
            hash: target.hash || '',
        };
    } else {
        console.error('[Router] Invalid target:', target);
        return;
    }

    // Root → default landing page. Auth check here only picks which default
    // to use; it never blocks a specific route.
    if (!parsed.page || parsed.page === 'index') {
        parsed.page = 'subjects';
    }

    // Optional payload for the next page.
    if (data && Object.keys(data).length > 0) {
        try {
            sessionStorage.setItem('navData', JSON.stringify(data));
        } catch { /* ignore quota errors */ }
    }

    const url = buildUrl(parsed);

    try {
        window.history.pushState(
            { page: parsed.page, params: parsed.params },
            '',
            url,
        );
    } catch (err) {
        console.warn('[Router] pushState failed, using replaceState:', err);
        try {
            window.history.replaceState(
                { page: parsed.page, params: parsed.params },
                '',
                url,
            );
        } catch { /* ignore */ }
    }

    pageManagerNavigate(parsed.page, parsed.params, parsed.query, parsed.hash);
}

/**
 * Replace the current URL without pushing a new history entry. Used by
 * app.js after resolving a cold-start deep link so the address bar matches
 * the route without polluting history.
 *
 * @param {string} raw
 * @returns {void}
 */
export function replaceUrl(raw) {
    const parsed = parseRoute(raw);
    if (!parsed.page) return;
    const url = buildUrl(parsed);
    try {
        window.history.replaceState(
            { page: parsed.page, params: parsed.params },
            '',
            url,
        );
    } catch { /* ignore */ }
}

// ============================================================
// CURRENT PAGE
// ============================================================

/**
 * Return the name of the page the URL bar currently represents.
 * @returns {string}
 */
export function getCurrentPage() {
    const full = window.location.pathname
        + window.location.search
        + window.location.hash;
    const parsed = parseRoute(full);
    return parsed.page || 'index';
}

/**
 * Return the parsed route for the current URL bar state.
 * @returns {{ page: string, params: Record<string, string>, query: URLSearchParams, hash: string }}
 */
export function getCurrentRoute() {
    const full = window.location.pathname
        + window.location.search
        + window.location.hash;
    return parseRoute(full);
}

// ============================================================
// NAVIGATION DATA
// ============================================================

/**
 * One-shot read of the payload set by the most recent navigateTo(_, data).
 * Clears it after reading so the next page does not inherit stale data.
 *
 * @returns {Record<string, any>}
 */
export function getNavData() {
    try {
        const raw = sessionStorage.getItem('navData');
        sessionStorage.removeItem('navData');
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

// ============================================================
// GO BACK
// ============================================================

export function goBack() {
    window.history.back();
}

// ============================================================
// INIT ROUTER
// ============================================================

export function initRouter() {
    // 1. popstate — back / forward button.
    window.addEventListener('popstate', () => {
        const full = window.location.pathname
            + window.location.search
            + window.location.hash;
        const parsed = parseRoute(full);
        if (!parsed.page) return;
        pageManagerNavigate(parsed.page, parsed.params, parsed.query, parsed.hash);
    });

    // 2. Link interception — capture internal <a> clicks and [data-route]
    //    elements. External links are left alone.
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]') || e.target.closest('[data-route]');
        if (!link) return;

        const href = link.getAttribute('href') || link.dataset.route;
        if (!href) return;

        // External URLs, mail, tel — let the browser handle them.
        if (/^(https?:)?\/\//i.test(href)) return;
        if (href.startsWith('mailto:')) return;
        if (href.startsWith('tel:')) return;
        if (href.startsWith('sms:')) return;

        // Everything else is an internal navigation.
        e.preventDefault();
        navigateTo(href);
    });

    // 3. Initial route from the current URL.
    const initial = window.location.pathname
        + window.location.search
        + window.location.hash;
    const parsed = parseRoute(initial);

    if (!parsed.page) {
        // Bare root — no deep link, no route. Delegate the default to
        // page-manager by navigating to the empty-page default. Whatever
        // page-manager does with an empty page name becomes the landing
        // screen. If the app has a specific default (e.g. `subjects`),
        // app.js will have already written it to the URL bar before
        // calling initRouter().
        return;
    }

    pageManagerNavigate(parsed.page, parsed.params, parsed.query, parsed.hash);
}

// ============================================================
// EXPOSE
// ============================================================

window.router = {
    navigateTo,
    replaceUrl,
    goBack,
    initRouter,
    getCurrentPage,
    getCurrentRoute,
    getNavData,
    parseRoute,
};

export default {
    navigateTo,
    replaceUrl,
    goBack,
    initRouter,
    getCurrentPage,
    getCurrentRoute,
    getNavData,
    parseRoute,
};