// scripts/medvix.js
/**
 * ============================================================================
 * MedVix Integration Facade
 * ============================================================================
 * Wires medvix-engine.js + medvix-narrator.js into MedVix.
 *
 * Design:
 *   • Engine state is DERIVED from db.getAllExamResults() at boot.
 *     No separate persistence → no desync, no migration.
 *   • Runtime ingestion is fire-and-forget after each exam → page never
 *     blocks on the engine.
 *   • Everything async, nothing throws to callers — MedVix must never
 *     break because the learning engine has a bug.
 *
 * Public API:
 *   ensureReady()                              → Promise<void>
 *   ingestExam(examResult, learnerId?)         → Promise<summary|null>
 *   getConceptState(conceptId)                 → Promise<snapshot|null>
 *   getAllConceptStates()                      → Promise<snapshot[]>
 *   getLearnerSummary()                        → Promise<summary|null>
 *   getDiagnose(conceptId)                     → Promise<diagnostic|null>
 *   getReviewPlan(conceptId)                   → Promise<plan|null>
 *   selectNextQuestions(pool, budget, mode, subject) → Promise<selection|null>
 *   getModeRecommendation(context)             → Promise<{mode,reason,confidence}>
 *   getTopReviewTargets(limit)                 → Promise<[{conceptId,urgency,snapshot}]>
 *   narrateConcept(conceptId, register?)       → Promise<narration|null>
 *   narrateSnapshot(snapshot, intent, register?, ctx?) → Promise<narration>
 *   narrateSession(sessionSummary, register?)  → Promise<narration>
 *   narrateLearningDigest(register?)           → Promise<{...}>
 *   monitor()                                  → Promise<diagnostics|null>
 *   reset()                                    → Promise<void>
 * ============================================================================
 */

import { createEngine } from './medvix-engine.js';
import { createNarrator } from './medvix-narrator.js';
import * as db from './db.js';

let _engine = null;
let _narrator = null;
let _initialized = false;
let _initPromise = null;

// ==================== BOOTSTRAP ====================
async function bootstrap() {
  _engine = createEngine();
  _narrator = createNarrator({ register: 'friendly' });

  let allExams = [];
  try {
    allExams = (await db.getAllExamResults()) || [];
  } catch (e) {
    console.warn('[MedVix] Could not load exam results:', e);
  }

  // Sort chronologically so BKT/ACT-R replay in the right order.
  allExams.sort((a, b) => {
    const ta = new Date(a?.date || 0).getTime() || 0;
    const tb = new Date(b?.date || 0).getTime() || 0;
    return ta - tb;
  });

  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  for (const exam of allExams) {
    try {
      const res = _engine.ingestExam(exam, 'local');
      ingested += res.ingested || 0;
      skipped += res.skipped || 0;
    } catch (e) {
      failed += 1;
      console.warn('[MedVix] ingestExam failed for', exam?.examId, e);
    }
  }

  _initialized = true;
  try {
    console.debug('[MedVix] Bootstrap complete:', {
      exams: allExams.length, ingested, skipped, failed,
      eventCount: _engine.getEventCount(),
      concepts: _engine.getAllConceptStates().length,
    });
  } catch { /* ignore */ }
}

export async function ensureReady() {
  if (_initialized) return;
  if (_initPromise) return _initPromise;
  _initPromise = bootstrap();
  return _initPromise;
}

// ==================== INGEST ====================
export async function ingestExam(examResult, learnerId = 'local') {
  try {
    await ensureReady();
    if (!examResult || !Array.isArray(examResult.questions)) return null;
    const res = _engine.ingestExam(examResult, learnerId);
    return res;
  } catch (e) {
    console.warn('[MedVix] ingestExam failed:', e);
    return null;
  }
}

// ==================== STATE READERS ====================
export async function getConceptState(conceptId) {
  try { await ensureReady(); return _engine.getConceptState(conceptId); }
  catch { return null; }
}

export async function getAllConceptStates() {
  try { await ensureReady(); return _engine.getAllConceptStates(); }
  catch { return []; }
}

export async function getLearnerSummary() {
  try { await ensureReady(); return _engine.getLearnerSummary(); }
  catch { return null; }
}

export async function getDiagnose(conceptId) {
  try { await ensureReady(); return _engine.diagnose(conceptId); }
  catch { return null; }
}

export async function getReviewPlan(conceptId) {
  try { await ensureReady(); return _engine.getReviewPlan(conceptId); }
  catch { return null; }
}

export async function selectNextQuestions(pool, budgetSec, mode, subject) {
  try { await ensureReady(); return _engine.selectNextQuestions(pool, budgetSec, mode, subject); }
  catch (e) { console.warn('[MedVix] selectNextQuestions failed:', e); return null; }
}

export async function getModeRecommendation(context) {
  try { await ensureReady(); return _engine.getModeRecommendation(context); }
  catch { return null; }
}

export async function monitor() {
  try { await ensureReady(); return _engine.monitor(); }
  catch { return null; }
}

// ==================== NARRATOR ====================
export async function narrateSnapshot(snapshot, intent, register = 'friendly', ctx = {}) {
  try {
    await ensureReady();
    return _narrator.explain(snapshot, intent, register || 'friendly', ctx || {});
  } catch (e) {
    console.warn('[MedVix] narrateSnapshot failed:', e);
    return { text: '', valid: false, reason: 'narrator_error' };
  }
}

export async function narrateConcept(conceptId, register = 'friendly') {
  try {
    await ensureReady();
    const snap = _engine.getConceptState(conceptId);
    if (!snap) return null;
    return _narrator.describeState(snap, register || 'friendly');
  } catch (e) {
    console.warn('[MedVix] narrateConcept failed:', e);
    return null;
  }
}

export async function narrateSession(sessionSummary, register = 'friendly') {
  try { await ensureReady(); return _narrator.describeSession(sessionSummary, register); }
  catch { return null; }
}

/**
 * Highest-urgency concepts (retrieval risk + low mastery + CI width).
 */
export async function getTopReviewTargets(limit = 3) {
  try {
    await ensureReady();
    const snapshots = _engine.getAllConceptStates();
    const scored = snapshots
      .map((s) => {
        const m = s?.mastery?.p ?? 0;
        const pRet = s?.retrieval?.pNow ?? 0;
        const ci = s?.mastery?.ci90 || [0, 1];
        const width = ci[1] - ci[0];
        const urgency = (1 - pRet) * 0.6 + (1 - m) * 0.4 + width * 0.2;
        return { conceptId: s.conceptId, urgency, snapshot: s };
      })
      .filter((x) => (x.snapshot?.mastery?.evidenceCount || 0) >= 2)
      .sort((a, b) => b.urgency - a.urgency);
    return scored.slice(0, Math.max(1, limit));
  } catch { return []; }
}

/**
 * One-shot digest for the performance page: weakest concepts, retention
 * risks, top review targets. Each item carries a narrator-generated line.
 */
export async function narrateLearningDigest(register = 'friendly') {
  try {
    await ensureReady();
    const summary = _engine.getLearnerSummary();
    const snapshots = _engine.getAllConceptStates();

    const weak = [];
    const atRisk = [];
    for (const s of snapshots) {
      const m = s?.mastery?.p ?? 0;
      const pRet = s?.retrieval?.pNow ?? 0;
      const ev = s?.mastery?.evidenceCount || 0;
      if (ev < 2) continue;  // don't narrate guesswork
      if (m < 0.55) weak.push(s);
      if (pRet > 0 && pRet < 0.65) atRisk.push(s);
    }
    weak.sort((a, b) => (a.mastery.p ?? 0) - (b.mastery.p ?? 0));
    atRisk.sort((a, b) => (a.retrieval.pNow ?? 1) - (b.retrieval.pNow ?? 1));

    const weakNarrations = [];
    for (const s of weak.slice(0, 3)) {
      try {
        const narr = _narrator.describeState(s, register);
        if (narr?.valid) weakNarrations.push({ conceptId: s.conceptId, narration: narr });
      } catch { /* skip */ }
    }

    const riskNarrations = [];
    for (const s of atRisk.slice(0, 3)) {
      try {
        const narr = _narrator.explain(s, 'forgetting_risk', register, { eventId: s.conceptId });
        if (narr?.valid) riskNarrations.push({ conceptId: s.conceptId, narration: narr });
      } catch { /* skip */ }
    }

    const targets = [];
    const topUrgent = await getTopReviewTargets(3);
    for (const t of topUrgent) {
      try {
        const narr = _narrator.explain(t.snapshot, 'review_scheduled', register, { eventId: t.conceptId });
        if (narr?.valid) targets.push({ conceptId: t.conceptId, urgency: t.urgency, narration: narr });
      } catch { /* skip */ }
    }

    return {
      summary,
      totalConcepts: snapshots.length,
      evidenceCount: summary?.totalEvidence ?? 0,
      averageMastery: summary?.averageMastery ?? null,
      brier: summary?.brier || null,
      weakNarrations,
      riskNarrations,
      targets,
    };
  } catch (e) {
    console.warn('[MedVix] narrateLearningDigest failed:', e);
    return {
      summary: null, totalConcepts: 0, evidenceCount: 0,
      averageMastery: null, brier: null,
      weakNarrations: [], riskNarrations: [], targets: [],
    };
  }
}

// ==================== RESET (for logout / data wipe) ====================
export async function reset() {
  _engine = null;
  _narrator = null;
  _initialized = false;
  _initPromise = null;
}

// ==================== LOW-LEVEL ACCESS (debug only) ====================
export function _getEngine() { return _engine; }
export function _getNarrator() { return _narrator; }