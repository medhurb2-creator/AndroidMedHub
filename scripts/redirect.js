// scripts/redirect.js
/**
 * Smart cross-page redirects with chained returns + state preservation.
 * ============================================================================
 *
 * A page that can't proceed calls navigateWithReturn(target, reason, meta).
 * That:
 *   1. Pushes the current URL onto a return stack (sessionStorage).
 *   2. Captures a snapshot of the page — form-field values, scroll
 *      position, focus, and (optionally) a page-specific state blob —
 *      keyed by the page's clean URL.
 *   3. Navigates to the target with ?returnTo=&redirect_reason= appended.
 *
 * When the target (or any downstream page) resolves the blocker, it calls
 * consumeAndReturn(). That pops the stack and navigates back. The page's
 * init() then calls consumeSnapshot(), which restores everything captured
 * above — the user resumes exactly where they left off.
 *
 * Both layers are needed:
 *   • UI snapshot (automatic) — form inputs, textareas, selects,
 *     contenteditable, scroll, focus. Covers the common case for free.
 *   • Page snapshot (opt-in) — in-memory state that never touched the DOM:
 *     selected topic IDs, exam config, wizard step, dragged item, etc.
 *     Pages register a state adapter or pass `meta.snapshot`.
 *
 * Chains are automatic. Each redirect pushes; each completion pops.
 */

import { navigateTo as routerNavigate } from './router.js';

const STACK_KEY      = 'medvix.redirectStack.v1';
const SNAPSHOT_KEY   = 'medvix.redirectSnapshots.v1';
const MAX_STACK      = 20;
const MAX_SNAPSHOTS  = 10;
const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes

// ── URL helpers ─────────────────────────────────────────────────────────

function currentUrlClean() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete('returnTo');
    u.searchParams.delete('redirect');
    u.searchParams.delete('redirect_reason');
    return u.pathname + (u.search || '') + (u.hash || '');
  } catch {
    return window.location.pathname + window.location.search + window.location.hash;
  }
}

function splitHash(url) {
  const i = url.indexOf('#');
  return i < 0 ? [url, ''] : [url.slice(0, i), url.slice(i)];
}

function appendReturnParams(target, returnTo, reason) {
  if (!returnTo && !reason) return target;
  const [pathAndQuery, hash] = splitHash(target);
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const parts = [];
  if (returnTo) parts.push('returnTo=' + encodeURIComponent(returnTo));
  if (reason)   parts.push('redirect_reason=' + encodeURIComponent(reason));
  return pathAndQuery + sep + parts.join('&') + hash;
}

// ── Return stack ────────────────────────────────────────────────────────

function readStack() {
  try {
    const raw = sessionStorage.getItem(STACK_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return arr.filter(e =>
      e && typeof e.url === 'string' && e.url &&
      (!e.at || now - e.at < STALE_AFTER_MS)
    );
  } catch { return []; }
}

function writeStack(stack) {
  try {
    if (!stack.length) sessionStorage.removeItem(STACK_KEY);
    else sessionStorage.setItem(
      STACK_KEY,
      JSON.stringify(stack.slice(-MAX_STACK))
    );
  } catch { /* quota / disabled */ }
}

export function getReturnStack() { return readStack(); }
export function peekReturn()     { const s = readStack(); return s.length ? s[s.length - 1] : null; }
export function hasReturn()      { return readStack().length > 0; }
export function clearReturns()   { try { sessionStorage.removeItem(STACK_KEY); } catch {} }

export function pushReturn(url, reason = null, meta = {}) {
  if (!url) return;
  const clean = String(url);
  const stack = readStack();
  const top = stack[stack.length - 1];
  if (top && top.url === clean) return;
  stack.push({ url: clean, reason, meta, at: Date.now() });
  writeStack(stack);
}

export function popReturn() {
  const stack = readStack();
  const entry = stack.pop() || null;
  writeStack(stack);
  return entry;
}

// ── Snapshot store ──────────────────────────────────────────────────────

function readSnapshotMap() {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return {};
    const now = Date.now();
    const out = {};
    for (const k of Object.keys(obj)) {
      const s = obj[k];
      if (s && s.at && now - s.at < STALE_AFTER_MS) out[k] = s;
    }
    return out;
  } catch { return {}; }
}

function writeSnapshotMap(map) {
  try {
    const keys = Object.keys(map);
    if (!keys.length) { sessionStorage.removeItem(SNAPSHOT_KEY); return; }
    if (keys.length > MAX_SNAPSHOTS) {
      keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
      for (const k of keys.slice(0, keys.length - MAX_SNAPSHOTS)) delete map[k];
    }
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(map));
  } catch (e) {
    console.warn('[Redirect] Snapshot write failed:', e);
  }
}

// ── Page state adapters ─────────────────────────────────────────────────
//
// A page that carries in-memory state registers an adapter once, at the
// top of init(). From then on, EVERY navigateWithReturn originating from
// that page automatically captures the adapter's state, and every
// consumeSnapshot() on that page automatically restores it.

const _adapters = new Map(); // pageKey -> { capture, restore }

export function registerStateAdapter(pageKey, adapter) {
  if (!pageKey || !adapter || typeof adapter !== 'object') return;
  _adapters.set(String(pageKey), adapter);
}

export function unregisterStateAdapter(pageKey) {
  _adapters.delete(String(pageKey));
}

function _adapterFor(key) {
  if (!key) return null;
  const cleanPath = String(key).replace(/^\//, '').split(/[?#]/)[0];
  return _adapters.get(key) || _adapters.get(cleanPath) || null;
}

// ── UI state capture / restore ──────────────────────────────────────────

const FIELD_SELECTOR = [
  'input:not([type="password"]):not([type="file"])',
  ':not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
  ', textarea, select, [contenteditable="true"]',
].join('');

function captureUIState() {
  const fields = {};

  let nodes;
  try { nodes = document.querySelectorAll(FIELD_SELECTOR); }
  catch { nodes = []; }

  nodes.forEach(el => {
    const key = el.id || el.name;
    if (!key) return;
    const entry = {};
    const tag = el.tagName;

    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      entry.kind = type === 'checkbox' || type === 'radio' ? 'check' : 'value';
      if (entry.kind === 'check') entry.checked = !!el.checked;
      else entry.value = el.value;
    } else if (tag === 'TEXTAREA') {
      entry.kind = 'value';
      entry.value = el.value;
    } else if (tag === 'SELECT') {
      if (el.multiple) {
        entry.kind = 'multi';
        entry.selected = Array.from(el.selectedOptions).map(o => o.value);
      } else {
        entry.kind = 'value';
        entry.value = el.value;
      }
    } else if (el.isContentEditable) {
      entry.kind = 'html';
      entry.html = el.innerHTML;
    } else {
      return;
    }
    fields[key] = entry;
  });

  const scrollRoots = {};
  document.querySelectorAll('[data-preserve-scroll]').forEach(el => {
    const key = el.id || el.getAttribute('data-preserve-scroll');
    if (key) scrollRoots[key] = el.scrollTop;
  });

  const focusedEl = document.activeElement;
  const focused = focusedEl && (focusedEl.id || focusedEl.name) || null;

  return {
    scrollY: window.scrollY || document.documentElement.scrollTop || 0,
    scrollRoots,
    fields,
    focused,
  };
}

function _findField(key) {
  let el = null;
  try { el = document.getElementById(key); } catch {}
  if (!el) {
    try { el = document.querySelector(`[name="${CSS.escape(key)}"]`); } catch {}
  }
  return el;
}

function restoreUIState(uiState) {
  if (!uiState || typeof uiState !== 'object') return 0;

  let count = 0;
  const fields = uiState.fields || {};
  for (const key of Object.keys(fields)) {
    const entry = fields[key];
    const el = _findField(key);
    if (!el) continue;
    try {
      if (entry.kind === 'check') {
        el.checked = !!entry.checked;
      } else if (entry.kind === 'value') {
        if (typeof entry.value === 'string') el.value = entry.value;
      } else if (entry.kind === 'multi') {
        const set = new Set(entry.selected || []);
        for (const o of el.options || []) o.selected = set.has(o.value);
      } else if (entry.kind === 'html') {
        el.innerHTML = entry.html || '';
      }
      count++;
    } catch (e) {
      console.warn('[Redirect] Field restore failed for', key, e);
    }
  }

  const scrollRoots = uiState.scrollRoots || {};
  for (const key of Object.keys(scrollRoots)) {
    const el = _findField(key) ||
               document.querySelector(`[data-preserve-scroll="${CSS.escape(key)}"]`);
    if (el) el.scrollTop = scrollRoots[key];
  }

  if (uiState.scrollY) {
    requestAnimationFrame(() => window.scrollTo(0, uiState.scrollY));
  }

  if (uiState.focused) {
    requestAnimationFrame(() => {
      const el = _findField(uiState.focused);
      if (el && typeof el.focus === 'function') {
        try { el.focus({ preventScroll: true }); } catch { el.focus(); }
      }
    });
  }

  return count;
}

// ── Public navigation API ───────────────────────────────────────────────

/**
 * Push the current page and navigate to `target`, capturing the current
 * page's state so it can be restored on return.
 *
 * @param {string} target
 * @param {string} [reason]
 * @param {object} [meta]
 *   meta.snapshot     — page-specific state blob to persist (overrides adapter)
 *   meta.snapshotKey  — custom key (defaults to current clean URL)
 *   meta.noSnapshot   — skip capture entirely
 */
export function navigateWithReturn(target, reason = null, meta = {}) {
  if (!target || typeof target !== 'string') return;

  const current         = currentUrlClean();
  const cleanTargetPath = target.replace(/^\//, '').split(/[?#]/)[0];
  const cleanCurrentPath = current.replace(/^\//, '').split(/[?#]/)[0];
  const shouldPush = cleanTargetPath && cleanTargetPath !== cleanCurrentPath;

  if (shouldPush) pushReturn(current, reason, meta);

  if (!meta.noSnapshot) {
    const key = meta.snapshotKey || current;

    let pageState = meta.snapshot;
    if (pageState === undefined) {
      const adapter = _adapterFor(key);
      if (adapter && typeof adapter.capture === 'function') {
        try { pageState = adapter.capture(); }
        catch (e) { console.warn('[Redirect] Adapter capture failed:', e); }
      }
    }

    let uiState = null;
    try { uiState = captureUIState(); }
    catch (e) { console.warn('[Redirect] UI capture failed:', e); }

    const snapshot = { v: 1, at: Date.now(), key, url: window.location.href, ui: uiState };
    if (pageState !== undefined) snapshot.page = pageState;

    const map = readSnapshotMap();
    map[key] = snapshot;
    writeSnapshotMap(map);
  }

  routerNavigate(appendReturnParams(target, current, reason));
}

/**
 * Pop the top return entry and navigate there. If the stack is empty,
 * fall back to the URL's returnTo, then to `fallback`.
 */
export function consumeAndReturn(fallback = 'subjects', opts = {}) {
  let entry = null;

  if (opts.clearAll) {
    const stack = readStack();
    entry = stack.length ? stack[stack.length - 1] : null;
    writeStack([]);
  } else {
    entry = popReturn();
  }

  if (entry && entry.url) { routerNavigate(entry.url); return entry; }

  try {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('returnTo') || params.get('redirect');
    if (fromUrl) {
      routerNavigate(fromUrl);
      return { url: fromUrl, reason: params.get('redirect_reason') };
    }
  } catch {}

  if (fallback) routerNavigate(fallback);
  return null;
}

// ── Snapshot read / consume ─────────────────────────────────────────────

export function peekSnapshot(key) {
  return readSnapshotMap()[key || currentUrlClean()] || null;
}

export function hasSnapshot(key) {
  return !!peekSnapshot(key);
}

/**
 * Consume the snapshot for the current page (or a supplied key).
 * Restores UI state and runs the adapter's restore hook. One-shot —
 * the snapshot is deleted regardless of what it contains.
 *
 * Call this at the end of init(). Pages that need finer control can
 * peekSnapshot() first, do setup, then consumeSnapshot().
 *
 * @param {string} [key]              defaults to current clean URL
 * @param {{ applyUI?: boolean, applyAdapter?: boolean }} [opts]
 * @returns {object|null}
 */
export function consumeSnapshot(key, { applyUI = true, applyAdapter = true } = {}) {
  const k = key || currentUrlClean();
  const map = readSnapshotMap();
  const snap = map[k];
  if (!snap) return null;
  delete map[k];
  writeSnapshotMap(map);

  let restoredFields = 0;
  if (applyUI && snap.ui) {
    try { restoredFields = restoreUIState(snap.ui); }
    catch (e) { console.warn('[Redirect] UI restore failed:', e); }
  }

  if (applyAdapter && snap.page !== undefined) {
    const adapter = _adapterFor(k);
    if (adapter && typeof adapter.restore === 'function') {
      try { adapter.restore(snap.page); }
      catch (e) { console.warn('[Redirect] Adapter restore failed:', e); }
    }
  }

  try {
    document.dispatchEvent(new CustomEvent('redirect:restored', {
      detail: { snapshot: snap, restoredFields }
    }));
  } catch {}

  return snap;
}

export function clearSnapshots() {
  try { sessionStorage.removeItem(SNAPSHOT_KEY); } catch {}
}

// ── Context readers ─────────────────────────────────────────────────────

export function readRedirectContext() {
  let returnTo = null, reason = null, source = 'none';
  try {
    const params = new URLSearchParams(window.location.search);
    returnTo = params.get('returnTo') || params.get('redirect') || null;
    reason   = params.get('redirect_reason') || null;
    if (returnTo || reason) source = 'url';
  } catch {}

  if (!returnTo) {
    const top = peekReturn();
    if (top) { returnTo = top.url; reason = reason || top.reason || null; source = 'stack'; }
  }

  return { returnTo, reason, source, hasContext: !!(returnTo || reason) };
}

export function stripRedirectParams() {
  try {
    const u = new URL(window.location.href);
    u.searchParams.delete('returnTo');
    u.searchParams.delete('redirect');
    u.searchParams.delete('redirect_reason');
    window.history.replaceState({}, '', u.pathname + (u.search || '') + (u.hash || ''));
  } catch {}
}

export default {
  navigateWithReturn, consumeAndReturn,
  pushReturn, popReturn, peekReturn, hasReturn,
  getReturnStack, clearReturns,
  registerStateAdapter, unregisterStateAdapter,
  peekSnapshot, hasSnapshot, consumeSnapshot, clearSnapshots,
  readRedirectContext, stripRedirectParams,
};