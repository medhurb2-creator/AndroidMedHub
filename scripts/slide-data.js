// scripts/slide-data.js
//
// Downloads data.zip from the public-assets Convex pipeline, unzips it
// with JSZip (npm dependency), seeds db.js with the questions / images,
// discards the zip blob (never persisted — GC on return), and re-checks
// for updates once per week.
//
// Zip layout expected:
//   subject.json                          ← { SUBJECT_META, TOPICS }
//   questions/{subject}/{topic}.json
//   images/{subject}/{filename.(avif|png|jpg|jpeg|webp)}
//
// Requires: npm install jszip

import JSZip from 'jszip';

import * as db from './db.js';
import * as utils from './utils.js';
import { convexHttpClient } from './convex-client.js';

const ASSET_KEY       = 'data';
const SUBJECT_JSON    = 'subject.json';
const VERSION_KEY     = 'slideDataVersion';
const LAST_CHECK_KEY  = 'slideDataLastCheck';
const MANIFEST_KEY    = 'slideDataManifest';
const IMAGE_IDS_KEY   = 'slideDataImageIds';
const WEEKLY_MS       = 2 * 24 * 60 * 60 * 1000;
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes hard cap

// ---------------------------------------------------------------- status
let _status = {
  downloaded:      false,
  version:         0,
  updateAvailable: false,
  downloading:     false,
  progress:        0,
  extracting:      false,
  extractProgress: 0,
  checking:        false,
  lastChecked:     0,
  error:           null,
};

const _listeners = new Set();
function _emit() {
  const snap = { ..._status };
  for (const fn of _listeners) { try { fn(snap); } catch {} }
}

export function subscribe(fn) {
  _listeners.add(fn);
  try { fn({ ..._status }); } catch {}
  return () => _listeners.delete(fn);
}

export function getStatus() { return { ..._status }; }

// ---------------------------------------------------------------- helpers
function _getLocalVersion() {
  const v = parseInt(localStorage.getItem(VERSION_KEY) || '0', 10);
  return Number.isFinite(v) ? v : 0;
}
function _setLocalVersion(v) { localStorage.setItem(VERSION_KEY, String(v || 0)); }

// Wraps a promise with a hard timeout so a stuck DB call fails loudly
// instead of hanging the whole extraction.
async function _withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function _mimeForExt(ext) {
  switch ((ext || '').toLowerCase()) {
    case 'png':  return 'image/png';
    case 'webp': return 'image/webp';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'avif': return 'image/avif';
    case 'gif':  return 'image/gif';
    case 'svg':  return 'image/svg+xml';
    default:     return 'application/octet-stream';
  }
}

// ---------------------------------------------------------------- _isDownloaded (bulletproof)
//
// Can NEVER throw or hang. Every DB call is wrapped in try/catch, and
// the whole function is wrapped in try/catch as a belt-and-braces
// fallback. This is critical: `init()` awaits this before emitting
// status, so if it threw or hung, the Subjects card would stay on its
// initial "Checking…" HTML text forever.
async function _isDownloaded() {
  try {
    const m = utils.getLocalStorage(MANIFEST_KEY, null);
    if (!m || !m.TOPICS) {
      console.log('[SlideData] _isDownloaded: no manifest in localStorage');
      return false;
    }
    for (const [subj, topics] of Object.entries(m.TOPICS)) {
      if (!Array.isArray(topics)) continue;
      for (const t of topics) {
        if (!t || !t.id) continue;
        try {
          const cached = await db.getQuestions({ subject: subj, topic: t.id });
          if (cached && cached.length) {
            console.log(`[SlideData] _isDownloaded: ${cached.length} q for ${subj}/${t.id}`);
            return true;
          }
        } catch (e) {
          console.warn(`[SlideData] _isDownloaded: getQuestions failed for ${subj}/${t.id}`, e);
        }
      }
    }
    console.log('[SlideData] _isDownloaded: manifest present, no matching questions in DB');
    return false;
  } catch (e) {
    console.warn('[SlideData] _isDownloaded crashed:', e);
    return false;
  }
}

// ---------------------------------------------------------------- topic id canonicalisation
function _canonicalTopicId(subject, fileTopic, declaredTopicsBySubject) {
  const declared = declaredTopicsBySubject[subject] || [];
  if (!declared.length) return fileTopic;
  if (declared.includes(fileTopic)) return fileTopic;
  if (declared.length === 1) return declared[0];
  const match =
    declared.find(id => id.endsWith('-' + fileTopic)) ||
    declared.find(id => id.endsWith(fileTopic)) ||
    declared.find(id => id.includes(fileTopic));
  if (match) {
    console.log(`[SlideData] topic "${fileTopic}" → "${match}" for subject "${subject}"`);
    return match;
  }
  console.warn(`[SlideData] no manifest topic matches filename "${fileTopic}" under "${subject}" — storing under file name`);
  return fileTopic;
}

// ---------------------------------------------------------------- questions cache
async function _invalidateQuestionsManifest() {
  try {
    const q = await import('./questions.js');
    q.invalidateSlideManifestCache?.();
  } catch { /* questions.js may not be loaded yet */ }
}

// ---------------------------------------------------------------- remote lookups
async function _fetchRemoteInfo() {
  try {
    return await _withTimeout(
      convexHttpClient.query('publicAssets/queries:getAsset', { key: ASSET_KEY }),
      15000,
      'getAsset'
    ) || null;
  } catch (e) {
    console.warn('[SlideData] getAsset failed', e);
    return null;
  }
}

async function _fetchPresignedUrl(info) {
  const r2Key = `public-assets/${ASSET_KEY}.${info.fileType || 'zip'}`;
  return await _withTimeout(
    convexHttpClient.action('publicAssets/actions:getDownloadUrl', { r2Key }),
    15000,
    'getDownloadUrl'
  );
}

// ---------------------------------------------------------------- init (bulletproof)
let _initialized = false;
let _weeklyTimer = null;

export async function init() {
  // Always emit — even if _isDownloaded throws — so the card transitions
  // out of its initial "Checking…" HTML state.
  if (_initialized) {
    try { _status.downloaded = await _isDownloaded(); }
    catch { _status.downloaded = false; }
    _emit();
    return;
  }
  _initialized = true;

  try {
    _status.downloaded = await _isDownloaded();
    _status.version    = _getLocalVersion();
    _status.lastChecked = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10);
  } catch (e) {
    console.warn('[SlideData] init precheck failed:', e);
    _status.downloaded = false;
  } finally {
    _emit();
  }

  checkForUpdates({ silent: true })
    .catch(() => {})
    .finally(_scheduleWeekly);
}

function _scheduleWeekly() {
  if (_weeklyTimer) clearTimeout(_weeklyTimer);
  const last = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10);
  const wait = Math.max(0, WEEKLY_MS - (Date.now() - last));
  _weeklyTimer = setTimeout(() => {
    checkForUpdates({ silent: true })
      .catch(() => {})
      .finally(_scheduleWeekly);
  }, wait);
}

// ---------------------------------------------------------------- update check
export async function checkForUpdates({ silent = false, force = false } = {}) {
  if (_status.checking) return _status;

  const last = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10);
  if (!force && Date.now() - last < WEEKLY_MS) return _status;

  _status.checking = true;
  _emit();

  try {
    const info = await _fetchRemoteInfo();
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    _status.lastChecked = Date.now();

    if (info) {
      const remoteVer  = info.version || 0;
      const localVer   = _getLocalVersion();
      const downloaded = await _isDownloaded();
      _status.downloaded      = downloaded;
      _status.version         = localVer;
      _status.updateAvailable = downloaded && remoteVer > localVer;
    }
  } catch (e) {
    if (!silent) _status.error = e.message || String(e);
  } finally {
    _status.checking = false;
    _emit();
  }
  return _status;
}

// ---------------------------------------------------------------- download
export async function downloadSlideData() {
  if (_status.downloading) return { ok: false, error: 'busy' };

  _status.downloading     = true;
  _status.extracting      = false;
  _status.progress        = 0;
  _status.extractProgress = 0;
  _status.error           = null;
  _emit();

  try {
    const info = await _fetchRemoteInfo();
    if (!info) throw new Error('Slide data not published on server');

    const url = await _fetchPresignedUrl(info);
    if (!url) throw new Error('Could not obtain download URL');

    const zipBlob = await _downloadWithProgress(url, (loaded, total) => {
      _status.progress = total ? Math.round((loaded / total) * 100) : 0;
      _emit();
    });

    _status.extracting = true;
    _emit();

    await _withTimeout(
      _extractZip(zipBlob, (done, total) => {
        _status.extractProgress = total ? Math.round((done / total) * 100) : 0;
        _emit();
      }),
      EXTRACT_TIMEOUT_MS,
      'extraction'
    );

    // Verify the extraction actually landed questions in the DB before
    // declaring success. Catches the "silent save failure" case where
    // _extractZip returns without throwing but nothing was written.
    const ok = await _isDownloaded();
    if (!ok) {
      throw new Error(
        'Extraction completed but no questions found in DB. ' +
        'Check the browser console for [SlideData] or [DB] warnings above.'
      );
    }

    await _invalidateQuestionsManifest();

    _setLocalVersion(info.version || 0);
    _status.downloaded      = true;
    _status.version         = info.version || 0;
    _status.updateAvailable = false;
    _status.lastChecked     = Date.now();
    localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    _emit();

    return { ok: true };
  } catch (e) {
    console.error('[SlideData] download failed', e);
    _status.error = e.message || String(e);
    return { ok: false, error: _status.error };
  } finally {
    _status.downloading = false;
    _status.extracting  = false;
    _emit();
  }
}

async function _downloadWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);

  const total = parseInt(res.headers.get('content-length') || '0', 10);
  if (!res.body || !total) return await res.blob();

  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(loaded, total);
  }
  return new Blob(chunks, { type: 'application/zip' });
}

// ---------------------------------------------------------------- extract
//
// Progress semantics fixed: the bar now covers BOTH parse and save
// phases, so 100% means everything is on disk. Previously the bar hit
// 100% after parsing, then the save/cleanup steps ran silently — a
// hang or slow operation there looked like "stuck at 100%".
async function _extractZip(zipBlob, onProgress) {
  console.log('[SlideData] extract: loading zip');
  const zip = await JSZip.loadAsync(zipBlob);
  console.log('[SlideData] extract: zip loaded, entries:', Object.keys(zip.files).length);

  // --- subject.json -------------------------------------------------
  let subjectEntry = null;
  zip.forEach((path, entry) => {
    if (!entry.dir && (path === SUBJECT_JSON || path.endsWith('/' + SUBJECT_JSON))) {
      subjectEntry = { path, entry };
    }
  });
  if (!subjectEntry) throw new Error(`${SUBJECT_JSON} not found in zip`);
  console.log('[SlideData] extract: subject.json at', subjectEntry.path);

  const newManifest = JSON.parse(await subjectEntry.entry.async('string'));
  if (!newManifest.SUBJECT_META || !newManifest.TOPICS) {
    throw new Error(`Invalid ${SUBJECT_JSON}: missing SUBJECT_META or TOPICS`);
  }

  const declaredTopicsBySubject = {};
  for (const [subj, list] of Object.entries(newManifest.TOPICS || {})) {
    declaredTopicsBySubject[subj] = (list || []).map(t => t && t.id).filter(Boolean);
  }

  // --- enumerate ----------------------------------------------------
  const qEntries = [];
  const iEntries = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    if (/(^|\/)questions\//.test(path) && path.endsWith('.json')) qEntries.push({ path, entry });
    else if (/(^|\/)images\//.test(path))                         iEntries.push({ path, entry });
  });
  console.log(`[SlideData] extract: ${qEntries.length} question files, ${iEntries.length} images`);

  // --- parse into memory (half of the progress) --------------------
  const parseTotal = qEntries.length + iEntries.length;
  let parseDone = 0;

  const parsedQuestions = [];
  for (const { path, entry } of qEntries) {
    try {
      const data = JSON.parse(await entry.async('string'));
      const parts = path.split('/');
      if (parts.length < 3) continue;
      const subject   = parts[parts.length - 2];
      const fileTopic = parts[parts.length - 1].replace(/\.json$/i, '');
      const arr = Array.isArray(data) ? data : (data.questions || []);
      if (!Array.isArray(arr) || !arr.length) continue;
      const topic = _canonicalTopicId(subject, fileTopic, declaredTopicsBySubject);
      parsedQuestions.push({ subject, topic, questions: arr });
    } catch (e) {
      console.warn(`[SlideData] question parse failed: ${path}`, e);
    } finally {
      parseDone++;
      onProgress(parseDone, parseTotal + qEntries.length + iEntries.length);
    }
  }

  const parsedImages = [];
  for (const { path, entry } of iEntries) {
    try {
      const parts = path.split('/');
      if (parts.length < 3) continue;
      const filename = parts[parts.length - 1];
      const subject  = parts[parts.length - 2];
      const id = `slide-img:${subject}:${filename}`;
      const raw  = await entry.async('blob');
      const mime = _mimeForExt(filename.split('.').pop());
      const blob = raw.type ? raw : new Blob([raw], { type: mime });
      parsedImages.push({ id, blob });
    } catch (e) {
      console.warn(`[SlideData] image parse failed: ${path}`, e);
    } finally {
      parseDone++;
      onProgress(parseDone, parseTotal + qEntries.length + iEntries.length);
    }
  }

  // --- save questions (second half of the progress) ----------------
  const saveTotal = qEntries.length + iEntries.length;
  let saveDone = 0;

  console.log(`[SlideData] extract: saving ${parsedQuestions.length} question batches`);
  let totalSaved = 0;
  for (const { subject, topic, questions } of parsedQuestions) {
    try {
      await db.saveQuestions(questions.map(q => ({ ...q, subject, topic })));
      totalSaved += questions.length;
      console.log(`[SlideData] extract: saved ${questions.length} → ${subject}/${topic}`);
    } catch (e) {
      console.warn(`[SlideData] saveQuestions failed for ${subject}/${topic}`, e);
    } finally {
      saveDone++;
      onProgress(parseTotal + saveDone, parseTotal + saveTotal);
    }
  }

  if (qEntries.length === 0) {
    throw new Error('Zip contained no files under questions/. Check the folder structure.');
  }
  if (totalSaved === 0) {
    throw new Error(
      `No questions could be saved (parsed ${qEntries.length} file(s), 0 DB writes succeeded). ` +
      `Check that ${SUBJECT_JSON} TOPICS ids match the zip's question file names.`
    );
  }
  console.log(`[SlideData] extract: ${totalSaved} questions saved`);

  // --- save images --------------------------------------------------
  const newImageIds = [];
  for (const { id, blob } of parsedImages) {
    try {
      await db.saveFileBlob(id, blob);
      newImageIds.push(id);
    } catch (e) {
      console.warn(`[SlideData] saveFileBlob failed for ${id}`, e);
    } finally {
      saveDone++;
      onProgress(parseTotal + saveDone, parseTotal + saveTotal);
    }
  }
  console.log(`[SlideData] extract: ${newImageIds.length} images saved`);

  // --- delete topics in old manifest but not in new ----------------
  const oldManifest = utils.getLocalStorage(MANIFEST_KEY, null);
  if (oldManifest?.TOPICS) {
    for (const [subj, oldTopics] of Object.entries(oldManifest.TOPICS)) {
      const newTopicIds = new Set(
        ((newManifest.TOPICS && newManifest.TOPICS[subj]) || [])
          .map(t => t && t.id).filter(Boolean)
      );
      for (const t of oldTopics || []) {
        if (!t || !t.id) continue;
        if (newTopicIds.has(t.id)) continue;
        try { await db.deleteQuestionsBySubjectAndTopic(subj, t.id); }
        catch (e) { console.warn('[SlideData] delete failed', subj, t.id, e); }
      }
    }
  }

  // --- orphan cleanup under each manifest subject ------------------
  for (const subj of Object.keys(newManifest.TOPICS || {})) {
    const declared = new Set(declaredTopicsBySubject[subj] || []);
    try {
      const all = await db.getQuestions({ subject: subj });
      const orphans = new Set();
      all.forEach(q => { if (q.topic && !declared.has(q.topic)) orphans.add(q.topic); });
      for (const t of orphans) {
        try { await db.deleteQuestionsBySubjectAndTopic(subj, t); }
        catch (e) { console.warn('[SlideData] orphan delete failed', subj, t, e); }
      }
      if (orphans.size) {
        console.log(`[SlideData] extract: cleaned ${orphans.size} orphan topic(s) under "${subj}"`);
      }
    } catch (e) {
      console.warn(`[SlideData] orphan cleanup failed for "${subj}"`, e);
    }
  }

  // --- orphan image cleanup ----------------------------------------
  const oldIds = utils.getLocalStorage(IMAGE_IDS_KEY, []);
  const keep   = new Set(newImageIds);
  for (const id of oldIds) {
    if (!keep.has(id)) { try { await db.deleteFileBlob(id); } catch {} }
  }

  // --- commit manifest last ----------------------------------------
  utils.setLocalStorage(MANIFEST_KEY, newManifest);
  utils.setLocalStorage(IMAGE_IDS_KEY, newImageIds);

  console.log(
    `[SlideData] extract: done — ${totalSaved} questions, ${newImageIds.length} images, ` +
    `${Object.keys(newManifest.TOPICS).length} subject(s)`
  );
}

// ---------------------------------------------------------------- image API
export async function getSlideImage(subject, filename) {
  return db.getFileBlob(`slide-img:${subject}:${filename}`);
}

// ---------------------------------------------------------------- reset
export async function clearSlideData() {
  const m = utils.getLocalStorage(MANIFEST_KEY, null);
  if (m?.TOPICS) {
    for (const [subj, topics] of Object.entries(m.TOPICS)) {
      for (const t of topics || []) {
        try { await db.deleteQuestionsBySubjectAndTopic(subj, t.id); } catch {}
      }
    }
  }
  for (const id of utils.getLocalStorage(IMAGE_IDS_KEY, [])) {
    try { await db.deleteFileBlob(id); } catch {}
  }
  utils.removeLocalStorage(MANIFEST_KEY);
  utils.removeLocalStorage(IMAGE_IDS_KEY);
  localStorage.removeItem(VERSION_KEY);
  localStorage.removeItem(LAST_CHECK_KEY);

  await _invalidateQuestionsManifest();

  _status = { ..._status, downloaded: false, version: 0, updateAvailable: false, error: null };
  _emit();
}

// ---------------------------------------------------------------- diagnose
//
// Run in the console as: await import('/scripts/slide-data.js').then(m => m.diagnose())
// Prints everything you need to know about the current slide-data state.
export async function diagnose() {
  const manifest = utils.getLocalStorage(MANIFEST_KEY, null);
  const diag = {
    status: { ..._status },
    localVersion: _getLocalVersion(),
    lastChecked: localStorage.getItem(LAST_CHECK_KEY),
    manifestPresent: !!manifest,
    manifestSubjects: manifest ? Object.keys(manifest.SUBJECT_META || {}) : [],
    manifestTopics:   manifest ? Object.keys(manifest.TOPICS || {}) : [],
    imageIds: utils.getLocalStorage(IMAGE_IDS_KEY, []).length,
    dbCounts: {},
    dbTotal: 0,
  };
  try {
    const all = await db.getAllQuestions();
    diag.dbTotal = all.length;
    const byKey = {};
    all.forEach(q => {
      const k = `${q.subject}/${q.topic}`;
      byKey[k] = (byKey[k] || 0) + 1;
    });
    diag.dbCounts = byKey;
  } catch (e) {
    diag.dbError = e.message;
  }
  console.log('[SlideData] diagnose:', diag);
  return diag;
}