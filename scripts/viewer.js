// frontend-user/scripts/viewer.js

/**
 * Universal Document Viewer Module
 * Supports: PDF (scroll/paginated, search+highlight, outline, text layer),
 *           images, Office docs (iframe fallback), and local files from device.
 */

import * as content from './content.js';
import * as subscription from './subscription.js';
import * as ui from './ui.js';
import * as router from './router.js';

// =========================================================================
// Constants & Config
// =========================================================================

const MIME_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
};

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5.0;
const SEARCH_DEBOUNCE = 300;
const LAZY_LOAD_MARGIN = '200px';
const AUTO_HIDE_DELAY = 3000;

// =========================================================================
// State
// =========================================================================

let pdfDoc = null;
let currentPage = 1;
let totalPages = 1;
let currentScale = 1.0;
let currentDocId = null;
let viewMode = 'scroll';
let pdfOutline = [];
let searchMatches = [];
let currentMatchIndex = -1;
let viewerEls = {};
let isLocalFile = false;

let intersectionObserver = null;
let renderTasks = new Map();
let abortController = null;
let cleanupFunctions = [];
let scrollTimeout = null;
let zoomRenderTimer = null;
let dprListener = null;
const textContentCache = new Map();
const pageViewportCache = new Map(); // pageNum -> { width, height } at scale 1

// Auto-hide state
let autoHideTimer = null;
let lastTapTime = 0;
let isHeaderVisible = true;
let isOverControls = false;   // true when pointer or focus is over header/footer

// Panning state
let isPanning = false;
let pointerDown = false;
let lastPointerX = 0;
let lastPointerY = 0;
let panOffsetX = 0;
let panOffsetY = 0;

// Image element reference for image zoom/pan
let imageElement = null;
let imageScale = 1;

// =========================================================================
// DOM helpers
// =========================================================================

function getViewerElements() {
  const embedded = document.getElementById('viewer');
  if (!embedded) return null;
  return {
    container: embedded,
    main: document.getElementById('viewer-main'),
    content: document.getElementById('viewer-content'),
    loading: document.getElementById('viewer-loading'),
    progress: document.getElementById('viewer-progress'),
    title: document.getElementById('viewer-title'),
    footer: document.getElementById('viewer-footer'),
    pageNum: document.getElementById('viewer-page-num'),
    pageCount: document.getElementById('viewer-page-count'),
    pageInput: document.getElementById('viewer-page-input'),
    prevBtn: document.getElementById('viewer-prev-page'),
    nextBtn: document.getElementById('viewer-next-page'),
    zoomIn: document.getElementById('viewer-zoom-in'),
    zoomOut: document.getElementById('viewer-zoom-out'),
    zoomLevel: document.getElementById('viewer-zoom-level'),
    zoomFit: document.getElementById('viewer-zoom-fit'),
    zoomReset: document.getElementById('viewer-zoom-reset'),
    backBtn: document.getElementById('viewer-back-btn'),
    fullscreenBtn: document.getElementById('viewer-fullscreen-btn'),
    toggleViewBtn: document.getElementById('viewer-toggle-view'),
    searchBtn: document.getElementById('viewer-search-btn'),
    searchBar: document.getElementById('viewer-search-bar'),
    searchInput: document.getElementById('viewer-search-input'),
    searchPrev: document.getElementById('viewer-search-prev'),
    searchNext: document.getElementById('viewer-search-next'),
    searchCount: document.getElementById('viewer-search-count'),
    searchOptions: document.getElementById('viewer-search-options'),
    searchCaseSensitive: document.getElementById('viewer-search-case'),
    searchWholeWord: document.getElementById('viewer-search-whole'),
    searchClose: document.getElementById('viewer-search-close'),
    outlineBtn: document.getElementById('viewer-outline-btn'),
    outlineDrawer: document.getElementById('viewer-outline-drawer'),
    openLocalBtn: document.getElementById('viewer-open-local'),
    fileInput: document.getElementById('viewer-file-input'),
    textLayerContainer: document.getElementById('viewer-text-layer'),
  };
}

function refreshElements() {
  viewerEls = getViewerElements();
}

// =========================================================================
// CSS injection for loading dots & auto-hide styles
// =========================================================================

function injectViewerStyles() {
  if (document.getElementById('viewer-inline-styles')) return;
  const style = document.createElement('style');
  style.id = 'viewer-inline-styles';
  style.textContent = `
    .viewer-loading-dots {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      font-size: 2rem;
      color: var(--text-secondary, #888);
      gap: 0.25rem;
    }
    .viewer-loading-dots span {
      animation: viewer-dot-bounce 1.4s infinite ease-in-out both;
      display: inline-block;
    }
    .viewer-loading-dots span:nth-child(1) { animation-delay: 0s; }
    .viewer-loading-dots span:nth-child(2) { animation-delay: 0.2s; }
    .viewer-loading-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes viewer-dot-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-0.5em); }
    }

    /* Auto-hide header/footer */
    .viewer-header {
      transition: transform 0.3s ease, opacity 0.3s ease;
      transform: translateY(0);
      opacity: 1;
    }
    .viewer-header.hidden {
      transform: translateY(-100%);
      opacity: 0;
      pointer-events: none;
    }
    .viewer-footer {
      transition: transform 0.3s ease, opacity 0.3s ease;
      transform: translateY(0);
      opacity: 1;
    }
    .viewer-footer.hidden {
      transform: translateY(100%);
      opacity: 0;
      pointer-events: none;
    }

    /* Improve offscreen page rendering performance */
    .canvas-wrapper {
      content-visibility: auto;
      contain-intrinsic-size: 200px;
    }
  `;
  document.head.appendChild(style);
}

// =========================================================================
// PDF.js Initialization
// =========================================================================

if (typeof pdfjsLib !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
}

// =========================================================================
// Helper: MIME detection & Blob fix
// =========================================================================

function getMimeType(fileType) {
  return MIME_TYPES[fileType?.toLowerCase()] || 'application/octet-stream';
}

async function ensureMimeType(blob, fileType) {
  if ((blob.type === 'application/octet-stream' || !blob.type) && fileType) {
    const mapped = getMimeType(fileType);
    if (mapped !== 'application/octet-stream') {
      return new Blob([await blob.arrayBuffer()], { type: mapped });
    }
  }
  return blob;
}

// =========================================================================
// Cleanup
// =========================================================================

function destroyCurrentDocument() {
  renderTasks.forEach(task => task.cancel());
  renderTasks.clear();

  if (abortController) {
    abortController.abort();
    abortController = null;
  }

  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }

  if (pdfDoc) {
    pdfDoc.destroy();
    pdfDoc = null;
  }

  if (zoomRenderTimer) {
    clearTimeout(zoomRenderTimer);
    zoomRenderTimer = null;
  }

  if (dprListener) {
    window.removeEventListener('resize', dprListener);
    dprListener = null;
  }

  textContentCache.clear();
  pageViewportCache.clear();

  // Remove auto-hide interaction listeners
  removeAutoHideListeners();

  cleanupFunctions.forEach(fn => fn());
  cleanupFunctions = [];

  currentPage = 1;
  totalPages = 1;
  currentScale = 1.0;
  pdfOutline = [];
  searchMatches = [];
  currentMatchIndex = -1;
  panOffsetX = 0;
  panOffsetY = 0;

  const main = viewerEls.main;
  if (main) {
    main.innerHTML = '';
    main.classList.remove('scroll-view', 'page-view');
  }

  if (viewerEls.searchInput) viewerEls.searchInput.value = '';
  updateSearchUI();

  if (viewerEls.outlineDrawer) viewerEls.outlineDrawer.classList.remove('open');

  imageElement = null;
  imageScale = 1;
  isOverControls = false;
}

// =========================================================================
// Main Render Entry
// =========================================================================

async function renderDocument(blob, fileType = null, title = 'Document') {
  destroyCurrentDocument();

  const { main, loading, progress, title: titleEl } = viewerEls;
  if (!main) return;

  // Attach all controls (once per document)
  setupControls();
  setupAutoHideListeners();
  setupDPRListener();

  if (loading) loading.style.display = 'block';
  if (progress) progress.style.display = 'none';
  if (titleEl) titleEl.textContent = title;

  blob = await ensureMimeType(blob, fileType);
  console.log('[Viewer] Document type:', blob.type, 'fileType:', fileType);

  try {
    if (blob.type === 'application/pdf') {
      await renderPDF(blob);
    } else if (blob.type.startsWith('image/')) {
      renderImage(blob);
    } else {
      renderFallback(blob);
    }
  } catch (err) {
    console.error('[Viewer] Render error:', err);
    main.innerHTML = `<div class="error-container" role="alert">
      <p>Failed to render document: ${escapeHtml(err.message)}</p>
      <button class="btn-secondary" onclick="window.history.back()">Go Back</button>
    </div>`;
    if (viewerEls.footer) viewerEls.footer.style.display = 'none';
  } finally {
    if (loading) loading.style.display = 'none';
    if (progress) progress.style.display = 'none';
  }
}

// =========================================================================
// PDF Rendering
// =========================================================================

async function renderPDF(blob) {
  const { main, footer, progress } = viewerEls;

  const arrayBuffer = await blob.arrayBuffer();
  pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  totalPages = pdfDoc.numPages;
  currentPage = 1;

  try {
    pdfOutline = await pdfDoc.getOutline();
  } catch {
    pdfOutline = [];
  }
  buildOutline();

  viewMode = localStorage.getItem('viewer-viewMode') || 'scroll';

  if (progress) {
    pdfDoc.onProgress = ({ loaded: l, total }) => {
      if (total) {
        progress.style.display = 'block';
        progress.value = l / total;
      }
    };
  }

  if (main) {
    main.innerHTML = '<div class="viewer-loading-dots"><span>.</span><span>.</span><span>.</span></div>';
  }

  await renderCurrentLayout();

  if (footer) footer.style.display = 'flex';
  showHeaderFooter(); // ensure visible initially
}

// =========================================================================
// Layout rendering
// =========================================================================

let onScrollHandler = null;

async function renderCurrentLayout() {
  const { main, textLayerContainer } = viewerEls;
  if (!main) return;

  if (zoomRenderTimer) {
    clearTimeout(zoomRenderTimer);
    zoomRenderTimer = null;
  }

  if (viewMode === 'scroll') {
    main.classList.add('scroll-view');
    main.classList.remove('page-view');

    const existingContainer = main.querySelector('.page-container');

    if (!existingContainer) {
      // Initial build
      main.innerHTML = '';
      renderTasks.forEach(task => task.cancel());
      renderTasks.clear();

      if (onScrollHandler) {
        main.removeEventListener('scroll', onScrollHandler);
        onScrollHandler = null;
      }

      panOffsetX = 0;
      panOffsetY = 0;

      await renderAllPagesScroll();

      onScrollHandler = onScroll;
      main.addEventListener('scroll', onScrollHandler);
      setTimeout(() => detectVisiblePage(), 100);
    } else {
      // Zoom changed: cancel all pending renders
      renderTasks.forEach(task => task.cancel());
      renderTasks.clear();

      // Immediately update dimensions for pages whose base sizes are cached
      syncWrapperDimensions();

      // Then re-render visible pages at new scale
      await updateVisiblePages();
    }
  } else {
    main.classList.remove('scroll-view');
    main.classList.add('page-view');
    main.innerHTML = '';
    renderTasks.forEach(task => task.cancel());
    renderTasks.clear();

    if (onScrollHandler) {
      main.removeEventListener('scroll', onScrollHandler);
      onScrollHandler = null;
    }

    panOffsetX = 0;
    panOffsetY = 0;

    await renderSinglePage(currentPage);
  }

  if (textLayerContainer) textLayerContainer.innerHTML = '';
  updateZoomDisplay();
  updateNavButtons();
  resetAutoHideTimer();
}

async function updateVisiblePages() {
  const main = viewerEls.main;
  if (!main) return;

  const viewportTop = main.scrollTop;
  const viewportBottom = viewportTop + main.clientHeight;
  const wrappers = main.querySelectorAll('.canvas-wrapper');
  const tasks = [];

  wrappers.forEach(wrapper => {
    const rect = wrapper.getBoundingClientRect();
    const wrapperTop = rect.top + main.scrollTop - main.getBoundingClientRect().top;
    const wrapperBottom = wrapperTop + rect.height;

    if (wrapperBottom >= viewportTop && wrapperTop <= viewportBottom) {
      const pageNum = parseInt(wrapper.dataset.page, 10);
      tasks.push(lazyRenderPage(pageNum, wrapper));
    }
  });

  await Promise.all(tasks);
}

function onScroll() {
  clearTimeout(scrollTimeout);
  scrollTimeout = setTimeout(() => detectVisiblePage(), 50);
  resetAutoHideTimer();
}

function detectVisiblePage() {
  const { main } = viewerEls;
  if (!main || viewMode !== 'scroll') return;
  const wrappers = main.querySelectorAll('.canvas-wrapper');
  if (!wrappers.length) return;
  let maxVisible = 0;
  let visiblePage = 1;
  const viewportHeight = main.clientHeight;
  const viewportTop = main.scrollTop;
  const viewportBottom = viewportTop + viewportHeight;

  wrappers.forEach((wrapper, index) => {
    const rect = wrapper.getBoundingClientRect();
    const wrapperTop = rect.top + main.scrollTop - main.getBoundingClientRect().top;
    const wrapperBottom = wrapperTop + rect.height;
    const visibleHeight = Math.min(wrapperBottom, viewportBottom) - Math.max(wrapperTop, viewportTop);
    if (visibleHeight > maxVisible) {
      maxVisible = visibleHeight;
      visiblePage = index + 1;
    }
  });

  if (visiblePage !== currentPage) {
    currentPage = visiblePage;
    updatePageNumberDisplay();
  }
}

function updatePageNumberDisplay() {
  const { pageNum, pageInput, pageCount } = viewerEls;
  if (pageNum) pageNum.textContent = currentPage;
  if (pageInput) {
    pageInput.value = currentPage;
    pageInput.min = 1;
    pageInput.max = totalPages;
  }
  if (pageCount) pageCount.textContent = totalPages;
  updateNavButtons();
}

async function renderAllPagesScroll() {
  const { main } = viewerEls;
  const container = document.createElement('div');
  container.className = 'page-container';

  for (let i = 1; i <= totalPages; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'canvas-wrapper';
    wrapper.dataset.page = i;
    wrapper.style.minHeight = '200px';
    container.appendChild(wrapper);
  }

  main.appendChild(container);

  if (intersectionObserver) intersectionObserver.disconnect();

  intersectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;

        const wrapper = entry.target;
        const pageNum = parseInt(wrapper.dataset.page, 10);

        const needsRender =
          !wrapper.querySelector('canvas.pdf-canvas') ||
          wrapper.dataset.renderedScale !== String(currentScale);

        if (needsRender) {
          lazyRenderPage(pageNum, wrapper);
        }
      });
    },
    { rootMargin: LAZY_LOAD_MARGIN }
  );

  document.querySelectorAll('.canvas-wrapper').forEach(w => {
    intersectionObserver.observe(w);
  });

  // Preload page sizes to eliminate placeholder jumps
  preloadPageSizes();
}

async function lazyRenderPage(pageNum, wrapper) {
  const canvas = await renderPageToCanvas(pageNum);
  if (!canvas) return;
  wrapper.innerHTML = '';
  wrapper.appendChild(canvas);

  // Mark this wrapper as rendered at the current zoom scale
  wrapper.dataset.renderedScale = String(currentScale);
}

async function renderSinglePage(pageNum) {
  const { main } = viewerEls;
  const container = document.createElement('div');
  container.className = 'page-container';
  container.style.transformOrigin = '0 0';
  const wrapper = document.createElement('div');
  wrapper.className = 'canvas-wrapper';
  const canvas = await renderPageToCanvas(pageNum);
  if (canvas) wrapper.appendChild(canvas);
  container.appendChild(wrapper);
  main.appendChild(container);
}

async function renderPageToCanvas(pageNum) {
  if (!pdfDoc) return null;

  const scale = currentScale; // capture current zoom

  if (renderTasks.has(pageNum)) {
    renderTasks.get(pageNum).cancel();
    renderTasks.delete(pageNum);
  }

  try {
    const page = await pdfDoc.getPage(pageNum);

    // Cache base viewport at scale 1 for dimension calculations
    const baseViewport = page.getViewport({ scale: 1 });
    pageViewportCache.set(pageNum, {
      width: baseViewport.width,
      height: baseViewport.height,
    });

    // CSS viewport (used for layout / CSS size)
    const cssViewport = page.getViewport({ scale });

    // High-DPI rendering viewport
    const pixelRatio = window.devicePixelRatio || 1;
    const renderViewport = page.getViewport({ scale: scale * pixelRatio });

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    // Set canvas backing store dimensions (actual pixels)
    canvas.height = renderViewport.height;
    canvas.width = renderViewport.width;
    // Set CSS dimensions to the intended layout size
    canvas.style.display = 'block';
    canvas.style.width = cssViewport.width + 'px';
    canvas.style.height = cssViewport.height + 'px';

    const context = canvas.getContext('2d');
    const renderTask = page.render({ canvasContext: context, viewport: renderViewport });
    renderTasks.set(pageNum, renderTask);
    await renderTask.promise;
    renderTasks.delete(pageNum);

    // If zoom changed while this render was in progress, discard it.
    if (scale !== currentScale) {
      return null;
    }

    // Text layer is not attached here for performance.
    // It will be created only when needed (e.g., search/highlight).

    return canvas;
  } catch (err) {
    if (err?.name === 'RenderingCancelledException') return null;
    console.error(`Error rendering page ${pageNum}:`, err);
    return null;
  }
}

// =========================================================================
// Text Layer (kept for potential future use, but not automatically rendered)
// =========================================================================

function attachTextLayer(canvas, pageNum, page, viewport) {
  const wrapper = canvas.parentElement;
  if (!wrapper) return;

  let textLayerDiv = wrapper.querySelector('.textLayer');
  if (textLayerDiv) textLayerDiv.remove();

  textLayerDiv = document.createElement('div');
  textLayerDiv.className = 'textLayer';
  textLayerDiv.style.width = viewport.width + 'px';
  textLayerDiv.style.height = viewport.height + 'px';
  wrapper.style.position = 'relative';
  canvas.style.position = 'absolute';
  canvas.style.top = '0';
  canvas.style.left = '0';
  textLayerDiv.style.position = 'absolute';
  textLayerDiv.style.top = '0';
  textLayerDiv.style.left = '0';

  wrapper.appendChild(textLayerDiv);

  page.getTextContent().then(textContent => {
    pdfjsLib.renderTextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
      textDivs: [],
    });
  });
}

// =========================================================================
// Search & Highlighting
// =========================================================================

async function performSearch() {
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  const input = viewerEls.searchInput;
  if (!input) return;
  const query = input.value.trim();
  if (!query) {
    searchMatches = [];
    currentMatchIndex = -1;
    clearSearchHighlights();
    updateSearchUI();
    return;
  }

  if (!pdfDoc) return;

  const caseSensitive = viewerEls.searchCaseSensitive?.checked || false;
  const wholeWord = viewerEls.searchWholeWord?.checked || false;

  searchMatches = [];
  currentMatchIndex = -1;

  try {
    for (let i = 1; i <= totalPages; i++) {
      if (signal.aborted) return;
      const page = await pdfDoc.getPage(i);

      // Use cached text content if available
      let textContent = textContentCache.get(i);
      if (!textContent) {
        textContent = await page.getTextContent();
        textContentCache.set(i, textContent);
      }

      const { items } = textContent;
      const pageViewport = page.getViewport({ scale: currentScale });

      const textItems = items.map(item => ({
        str: item.str,
        transform: item.transform,
        width: item.width,
        height: item.height,
      }));

      const fullText = textItems.map(t => t.str).join('');
      let regex;
      try {
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = wholeWord ? `\\b${escaped}\\b` : escaped;
        regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
      } catch {
        continue;
      }

      let match;
      while ((match = regex.exec(fullText)) !== null) {
        const startIdx = match.index;
        const endIdx = startIdx + match[0].length;

        const rects = [];
        let charCount = 0;
        for (const item of textItems) {
          const len = item.str.length;
          const itemStart = charCount;
          const itemEnd = charCount + len;
          if (itemEnd > startIdx && itemStart < endIdx) {
            const tx = item.transform;
            const x1 = tx[4];
            const y1 = tx[5];
            const x2 = x1 + item.width;
            const y2 = y1 + item.height;

            const rect = pageViewport.convertToViewportRectangle([x1, y1, x2, y2]);
            const x = Math.min(rect[0], rect[2]);
            const y = Math.min(rect[1], rect[3]);
            const w = Math.abs(rect[2] - rect[0]);
            const h = Math.abs(rect[3] - rect[1]);

            rects.push({ x, y, width: w, height: h });
          }
          charCount += len;
          if (charCount >= endIdx) break;
        }

        if (rects.length > 0) {
          searchMatches.push({ pageNum: i, text: match[0], rects });
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error('Search error:', err);
  }

  currentMatchIndex = searchMatches.length > 0 ? 0 : -1;
  if (searchMatches.length > 0) {
    navigateToMatch(0);
  } else {
    ui.showToast('No matches found', 'warning');
  }
  clearSearchHighlights();
  highlightCurrentMatch();
  updateSearchUI();
}

function navigateSearch(delta) {
  if (!searchMatches.length) return;
  currentMatchIndex = (currentMatchIndex + delta + searchMatches.length) % searchMatches.length;
  navigateToMatch(0);
}

function navigateToMatch(_offset) {
  const match = searchMatches[currentMatchIndex];
  if (!match) return;

  if (viewMode === 'page') {
    if (currentPage !== match.pageNum) {
      currentPage = match.pageNum;
      renderCurrentLayout().then(() => highlightCurrentMatch());
      return;
    }
  } else {
    const wrapper = document.querySelector(`.canvas-wrapper[data-page="${match.pageNum}"]`);
    if (wrapper) {
      wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => highlightCurrentMatch(), 300);
    } else {
      highlightCurrentMatch();
    }
    return;
  }
  highlightCurrentMatch();
}

function highlightCurrentMatch() {
  clearSearchHighlights();
  const match = searchMatches[currentMatchIndex];
  if (!match) return;

  const wrapper = document.querySelector(`.canvas-wrapper[data-page="${match.pageNum}"]`);
  if (!wrapper) return;

  // Create or get a dedicated search overlay layer
  let layer = wrapper.querySelector('.search-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'search-layer';
    layer.style.position = 'absolute';
    layer.style.top = '0';
    layer.style.left = '0';
    layer.style.width = '100%';
    layer.style.height = '100%';
    layer.style.pointerEvents = 'none';
    wrapper.style.position = 'relative';
    wrapper.appendChild(layer);
  }

  match.rects.forEach(rect => {
    const div = document.createElement('div');
    div.className = 'search-highlight active';
    div.style.left = rect.x + 'px';
    div.style.top = rect.y + 'px';
    div.style.width = rect.width + 'px';
    div.style.height = rect.height + 'px';
    layer.appendChild(div);
  });
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-highlight').forEach(el => el.remove());
}

function updateSearchUI() {
  const countEl = viewerEls.searchCount;
  if (countEl) {
    countEl.textContent = searchMatches.length
      ? `${currentMatchIndex + 1}/${searchMatches.length}`
      : '';
  }
  if (viewerEls.searchPrev) viewerEls.searchPrev.disabled = !searchMatches.length;
  if (viewerEls.searchNext) viewerEls.searchNext.disabled = !searchMatches.length;
}

let searchTimeout;
function onSearchInput() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(performSearch, SEARCH_DEBOUNCE);
}

// =========================================================================
// Image Rendering
// =========================================================================

function renderImage(blob) {
  const { main, footer } = viewerEls;
  if (!main) return;

  // Use page-view mode so overflow is hidden and panning works
  main.classList.add('page-view');
  main.classList.remove('scroll-view');

  const wrapper = document.createElement('div');
  wrapper.style.width = '100%';
  wrapper.style.height = '100%';
  wrapper.style.display = 'flex';
  wrapper.style.alignItems = 'center';
  wrapper.style.justifyContent = 'center';
  wrapper.style.transformOrigin = 'center center';
  wrapper.style.touchAction = 'none';

  const img = document.createElement('img');
  img.src = URL.createObjectURL(blob);
  img.style.maxWidth = 'none';
  img.style.maxHeight = 'none';
  img.style.objectFit = 'contain';
  img.style.transformOrigin = 'center center';
  img.style.transition = 'transform 0.1s';
  img.style.touchAction = 'none';

  wrapper.appendChild(img);
  main.innerHTML = '';
  main.appendChild(wrapper);

  imageElement = img;
  imageScale = 1;
  panOffsetX = 0;
  panOffsetY = 0;

  if (footer) footer.style.display = 'none';

  resetAutoHideTimer();
}

// =========================================================================
// Fallback (Office docs, text, etc.)
// =========================================================================

function renderFallback(blob) {
  const { main, footer } = viewerEls;
  if (!main) return;

  const textTypes = [
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/rtf', // RTF can be shown as plain text
    'application/vnd.oasis.opendocument.text', // fallback
  ];

  if (textTypes.some(type => blob.type.includes(type))) {
    // Render text directly with proper formatting
    blob.text().then(text => {
      const pre = document.createElement('pre');
      pre.textContent = text;
      pre.style.whiteSpace = 'pre-wrap';      // preserve line breaks
      pre.style.wordBreak = 'break-word';     // wrap long lines
      pre.style.margin = '0';
      pre.style.padding = '1rem';
      pre.style.fontFamily = 'var(--font-mono, monospace)';
      pre.style.fontSize = '0.95rem';
      pre.style.lineHeight = '1.5';
      pre.style.overflow = 'auto';
      pre.style.height = '100%';
      pre.style.boxSizing = 'border-box';
      main.innerHTML = '';
      main.appendChild(pre);
    });
    if (footer) footer.style.display = 'none';
    return;
  }

  const url = URL.createObjectURL(blob);
  const iframeTypes = [
    'application/vnd.openxmlformats-officedocument',
    'application/msword',
    'application/vnd.ms-powerpoint',
    'application/vnd.ms-excel',
  ];
  const canIframe = iframeTypes.some(type => blob.type.includes(type));

  if (canIframe) {
    const iframe = document.createElement('iframe');
    iframe.src = url;
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    main.innerHTML = '';
    main.appendChild(iframe);
    ui.showToast('Document opened in browser. For best experience, download and open locally.', 'info');
  } else {
    main.innerHTML = `<div class="unsupported">
      <p>Preview not available for this file type (${blob.type}).</p>
      <a href="${url}" download class="btn-primary">Download to view locally</a>
    </div>`;
  }
  if (footer) footer.style.display = 'none';
}

// =========================================================================
// Outline
// =========================================================================

function buildOutline() {
  const drawer = viewerEls.outlineDrawer;
  if (!drawer) return;
  drawer.innerHTML = '';
  if (!pdfOutline || pdfOutline.length === 0) {
    drawer.innerHTML = '<div class="outline-empty">No outline</div>';
    return;
  }
  renderOutlineItems(pdfOutline, drawer, 0);
}

function renderOutlineItems(items, parent, level) {
  const ul = document.createElement('ul');
  ul.className = 'outline-list';

  items.forEach(item => {
    const li = document.createElement('li');
    li.className = `outline-item level-${Math.min(level, 3)}`;

    const link = document.createElement('a');
    link.textContent = item.title || 'Untitled';
    link.href = '#';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToDest(item.dest);
      if (viewerEls.outlineDrawer && window.innerWidth < 768) {
        viewerEls.outlineDrawer.classList.remove('open');
      }
    });
    li.appendChild(link);

    if (item.items && item.items.length > 0) {
      renderOutlineItems(item.items, li, level + 1);
    }

    ul.appendChild(li);
  });

  parent.appendChild(ul);
}

async function navigateToDest(dest) {
  if (!pdfDoc || !dest) return;

  try {
    const pageIndex = await pdfDoc.getPageIndex(dest);
    const pageNum = pageIndex + 1;
    currentPage = pageNum;
    await renderCurrentLayout();
    if (viewMode === 'scroll') {
      const wrapper = document.querySelector(`.canvas-wrapper[data-page="${pageNum}"]`);
      wrapper?.scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) {
    console.error('Outline navigation error:', err);
  }
}

// =========================================================================
// Auto‑hide / Double‑tap
// =========================================================================

function showHeaderFooter() {
  const header = document.querySelector('.viewer-header');
  const footer = document.getElementById('viewer-footer');
  if (header) header.classList.remove('hidden');
  if (footer) footer.classList.remove('hidden');
  isHeaderVisible = true;
  resetAutoHideTimer();
}

function hideHeaderFooter() {
  const header = document.querySelector('.viewer-header');
  const footer = document.getElementById('viewer-footer');
  if (header) header.classList.add('hidden');
  if (footer) footer.classList.add('hidden');
  isHeaderVisible = false;
}

function resetAutoHideTimer() {
  if (autoHideTimer) clearTimeout(autoHideTimer);
  // Only start timer if not currently interacting with controls
  if (!isOverControls && isHeaderVisible) {
    autoHideTimer = setTimeout(() => {
      if (!isOverControls) {
        hideHeaderFooter();
      }
    }, AUTO_HIDE_DELAY);
  }
}

function handleDoubleTap(e) {
  const now = Date.now();
  if (now - lastTapTime < 300) {
    if (isHeaderVisible) {
      hideHeaderFooter();
    } else {
      showHeaderFooter();
    }
    lastTapTime = 0;
  } else {
    lastTapTime = now;
  }
}

// -------------------------------------------------------------------------
// Auto-hide interaction with header/footer
// -------------------------------------------------------------------------

function setupAutoHideListeners() {
  const header = document.querySelector('.viewer-header');
  const footer = document.getElementById('viewer-footer');
  if (!header && !footer) return;

  const onEnter = () => {
    isOverControls = true;
    if (autoHideTimer) {
      clearTimeout(autoHideTimer);
      autoHideTimer = null;
    }
  };

  const onLeave = () => {
    isOverControls = false;
    if (isHeaderVisible) resetAutoHideTimer();
  };

  // For each control, add mouseenter/mouseleave and focusin/focusout
  [header, footer].forEach(el => {
    if (!el) return;
    el.addEventListener('mouseenter', onEnter);
    el.addEventListener('mouseleave', onLeave);
    el.addEventListener('focusin', onEnter);
    el.addEventListener('focusout', (e) => {
      // Only leave if focus completely left the element
      if (!el.contains(e.relatedTarget)) onLeave();
    });
  });

  // Store removal functions in cleanupFunctions
  cleanupFunctions.push(() => {
    [header, footer].forEach(el => {
      if (!el) return;
      el.removeEventListener('mouseenter', onEnter);
      el.removeEventListener('mouseleave', onLeave);
      el.removeEventListener('focusin', onEnter);
      el.removeEventListener('focusout', onLeave);
    });
  });
}

function removeAutoHideListeners() {
  // The cleanup functions will handle removal; but we can also clear isOverControls
  isOverControls = false;
  if (autoHideTimer) {
    clearTimeout(autoHideTimer);
    autoHideTimer = null;
  }
}

// =========================================================================
// Panning (page mode and images)
// =========================================================================

function setupPanning(container) {
  const pointerDownHandler = (e) => {
    if (e.button !== 0) return;
    // Enable panning in page mode OR when an image is displayed
    if (viewMode !== 'page' && !imageElement) return;
    pointerDown = true;
    isPanning = false;
    lastPointerX = e.clientX;
    lastPointerY = e.clientY;
    container.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const pointerMoveHandler = (e) => {
    if (!pointerDown) return;
    const dx = e.clientX - lastPointerX;
    const dy = e.clientY - lastPointerY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      isPanning = true;
    }
    if (isPanning) {
      panOffsetX += dx;
      panOffsetY += dy;
      applyPanTransform();
      lastPointerX = e.clientX;
      lastPointerY = e.clientY;
    }
  };

  const pointerUpHandler = (e) => {
    pointerDown = false;
    isPanning = false;
    if (container.hasPointerCapture(e.pointerId)) {
      container.releasePointerCapture(e.pointerId);
    }
  };

  container.addEventListener('pointerdown', pointerDownHandler);
  container.addEventListener('pointermove', pointerMoveHandler);
  container.addEventListener('pointerup', pointerUpHandler);
  container.addEventListener('pointercancel', pointerUpHandler);

  cleanupFunctions.push(() => {
    container.removeEventListener('pointerdown', pointerDownHandler);
    container.removeEventListener('pointermove', pointerMoveHandler);
    container.removeEventListener('pointerup', pointerUpHandler);
    container.removeEventListener('pointercancel', pointerUpHandler);
  });
}

function applyPanTransform() {
  // For PDF page view, pan the .page-container
  const container = viewerEls.main?.querySelector('.page-container');
  if (container) {
    container.style.transform = `translate(${panOffsetX}px, ${panOffsetY}px)`;
    return;
  }

  // For images, pan the wrapper
  if (imageElement && imageElement.parentElement) {
    const wrapper = imageElement.parentElement;
    wrapper.style.transform = `translate(${panOffsetX}px, ${panOffsetY}px)`;
  }
}

// =========================================================================
// Pinch Zoom (PDF & Images)
// =========================================================================

function setupPinchZoom(container) {
  let initialDistance = 0;
  let initialScale = 1;

  const touchStartHandler = (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      initialDistance = Math.hypot(dx, dy);
      initialScale = imageElement ? imageScale : currentScale;
      e.preventDefault();
    }
  };

  const touchMoveHandler = (e) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const distance = Math.hypot(dx, dy);
      if (initialDistance > 0) {
        let scale = initialScale * (distance / initialDistance);
        scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

        if (imageElement) {
          imageScale = scale;
          imageElement.style.transform = `scale(${scale})`;
        } else {
          setZoom(scale);
        }
        e.preventDefault();
      }
    }
  };

  const touchEndHandler = () => {
    initialDistance = 0;
  };

  container.addEventListener('touchstart', touchStartHandler, { passive: false });
  container.addEventListener('touchmove', touchMoveHandler, { passive: false });
  container.addEventListener('touchend', touchEndHandler);

  cleanupFunctions.push(() => {
    container.removeEventListener('touchstart', touchStartHandler);
    container.removeEventListener('touchmove', touchMoveHandler);
    container.removeEventListener('touchend', touchEndHandler);
  });
}

// =========================================================================
// Controls & Event Wiring
// =========================================================================

function setupControls() {
  const els = viewerEls;
  if (!els.container) return;

  // ---------- View Mode Toggle ----------
  if (els.toggleViewBtn) {
    const updateToggleLabel = () => {
      els.toggleViewBtn.textContent = viewMode === 'scroll' ? '📄 Page View' : '📜 Scroll View';
    };
    updateToggleLabel();
    const toggleHandler = () => {
      viewMode = viewMode === 'scroll' ? 'page' : 'scroll';
      localStorage.setItem('viewer-viewMode', viewMode);
      renderCurrentLayout();
      updateToggleLabel();
    };
    els.toggleViewBtn.addEventListener('click', toggleHandler);
    cleanupFunctions.push(() => els.toggleViewBtn?.removeEventListener('click', toggleHandler));
  }

  // ---------- Page Navigation ----------
  if (els.prevBtn) {
    const handler = () => { if (currentPage > 1) { currentPage--; renderCurrentLayout(); } };
    els.prevBtn.addEventListener('click', handler);
    cleanupFunctions.push(() => els.prevBtn?.removeEventListener('click', handler));
  }
  if (els.nextBtn) {
    const handler = () => { if (currentPage < totalPages) { currentPage++; renderCurrentLayout(); } };
    els.nextBtn.addEventListener('click', handler);
    cleanupFunctions.push(() => els.nextBtn?.removeEventListener('click', handler));
  }

  // ---------- Page Jump via Input ----------
  if (els.pageInput) {
    const jumpHandler = () => {
      let page = parseInt(els.pageInput.value, 10);
      if (isNaN(page)) return;
      page = Math.max(1, Math.min(totalPages, page));
      els.pageInput.value = page;

      if (viewMode === 'page') {
        if (page !== currentPage) {
          currentPage = page;
          renderCurrentLayout();
        }
      } else {
        const wrapper = document.querySelector(`.canvas-wrapper[data-page="${page}"]`);
        if (wrapper) {
          if (!wrapper.querySelector('canvas')) {
            lazyRenderPage(page, wrapper);
          }
          wrapper.scrollIntoView({ behavior: 'smooth' });
          setTimeout(() => {
            currentPage = page;
            updatePageNumberDisplay();
          }, 300);
        }
      }
    };
    els.pageInput.addEventListener('change', jumpHandler);
    els.pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        jumpHandler();
      }
    });
    cleanupFunctions.push(() => {
      els.pageInput?.removeEventListener('change', jumpHandler);
      els.pageInput?.removeEventListener('keydown', jumpHandler);
    });
  }

  // ---------- Zoom ----------
  if (els.zoomIn) {
    const handler = () => {
      if (imageElement) {
        imageScale = Math.min(MAX_ZOOM, imageScale + ZOOM_STEP);
        imageElement.style.transform = `scale(${imageScale})`;
      } else {
        setZoom(currentScale + ZOOM_STEP);
      }
    };
    els.zoomIn.addEventListener('click', handler);
    cleanupFunctions.push(() => els.zoomIn?.removeEventListener('click', handler));
  }
  if (els.zoomOut) {
    const handler = () => {
      if (imageElement) {
        imageScale = Math.max(MIN_ZOOM, imageScale - ZOOM_STEP);
        imageElement.style.transform = `scale(${imageScale})`;
      } else {
        setZoom(currentScale - ZOOM_STEP);
      }
    };
    els.zoomOut.addEventListener('click', handler);
    cleanupFunctions.push(() => els.zoomOut?.removeEventListener('click', handler));
  }
  if (els.zoomFit) {
    const handler = () => {
      if (imageElement) {
        const mainRect = viewerEls.main.getBoundingClientRect();
        const imgRect = imageElement.getBoundingClientRect();
        const fitScale = (mainRect.width - 20) / imgRect.width;
        imageScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fitScale));
        imageElement.style.transform = `scale(${imageScale})`;
      } else {
        zoomToFit();
      }
    };
    els.zoomFit.addEventListener('click', handler);
    cleanupFunctions.push(() => els.zoomFit?.removeEventListener('click', handler));
  }
  if (els.zoomReset) {
    const handler = () => {
      if (imageElement) {
        imageScale = 1;
        imageElement.style.transform = 'scale(1)';
      } else {
        setZoom(1.0);
      }
    };
    els.zoomReset.addEventListener('click', handler);
    cleanupFunctions.push(() => els.zoomReset?.removeEventListener('click', handler));
  }

  // Wheel zoom (Ctrl+Wheel)
  const wheelHandler = (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = -Math.sign(e.deltaY) * ZOOM_STEP;
      if (imageElement) {
        imageScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, imageScale + delta));
        imageElement.style.transform = `scale(${imageScale})`;
      } else {
        setZoom(currentScale + delta);
      }
    }
  };
  els.main?.addEventListener('wheel', wheelHandler, { passive: false });
  cleanupFunctions.push(() => els.main?.removeEventListener('wheel', wheelHandler));

  // ---------- Search ----------
  if (els.searchBtn) {
    const handler = () => {
      if (els.searchBar) {
        els.searchBar.classList.toggle('active');
        if (els.searchBar.classList.contains('active')) {
          els.searchInput?.focus();
        } else {
          clearSearchHighlights();
        }
      }
    };
    els.searchBtn.addEventListener('click', handler);
    cleanupFunctions.push(() => els.searchBtn?.removeEventListener('click', handler));
  }
  if (els.searchClose) {
    const handler = () => {
      if (els.searchBar) els.searchBar.classList.remove('active');
      clearSearchHighlights();
    };
    els.searchClose.addEventListener('click', handler);
    cleanupFunctions.push(() => els.searchClose?.removeEventListener('click', handler));
  }
  if (els.searchInput) {
    els.searchInput.addEventListener('input', onSearchInput);
    cleanupFunctions.push(() => els.searchInput?.removeEventListener('input', onSearchInput));
    const keyHandler = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigateSearch(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        els.searchBar?.classList.remove('active');
        clearSearchHighlights();
      }
    };
    els.searchInput.addEventListener('keydown', keyHandler);
    cleanupFunctions.push(() => els.searchInput?.removeEventListener('keydown', keyHandler));
  }
  if (els.searchPrev) {
    const handler = () => navigateSearch(-1);
    els.searchPrev.addEventListener('click', handler);
    cleanupFunctions.push(() => els.searchPrev?.removeEventListener('click', handler));
  }
  if (els.searchNext) {
    const handler = () => navigateSearch(1);
    els.searchNext.addEventListener('click', handler);
    cleanupFunctions.push(() => els.searchNext?.removeEventListener('click', handler));
  }
  [els.searchCaseSensitive, els.searchWholeWord].forEach(el => {
    if (el) {
      const handler = performSearch;
      el.addEventListener('change', handler);
      cleanupFunctions.push(() => el.removeEventListener('change', handler));
    }
  });

  // ---------- Outline ----------
  if (els.outlineBtn) {
    const handler = () => els.outlineDrawer?.classList.toggle('open');
    els.outlineBtn.addEventListener('click', handler);
    cleanupFunctions.push(() => els.outlineBtn?.removeEventListener('click', handler));
  }

  const outsideOutlineHandler = (e) => {
    if (els.outlineDrawer && !e.target.closest('.outline-drawer')) {
      els.outlineDrawer.classList.remove('open');
    }
  };
  document.addEventListener('click', outsideOutlineHandler);
  cleanupFunctions.push(() => document.removeEventListener('click', outsideOutlineHandler));

  // ---------- Open Local File ----------
  if (els.openLocalBtn && els.fileInput) {
    const handler = () => els.fileInput.click();
    els.openLocalBtn.addEventListener('click', handler);
    cleanupFunctions.push(() => els.openLocalBtn?.removeEventListener('click', handler));

    const fileHandler = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      isLocalFile = true;
      const fileType = file.name.split('.').pop();
      await renderDocument(file, fileType, file.name);
      els.fileInput.value = '';
    };
    els.fileInput.addEventListener('change', fileHandler);
    cleanupFunctions.push(() => els.fileInput?.removeEventListener('change', fileHandler));
  }

  // ---------- Drag & Drop ----------
  const dropHandler = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    isLocalFile = true;
    const fileType = file.name.split('.').pop();
    renderDocument(file, fileType, file.name);
  };
  const dragOverHandler = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  document.addEventListener('drop', dropHandler);
  document.addEventListener('dragover', dragOverHandler);
  cleanupFunctions.push(
    () => document.removeEventListener('drop', dropHandler),
    () => document.removeEventListener('dragover', dragOverHandler)
  );

  // ---------- Touch swipe (page mode) ----------
  let touchStartX = 0;
  const touchStart = (e) => {
    if (viewMode !== 'page') return;
    touchStartX = e.touches[0].clientX;
  };
  const touchEnd = (e) => {
    if (viewMode !== 'page') return;
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) {
      if (diff > 0 && currentPage < totalPages) { currentPage++; renderCurrentLayout(); }
      else if (diff < 0 && currentPage > 1) { currentPage--; renderCurrentLayout(); }
    }
  };
  if (els.main) {
    els.main.addEventListener('touchstart', touchStart, { passive: true });
    els.main.addEventListener('touchend', touchEnd, { passive: true });
    cleanupFunctions.push(
      () => els.main?.removeEventListener('touchstart', touchStart),
      () => els.main?.removeEventListener('touchend', touchEnd)
    );
  }

  // ---------- Fullscreen ----------
  if (els.fullscreenBtn) {
    const handler = toggleFullscreen;
    els.fullscreenBtn.addEventListener('click', handler);
    cleanupFunctions.push(() => els.fullscreenBtn?.removeEventListener('click', handler));
  }

  // ---------- Back ----------
  if (els.backBtn) {
    const handler = () => {
      if (typeof window.closeViewer === 'function') {
        window.closeViewer();
      } else {
        if (window.history.length > 1) {
          window.history.back();
        } else {
          router.navigateTo('subjects.html');
        }
      }
    };
    els.backBtn.addEventListener('click', handler);
    cleanupFunctions.push(() => els.backBtn?.removeEventListener('click', handler));
  }

  // ---------- Double‑tap toggle ----------
  if (els.main) {
    els.main.addEventListener('click', handleDoubleTap);
    cleanupFunctions.push(() => els.main?.removeEventListener('click', handleDoubleTap));
  }

  // ---------- Panning ----------
  if (els.main) {
    setupPanning(els.main);
  }

  // ---------- Pinch Zoom ----------
  if (els.main) {
    setupPinchZoom(els.main);
  }

  // ---------- Keyboard shortcuts ----------
  const keyShortcutHandler = (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); if (viewMode === 'page') { if (currentPage > 1) { currentPage--; renderCurrentLayout(); } } break;
      case 'ArrowRight': e.preventDefault(); if (viewMode === 'page') { if (currentPage < totalPages) { currentPage++; renderCurrentLayout(); } } break;
      case '+': case '=': e.preventDefault(); if (imageElement) { imageScale = Math.min(MAX_ZOOM, imageScale + ZOOM_STEP); imageElement.style.transform = `scale(${imageScale})`; } else setZoom(currentScale + ZOOM_STEP); break;
      case '-': e.preventDefault(); if (imageElement) { imageScale = Math.max(MIN_ZOOM, imageScale - ZOOM_STEP); imageElement.style.transform = `scale(${imageScale})`; } else setZoom(currentScale - ZOOM_STEP); break;
      case '0': e.preventDefault(); if (imageElement) { imageScale = 1; imageElement.style.transform = 'scale(1)'; } else setZoom(1.0); break;
      case 'f': if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleFullscreen(); } break;
      default: break;
    }
  };
  document.addEventListener('keydown', keyShortcutHandler);
  cleanupFunctions.push(() => document.removeEventListener('keydown', keyShortcutHandler));
}

// =========================================================================
// Zoom helpers
// =========================================================================

function setZoom(scale) {
  currentScale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  updateZoomDisplay();

  if (zoomRenderTimer) clearTimeout(zoomRenderTimer);
  zoomRenderTimer = setTimeout(() => {
    zoomRenderTimer = null;
    renderCurrentLayout().then(() => {
      if (searchMatches.length) highlightCurrentMatch();
    });
  }, 150);
}

function zoomToFit() {
  if (!viewerEls.main) return;
  const containerWidth = viewerEls.main.clientWidth - 40;
  if (pdfDoc) {
    pdfDoc.getPage(1).then(page => {
      const origViewport = page.getViewport({ scale: 1 });
      const fitScale = containerWidth / origViewport.width;
      setZoom(fitScale * 0.95);
    });
  }
}

function updateZoomDisplay() {
  if (viewerEls.zoomLevel) {
    viewerEls.zoomLevel.textContent = Math.round(currentScale * 100) + '%';
  }
}

function updateNavButtons() {
  if (!viewerEls.prevBtn || !viewerEls.nextBtn) return;
  if (viewMode === 'scroll' || !pdfDoc) {
    viewerEls.prevBtn.disabled = true;
    viewerEls.nextBtn.disabled = true;
  } else {
    viewerEls.prevBtn.disabled = currentPage <= 1;
    viewerEls.nextBtn.disabled = currentPage >= totalPages;
  }
  if (viewerEls.pageInput) {
    viewerEls.pageInput.min = 1;
    viewerEls.pageInput.max = totalPages;
  }
}

// =========================================================================
// Fullscreen
// =========================================================================

function toggleFullscreen() {
  const container = viewerEls.container || document.querySelector('.viewer-container') || document.documentElement;
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

// =========================================================================
// Device Pixel Ratio change handler
// =========================================================================

function setupDPRListener() {
  if (dprListener) return;
  let lastDPR = window.devicePixelRatio || 1;

  dprListener = () => {
    const currentDPR = window.devicePixelRatio || 1;
    if (currentDPR !== lastDPR) {
      lastDPR = currentDPR;
      // Re-render visible pages to adjust to new DPR
      if (viewMode === 'scroll') {
        updateVisiblePages();
      } else {
        renderSinglePage(currentPage);
      }
    }
  };
  window.addEventListener('resize', dprListener);
  cleanupFunctions.push(() => {
    window.removeEventListener('resize', dprListener);
    dprListener = null;
  });
}

// =========================================================================
// Utility: escape HTML
// =========================================================================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =========================================================================
// Helper: sync wrapper dimensions using cached base sizes
// =========================================================================

function syncWrapperDimensions() {
  const wrappers = viewerEls.main?.querySelectorAll('.canvas-wrapper');
  wrappers?.forEach(wrapper => {
    const pageNum = parseInt(wrapper.dataset.page, 10);
    const base = pageViewportCache.get(pageNum);
    if (!base) return;

    const w = base.width * currentScale;
    const h = base.height * currentScale;

    wrapper.style.width = `${w}px`;
    wrapper.style.height = `${h}px`;
    wrapper.style.minHeight = `${h}px`;

    const canvas = wrapper.querySelector('canvas.pdf-canvas');
    if (canvas && wrapper.dataset.renderedScale !== String(currentScale)) {
      canvas.remove(); // remove stale old-zoom canvas
      delete wrapper.dataset.renderedScale;
    }
  });
}

// =========================================================================
// Helper: preload page sizes to prevent placeholder jumps
// =========================================================================

let pageSizePreloadStarted = false;

function preloadPageSizes() {
  if (pageSizePreloadStarted || !pdfDoc) return;
  pageSizePreloadStarted = true;

  const queue = Array.from({ length: totalPages }, (_, i) => i + 1);
  const concurrency = 3;

  const worker = async () => {
    while (queue.length && pdfDoc) {
      const pageNum = queue.shift();
      try {
        const page = await pdfDoc.getPage(pageNum);
        const base = page.getViewport({ scale: 1 });

        if (!pageViewportCache.has(pageNum)) {
          pageViewportCache.set(pageNum, {
            width: base.width,
            height: base.height,
          });
        }

        const wrapper = viewerEls.main?.querySelector(
          `.canvas-wrapper[data-page="${pageNum}"]`
        );

        if (wrapper && !wrapper.querySelector('canvas.pdf-canvas')) {
          wrapper.style.width = `${base.width * currentScale}px`;
          wrapper.style.height = `${base.height * currentScale}px`;
          wrapper.style.minHeight = `${base.height * currentScale}px`;
        }
      } catch (err) {
        console.warn('Page size preload failed', pageNum, err);
      }
    }
  };

  Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, worker)
  ).catch(() => {});
}

// =========================================================================
// PUBLIC API
// =========================================================================

export async function loadDocumentInPage(docId) {
  refreshElements();
  injectViewerStyles();
  currentDocId = docId;
  isLocalFile = false;

  const { main, loading } = viewerEls;
  if (!main) return;

  if (loading) loading.style.display = 'block';
  if (main) main.innerHTML = '';

  try {
    const hasActive = await subscription.hasActiveSubscription();
    if (!hasActive) {
      ui.showToast('Subscription required', 'warning');
      router.navigateTo('subscription.html');
      return;
    }

    let blob = await content.getLocalFile(docId);
    if (!blob) {
      ui.showLoading('Fetching document...');
      const success = await content.downloadResource(docId);
      ui.hideLoading();
      if (!success) throw new Error('Download failed');
      blob = await content.getLocalFile(docId);
      if (!blob) throw new Error('File not found after download');
    }

    await renderDocument(blob, null, 'Document');
  } catch (err) {
    console.error('[Viewer] Error:', err);
    if (main) {
      main.innerHTML = `<div class="error-container"><p>Failed to load document: ${escapeHtml(err.message)}</p>
        <button class="btn-secondary" onclick="window.history.back()">Go Back</button></div>`;
    }
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

export async function openDocument(docId, title = 'Document', fileType = null) {
  injectViewerStyles();
  if (typeof window.showViewer === 'function') {
    window.showViewer(docId, title, fileType);
  } else {
    router.navigateTo(`viewer.html?docId=${docId}`);
  }
}

export function showEmbeddedViewer(docId, title = 'Document', fileType = null) {
  refreshElements();
  injectViewerStyles();
  currentDocId = docId;
  isLocalFile = false;

  const { container, main, title: titleEl, loading } = viewerEls;
  if (!main) return;

  if (container) {
    container.style.display = 'flex';
    container.style.position = 'fixed';
    container.style.top = '0';
    container.style.left = '0';
    container.style.width = '100%';
    container.style.height = '100%';
    container.style.zIndex = '2000';
    container.style.background = 'var(--bg-primary)';
  }
  const appContainer = document.getElementById('app');
  if (appContainer) appContainer.style.display = 'none';

  if (loading) loading.style.display = 'block';
  if (titleEl) titleEl.textContent = title || 'Document';
  if (main) main.innerHTML = '';

  loadDocumentIntoEmbedded(docId, fileType);
}

async function loadDocumentIntoEmbedded(docId, fileType) {
  const { main, loading } = viewerEls;
  try {
    let blob = await content.getLocalFile(docId);
    if (!blob) {
      ui.showLoading('Downloading document...');
      const success = await content.downloadResource(docId);
      ui.hideLoading();
      if (!success) throw new Error('Download failed');
      blob = await content.getLocalFile(docId);
      if (!blob) throw new Error('File not found after download');
    }
    await renderDocument(blob, fileType);
  } catch (err) {
    console.error('[Embedded Viewer] Error:', err);
    if (main) main.innerHTML = `<div class="error-container"><p>${escapeHtml(err.message)}</p></div>`;
  } finally {
    if (loading) loading.style.display = 'none';
  }
}

export function closeEmbeddedViewer() {
  destroyCurrentDocument();

  const container = viewerEls.container;
  if (container) container.style.display = 'none';
  const appContainer = document.getElementById('app');
  if (appContainer) appContainer.style.display = 'block';

  currentDocId = null;
  isLocalFile = false;
}

// Legacy alias
export async function openDocumentModal(docId) {
  return openDocument(docId);
}