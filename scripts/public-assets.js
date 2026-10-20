// frontend-user/scripts/public-assets.js
import * as utils from './utils.js';
import * as db from './db.js';
import { convexHttpClient } from './convex-client.js';

const ASSET_KEYS = {
  USER_MANUAL: 'user-manual',
  RESOURCES_UPDATE: 'resources-update',
  TOPICS: 'topics',
};

const VERSION_STORAGE_KEY = 'publicAssetVersions';
const LAST_SYNC_KEY = 'publicAssetLastSync';
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

async function getAssetVersions() {
  try {
    const stored = await db.getPublicAssetVersions?.() || {};
    console.log('[PublicAssets] Loaded versions from IndexedDB:', stored);
    return stored;
  } catch {
    const stored = utils.getLocalStorage(VERSION_STORAGE_KEY, {});
    console.log('[PublicAssets] Loaded versions from localStorage:', stored);
    return stored;
  }
}

async function saveAssetVersions(versions) {
  try {
    await db.savePublicAssetVersions?.(versions);
    console.log('[PublicAssets] Saved versions to IndexedDB:', versions);
  } catch {}
  utils.setLocalStorage(VERSION_STORAGE_KEY, versions);
  console.log('[PublicAssets] Saved versions to localStorage:', versions);
}

async function fetchAsset(key) {
  console.log(`[PublicAssets] Fetching asset metadata for: ${key}`);
  try {
    const result = await convexHttpClient.query("publicAssets/queries:getAsset", { key });
    console.log(`[PublicAssets] Metadata for ${key}:`, result);
    return result;
  } catch (err) {
    console.warn(`[PublicAssets] Failed to fetch ${key}:`, err);
    return null;
  }
}

async function downloadAndStoreAsset(key, assetInfo) {
  console.log(`[PublicAssets] Downloading ${key} (v${assetInfo.version})...`);
  const r2Key = `public-assets/${key}.${assetInfo.fileType}`;
  console.log(`[PublicAssets] R2 key: ${r2Key}`);
  const urlResult = await convexHttpClient.action("publicAssets/actions:getDownloadUrl", { r2Key });
  console.log(`[PublicAssets] Presigned URL received:`, urlResult);
  if (!urlResult) return false;
  const response = await fetch(urlResult);
  if (!response.ok) {
    console.error(`[PublicAssets] Download failed: ${response.status} ${response.statusText}`);
    return false;
  }
  const blob = await response.blob();
  console.log(`[PublicAssets] Downloaded ${blob.size} bytes for ${key}`);
  try {
    await db.savePublicAsset?.(key, blob, assetInfo);
    console.log(`[PublicAssets] Saved ${key} to IndexedDB`);
  } catch (err) {
    console.warn(`[PublicAssets] IndexedDB save failed, falling back to localStorage:`, err);
    // For JSON files, store raw string to avoid base64 overhead
    if (assetInfo.fileType === 'json') {
      const text = await blob.text();
      localStorage.setItem(`publicAsset_${key}`, text);
      console.log(`[PublicAssets] Saved ${key} as JSON string to localStorage`);
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        localStorage.setItem(`publicAsset_${key}`, reader.result);
        console.log(`[PublicAssets] Saved ${key} as base64 to localStorage`);
      };
      reader.readAsDataURL(blob);
    }
  }
  return true;
}

// ============================================================
// In-memory JSON cache for public-asset payloads.
//
// `getTopicsJson()` and `getResourcesUpdateJson()` are called on
// hot paths — topics on every resource-browser navigation,
// resources-update on every app boot after the sync check. Each
// call would otherwise read the blob from IndexedDB, convert it to
// a string, and JSON.parse it. Three operations that are cheap
// individually but add up across a session.
//
// Design:
//   • A cache hit returns the parsed object synchronously.
//   • A cache miss performs the read+parse once and stores the
//     result. Parse failures are NOT cached — the next call retries,
//     so a transient disk hiccup does not pin the caller to a null.
//   • An in-flight promise makes concurrent cold-cache calls share
//     one underlying read. Two callers landing at the same tick
//     cannot both open the file.
//   • The cache is invalidated from `syncPublicAssets()` whenever a
//     new version of the corresponding asset is downloaded. Absent
//     a version bump, the parsed object stays warm for the session.
// ============================================================

let _topicsJsonCache        = null;
let _topicsJsonCached       = false;
let _topicsJsonInflight     = null;

let _resourcesUpdateCache   = null;
let _resourcesUpdateCached  = false;
let _resourcesUpdateInflight = null;

function _invalidateTopicsCache() {
  _topicsJsonCache    = null;
  _topicsJsonCached   = false;
  _topicsJsonInflight = null;
}

function _invalidateResourcesUpdateCache() {
  _resourcesUpdateCache    = null;
  _resourcesUpdateCached   = false;
  _resourcesUpdateInflight = null;
}

export async function syncPublicAssets() {
  console.log('[PublicAssets] Checking sync cooldown...');
  const lastSync = parseInt(localStorage.getItem(LAST_SYNC_KEY) || '0', 10);
  const now = Date.now();

  if (now - lastSync < COOLDOWN_MS) {
    console.log('[PublicAssets] Cooldown active (< 24 hours since last sync). Skipping sync.');
    return;
  }

  console.log('[PublicAssets] Syncing public assets...');
  const versions = await getAssetVersions();
  let updated = false;

  for (const key of Object.values(ASSET_KEYS)) {
    console.log(`[PublicAssets] Checking asset: ${key}`);
    const assetInfo = await fetchAsset(key);
    if (!assetInfo) {
      console.log(`[PublicAssets] No metadata for ${key}, skipping.`);
      continue;
    }
    const localVersion = versions[key] || 0;
    console.log(`[PublicAssets] ${key}: local version ${localVersion}, remote version ${assetInfo.version}`);
    if (assetInfo.version > localVersion || !(await getPublicAsset(key))) {
      console.log(`[PublicAssets] Updating ${key} (v${assetInfo.version})...`);
      const success = await downloadAndStoreAsset(key, assetInfo);
      if (success) {
        versions[key] = assetInfo.version;
        updated = true;
        // The parsed-JSON cache for this asset is now stale. Clear it
        // so the next getTopicsJson() / getResourcesUpdateJson() call
        // re-reads the fresh blob from storage.
        if (key === ASSET_KEYS.TOPICS) {
          _invalidateTopicsCache();
        }
        if (key === ASSET_KEYS.RESOURCES_UPDATE) {
          _invalidateResourcesUpdateCache();
        }
        console.log(`[PublicAssets] Successfully updated ${key} to version ${assetInfo.version}`);
      } else {
        console.warn(`[PublicAssets] Failed to update ${key}`);
      }
    } else {
      console.log(`[PublicAssets] ${key} is up to date (v${assetInfo.version})`);
    }
  }

  if (updated) {
    await saveAssetVersions(versions);
    console.log('[PublicAssets] Sync complete. Versions saved.');
  } else {
    console.log('[PublicAssets] All assets up to date. No changes.');
  }

  // Update the last sync timestamp in localStorage to reset the 24-hr window
  localStorage.setItem(LAST_SYNC_KEY, String(now));
  console.log('[PublicAssets] Cooldown timestamp updated.');
}

export async function getPublicAsset(key) {
  console.log(`[PublicAssets] Retrieving ${key} from storage...`);
  try {
    const stored = await db.getPublicAsset?.(key);
    if (stored) {
      console.log(`[PublicAssets] Retrieved ${key} from IndexedDB (${stored.size} bytes)`);
      return stored;
    }
  } catch (err) {
    console.warn(`[PublicAssets] IndexedDB retrieval failed for ${key}:`, err);
  }
  const storedStr = localStorage.getItem(`publicAsset_${key}`);
  if (storedStr) {
    console.log(`[PublicAssets] Retrieved ${key} from localStorage (${storedStr.length} chars)`);
    // If it's a data URL, convert to blob
    if (storedStr.startsWith('data:')) {
      const blob = await fetch(storedStr).then(r => r.blob());
      return blob;
    }
    // If it's plain JSON, convert to Blob
    try {
      const blob = new Blob([storedStr], { type: 'application/json' });
      return blob;
    } catch {
      return null;
    }
  }
  console.log(`[PublicAssets] ${key} not found in storage.`);
  return null;
}

// ============================================================
// resources-update.json accessor — cached.
//
// Returns the parsed JSON payload, or null when the asset has not
// been downloaded yet. Failed parses are not cached; a successful
// parse stays in memory until the sync script downloads a newer
// version.
// ============================================================
export async function getResourcesUpdateJson() {
  if (_resourcesUpdateCached) {
    console.log('[PublicAssets] resources-update.json: cache hit');
    return _resourcesUpdateCache;
  }
  if (_resourcesUpdateInflight) {
    return _resourcesUpdateInflight;
  }

  _resourcesUpdateInflight = (async () => {
    console.log('[PublicAssets] Getting resources-update.json...');
    const blob = await getPublicAsset(ASSET_KEYS.RESOURCES_UPDATE);
    if (!blob) {
      console.warn('[PublicAssets] No blob found for resources-update.json');
      return null;
    }
    const text = await blob.text();
    console.log(`[PublicAssets] resources-update.json content length: ${text.length}`);
    try {
      const data = JSON.parse(text);
      _resourcesUpdateCache  = data;
      _resourcesUpdateCached = true;
      console.log('[PublicAssets] Successfully parsed resources-update.json');
      return data;
    } catch (err) {
      console.error('[PublicAssets] Failed to parse resources-update.json:', err);
      return null;
    } finally {
      _resourcesUpdateInflight = null;
    }
  })();

  return _resourcesUpdateInflight;
}

// ============================================================
// topics.json accessor — cached.
//
// Returns the parsed JSON payload, or null when the asset has not
// been downloaded yet (e.g. on first boot before sync completes,
// or if the download failed). Failed parses are not cached; a
// successful parse stays in memory until the sync script downloads
// a newer version.
//
// This is the hot path on the resource browser — the module reads
// topics.json on every navigation to decide whether to show a topic
// grid. Before the cache, every navigation paid a disk read + blob
// conversion + JSON.parse. Now it is a synchronous lookup after the
// first successful parse in the session.
// ============================================================
export async function getTopicsJson() {
  if (_topicsJsonCached) {
    console.log('[PublicAssets] topics.json: cache hit');
    return _topicsJsonCache;
  }
  if (_topicsJsonInflight) {
    return _topicsJsonInflight;
  }

  _topicsJsonInflight = (async () => {
    console.log('[PublicAssets] Getting topics.json...');
    const blob = await getPublicAsset(ASSET_KEYS.TOPICS);
    if (!blob) {
      console.warn('[PublicAssets] No blob found for topics.json');
      return null;
    }
    const text = await blob.text();
    console.log(`[PublicAssets] topics.json content length: ${text.length}`);
    try {
      const data = JSON.parse(text);
      _topicsJsonCache  = data;
      _topicsJsonCached = true;
      console.log('[PublicAssets] Successfully parsed topics.json');
      return data;
    } catch (err) {
      console.error('[PublicAssets] Failed to parse topics.json:', err);
      return null;
    } finally {
      _topicsJsonInflight = null;
    }
  })();

  return _topicsJsonInflight;
}

export async function initPublicAssets() {
  console.log('[PublicAssets] Initializing...');
  await syncPublicAssets();
  // Optionally verify the JSON files are loadable
  const resourcesUpdate = await getResourcesUpdateJson();
  if (resourcesUpdate) {
    console.log('[PublicAssets] Initialization complete. resources-update.json loaded.');
  } else {
    console.warn('[PublicAssets] Initialization complete. resources-update.json not available.');
  }
  const topics = await getTopicsJson();
  if (topics) {
    console.log('[PublicAssets] Initialization complete. topics.json loaded.');
  } else {
    console.warn('[PublicAssets] Initialization complete. topics.json not available.');
  }
}