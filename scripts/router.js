// scripts/router.js

/**
 * SPA Router – Full Version (Clean URLs)
 * Handles static, dynamic, query, hash routes.
 * No `.html` in URLs or internal page names.
 *
 * Pages are resolved dynamically – no static lists required.
 * Authentication is enforced by page-manager based on each page's `data-auth`.
 */

import * as ui from './ui.js';
import * as auth from './auth.js';
import { navigateTo as pageManagerNavigate } from './page-manager.js';

// ==================== STATIC PERMISSION LISTS (optional helpers) ====================
const PUBLIC_PAGES = [
    'index', 'welcome', 'login', 'signup', 'forgot-password',
    'locked', 'shared-exam', 'shared-note', 'privacy', 'terms', 'agent-terms', 'error'
];

const PROTECTED_PAGES = [
    'subjects', 'subject-specific', 'exam-settings', 'exam-room', 'results',
    'performance', 'profile', 'subscription', 'free-trial', 'payment',
    'referral', 'agent-registration', 'ai', 'notes', 'notifications',
    'resource-browser', 'pdf-settings'
];

// ==================== DYNAMIC ROUTE PATTERNS ====================
const DYNAMIC_ROUTES = [
    { pattern: /^exam\/(.+)$/, page: 'exam', paramKey: 'id' },
    { pattern: /^resource\/viewer\/(.+)$/, page: 'resource-viewer', paramKey: 'id' },
    { pattern: /^shared-exam\/(.+)$/, page: 'shared-exam', paramKey: 'token' }
];

// ==================== PERMISSION CHECK (relaxed) ====================
function isAllowed(targetPage, currentPage) {
    if (PUBLIC_PAGES.includes(targetPage)) return true;

    if (PROTECTED_PAGES.includes(targetPage)) {
        const isLoggedIn = auth.checkAuth();
        if (!isLoggedIn) {
            ui.showToast('Please log in first', 'warning');
            return false;
        }
    }

    return true;
}

// ==================== ROUTE RESOLVER ====================
function resolveRoute(path) {
    // 1. Separate hash and query from the path
    let pathPart = path;
    let queryString = '';
    let hash = '';

    if (pathPart.includes('#')) {
        const parts = pathPart.split('#');
        pathPart = parts[0];
        hash = parts[1];
    }

    if (pathPart.includes('?')) {
        const parts = pathPart.split('?');
        pathPart = parts[0];
        queryString = parts[1];
    }

    // 2. Clean the path: remove leading/trailing slashes, strip /pages/ prefix, remove .html
    pathPart = pathPart.replace(/^\/+|\/+$/g, '');
    pathPart = pathPart.replace(/^pages\//, '');          // strip /pages/ prefix
    pathPart = pathPart.replace(/\.html$/, '');           // strip .html extension

    const query = new URLSearchParams(queryString || '');

    // 3. Root → redirect based on auth
    if (!pathPart || pathPart === 'index' || pathPart === 'index.html') {
        const isLoggedIn = auth.checkAuth();
        return {
            page: isLoggedIn ? 'subjects' : 'welcome',
            params: {},
            query,
            hash
        };
    }

    // 4. Dynamic route match
    for (const route of DYNAMIC_ROUTES) {
        const match = pathPart.match(route.pattern);
        if (match) {
            return {
                page: route.page,
                params: { [route.paramKey]: match[1] },
                query,
                hash
            };
        }
    }

    // 5. For any other path, treat it as a static page name
    return { page: pathPart, params: {}, query, hash };
}

// ==================== URL BUILDER ====================
function buildUrl({ page, params = {}, query = new URLSearchParams(), hash = '' }) {
    let path = page;
    for (const route of DYNAMIC_ROUTES) {
        if (route.page === page && params[route.paramKey]) {
            if (page === 'exam') path = `exam/${params.id}`;
            else if (page === 'resource-viewer') path = `resource/viewer/${params.id}`;
            else if (page === 'shared-exam') path = `shared-exam/${params.token}`;
            break;
        }
    }
    let url = `/${path}`;
    if (query.toString()) url += `?${query.toString()}`;
    if (hash) url += `#${hash}`;
    return url;
}

// ==================== NAVIGATE ====================
export function navigateTo(target, data = {}) {
    let resolved;
    let targetPage;

    if (typeof target === 'string') {
        resolved = resolveRoute(target);
        targetPage = resolved.page;
    } else if (typeof target === 'object') {
        resolved = target;
        targetPage = target.page;
    } else {
        console.error('[Router] Invalid target:', target);
        return;
    }

    const current = getCurrentPage();
    if (!isAllowed(targetPage, current)) return;

    if (Object.keys(data).length > 0) {
        sessionStorage.setItem('navData', JSON.stringify(data));
    }

    const url = buildUrl(resolved);
    window.history.pushState({ page: targetPage, params: resolved.params }, '', url);

    pageManagerNavigate(targetPage, resolved.params, resolved.query, resolved.hash);
}

// ==================== GET CURRENT PAGE ====================
export function getCurrentPage() {
    const path = window.location.pathname;
    if (path === '/' || path === '/index') return 'index';
    // Strip /pages/ and .html for matching
    let cleanPath = path.replace(/^\/+|\/+$/g, '');
    cleanPath = cleanPath.replace(/^pages\//, '');
    cleanPath = cleanPath.replace(/\.html$/, '');

    for (const route of DYNAMIC_ROUTES) {
        const match = cleanPath.match(route.pattern);
        if (match) return route.page;
    }
    const parts = cleanPath.split('/');
    return parts[0] || 'index';
}

// ==================== NAVIGATION DATA ====================
export function getNavData() {
    const data = sessionStorage.getItem('navData');
    sessionStorage.removeItem('navData');
    return data ? JSON.parse(data) : {};
}

// ==================== GO BACK ====================
export function goBack() {
    window.history.back();
}

// ==================== INIT ROUTER ====================
export function initRouter() {
    // Popstate – always resolve from the full URL to preserve query and hash
    window.addEventListener('popstate', () => {
        const fullPath = window.location.pathname + window.location.search + window.location.hash;
        const resolved = resolveRoute(fullPath);
        navigateTo(resolved);
    });

    // Intercept link clicks
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a[href]') || e.target.closest('[data-route]');
        if (!link) return;
        const href = link.getAttribute('href') || link.dataset.route;
        if (!href) return;
        if (href.startsWith('http') || href.startsWith('//') ||
            href.startsWith('mailto:') || href.startsWith('tel:')) return;
        e.preventDefault();
        navigateTo(href);
    });

    // Initial load
    const initialPath = window.location.pathname + window.location.search + window.location.hash;
    const resolved = resolveRoute(initialPath);
    navigateTo(resolved);
}

// ==================== EXPOSE ====================
window.router = { navigateTo, goBack, initRouter, getCurrentPage, getNavData };
export default { navigateTo, goBack, initRouter, getCurrentPage, getNavData };