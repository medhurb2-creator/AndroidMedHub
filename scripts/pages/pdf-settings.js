// scripts/pages/pdf-settings.js
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as auth from '../auth.js';
import * as utils from '../utils.js';
import * as subscription from '../subscription.js';
import * as questions from '../questions.js';
import * as examEngine from '../exam-engine.js';

// --- PDF engine imports (v7.0) ---
import { exportDocument } from '../pdf-engine.js';

// Fallback – if the module system didn't deliver the function (cache issue),
// use the global window version attached by File 1.
const safeExportDocument =
  typeof exportDocument === 'function' ? exportDocument : window.exportDocument;

let $;
let config = null;
let hasActiveSub = false;
const MAX_QUESTIONS = 60;
const DAILY_LIMIT = 3;
const WEEKLY_LIMIT = 6;

// ==================== TOPICS ORDER (per subject) ====================
const TOPICS_BY_SUBJECT = {
  anatomy: [
    'introduction-anatomy', 'back', 'upper-limb', 'lower-limb',
    'thorax', 'abdomen', 'pelvis-perineum', 'head-neck',
    'neuroanatomy', 'cross-sectional-anatomy'
  ],
  physiology: [
    'introduction-homeostasis', 'cell-physiology', 'body-fluids-compartments',
    'cellular-transport', 'membrane-physiology', 'signal-transduction',
    'muscle-physiology', 'cardiovascular', 'respiratory', 'renal',
    'gastrointestinal', 'endocrine', 'reproductive', 'neurophysiology',
    'special-senses', 'integrative-physiology'
  ],
  biochemistry: [
    'biomolecules', 'amino-acids-proteins', 'carbohydrates', 'lipids',
    'nucleic-acids', 'enzymology', 'bioenergetics', 'metabolism-overview',
    'carbohydrate-metabolism', 'lipid-metabolism', 'protein-metabolism',
    'integration-metabolism', 'molecular-biology', 'clinical-biochemistry',
    'nutrition', 'acid-base-balance', 'biochemical-techniques'
  ],
  histology: [
    'introduction-histology', 'cell-structure', 'epithelial-tissue',
    'connective-tissue', 'cartilage-bone', 'adipose-tissue',
    'blood-hematopoiesis', 'muscle-tissue', 'nervous-tissue',
    'cardiovascular-system', 'lymphatic-system', 'respiratory-system',
    'digestive-system', 'endocrine-glands', 'urinary-system',
    'reproductive-system-male', 'reproductive-system-female', 'skin-integument'
  ],
  embryology: [
    'introduction-embryology', 'gametogenesis', 'fertilization',
    'cleavage-implantation', 'embryogenesis-week1-3', 'embryogenesis-week3-8',
    'fetal-development', 'placenta-membranes', 'birth-defects-teratology',
    'cardiovascular-development', 'nervous-system-development',
    'gastrointestinal-development', 'respiratory-development',
    'head-neck-development', 'urogenital-development', 'limb-development'
  ],
  pathology: [
    'introduction-pathology', 'cellular-injury', 'adaptations',
    'intracellular-accumulations', 'inflammation-acute', 'inflammation-chronic',
    'repair-regeneration', 'hemodynamic-disorders', 'thrombosis-embolism',
    'shock', 'genetic-disorders', 'immunopathology', 'amyloidosis',
    'neoplasia', 'infectious-diseases', 'environmental-nutritional',
    'cardiovascular-pathology', 'respiratory-pathology', 'gastrointestinal-pathology',
    'hepatobiliary-pathology', 'renal-pathology', 'endocrine-pathology',
    'reproductive-pathology-male', 'reproductive-pathology-female',
    'nervous-system-pathology', 'musculoskeletal-pathology'
  ],
  pharmacology: [
    'introduction-pharmacology', 'pharmacokinetics', 'pharmacodynamics',
    'drug-metabolism', 'drug-interactions', 'autonomic-nervous-system',
    'cholinergic-agents', 'adrenergic-agents', 'cardiovascular-drugs',
    'renal-drugs', 'respiratory-drugs', 'gastrointestinal-drugs',
    'cns-drugs', 'anesthetic-agents', 'analgesic-agents', 'endocrine-drugs',
    'chemotherapy', 'antimicrobial-drugs', 'antifungal-antiviral', 'toxicology'
  ],
  microbiology: [
    'introduction-microbiology', 'bacterial-structure', 'bacterial-physiology',
    'bacterial-genetics', 'sterilization-disinfection', 'bacteriology',
    'gram-positive-cocci', 'gram-positive-bacilli', 'gram-negative-cocci',
    'gram-negative-bacilli', 'anaerobic-bacteria', 'mycobacteria',
    'spirochetes', 'virology', 'mycology', 'parasitology', 'immunology',
    'antimicrobial-therapy', 'infection-control'
  ]
};

// ==================== ENCODING / DECODING EXAM CODE ====================
const BASE36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const SUBJECT_CODES = {
  'AN': 'anatomy',
  'PH': 'physiology',
  'BI': 'biochemistry',
  'HI': 'histology',
  'EM': 'embryology',
  'PA': 'pathology',
  'PM': 'pharmacology',
  'MI': 'microbiology'
};
const SUBJECT_FROM_CODE = Object.fromEntries(
  Object.entries(SUBJECT_CODES).map(([code, name]) => [name, code])
);

function encodeExamCode(subject, topicIds, seed, numQuestions) {
  const subjCode = SUBJECT_FROM_CODE[subject];
  if (!subjCode) throw new Error(`Unknown subject: ${subject}`);

  const topicList = TOPICS_BY_SUBJECT[subject];
  if (!topicList) throw new Error(`No topic list for subject: ${subject}`);
  let bitmask = 0;
  for (const tid of topicIds) {
    const idx = topicList.indexOf(tid);
    if (idx === -1) throw new Error(`Topic ${tid} not found in subject ${subject}`);
    bitmask |= (1 << idx);
  }
  const maskStr = BASE36[bitmask % 36] + BASE36[Math.floor(bitmask / 36)];

  let s = seed;
  let seedStr = '';
  for (let i = 0; i < 4; i++) {
    seedStr = BASE36[s % 36] + seedStr;
    s = Math.floor(s / 36);
  }

  const q1 = numQuestions % 36;
  const q2 = Math.floor(numQuestions / 36);
  const qStr = BASE36[q1] + BASE36[q2];

  const core = subjCode + maskStr + seedStr + qStr;
  let sum = 0;
  for (const ch of core) {
    sum += BASE36.indexOf(ch);
  }
  const checksum = sum % (36 * 36);
  const c1 = checksum % 36;
  const c2 = Math.floor(checksum / 36);
  const checkStr = BASE36[c1] + BASE36[c2];

  return core + checkStr;
}

function decodeExamCode(code) {
  if (typeof code !== 'string' || code.length !== 12) return null;
  code = code.toUpperCase();

  const subjCode = code.slice(0, 2);
  const maskStr = code.slice(2, 4);
  const seedStr = code.slice(4, 8);
  const qStr = code.slice(8, 10);
  const checkStr = code.slice(10, 12);

  const core = code.slice(0, 10);
  let sum = 0;
  for (const ch of core) {
    sum += BASE36.indexOf(ch);
  }
  const expectedChecksum = sum % (36 * 36);
  const expectedC1 = expectedChecksum % 36;
  const expectedC2 = Math.floor(expectedChecksum / 36);
  if (checkStr[0] !== BASE36[expectedC1] || checkStr[1] !== BASE36[expectedC2]) {
    return null;
  }

  const subject = SUBJECT_CODES[subjCode];
  if (!subject) return null;

  const maskVal = BASE36.indexOf(maskStr[0]) + BASE36.indexOf(maskStr[1]) * 36;
  const topicList = TOPICS_BY_SUBJECT[subject];
  if (!topicList) return null;
  const selectedTopicIds = [];
  for (let i = 0; i < topicList.length; i++) {
    if (maskVal & (1 << i)) {
      selectedTopicIds.push(topicList[i]);
    }
  }
  if (selectedTopicIds.length === 0) return null;

  let seed = 0;
  for (const ch of seedStr) {
    seed = seed * 36 + BASE36.indexOf(ch);
  }

  const qCount = BASE36.indexOf(qStr[0]) + BASE36.indexOf(qStr[1]) * 36;
  if (qCount < 1 || qCount > MAX_QUESTIONS) return null;

  return { subject, topicIds: selectedTopicIds, seed, numQuestions: qCount };
}

// ==================== LIMIT CHECKS ====================
function checkPDFLimits() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const firstJan = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now - firstJan) / (24 * 60 * 60 * 1000));
  const weekNum = Math.ceil((days + firstJan.getDay() + 1) / 7);
  const weekKey = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

  let daily = JSON.parse(localStorage.getItem('pdf_daily_limit') || '{"date":"","count":0}');
  let weekly = JSON.parse(localStorage.getItem('pdf_weekly_limit') || '{"week":"","count":0}');

  if (daily.date !== today) { daily.count = 0; daily.date = today; }
  if (weekly.week !== weekKey) { weekly.count = 0; weekly.week = weekKey; }

  if (daily.count >= DAILY_LIMIT) {
    return { ok: false, msg: `Daily limit reached (${DAILY_LIMIT}/${DAILY_LIMIT}). Try again tomorrow.` };
  }
  if (weekly.count >= WEEKLY_LIMIT) {
    return { ok: false, msg: `Weekly limit reached (${WEEKLY_LIMIT}/${WEEKLY_LIMIT}). Try again next week.` };
  }
  return { ok: true, daily, weekly };
}

function incrementPDFLimits() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const firstJan = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now - firstJan) / (24 * 60 * 60 * 1000));
  const weekNum = Math.ceil((days + firstJan.getDay() + 1) / 7);
  const weekKey = `${now.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

  let daily = localStorage.getItem('pdf_daily_limit');
  let weekly = localStorage.getItem('pdf_weekly_limit');
  daily = daily ? JSON.parse(daily) : { date: today, count: 0 };
  weekly = weekly ? JSON.parse(weekly) : { week: weekKey, count: 0 };

  if (daily.date !== today) { daily.date = today; daily.count = 0; }
  if (weekly.week !== weekKey) { weekly.week = weekKey; weekly.count = 0; }

  daily.count++;
  weekly.count++;
  localStorage.setItem('pdf_daily_limit', JSON.stringify(daily));
  localStorage.setItem('pdf_weekly_limit', JSON.stringify(weekly));
}

// ==================== SEEDED SHUFFLE ====================
function seededShuffle(array, seed) {
  if (!array || !array.length) return array;
  const arr = [...array];
  let m = arr.length;
  let s = seed;
  while (m) {
    s = (s * 9301 + 49297) % 233280;
    const i = Math.floor((s / 233280) * m);
    m--;
    [arr[m], arr[i]] = [arr[i], arr[m]];
  }
  return arr;
}

export async function init(context) {
  $ = (sel) => context.root.querySelector(sel);

  ui.applyTheme();

  // ── Auth gate ────────────────────────────────────────────────────
  // Round-trip through login. The engine's PDF config persists across
  // navigations, so on return the page picks up right where the user
  // left off.
  if (!auth.checkAuth()) {
    ui.showToast('Please log in to configure PDF export', 'warning');
    redirect.navigateWithReturn('login', 'auth_required');
    return;
  }

  // ── Config gate ──────────────────────────────────────────────────
  // No PDF config means the user never got here through the intended
  // flow (subject-specific → select topics → PDF mode). There is no
  // page to come back to, so we clear the redirect chain and bail to
  // subjects. A dangling returnTo would just loop us back here.
  config = examEngine.getConfig();
  if (!config || config.mode !== 'pdf') {
    ui.showToast('No PDF configuration found. Please select topics first.', 'error');
    try { redirect.clearReturns(); }   catch { /* ignore */ }
    try { redirect.clearSnapshots(); } catch { /* ignore */ }
    router.navigateTo('subjects');
    return;
  }

  // ── State adapter ────────────────────────────────────────────────
  // Registered after both gates so we only ever capture meaningful
  // state. The exam code input, question-count input, and the four
  // checkboxes (include-questions / answer-sheet / answer-booklet /
  // fillout) already have ids, so the automatic UI snapshot covers
  // them. This adapter adds the module-local decoded config that
  // never lands in the DOM.
  redirect.registerStateAdapter('pdf-settings', {
    capture: () => {
      const btn = document.getElementById('generatePdfBtn');
      const seedFromBtn = btn?.dataset?.seed;
      return {
        decodedConfig: window._decodedConfig || null,
        seedFromButton: seedFromBtn ? Number(seedFromBtn) : null,
      };
    },
    restore: (data) => {
      if (!data) return;
      if (data.decodedConfig) {
        window._decodedConfig = data.decodedConfig;
      }
      if (Number.isFinite(data.seedFromButton)) {
        const btn = document.getElementById('generatePdfBtn');
        if (btn) btn.dataset.seed = String(data.seedFromButton);
      }
    },
  });

  // ── Subscription check ───────────────────────────────────────────
  // Non-blocking: the user can still view/edit settings, we just
  // disable generation and surface a subscribe CTA. This keeps the
  // page usable for users who want to tweak inputs before paying.
  hasActiveSub = await subscription.hasActiveSubscription();
  if (!hasActiveSub) {
    ui.showToast('An active subscription is required to generate PDFs.', 'warning');
    const genBtn = $('#generatePdfBtn');
    if (genBtn) genBtn.disabled = true;
    const subMsg = $('#sub-required-msg');
    if (subMsg) subMsg.style.display = 'block';
  }

  // Fill summary
  const subjectMeta = await questions.getSubjectMeta(config.subject);
  $('#pdf-subject-icon').textContent = subjectMeta?.icon || '📚';
  $('#pdf-subject-name').textContent = subjectMeta?.name || config.subject;

  const topicNames = config.topics.map(t => t.name).join(', ');
  $('#pdf-topic-names').textContent = topicNames;

  // Hide shimmer, show real content
  $('#shimmer-content').style.display = 'none';
  $('#real-content').style.display = 'block';

  // Attach event listeners
  attachEventListeners(context);

  // Auto-decode from URL parameter, if present. Runs BEFORE snapshot
  // consumption so a deep-linked `?code=X` always wins over a stale
  // session restore — an explicit link beats a passive memory.
  const urlParams = new URLSearchParams(window.location.search);
  const codeParam = urlParams.get('code');
  if (codeParam) {
    $('#pdf-exam-code').value = codeParam;
    $('#decodeCodeBtn').click();
  }

  // ── Self-consume of the return stack ─────────────────────────────
  // If a snapshot exists for this page AND the top of the return
  // stack points here, we are the target of a just-completed round
  // trip. Pop the entry so the stack does not grow on subsequent
  // redirects.
  try {
    const hasSnap = redirect.hasSnapshot();
    if (hasSnap) {
      const myUrl =
        window.location.pathname +
        (window.location.search || '') +
        (window.location.hash || '');
      const top = redirect.peekReturn();
      if (top && top.url === myUrl) redirect.popReturn();
    }
  } catch (err) {
    console.warn('[PDFSettings] Return-stack cleanup failed:', err);
  }

  // ── Resume snapshot ──────────────────────────────────────────────
  // Restores exam code input, question count, checkboxes (auto), and
  // the decoded config / seed (adapter).
  const snap = redirect.consumeSnapshot();
  if (snap && (snap.ui || snap.page)) {
    ui.showToast('Continuing where you left off', 'info', 1800);
    console.log('[PDFSettings] Resumed from redirect:', {
      fields: Object.keys(snap.ui?.fields || {}).length,
      pageState: snap.page,
    });
  }

  console.log('[PDFSettings] Initialized');
}

function attachEventListeners(context) {
  const backBtn = $('#backBtn');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      router.navigateTo(`subject-specific?subject=${config?.subject || ''}`);
    });
  }

  const themeToggle = $('#themeToggle');
  if (themeToggle) {
    themeToggle.addEventListener('click', ui.toggleTheme);
  }

  const decodeCodeBtn = $('#decodeCodeBtn');
  if (decodeCodeBtn) {
    decodeCodeBtn.addEventListener('click', handleDecode);
  }

  const generatePdfBtn = $('#generatePdfBtn');
  if (generatePdfBtn) {
    generatePdfBtn.addEventListener('click', handleGenerate);
  }

  // Subscribe CTA in the "sub required" message. Round-trips through
  // subscription so a session expiry mid-flow still lands the user
  // back on this page with the PDF config intact.
  const subscribeCta = $('#pdf-subscribe-cta');
  if (subscribeCta) {
    subscribeCta.addEventListener('click', (e) => {
      e.preventDefault();
      redirect.navigateWithReturn('subscription', 'subscription_required');
    });
  }
}

// ==================== DECODE HANDLER ====================
async function handleDecode() {
  const code = $('#pdf-exam-code').value.trim().toUpperCase();
  if (!code) {
    ui.showToast('Please enter an exam code.', 'warning');
    return;
  }
  const decoded = decodeExamCode(code);
  if (!decoded) {
    ui.showToast('Invalid exam code. Please check the format.', 'error');
    return;
  }
  $('#pdf-question-count').value = decoded.numQuestions;
  $('#generatePdfBtn').dataset.seed = decoded.seed;

  // Update topic names display
  try {
    const topics = await questions.getTopicsBySubject(decoded.subject);
    const names = topics.filter(t => decoded.topicIds.includes(t.id)).map(t => t.name);
    $('#pdf-topic-names').textContent = names.join(', ');
  } catch (err) {
    console.warn('Could not fetch topic names:', err);
  }

  window._decodedConfig = decoded;
  ui.showToast(`Decoded: ${decoded.subject}, ${decoded.numQuestions} questions`, 'success');
}

// ==================== GENERATE HANDLER (v7.0 WASM Engine) ====================
//
// The v7.0 engine produces one PDF per document type. When multiple types
// are selected (exam + answer sheet + answer key), the handler calls
// `exportDocument` once per type. The engine serializes compiles internally,
// so the calls are safely sequential. On Web each export triggers its own
// silent browser download; on Capacitor each is written to DOCUMENTS.

async function handleGenerate() {
  const btn = $('#generatePdfBtn');
  btn.disabled = true;
  btn.textContent = 'Generating...';

  try {
    // Re-check the subscription at click time — the user may have
    // been on this page long enough for the sub to expire.
    const stillSubbed = await subscription.hasActiveSubscription();
    if (!stillSubbed) {
      ui.showToast('Your subscription has expired. Please resubscribe.', 'error');
      redirect.navigateWithReturn('subscription', 'subscription_required');
      return;
    }

    if (typeof safeExportDocument !== 'function') {
      ui.showToast('PDF engine unavailable — please reload the page', 'error');
      return;
    }

    // ── Rate limiting ──────────────────────────────────────────────────
    const limitCheck = checkPDFLimits();
    if (!limitCheck.ok) {
      ui.showToast(limitCheck.msg, 'warning');
      return;
    }

    // ── Input validation ───────────────────────────────────────────────
    const numQuestions = parseInt($('#pdf-question-count').value, 10);
    if (isNaN(numQuestions) || numQuestions < 1 || numQuestions > MAX_QUESTIONS) {
      ui.showToast(`Please enter a number between 1 and ${MAX_QUESTIONS}.`, 'warning');
      return;
    }

    const includeQuestions     = $('#include-questions').checked;
    const includeAnswerSheet   = $('#include-answer-sheet').checked;
    const includeAnswerBooklet = $('#include-answer-booklet').checked;
    const includeFillout       = $('#include-fillout').checked;

    if (!includeQuestions && !includeAnswerSheet && !includeAnswerBooklet) {
      ui.showToast('Please select at least one document type.', 'warning');
      return;
    }

    // ── Seed resolution ────────────────────────────────────────────────
    let seed = parseInt(btn.dataset.seed, 10);
    if (isNaN(seed) || seed === 0) {
      seed = Math.floor(Math.random() * 2147483647);
    }
    delete btn.dataset.seed;

    // ── Fetch + shuffle questions ──────────────────────────────────────
    const rawQuestions = await questions.getQuestionsForExam({
      subject: config.subject,
      topics: config.topics,
      questionCount: numQuestions
    });

    if (!rawQuestions || rawQuestions.length < numQuestions) {
      ui.showToast(
        `Not enough questions available. Got ${rawQuestions?.length || 0}, needed ${numQuestions}.`,
        'error'
      );
      return;
    }

    const shuffled = seededShuffle(rawQuestions, seed);
    const selectedQuestions = shuffled.slice(0, numQuestions);

    // ── Build the per-question shapes expected by File 2's schemas ─────
    const LETTERS = ['A', 'B', 'C', 'D', 'E'];

    const examQuestions = selectedQuestions.map((q, idx) => {
      const optionStrings = q.options.map((opt, i) => `${LETTERS[i]}. ${opt.text}`);

      let correctLetter = 'A';
      q.options.forEach((opt, i) => {
        if (opt.isCorrect) correctLetter = LETTERS[i];
      });

      const explanationObj = {
        overview:            q.explanation?.overview            || '',
        highYield:           q.explanation?.highYield           || '',
        clinicalCorrelation: q.explanation?.clinicalCorrelation || ''
      };

      return {
        id: `${idx + 1}`,
        text: q.question,
        options: optionStrings,
        correct: correctLetter,
        explanation: explanationObj
      };
    });

    // ── Common metadata ────────────────────────────────────────────────
    const isoDate = new Date().toISOString().slice(0, 10);
    const topicIds = config.topics.map(t => t.id);
    const examCode = encodeExamCode(config.subject, topicIds, seed, numQuestions);

    // ── Compose payloads for each selected document type ───────────────
    const payloads = [];

    if (includeQuestions) {
      payloads.push({
        type: 'exam',
        data: {
          id: examCode,
          title: `${config.subject} – Practice Exam`,
          subject: config.subject,
          topics: config.topics.map(t => t.name).join(', '),
          difficulty: 'Moderate',
          duration: `${Math.ceil(numQuestions * 1.2)} minutes`,
          totalMarks: selectedQuestions.length,
          date: isoDate,
          studentInfo: includeFillout,
          questions: examQuestions.map(q => ({
            id: q.id,
            text: q.text,
            options: q.options
          }))
        }
      });
    }

    if (includeAnswerSheet) {
      payloads.push({
        type: 'mcq-sheet',
        data: {
          id: examCode,
          title: `${config.subject} – Answer Sheet`,
          totalQuestions: selectedQuestions.length,
          studentInfo: includeFillout
        }
      });
    }

    if (includeAnswerBooklet) {
      payloads.push({
        type: 'answer-key',
        data: {
          id: examCode,
          title: `${config.subject} – Answer Key`,
          subtitle: 'Detailed explanations for each question',
          subject: config.subject,
          date: isoDate,
          answers: examQuestions.map(q => ({
            id: q.id,
            question: q.text,
            correctOption: q.correct,
            explanation: q.explanation
          }))
        }
      });
    }

    // ── Export each document sequentially ──────────────────────────────
    const results = [];
    for (const { type, data } of payloads) {
      const result = await safeExportDocument(type, data);
      results.push(result);
    }

    // ── Success ────────────────────────────────────────────────────────
    incrementPDFLimits();

    let summary;
    if (results.length === 1) {
      summary = results[0].filename;
    } else {
      const names = results.map(r => r.filename).join(', ');
      summary = `${results.length} PDFs (${names})`;
    }
    ui.showToast(`Generated: ${summary} — Exam code: ${examCode}`, 'success');

  } catch (err) {
    console.error('[PDFSettings] Generate failed:', err);

    // Surface useful messages for the common failure modes.
    const code = err && err.code;
    let message = 'Failed to generate PDF. Please try again.';
    if (code === 'TIMEOUT')         message = 'PDF generation timed out — try fewer questions.';
    else if (code === 'STORAGE')    message = 'Could not save PDF — check storage permissions.';
    else if (code === 'VALIDATION') message = 'Invalid exam data — ' + (err.message || 'unknown error');
    else if (code === 'COMPILE')    message = 'PDF compile error — please report this.';
    else if (code === 'ASSET_LOAD') message = 'Could not load PDF assets — check your connection once.';
    else if (err && err.message)    message = 'PDF generation failed: ' + err.message;

    ui.showToast(message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate PDF';
  }
}

export function destroy() {
  // Unregister the state adapter so a subsequent page load does not
  // inherit a stale closure over this page's DOM.
  try { redirect.unregisterStateAdapter('pdf-settings'); } catch { /* ignore */ }
}