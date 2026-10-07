// scripts/page-loader.js

/**
 * Page Loader
 * ============================================================================
 *
 * Resolves a page name to its HTML shell and its eagerly-bundled JavaScript
 * module.
 *
 * Clean URL contract:
 *   The app uses clean URLs. Anything after the first `/`, `?`, `=`, or `#`
 *   in a URL is a route token or query parameter — not part of the page name.
 *
 *     exam/123          →  page `exam`,   token `123`
 *     exam?token=abc    →  page `exam`,   query `token=abc`
 *     exam/123/q/4      →  page `exam`,   tokens `123`, `q`, `4`
 *     notes#section-2   →  page `notes`,  hash `#section-2`
 *
 *   Page files are always flat: `pages/<name>.html` and `pages/<name>.js`.
 *   There are no nested page directories. Sub-routes are handled by the
 *   page's own init() using the params the router extracts.
 *
 * The loader takes whatever it receives and reduces it to the FIRST path
 * segment. If a caller passes a full URL or a raw route string by mistake,
 * the loader still finds the right page. Extracting params, query, and hash
 * is the router's job — not the loader's.
 */

// Eagerly import every page script so Vite bundles them all.
// `**` matches nested directories too, but the app's pages are flat —
// the glob is written this way so a future addition of a subdirectory
// does not silently break bundling.
const pageModules = import.meta.glob('./pages/**/*.js', { eager: true });

/**
 * Reduce a URL or route string to its page name — the first path segment.
 *
 * @param {string} raw
 * @returns {string}
 */
function extractPageName(raw) {
    if (!raw || typeof raw !== 'string') return '';

    let name = raw.trim();

    // Drop scheme + origin: `https://app.medvix.co.ke/exam/123` → `/exam/123`
    name = name.replace(/^[a-z][a-z0-9+.\-]*:\/\/[^/]+/i, '');

    // Drop hash first (it can contain `/` and `?`).
    const hIdx = name.indexOf('#');
    if (hIdx >= 0) name = name.slice(0, hIdx);

    // Drop query string.
    const qIdx = name.indexOf('?');
    if (qIdx >= 0) name = name.slice(0, qIdx);

    // Drop leading slashes.
    name = name.replace(/^\/+/, '');

    // Drop a `/pages/` prefix if a caller left one on.
    name = name.replace(/^pages\//, '');

    // Drop `.html` if a caller passed it.
    name = name.replace(/\.html$/, '');

    // Drop everything after the first remaining `/` — that is a route token,
    // not part of the page name.
    const sIdx = name.indexOf('/');
    if (sIdx >= 0) name = name.slice(0, sIdx);

    return name;
}

/**
 * Load a page by name.
 *
 * @param {string} pageName  Any URL or route string. The loader reduces it
 *                           to the first path segment internally.
 * @returns {Promise<{
 *   page: string,
 *   script: string,
 *   style: string|null,
 *   title: string,
 *   auth: string,
 *   cache: boolean,
 *   transition: string|null,
 *   preload: boolean,
 *   rootElement: Element,
 *   html: string,
 *   module: object,
 * }>}
 */
export async function loadPage(pageName) {
    const name = extractPageName(pageName);
    if (!name) {
        throw new Error('loadPage: empty or invalid page name');
    }

    const url = `/pages/${name}.html`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Page not found: ${url} (HTTP ${response.status})`);
    }
    const html = await response.text();

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const section = doc.querySelector('section[data-page]');
    if (!section) {
        throw new Error(`Invalid page: missing <section data-page> in ${url}`);
    }

    const metadata = {
        page: section.dataset.page || name,
        script: section.dataset.script || `/scripts/pages/${name}.js`,
        style: section.dataset.style || `/css/${name}.css`,
        title: section.dataset.title || name,
        auth: section.dataset.auth || 'none',
        cache: section.dataset.cache === 'true',
        transition: section.dataset.transition || null,
        preload: section.dataset.preload === 'true',
        rootElement: section,
        html: section.outerHTML,
    };

    const relativePath = `./pages/${name}.js`;
    const module = pageModules[relativePath];

    if (!module) {
        const available = Object.keys(pageModules)
            .map(k => k.replace(/^\.\/pages\//, '').replace(/\.js$/, ''))
            .sort()
            .join(', ');
        throw new Error(
            `Page script not found for "${name}". ` +
            `Expected ${relativePath}. ` +
            `Available page scripts: ${available || '(none)'}`
        );
    }

    return { ...metadata, module };
}