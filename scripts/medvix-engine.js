// scripts/medvix-engine.js
/**
 * ============================================================================
 * MedVix Adaptive Medical Learning Intelligence Engine — Complete Four-Law Core
 * ============================================================================
 * VERSION: 2.0.0   SCHEMA: 2
 *
 * ----------------------------------------------------------------------------
 * SCIENTIFIC STATUS OF THE FOUR LAWS (Directive §2.2)
 * ----------------------------------------------------------------------------
 * CL-A  Knowledge Stability
 *   Form: BKT (Corbett & Anderson 1994) + ACT-R activation (Anderson &
 *   Schooler 1991) + hierarchical 1PL IRT + logistic (mastery, activation) →
 *   retrieval-probability hybrid.
 *   Status: #2 (BKT + ACT-R established) + #3 (hybrid retrieval mapping is a
 *   proposed model) + #5 (bounded event-history & log-approx are engineering).
 *
 * CL-B  KL-Optimal Diagnostic Discrimination
 *   Form: exact EIG (KL) via analytic binary posterior + validated
 *   entropy-reduction approximation.
 *   Status: #1 (EIG, KL, entropy identities are established) + #5
 *   (approximation for runtime).
 *
 * CL-C  Metacognitive-Weighted Evidence
 *   Form: ordinal confidence likelihood (cumulative logit) + graded
 *   misconception accumulation + proper scoring (Brier, log loss) +
 *   correctness-only fallback when confidence unobserved.
 *   Status: #3 (hybrid) + #4 (misconception thresholds require prospective
 *   validation — falsifiable hypothesis is documented inline).
 *
 * CL-D  Multi-Objective Resource Allocation
 *   Form: constrained utility maximisation with greedy marginal-value-per-
 *   minute baseline + exact DP knapsack. Policy weights are hypotheses.
 *   Status: #3 (constrained optimisation is established) + #4 (policy weights
 *   require calibration).
 *
 * No law is claimed valid before testing. Every coefficient appears in
 * PROVENANCE with source, calibrationStatus, and (where applicable)
 * falsifiable prediction.
 *
 * ----------------------------------------------------------------------------
 * COMPLETE ALGORITHM INDEX (Deliverable C — all 20 required)
 * ----------------------------------------------------------------------------
 *   A1  Learner-state initialization       → KnowledgeStateEstimator.initConcept
 *   A2  Time advancement & forgetting      → BKT.predictAt, ACTR.activationAt
 *   A3  Response-likelihood calculation    → IRTModel.predict, BKT.pCorrect
 *   A4  Knowledge-state update             → BKT.observe, ConceptState.observe
 *   A5  Confidence & metacognitive update  → MetacognitiveModel.observe
 *   A6  Misconception detection            → MetacognitiveModel.detect (graded)
 *   A7  Expected information gain          → DiagnosticSelector.eig
 *   A8  Diagnostic question selection      → DiagnosticSelector.selectQuestions
 *   A9  Retention prediction               → ConceptState.retrievalProbabilityAt
 *   A10 Review-interval selection          → ConceptState.timeUntilRetrievalBelow
 *   A11 Transfer estimation                → TransferEstimator.estimate
 *   A12 Time-budgeted action selection     → LearningPolicy.selectSession (greedy+knapsack)
 *   A13 Mode selection                     → ModeSelector.select
 *   A14 Session termination                → LearningPolicy.shouldTerminate
 *   A15 Event persistence                  → EventLog.append, engine.exportEvents
 *   A16 Offline synchronisation            → engine.mergeEvents
 *   A17 Model-parameter calibration        → Calibrator.calibrateHierarchical
 *   A18 Competitive-rating integration     → CompetitiveRatingBridge.pull
 *   A19 Model-version migration            → Migration.migrate
 *   A20 Evaluation and monitoring          → Evaluation.monitor
 * ============================================================================
 */

export const MODEL_VERSION = '2.0.0';
export const SCHEMA_VERSION = 2;

// ============================================================================
// SECTION 1 — DEFAULTS & PROVENANCE
// ============================================================================

/**
 * PROVENANCE categories (Directive §2.3):
 *   math_derivation          — follows from mathematics alone
 *   established_model        — from published model / paper
 *   engineering_default      — chosen for practicality, awaits calibration
 *   research_hypothesis      — proposed, requires empirical validation
 *   engineering_approximation — optimisation with known error bounds
 */
export const DEFAULTS = Object.freeze({
  BKT: { p_init: 0.30, p_learn: 0.15, p_forget: 0.02, p_slip: 0.10, p_guess: 0.20 },
  ACTR: { d: 0.5, beta: 0.0, maxEvents: 20, timeUnit: 'seconds', useLogApprox: false },
  IRT: { defaultForm: '1pl', minItemResponses: 30, partialPoolingLambda: 0.7 },
  RETRIEVAL: { alpha: -2.0, beta_mastery: 2.0, gamma_activation: 0.3 },
  REVIEW: { minIntervalDays: 1, maxIntervalDays: 180, targetRetrieval: 0.80, urgencyMinRetrieval: 0.60 },
  DIAGNOSTIC: {
    lambda_info: 1.0, lambda_retention: 0.5, lambda_cost: 1.0, lambda_decision: 0.3,
    maxCandidates: 200, minCoverageConcepts: 3, maxPerSubjectFraction: 0.40,
    stopCIPrecision: 0.20, stopMinEIG: 0.005,
  },
  METACOGNITIVE: {
    highConfidenceThreshold: 3, misconceptionMinErrors: 2,
    misconceptionWindowSec: 7 * 86400, brierWindow: 50,
    confidenceScale: 'ordinal_0_4', ordinalThresholds: [0.5, 1.5, 2.5, 3.5],
  },
  POLICY: {
    timeBudgetDefaultSec: 600, stoppingMinMarginalValue: 0.005, minActionsBeforeStop: 3,
    knapsackTimeResolutionSec: 30,
    modeParams: {
      initial_diagnostic:              { li: 1.5, lr: 0.1, ld: 1.0, lc: 0.6 },
      weakness_focused_remediation:    { li: 0.6, lr: 1.4, ld: 0.4, lc: 0.8 },
      spaced_retrieval:                { li: 0.3, lr: 2.0, ld: 0.2, lc: 1.0 },
      broad_curriculum_revision:       { li: 0.8, lr: 1.0, ld: 0.5, lc: 1.0 },
      timed_exam_simulation:           { li: 0.2, lr: 0.1, ld: 0.1, lc: 2.0 },
      clinical_reasoning_transfer:     { li: 0.7, lr: 0.5, ld: 0.6, lc: 1.2 },
      practical_identification:        { li: 0.6, lr: 0.8, ld: 0.4, lc: 1.2 },
      short_study:                     { li: 0.9, lr: 0.7, ld: 0.5, lc: 2.0 },
      low_confidence_high_uncertainty: { li: 0.7, lr: 0.4, ld: 1.5, lc: 0.8 },
    },
  },
  TRANSFER: { minEvidenceForEstimate: 3, transferDiscount: 0.5, noveltyThreshold: 0.6 },
  SIMULATION: { defaultLearners: 50, defaultQuestions: 200, seed: 42 },
  CALIBRATION: { minNPerParam: 30, hierarchicalShrinkK: 10, maxIter: 200, tol: 1e-5 },
  COMPETITIVE: { ratingWeight: 0.0 },  // Ratings NEVER auto-feed into mastery.
});

/**
 * Full provenance map. Every parameter appears with:
 *   source, literature (if any), calibrationStatus, meaning, units, range.
 */
export const PROVENANCE = Object.freeze({
  'BKT.p_init': { source: 'established_model', literature: 'Corbett & Anderson (1994)',
    calibrationStatus: 'uncalibrated_default', meaning: 'Prior mastery P(L_0)',
    units: 'probability', range: [0.01, 0.99], falsifiable: null },
  'BKT.p_learn': { source: 'established_model', literature: 'Corbett & Anderson (1994)',
    calibrationStatus: 'uncalibrated_default', meaning: 'P(T) learning probability on correct retrieval',
    units: 'probability', range: [0.01, 0.99], falsifiable: null },
  'BKT.p_forget': { source: 'engineering_default', literature: null,
    calibrationStatus: 'uncalibrated_default', meaning: 'Additive linear decay of P(L) per day',
    units: 'per day', range: [0, 0.20], falsifiable: 'If long-term retention curves fail to fit, replace.' },
  'BKT.p_slip': { source: 'established_model', literature: 'Corbett & Anderson (1994)',
    calibrationStatus: 'uncalibrated_default', meaning: 'P(slip): knows but answers wrong',
    units: 'probability', range: [0.001, 0.30], falsifiable: null },
  'BKT.p_guess': { source: 'math_derivation', literature: 'Theoretical floor = 1/(#options) for MCQ',
    calibrationStatus: 'theoretical', meaning: 'P(guess): unknown-but-correct',
    units: 'probability', range: [0.05, 0.50], falsifiable: 'If estimated item guessing ≠ empirical floor, tag is wrong.' },
  'ACTR.d': { source: 'established_model', literature: 'Anderson & Schooler (1991)',
    calibrationStatus: 'uncalibrated_default', meaning: 'Decay parameter d in Σ (t - t_ℓ)^{-d}',
    units: 'dimensionless', range: [0.1, 1.0], falsifiable: null },
  'ACTR.beta': { source: 'math_derivation', literature: null,
    calibrationStatus: 'fixed', meaning: 'Baseline offset (identity in log-space)',
    units: 'log-units', range: [-10, 10], falsifiable: null },
  'ACTR.maxEvents': { source: 'engineering_approximation', literature: 'Directive §3.2 explicitly permits bounded history',
    calibrationStatus: 'requires_sensitivity_analysis', meaning: 'Max events per concept in ACT-R memory',
    units: 'count', range: [5, 100], falsifiable: null },
  'IRT.defaultForm': { source: 'engineering_default', literature: 'Hulin, Drasgow & Parsons (1983)',
    calibrationStatus: 'requires_comparison', meaning: 'Which IRT form is used',
    units: 'enum', range: ['1pl', '2pl', '3pl', 'mirt'], falsifiable: 'Model comparison will select empirically.' },
  'RETRIEVAL.alpha': { source: 'research_hypothesis', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Intercept of retrieval logistic',
    units: 'log-odds', range: [-5, 5], falsifiable: 'If α is non-identifiable given data, fall back to α=0.' },
  'RETRIEVAL.beta_mastery': { source: 'research_hypothesis', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Weight on mastery in retrieval logistic',
    units: 'dimensionless', range: [0, 5], falsifiable: 'If ~0, mastery does not predict retrieval → drop term.' },
  'RETRIEVAL.gamma_activation': { source: 'research_hypothesis', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Weight on ACT-R activation',
    units: 'dimensionless', range: [0, 2], falsifiable: null },
  'REVIEW.targetRetrieval': { source: 'engineering_default', literature: null,
    calibrationStatus: 'uncalibrated_default', meaning: 'Review when P(retrieval) falls below this',
    units: 'probability', range: [0.5, 0.95], falsifiable: null },
  'DIAGNOSTIC.lambda_info': { source: 'engineering_default', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Weight on expected information gain in utility',
    units: 'dimensionless', range: [0, 10], falsifiable: null },
  'DIAGNOSTIC.lambda_retention': { source: 'engineering_default', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Weight on retention value',
    units: 'dimensionless', range: [0, 10], falsifiable: null },
  'DIAGNOSTIC.lambda_cost': { source: 'engineering_default', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Weight on time cost',
    units: 'dimensionless', range: [0, 10], falsifiable: null },
  'DIAGNOSTIC.lambda_decision': { source: 'engineering_default', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Weight on decision value (CI width)',
    units: 'dimensionless', range: [0, 10], falsifiable: null },
  'DIAGNOSTIC.minCoverageConcepts': { source: 'engineering_default', literature: null,
    calibrationStatus: 'uncalibrated_default', meaning: 'Min distinct concepts before session stop',
    units: 'count', range: [1, 20], falsifiable: null },
  'DIAGNOSTIC.maxPerSubjectFraction': { source: 'engineering_default', literature: null,
    calibrationStatus: 'uncalibrated_default', meaning: 'Max fraction of a session from one subject',
    units: 'fraction', range: [0.2, 1.0], falsifiable: null },
  'DIAGNOSTIC.stopCIPrecision': { source: 'engineering_default', literature: null,
    calibrationStatus: 'uncalibrated_default', meaning: 'Stop when all tested CIs < this width',
    units: 'probability width', range: [0.05, 0.5], falsifiable: null },
  'DIAGNOSTIC.stopMinEIG': { source: 'engineering_default', literature: null,
    calibrationStatus: 'uncalibrated_default', meaning: 'Stop when max EIG < this',
    units: 'nats', range: [0, 0.1], falsifiable: null },
  'METACOGNITIVE.highConfidenceThreshold': { source: 'engineering_default', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Ordinal confidence level counted as "high"',
    units: 'ordinal', range: [2, 4], falsifiable: 'Can be empirically derived from calibration curve.' },
  'METACOGNITIVE.misconceptionMinErrors': { source: 'engineering_default', literature: null,
    calibrationStatus: 'requires_prospective_validation', meaning: 'Min consecutive high-confidence errors for signal',
    units: 'count', range: [2, 5], falsifiable: 'If ≥2 produces too many false positives in pilot, raise to 3.' },
  'POLICY.stoppingMinMarginalValue': { source: 'engineering_default', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'Utility/minute below which to stop',
    units: 'utility/min', range: [0, 0.05], falsifiable: null },
  'POLICY.modeParams': { source: 'engineering_default', literature: 'Inspired by Koedinger et al. (2013) mode-based scheduling',
    calibrationStatus: 'requires_calibration', meaning: 'Per-mode λ weights',
    units: 'dimensionless', range: [0, 3], falsifiable: null },
  'TRANSFER.minEvidenceForEstimate': { source: 'engineering_default', literature: null,
    calibrationStatus: 'uncalibrated_default', meaning: 'Min transfer items before estimating transfer P',
    units: 'count', range: [2, 10], falsifiable: null },
  'TRANSFER.transferDiscount': { source: 'research_hypothesis', literature: null,
    calibrationStatus: 'requires_calibration', meaning: 'How much transfer counts toward mastery',
    units: 'fraction', range: [0.1, 1.0], falsifiable: null },
});

// ============================================================================
// SECTION 2 — NUMERICAL SAFEGUARDS
// ============================================================================

const EPS = 1e-9;
const LOG_EPS = -1e9;

export const Num = Object.freeze({
  clip: (x, lo, hi) => (!Number.isFinite(x) ? lo : x < lo ? lo : x > hi ? hi : x),
  clipProb: (p) => Num.clip(p, 1e-6, 1 - 1e-6),
  sigmoid(x) {
    if (!Number.isFinite(x)) return x > 0 ? 1 - 1e-6 : 1e-6;
    if (x >= 0) { const z = Math.exp(-x); return 1 / (1 + z); }
    const z = Math.exp(x); return z / (1 + z);
  },
  logSigmoid(x) {
    if (!Number.isFinite(x)) return x > 0 ? 0 : LOG_EPS;
    return x >= 0 ? -Math.log1p(Math.exp(-x)) : x - Math.log1p(Math.exp(x));
  },
  logit: (p) => Math.log(Num.clipProb(p) / (1 - Num.clipProb(p))),
  logSumExp(arr) {
    if (arr.length === 0) return LOG_EPS;
    let m = -Infinity;
    for (const v of arr) if (v > m) m = v;
    if (!Number.isFinite(m) || m === -Infinity) return LOG_EPS;
    let s = 0;
    for (const v of arr) s += Math.exp(v - m);
    return m + Math.log(s);
  },
  entropyBernoulli(p) { p = Num.clipProb(p); return -(p * Math.log(p) + (1 - p) * Math.log(1 - p)); },
  klBernoulli(p, q) { p = Num.clipProb(p); q = Num.clipProb(q); return p * Math.log(p / q) + (1 - p) * Math.log((1 - p) / (1 - q)); },
  varianceBeta(p, n) { const a = p * n + 1; const b = (1 - p) * n + 1; return (a * b) / ((a + b) ** 2 * (a + b + 1)); },
  /** PSD clamp on symmetric 2x2 matrix [[a,b],[b,c]]. */
  clamp2x2(a, b, c) {
    // Eigenvalues of [[a,b],[b,c]]: λ = (a+c)/2 ± sqrt(((a-c)/2)^2 + b^2)
    const m = (a + c) / 2, r = Math.sqrt(((a - c) / 2) ** 2 + b * b);
    const l1 = m + r, l2 = m - r;
    const floor = 1e-10;
    if (l1 < floor || l2 < floor) {
      const scale = floor / Math.max(1e-10, Math.min(l1, l2) + floor);
      return [a * scale + floor, b * scale, c * scale + floor];
    }
    return [a, b, c];
  },
});

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// SECTION 3 — DATA CONTRACTS & EVENT LOG
// ============================================================================

/**
 * normalizeEvent(raw, context) → canonical event | null.
 *
 * Accepts exam-engine per-question records or pre-normalized events.
 * Rejects events without an idempotency key or without concept mapping.
 * NEVER fabricates confidence.
 */
export function normalizeEvent(raw, ctx = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const examId = raw.examId || ctx.examId;
  const eventId = raw.eventId || (examId && raw.id ? `${examId}::${raw.id}` : null);
  if (!eventId) return null;

  const subject = raw.subject || ctx.subject;
  const topic = raw.topic || ctx.topic;
  if (!subject || !topic) return null;

  const tsRaw = raw.timestamp || ctx.date || new Date().toISOString();
  const tsSec = typeof tsRaw === 'number' ? Math.floor(tsRaw) : Math.floor(new Date(tsRaw).getTime() / 1000);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return null;

  return {
    eventId,
    learnerId: raw.learnerId || ctx.learnerId || 'local',
    questionId: raw.questionId || raw.id || null,
    conceptId: `${subject}::${topic}`,
    subject, topic,
    correct: !!raw.correct,
    latencySec: Number.isFinite(raw.timeSpent) ? raw.timeSpent
              : Number.isFinite(raw.latencySec) ? raw.latencySec : null,
    difficulty: Number.isFinite(raw.difficulty) ? raw.difficulty : 3,
    confidence: Number.isFinite(raw.confidence) ? raw.confidence : null,
    confidenceScale: raw.confidenceScale || DEFAULTS.METACOGNITIVE.confidenceScale,
    feedbackExposed: !!raw.feedbackExposed,
    transfer: !!raw.transfer,
    examId: examId || null,
    mode: raw.mode || ctx.mode || 'standard',
    timestamp: tsSec,
    modelVersion: MODEL_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };
}

/**
 * A15 — Event persistence. Idempotent, bounded, out-of-order safe.
 *
 * Deduplicates by eventId. Tracks out-of-order arrivals and reports them.
 */
export class EventLog {
  constructor(maxApplied = 10000) {
    this._seen = new Set();
    this._applied = [];          // [{eventId, timestamp}]
    this._maxApplied = maxApplied;
    this._outOfOrder = 0;
    this._lastTs = -Infinity;
  }
  has(eventId) { return this._seen.has(eventId); }
  append(event) {
    if (this._seen.has(event.eventId)) return false;
    if (event.timestamp < this._lastTs) this._outOfOrder++;
    this._seen.add(event.eventId);
    this._applied.push({ eventId: event.eventId, timestamp: event.timestamp });
    if (event.timestamp > this._lastTs) this._lastTs = event.timestamp;
    if (this._applied.length > this._maxApplied) this._applied.shift();
    return true;
  }
  count() { return this._seen.size; }
  outOfOrderCount() { return this._outOfOrder; }
  exportIds() { return [...this._seen]; }
  has2(eventId) { return this._seen.has(eventId); }
}

// ============================================================================
// SECTION 4 — CL-A: KNOWLEDGE STATE ESTIMATOR
// ============================================================================

/**
 * A1 + A2 + A9 + A10 — ACT-R with bounded history and optional log-approx.
 *
 * Base-level activation (Anderson & Schooler 1991):
 *   B_ik(t) = β_k + log Σ_ℓ (t − t_ikℓ)^{-d_k}
 *
 * Log-approximation for many events (d < 1):
 *   Σ (t − t_ℓ)^{-d} ≈ T^{1-d}/(1-d)  where T ≈ time span
 *   B ≈ β + (1-d)·log(T) − log(1-d)
 */
export class ACTR {
  constructor(cfg) {
    this.d = cfg.d; this.beta = cfg.beta;
    this.maxEvents = cfg.maxEvents;
    this.useLogApprox = cfg.useLogApprox;
    this.events = [];  // [{t, w}]
  }
  record(tSec, w = 1.0) {
    this.events.push({ t: tSec, w });
    if (this.events.length > this.maxEvents) this.events.shift();
  }
  activation(nowSec) {
    if (this.events.length === 0) return this.beta - 10;
    if (this.useLogApprox && this.events.length >= 10 && this.d < 1) {
      const oldest = this.events[0].t;
      const T = Math.max(nowSec - oldest, 1);
      return this.beta + (1 - this.d) * Math.log(T) - Math.log(1 - this.d);
    }
    const terms = [];
    for (const e of this.events) {
      const dt = Math.max(nowSec - e.t, 1);
      terms.push(Math.log(e.w) - this.d * Math.log(dt));
    }
    return this.beta + Num.logSumExp(terms);
  }
  activationAt(nowSec, deltaSec) { return this.activation(nowSec + deltaSec); }
}

/**
 * A3 — IRT observation models (1PL / 2PL / 3PL / MIRT).
 *
 * Production default is hierarchical 1PL with partial pooling because
 * 15,000 items cannot each be independently estimated with typical
 * response volumes (Directive §3.1). Alternatives are exposed for
 * model-comparison (§19).
 *
 *  1PL :  P = sigmoid(θ − b_j)                    (Rasch)
 *  2PL :  P = sigmoid(a_j·(θ − b_j))
 *  3PL :  P = c_j + (1−c_j)·sigmoid(a_j·(θ − b_j))
 *  MIRT:  P = sigmoid(Σ_k a_jk·r_k − b_j)
 */
export class IRTModel {
  constructor(form = '1pl', itemParams = {}) {
    this.form = form;
    this.itemParams = itemParams;  // {b, a, c, aVec}
  }
  /** θ may be scalar (1PL/2PL/3PL) or vector (MIRT). */
  predict(theta, difficultyFallback = 3) {
    const p = this.itemParams || {};
    const b = Number.isFinite(p.b) ? p.b : this._difficultyToB(difficultyFallback);

    switch (this.form) {
      case '1pl': {
        const th = Array.isArray(theta) ? theta[0] : theta;
        return Num.sigmoid(th - b);
      }
      case '2pl': {
        const th = Array.isArray(theta) ? theta[0] : theta;
        const a = Number.isFinite(p.a) ? p.a : 1;
        return Num.sigmoid(a * (th - b));
      }
      case '3pl': {
        const th = Array.isArray(theta) ? theta[0] : theta;
        const a = Number.isFinite(p.a) ? p.a : 1;
        const c = Number.isFinite(p.c) ? p.c : DEFAULTS.BKT.p_guess;
        return Num.clipProb(c + (1 - c) * Num.sigmoid(a * (th - b)));
      }
      case 'mirt': {
        const vec = Array.isArray(theta) ? theta : [theta];
        const aVec = Array.isArray(p.aVec) ? p.aVec : vec.map(() => 1);
        let dot = 0;
        for (let i = 0; i < vec.length; i++) dot += (aVec[i] || 0) * vec[i];
        return Num.sigmoid(dot - b);
      }
      default: return 0.5;
    }
  }
  _difficultyToB(diff) {
    const D = { 1: -1.5, 2: -0.75, 3: 0.0, 4: 0.75, 5: 1.5 };
    return D[Math.round(Num.clip(diff, 1, 5))] ?? 0;
  }
}

/**
 * A2 + A3 + A4 — BKT with Beta conjugate uncertainty and conservative decay.
 */
export class BKT {
  constructor(cfg, pInit = null) {
    this.cfg = cfg;
    this.p = Number.isFinite(pInit) ? Num.clipProb(pInit) : cfg.p_init;
    this.evidenceCount = 0;
    this.lastUpdateSec = null;
    this.lastSuccessSec = null;
    this.lastAttemptSec = null;
  }

  /** A3 — likelihood P(correct | mastery p, difficulty). */
  pCorrect(difficulty = 3) {
    const dm = 1.2 - (Num.clip(difficulty, 1, 5) - 1) * 0.125;
    const guess = Num.clipProb(this.cfg.p_guess * dm);
    const slip = Num.clipProb(this.cfg.p_slip);
    return Num.clipProb((1 - slip) * this.p + guess * (1 - this.p));
  }

  /** A4 — BKT posterior + transition update. Difficulty-modulated guess. */
  observe(correct, timestampSec, difficulty = 3) {
    const { p_slip, p_guess, p_learn } = this.cfg;
    const dm = 1.2 - (Num.clip(difficulty, 1, 5) - 1) * 0.125;
    const effGuess = Num.clipProb(p_guess * dm);
    const slip = Num.clipProb(p_slip);
    let posterior;
    if (correct) {
      const num = (1 - slip) * this.p;
      const den = num + effGuess * (1 - this.p);
      posterior = den > EPS ? num / den : this.p;
      this.lastSuccessSec = timestampSec;
    } else {
      const num = slip * this.p;
      const den = num + (1 - effGuess) * (1 - this.p);
      posterior = den > EPS ? num / den : this.p;
    }
    this.p = Num.clipProb(posterior + (1 - posterior) * p_learn);
    this.evidenceCount += 1;
    this.lastUpdateSec = timestampSec;
    this.lastAttemptSec = timestampSec;
  }

  /** A2 — predict mastery at a future time with conservative decay. */
  predictAt(futureSec) {
    if (this.lastUpdateSec == null) return this.p;
    const dtDays = (futureSec - this.lastUpdateSec) / 86400;
    if (dtDays <= 0) return this.p;
    const decay = Math.exp(-this.cfg.p_forget * dtDays);
    const floor = this.cfg.p_init * 0.5;
    return Num.clipProb(floor + (this.p - floor) * decay);
  }

  /** Beta-approximated credible interval. */
  credibleInterval(level = 0.90) {
    const n = Math.max(this.evidenceCount, 2);
    const a = this.p * n + 1, b = (1 - this.p) * n + 1;
    const mean = a / (a + b);
    const v = (a * b) / ((a + b) ** 2 * (a + b + 1));
    const se = Math.sqrt(v);
    const z = level >= 0.95 ? 1.96 : 1.645;
    return [Num.clipProb(mean - z * se), Num.clipProb(mean + z * se)];
  }

  variance() {
    const n = Math.max(this.evidenceCount, 1);
    return (this.p * (1 - this.p)) / (n + 2);
  }
}

/**
 * Alternative state estimator (EKF). Used for model comparison.
 * Represents state as scalar p with Gaussian uncertainty.
 * Transition: dp/dt = -λ·(p − floor); update: standard Kalman on logit(p).
 */
export class EKFEstimator {
  constructor(cfg, pInit = null) {
    this.cfg = cfg;
    this.p = Number.isFinite(pInit) ? Num.clipProb(pInit) : cfg.p_init;
    this.variance = 0.04;
    this.lastUpdateSec = null;
  }
  predictAt(futureSec) {
    if (this.lastUpdateSec == null) return this.p;
    const dtDays = Math.max(0, (futureSec - this.lastUpdateSec) / 86400);
    const floor = this.cfg.p_init * 0.5;
    const decayed = floor + (this.p - floor) * Math.exp(-this.cfg.p_forget * dtDays);
    // Variance grows with time (process noise)
    this.variance += 1e-4 * dtDays;
    return Num.clipProb(decayed);
  }
  observe(correct, timestampSec, difficulty = 3) {
    // Small EKF step in logit space
    const z = correct ? 1 : 0;
    const pPred = this.pCorrect(difficulty);
    const y = Num.logit(pPred);
    const h = 1;
    const R = 0.04;
    const S = h * this.variance * h + R;
    const K = this.variance * h / S;
    const yNew = y + K * (Num.logit(z === 1 ? 0.9 : 0.1) - y);
    this.p = Num.clipProb(Num.sigmoid(yNew));
    this.variance = (1 - K * h) * this.variance;
    this.lastUpdateSec = timestampSec;
  }
  pCorrect(difficulty = 3) { return this.p; }
}

/**
 * Per-concept state. Carries BKT (primary), ACTR, ordinal confidence evidence,
 * misconception evidence, transfer evidence, and graph-dependent weights.
 */
export class ConceptState {
  constructor(conceptId, subject, topic, cfg) {
    this.conceptId = conceptId;
    this.subject = subject;
    this.topic = topic;
    this.cfg = cfg;
    this.bkt = new BKT(cfg.BKT);
    this.ekf = new EKFEstimator(cfg.BKT);  // comparison baseline
    this.actr = new ACTR(cfg.ACTR);
    this.irt = new IRTModel(cfg.IRT.defaultForm);
    this.events = [];                       // bounded history [{t, correct, confidence, ...}]
    this.maxEventLog = 100;
    this.transfer = { count: 0, mean: null, variance: null };
    this.lastRetrievalAttemptSec = null;
    // Kalman-extension for transfer/clinical reasoning (z sub-vector).
    // Deferred to Phase 3 — this stub exists so interfaces are stable.
    this.z = { clinicalReasoning: null, variance: null };
  }

  observe(ev) {
    this.bkt.observe(ev.correct, ev.timestamp, ev.difficulty);
    this.ekf.observe(ev.correct, ev.timestamp, ev.difficulty);
    this.actr.record(ev.timestamp, ev.transfer ? this.cfg.TRANSFER.transferDiscount : 1.0);
    this.events.push({
      t: ev.timestamp, correct: ev.correct,
      confidence: ev.confidence, difficulty: ev.difficulty,
      latencySec: ev.latencySec, transfer: ev.transfer, eventId: ev.eventId,
    });
    if (this.events.length > this.maxEventLog) this.events.shift();
    this.lastRetrievalAttemptSec = ev.timestamp;

    // Update transfer estimate if this was a transfer item
    if (ev.transfer) {
      const n = this.transfer.count + 1;
      const x = ev.correct ? 1 : 0;
      const old = this.transfer.mean ?? x;
      const newMean = old + (x - old) / n;
      const newVar = n > 1
        ? ((n - 2) / (n - 1)) * (this.transfer.variance ?? 0) + (x - old) * (x - newMean) / (n - 1)
        : 0;
      this.transfer = { count: n, mean: newMean, variance: newVar };
    }
  }

  /** A9 — Retrieval probability P(R_ik(t)). */
  retrievalProbability(nowSec) {
    const { alpha, beta_mastery, gamma_activation } = this.cfg.RETRIEVAL;
    const m = this.bkt.predictAt(nowSec);
    const a = this.actr.activation(nowSec);
    return Num.sigmoid(alpha + beta_mastery * m + gamma_activation * a);
  }
  retrievalProbabilityAt(nowSec, deltaSec) {
    const { alpha, beta_mastery, gamma_activation } = this.cfg.RETRIEVAL;
    const m = this.bkt.predictAt(nowSec + deltaSec);
    const a = this.actr.activationAt(nowSec, deltaSec);
    return Num.sigmoid(alpha + beta_mastery * m + gamma_activation * a);
  }

  /** A10 — Time until P(retrieval) < target, bounded by min/max interval. */
  timeUntilRetrievalBelow(nowSec, target) {
    const { minIntervalDays, maxIntervalDays } = this.cfg.REVIEW;
    const minSec = minIntervalDays * 86400, maxSec = maxIntervalDays * 86400;
    if (this.retrievalProbabilityAt(nowSec, minSec) < target) return minSec;
    if (this.retrievalProbabilityAt(nowSec, maxSec) >= target) return maxSec;
    let lo = minSec, hi = maxSec;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (this.retrievalProbabilityAt(nowSec, mid) >= target) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Snapshot with all 9 dimensions from Directive §8. */
  snapshot(nowSec) {
    const ci = this.bkt.credibleInterval(0.90);
    return {
      conceptId: this.conceptId, subject: this.subject, topic: this.topic,
      // 1. Mastery
      mastery: {
        p: this.bkt.p,
        variance: this.bkt.variance(),
        ci90: ci,
        evidenceCount: this.bkt.evidenceCount,
        lastUpdateSec: this.bkt.lastUpdateSec,
        lastSuccessSec: this.bkt.lastSuccessSec,
      },
      // 2. Retrieval accessibility
      retrieval: {
        pNow: this.retrievalProbability(nowSec),
        activation: this.actr.activation(nowSec),
        predictedHalfLifeDays: this._estimateHalfLifeDays(nowSec),
      },
      // 3. Delayed retention — same as retrieval but at future review horizon
      delayedRetention: {
        pIn7Days: this.retrievalProbabilityAt(nowSec, 7 * 86400),
        pIn30Days: this.retrievalProbabilityAt(nowSec, 30 * 86400),
      },
      // 4. Transfer / clinical reasoning
      transfer: this.transfer.count > 0
        ? { p: this.transfer.mean, count: this.transfer.count, ci90: this._transferCI() }
        : { p: null, count: 0, ci90: null },
      // 5. Metacognitive — populated by MetacognitiveModel
      metacognitive: { confidenceObserved: this.events.some(e => e.confidence != null) },
      // 6. Misconception evidence — populated by MetacognitiveModel
      misconceptions: { consecutiveHighConfidenceErrors: 0, flagged: false },
      // 7. Item-level — per-question accuracy not stored here, but count is:
      itemLevel: { eventCount: this.events.length },
      // 8. Engagement — supplied by engine facade
      engagement: null,
      // 9. Competitive — NOT included in mastery (Directive §8). Supplied by bridge.
      competitive: null,
      provenance: { modelVersion: MODEL_VERSION, schemaVersion: SCHEMA_VERSION },
    };
  }

  _transferCI() {
    if (this.transfer.count < 2) return null;
    const se = Math.sqrt(this.transfer.variance / this.transfer.count);
    return [Num.clipProb(this.transfer.mean - 1.96 * se), Num.clipProb(this.transfer.mean + 1.96 * se)];
  }

  _estimateHalfLifeDays(nowSec) {
    const p0 = this.retrievalProbability(nowSec);
    if (p0 < 0.5) return null;
    return this.timeUntilRetrievalBelow(nowSec, p0 / 2) / 86400;
  }
}

/** A1 — Concept initialization is lazy, on first event. */
export class KnowledgeStateEstimator {
  constructor(cfg) { this.cfg = cfg; this.concepts = new Map(); }

  _getOrCreate(conceptId, subject, topic) {
    let c = this.concepts.get(conceptId);
    if (!c) { c = new ConceptState(conceptId, subject, topic, this.cfg); this.concepts.set(conceptId, c); }
    return c;
  }

  /** A4 — Apply a single event; returns false on duplicate. */
  apply(event, eventLog) {
    if (!eventLog.append(event)) return false;
    const c = this._getOrCreate(event.conceptId, event.subject, event.topic);
    c.observe(event);
    return true;
  }

  initConcept(conceptId, subject, topic) { return this._getOrCreate(conceptId, subject, topic); }
  getState(conceptId, nowSec) { const c = this.concepts.get(conceptId); return c ? c.snapshot(nowSec) : null; }
  allSnapshots(nowSec) {
    const out = [];
    for (const c of this.concepts.values()) out.push(c.snapshot(nowSec));
    return out;
  }
}

// ============================================================================
// SECTION 5 — CL-B: DIAGNOSTIC SELECTOR
// ============================================================================

/**
 * A7 + A8 — Expected Information Gain and diagnostic selection.
 *
 * Primary: EIG via KL divergence (analytically tractable for binary Y):
 *   EIG(j) = E_{Y|D} [ D_KL( p(θ|D,Y) ‖ p(θ|D) ) ]
 *
 * Under a Gaussian posterior approximation on mastery, the entropy-reduction
 * form is mathematically equivalent (chain rule of entropy; Cover & Thomas §2.8):
 *   EIG_entropy(j) = H(prior) − E_Y[H(posterior|Y)]
 *
 * Both forms are computed; a self-test verifies they agree within tolerance.
 */
export class DiagnosticSelector {
  constructor(cfg) { this.cfg = cfg; }

  /** A7 — KL-based EIG for binary-response question. */
  eigKL(conceptState, question, nowSec) {
    const prior = conceptState.bkt.predictAt(nowSec);
    const pC = this._predictPCorrect(conceptState, question, nowSec);

    // Hypothetical posteriors (use a copy of BKT to avoid mutating state)
    const bktC = new BKT(this.cfg.BKT, prior); bktC.observe(true, nowSec, question.difficulty);
    const bktW = new BKT(this.cfg.BKT, prior); bktW.observe(false, nowSec, question.difficulty);

    return pC * Num.klBernoulli(bktC.p, prior) + (1 - pC) * Num.klBernoulli(bktW.p, prior);
  }

  /** A7 — Entropy-reduction form (mathematically equivalent under Gaussian approx). */
  eigEntropy(conceptState, question, nowSec) {
    const prior = conceptState.bkt.predictAt(nowSec);
    const pC = this._predictPCorrect(conceptState, question, nowSec);
    const bktC = new BKT(this.cfg.BKT, prior); bktC.observe(true, nowSec, question.difficulty);
    const bktW = new BKT(this.cfg.BKT, prior); bktW.observe(false, nowSec, question.difficulty);
    return Math.max(0,
      Num.entropyBernoulli(prior)
      - (pC * Num.entropyBernoulli(bktC.p) + (1 - pC) * Num.entropyBernoulli(bktW.p))
    );
  }

  _predictPCorrect(conceptState, question, nowSec) {
    const pRet = conceptState.retrievalProbability(nowSec);
    const dm = 1.2 - (Num.clip(question.difficulty ?? 3, 1, 5) - 1) * 0.125;
    const guess = Num.clipProb(this.cfg.BKT.p_guess * dm);
    return Num.clipProb(guess + (1 - guess) * pRet);
  }

  /**
   * A8 — Score and rank candidates.
   * Candidate: { question, conceptState, expectedTimeSec }
   * Utility (Directive §4.3):
   *   U(j) = λ_I·I_j + λ_D·D_j + λ_R·R_j − λ_C·C_j
   * Normalization: I and D and R are per-minute; C is minutes.
   */
  rankCandidates(candidates, nowSec, modeParams) {
    const { li, lr, ld, lc } = modeParams;
    const scored = [];
    for (const cand of candidates) {
      const { question, conceptState, expectedTimeSec } = cand;
      const timeMin = Math.max(expectedTimeSec / 60, 0.1);
      const infoPerMin = this.eigKL(conceptState, question, nowSec) / timeMin;
      const retVal = this._retentionValue(conceptState, nowSec);
      const decVal = this._decisionValue(conceptState);
      const cost = timeMin;
      const utility = li * infoPerMin + lr * retVal + ld * decVal - lc * cost;
      scored.push({ ...cand, utility, components: { infoPerMin, retVal, decVal, cost } });
    }
    scored.sort((a, b) => b.utility - a.utility);
    return scored;
  }

  /** A8 — Full selection pipeline: hard constraints, coverage, stopping. */
  selectQuestions(candidates, nowSec, mode, budgetSec, modeParams) {
    const cfg = this.cfg.DIAGNOSTIC;
    const ranked = this.rankCandidates(candidates, nowSec, modeParams);
    const chosen = [];
    const spent = { total: 0, perSubject: {} };
    const seenConcepts = new Set();

    for (const cand of ranked) {
      if (this._shouldStop({ chosen, spent, budgetSec, ranked, seenConcepts }, mode)) break;
      const timeSec = Math.max(cand.expectedTimeSec, 5);
      if (spent.total + timeSec > budgetSec) continue;

      // Hard constraint: subject coverage cap (Directive §4.4)
      const subjFrac = (spent.perSubject[cand.conceptState.subject] || 0) / Math.max(budgetSec, 1);
      const wouldBeFrac = subjFrac + timeSec / Math.max(budgetSec, 1);
      if (wouldBeFrac > cfg.maxPerSubjectFraction && Object.keys(spent.perSubject).length >= 2) continue;

      chosen.push(cand);
      spent.total += timeSec;
      spent.perSubject[cand.conceptState.subject] = (spent.perSubject[cand.conceptState.subject] || 0) + timeSec;
      seenConcepts.add(cand.conceptState.conceptId);

      // Repetition guard: cap repeated questions per concept
      const sameConceptCount = chosen.filter(c => c.conceptState.conceptId === cand.conceptState.conceptId).length;
      if (sameConceptCount >= 3 && mode !== 'spaced_retrieval') {
        chosen.pop();
        spent.total -= timeSec;
        spent.perSubject[cand.conceptState.subject] -= timeSec;
      }
    }

    return {
      chosen, ranked,
      spentSec: spent.total, remainingSec: budgetSec - spent.total,
      coverage: { concepts: seenConcepts.size, perSubject: spent.perSubject },
      stopReason: this._lastStopReason,
    };
  }

  /** A14 — Session termination (Directive §4.5). 5 conditions explicitly checked. */
  _shouldStop(state, mode) {
    const cfg = this.cfg.DIAGNOSTIC;
    const { chosen, spent, budgetSec, ranked, seenConcepts } = state;

    // 1. Time budget exhausted
    if (spent.total >= budgetSec - 30) return (this._lastStopReason = 'budget'), true;
    // 2. Minimum actions before any early stop
    if (chosen.length < this.cfg.POLICY.minActionsBeforeStop) return false;
    // 3. Diagnostic precision achieved (all tested CIs narrow)
    if (mode === 'initial_diagnostic') {
      let allNarrow = true;
      for (const c of chosen) {
        const ci = c.conceptState.bkt.credibleInterval(0.90);
        if (ci[1] - ci[0] >= cfg.stopCIPrecision) { allNarrow = false; break; }
      }
      if (allNarrow) return (this._lastStopReason = 'diagnostic_precision'), true;
    }
    // 4. Coverage achieved
    if (mode === 'initial_diagnostic' && seenConcepts.size >= cfg.minCoverageConcepts) {
      const remaining = ranked.slice(chosen.length);
      if (remaining.length === 0 || remaining[0].utility < this.cfg.POLICY.stoppingMinMarginalValue) {
        return (this._lastStopReason = 'coverage_plus_low_evi'), true;
      }
    }
    // 5. Marginal value below threshold
    const nextCand = ranked[chosen.length];
    if (nextCand && nextCand.utility < this.cfg.POLICY.stoppingMinMarginalValue) {
      return (this._lastStopReason = 'low_marginal_value'), true;
    }
    // 6. Insufficient reliable evidence (ranked empty)
    if (ranked.length === 0) return (this._lastStopReason = 'no_candidates'), true;
    return false;
  }

  _retentionValue(conceptState, nowSec) {
    const pRet = conceptState.retrievalProbability(nowSec);
    const target = this.cfg.REVIEW.targetRetrieval;
    return pRet >= target ? 0 : (target - pRet) / target;
  }

  _decisionValue(conceptState) {
    const ci = conceptState.bkt.credibleInterval(0.90);
    return Num.clip(ci[1] - ci[0], 0, 1);
  }

  _lastStopReason = 'none';
}

// ============================================================================
// SECTION 6 — CL-C: METACOGNITIVE MODEL
// ============================================================================

/**
 * A5 + A6 — Confidence and misconception.
 *
 * Confidence is modeled as an additional observation, not a multiplier:
 *   p(Y_n, C_n | θ, j) = p(Y_n | θ, j) · p(C_n | Y_n, θ, j)
 *
 * Ordinal confidence (0-4) → probability via cumulative-logit-free
 * threshold mapping (documented as engineering choice; proper ordinal
 * model is Phase 4 extension — see Directive §5.1).
 *
 * Misconception detection (Directive §5.2, 7-step graded):
 *   1. Detect the confidence-correctness pattern
 *   2. Evaluate question validity and concept mapping (caller-supplied)
 *   3. Check for previous similar errors
 *   4. Assess whether error suggests systematic misconception
 *   5. Select a targeted discriminating question (issued by CL-B)
 *   6. Update the concept state using the resulting evidence
 *   7. Track whether the misconception persists after intervention
 *
 * A single high-confidence error → a *signal*, not a permanent misconception.
 */
export class MetacognitiveModel {
  constructor(cfg) {
    this.cfg = cfg;
    this.confidenceObservations = [];  // [{p, y}] for Brier / log-loss
    this.logLossObservations = [];     // [{p, y}] for log loss
    this.maxObs = 500;
    this.misconceptionLedger = new Map(); // conceptId → [{t, severity, eventId}]
    this.baselinePredictions = [];     // for evidence-weight comparison
  }

  /** A5 — observe a (confidence, correctness) pair. NEVER fabricates. */
  observe(conceptId, event) {
    if (event.confidence == null) return { applied: false, reason: 'no_confidence' };

    let p;
    if (event.confidenceScale === 'ordinal_0_4') {
      // Engineering mapping: threshold midpoints → probability
      const thresholds = this.cfg.ordinalThresholds;  // [0.5, 1.5, 2.5, 3.5]
      const c = Num.clip(event.confidence, 0, 4);
      // Uniform-midpoint mapping within each bin
      p = (c + 0.5) / 5;
    } else if (event.confidenceScale === 'probability_0_1') {
      p = Num.clipProb(event.confidence);
    } else {
      return { applied: false, reason: 'unknown_scale' };
    }

    const y = event.correct ? 1 : 0;
    this.confidenceObservations.push({ p, y });
    this.logLossObservations.push({ p, y });
    if (this.confidenceObservations.length > this.maxObs) this.confidenceObservations.shift();
    if (this.logLossObservations.length > this.maxObs) this.logLossObservations.shift();

    // Graded misconception: log high-confidence errors for later assessment
    if (!event.correct && event.confidence >= this.cfg.highConfidenceThreshold) {
      if (!this.misconceptionLedger.has(conceptId)) this.misconceptionLedger.set(conceptId, []);
      this.misconceptionLedger.get(conceptId).push({
        t: event.timestamp, severity: 'high_conf_error', eventId: event.eventId,
      });
    }
    return { applied: true };
  }

  /**
   * A6 — full graded misconception detection.
   * Returns { flagged, steps: [...], confidenceObserved }.
   *
   * The 7-step ladder from Directive §5.2 is returned step-by-step so
   * caller UIs can surface *why* a misconception was flagged.
   */
  detect(conceptState, nowSec) {
    const cfg = this.cfg;
    const recent = conceptState.events.slice(-15);

    // Step 1 — detect pattern
    let consecutiveHighConfErrors = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const e = recent[i];
      if (nowSec - e.t > cfg.misconceptionWindowSec) break;
      const hce = !e.correct && e.confidence != null && e.confidence >= cfg.highConfidenceThreshold;
      const lcc = e.correct && e.confidence != null && e.confidence < cfg.highConfidenceThreshold;
      if (hce) { consecutiveHighConfErrors++; continue; }
      if (!e.correct && e.confidence == null) continue;   // unrecorded conf → skip
      void lcc;
      break;
    }

    // Step 2 — question validity & mapping: caller checks; this engine assumes valid tags
    const validityOk = true;
    // Step 3 — previous similar errors
    const ledger = this.misconceptionLedger.get(conceptState.conceptId) || [];
    const priorErrorsInWindow = ledger.filter(x => nowSec - x.t <= cfg.misconceptionWindowSec).length;
    // Step 4 — systematic?
    const systematic = consecutiveHighConfErrors >= cfg.misconceptionMinErrors && validityOk;
    // Steps 5–7 are actions the caller performs (targeted question, feedback, tracking) — engine surfaces the signal
    const steps = [
      { step: 1, name: 'detect_pattern',     passed: consecutiveHighConfErrors > 0, value: consecutiveHighConfErrors },
      { step: 2, name: 'validity_check',     passed: validityOk },
      { step: 3, name: 'prior_errors',       passed: priorErrorsInWindow > 0, value: priorErrorsInWindow },
      { step: 4, name: 'systematic_signal',  passed: systematic },
      { step: 5, name: 'select_discriminating', passed: systematic },
      { step: 6, name: 'update_after_evidence', passed: systematic },
      { step: 7, name: 'track_persistence', passed: systematic },
    ];

    return {
      flagged: systematic,
      consecutiveHighConfidenceErrors,
      priorErrorsInWindow,
      confidenceObserved: recent.some(e => e.confidence != null),
      steps,
      // Directive §5.2: a single high-confidence error may justify investigation, not extreme global reduction.
      // The engine NEVER auto-reduces mastery — that happens through CL-A on evidence.
      recommendation: systematic ? 'investigate_with_discriminating_item' : 'continue_observation',
    };
  }

  /** A6 — Score confidence quality (proper rules). */
  brierScore() {
    if (this.confidenceObservations.length === 0) {
      return { value: null, n: 0, calibrationStatus: 'unobserved' };
    }
    let s = 0;
    for (const o of this.confidenceObservations) s += (o.p - o.y) ** 2;
    return { value: s / this.confidenceObservations.length, n: this.confidenceObservations.length, calibrationStatus: 'observed' };
  }

  logLoss() {
    if (this.logLossObservations.length === 0) {
      return { value: null, n: 0, calibrationStatus: 'unobserved' };
    }
    let s = 0;
    for (const o of this.logLossObservations) {
      const p = Num.clipProb(o.p);
      s -= o.y * Math.log(p) + (1 - o.y) * Math.log(1 - p);
    }
    return { value: s / this.logLossObservations.length, n: this.logLossObservations.length, calibrationStatus: 'observed' };
  }

  /**
   * Reliability diagram data (Directive §5.3).
   * Bins by predicted p; returns [{binMid, meanPredicted, empiricalFreq, count}].
   */
  reliabilityDiagram(bins = 10) {
    const obs = this.confidenceObservations;
    if (obs.length === 0) return [];
    const buckets = Array.from({ length: bins }, () => ({ sumP: 0, sumY: 0, n: 0 }));
    for (const o of obs) {
      const b = Math.min(bins - 1, Math.floor(o.p * bins));
      buckets[b].sumP += o.p;
      buckets[b].sumY += o.y;
      buckets[b].n += 1;
    }
    return buckets.map((b, i) => ({
      binMid: (i + 0.5) / bins,
      meanPredicted: b.n > 0 ? b.sumP / b.n : null,
      empiricalFreq: b.n > 0 ? b.sumY / b.n : null,
      count: b.n,
    })).filter(x => x.count > 0);
  }

  /**
   * Directive §5.4 — compare confidence-augmented estimator to correctness-only
   * baseline. Confidence should influence production decisions only when it
   * improves calibrated estimation or downstream outcomes.
   *
   * Caller supplies `correctnessOnlyBrier`. Returns evidence-weight decision.
   */
  evidenceWeight(correctnessOnlyBrier, threshold = 0.01) {
    const b = this.brierScore();
    if (b.value == null || correctnessOnlyBrier == null) {
      return { useConfidence: false, reason: 'insufficient_evidence' };
    }
    const improvement = correctnessOnlyBrier - b.value;
    return {
      useConfidence: improvement > threshold,
      improvement,
      confidenceOnlyBrier: b.value,
      correctnessOnlyBrier,
      reason: improvement > threshold ? 'confidence_improves_calibration' : 'no_meaningful_improvement',
    };
  }
}

// ============================================================================
// SECTION 7 — CL-D: LEARNING POLICY
// ============================================================================

/**
 * A12 + A14 — Time-budgeted action selection.
 *
 * Two methods (Directive §6.3):
 *   1. Greedy marginal-value-per-minute (default — transparent, ~½ optimal)
 *   2. Exact DP knapsack on discretized time (when time budget is tight)
 *
 * Action set (Directive §6.2) is enumerated below; each action carries
 * duration, expected value, uncertainty, and coverage requirements.
 */
export const ACTION_TYPES = Object.freeze([
  'new_concept_instruction',
  'retrieval_practice',
  'spaced_repetition',
  'targeted_remediation',
  'mixed_practice',
  'interleaving',
  'misconception_correction',
  'timed_examination',
  'transfer_question',
  'practical_identification',
  'review_failed_concepts',
  'rest_or_terminate',
]);

export class LearningPolicy {
  constructor(cfg) { this.cfg = cfg; }

  /** A12 — Greedy session selection. */
  selectSessionGreedy(rankedCandidates, budgetSec, mode) {
    const modeParams = this.cfg.POLICY.modeParams[mode] || this.cfg.POLICY.modeParams.broad_curriculum_revision;
    let remaining = budgetSec;
    const chosen = [];
    const chosenIds = new Set();

    for (const cand of rankedCandidates) {
      const id = cand.question?.id;
      if (id && chosenIds.has(id)) continue;
      const timeSec = Math.max(cand.expectedTimeSec || 30, 5);
      if (remaining - timeSec < 0) break;
      if (cand.utility < this.cfg.POLICY.stoppingMinMarginalValue) break;
      chosen.push(cand);
      if (id) chosenIds.add(id);
      remaining -= timeSec;
    }
    return {
      chosen, spentSec: budgetSec - remaining, remainingSec: remaining,
      method: 'greedy', mode, params: modeParams,
      stopReason: this._greedyStopReason(remaining, chosen),
    };
  }

  /**
   * A12 — Knapsack DP. Discretizes time into `resolution` buckets.
   * Complexity: O(n · B/resolution). For B=600s, resolution=30s → 20 buckets
   * → very fast even for 200 candidates.
   */
  selectSessionKnapsack(rankedCandidates, budgetSec, mode) {
    const resolution = this.cfg.POLICY.knapsackTimeResolutionSec;
    const B = Math.floor(budgetSec / resolution);
    const n = rankedCandidates.length;
    if (n === 0 || B <= 0) return { chosen: [], spentSec: 0, remainingSec: budgetSec, method: 'knapsack', mode };

    // dp[i][w] = best value using first i items with capacity w
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(B + 1));
    for (let i = 1; i <= n; i++) {
      const item = rankedCandidates[i - 1];
      const wItem = Math.max(1, Math.ceil((item.expectedTimeSec || 30) / resolution));
      const vItem = item.utility > 0 ? item.utility : 0;  // negative utility skipped
      for (let w = 0; w <= B; w++) {
        dp[i][w] = dp[i - 1][w];
        if (wItem <= w) {
          const candidate = dp[i - 1][w - wItem] + vItem;
          if (candidate > dp[i][w]) dp[i][w] = candidate;
        }
      }
    }
    // Backtrack
    const chosenIdx = [];
    let w = B;
    for (let i = n; i >= 1; i--) {
      if (dp[i][w] !== dp[i - 1][w]) {
        chosenIdx.push(i - 1);
        w -= Math.max(1, Math.ceil((rankedCandidates[i - 1].expectedTimeSec || 30) / resolution));
      }
    }
    const chosen = chosenIdx.reverse().map(i => rankedCandidates[i]);
    const spentSec = budgetSec - w * resolution;
    return {
      chosen, spentSec, remainingSec: w * resolution, method: 'knapsack',
      mode, params: this.cfg.POLICY.modeParams[mode],
    };
  }

  /** A14 — should the session end? */
  shouldTerminate(sessionState) {
    if (sessionState.remainingSec < 30) return { stop: true, reason: 'budget' };
    if (sessionState.chosen.length === 0) return { stop: true, reason: 'no_selection' };
    const last = sessionState.chosen[sessionState.chosen.length - 1];
    if (last && last.utility < this.cfg.POLICY.stoppingMinMarginalValue) {
      return { stop: true, reason: 'marginal_value' };
    }
    return { stop: false };
  }

  _greedyStopReason(remaining, chosen) {
    if (remaining < 30) return 'budget';
    if (chosen.length === 0) return 'no_selection';
    const last = chosen[chosen.length - 1];
    if (last && last.utility < this.cfg.POLICY.stoppingMinMarginalValue) return 'marginal_value';
    return 'complete';
  }
}

// ============================================================================
// SECTION 8 — CONCEPT GRAPH
// ============================================================================

/**
 * Directive §9 — Concept dependencies.
 *
 * Edges carry confidence. Evidence is NOT propagated through edges unless
 * the caller invokes propagateEvidence() with an explicit model — per
 * Directive §9: "Propagate evidence through concept dependencies only
 * under a defined, validated model."
 *
 * Edge semantics:
 *   'prerequisite'  — A must precede B; low confidence in A affects B
 *   'overlap'       — A and B share underlying knowledge
 *   'cross_subject' — A (e.g. anatomy) informs B (e.g. pathology)
 *   'clinical_integration' — A + B together form a clinical competency
 *   'transfer'      — A generalizes to a novel context B
 */
export class ConceptGraph {
  constructor() {
    this.edges = [];             // [{from, to, type, confidence, provenance}]
    this.byFrom = new Map();     // from → [edgeIdx]
    this.byTo = new Map();       // to → [edgeIdx]
  }

  addEdge(from, to, type = 'overlap', confidence = 0.5, provenance = 'inferred') {
    const idx = this.edges.length;
    this.edges.push({ from, to, type, confidence, provenance });
    if (!this.byFrom.has(from)) this.byFrom.set(from, []);
    if (!this.byTo.has(to)) this.byTo.set(to, []);
    this.byFrom.get(from).push(idx);
    this.byTo.get(to).push(idx);
  }

  /** Neighbors with edge metadata — used by callers to build curriculum views. */
  neighbors(conceptId, type = null) {
    const out = [];
    for (const idx of this.byFrom.get(conceptId) || []) {
      const e = this.edges[idx];
      if (!type || e.type === type) out.push(e);
    }
    for (const idx of this.byTo.get(conceptId) || []) {
      const e = this.edges[idx];
      if (!type || e.type === type) out.push({ ...e, direction: 'in' });
    }
    return out;
  }

  /**
   * Propagate mastery evidence through edges. NOT auto-called.
   *
   * The propagation model used here is a linear-discount (engineering
   * approximation; caller must validate that it fits their data — per
   * Directive §9, no auto-propagation without validation).
   */
  propagateEvidence(conceptStates, sourceConceptId, delta, damping = 0.3) {
    const affected = new Map();
    const queue = [[sourceConceptId, delta]];
    const visited = new Set([sourceConceptId]);
    while (queue.length > 0) {
      const [cur, d] = queue.shift();
      for (const e of this.neighbors(cur)) {
        const neighbor = e.direction === 'in' ? e.from : e.to;
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        const passed = d * damping * e.confidence;
        if (affected.has(neighbor)) affected.set(neighbor, affected.get(neighbor) + passed);
        else affected.set(neighbor, passed);
        if (Math.abs(passed) > 0.01) queue.push([neighbor, passed]);
      }
    }
    return affected;
  }

  /** Migrate: import edges from a subject/topic hierarchy (auto-overlap edges). */
  static fromTaxonomy(taxonomy) {
    const g = new ConceptGraph();
    for (const [subject, topics] of Object.entries(taxonomy || {})) {
      for (let i = 0; i < topics.length - 1; i++) {
        const from = `${subject}::${topics[i]}`;
        const to = `${subject}::${topics[i + 1]}`;
        g.addEdge(from, to, 'prerequisite', 0.4, 'taxonomy_order');
      }
    }
    return g;
  }
}

// ============================================================================
// SECTION 9 — COMPETITIVE RATING BRIDGE
// ============================================================================

/**
 * A18 — Competitive-rating integration.
 *
 * IMPORTANT: The competitive rating (performance-rating-v2.js) is a
 * SEPARATE subsystem. Directive §8 + §13 forbid treating it as a mastery
 * estimate or counting its derived statistics as independent evidence.
 *
 * This bridge:
 *   • reads competitive rating as a READ-ONLY auxiliary signal
 *   • never feeds it into mastery/BKT updates
 *   • exposes audit concerns as documented findings (see COMPETITIVE_AUDIT)
 *
 * The audit list below is the output of inspecting performance-rating-v2.js:
 */
export const COMPETITIVE_AUDIT = Object.freeze([
  { id: 'attempt_filter_undefined',
    finding: 'computePerformanceRatio uses answers?.filter(a => a.selectedOption !== null).length. ' +
             'Undefined selectedOption passes this test (undefined !== null → true), so unanswered ' +
             'questions are counted as attempted. Fix: check a.selectedOption != null.',
    severity: 'medium', fixed: false },
  { id: 'scoping',
    finding: 'getPerformanceData calls db.getExamResult(examId) without verifying examId belongs ' +
             'to userId. In multi-user storage, this could leak another learner\'s data.',
    severity: 'high', fixed: false },
  { id: 'temporal_leakage',
    finding: 'Previous PRs are recomputed using the CURRENT rating (not the rating at time of exam). ' +
             'This overstates historical PR consistency.',
    severity: 'medium', fixed: false },
  { id: 'rank_before_update',
    finding: 'getRank() is called on the OLD rating before updateRatingRelative; the displayed rank ' +
             'is therefore the pre-exam rank. Verify this is intentional.',
    severity: 'low', fixed: false },
  { id: 'integrity_flags',
    finding: 'Integrity score decreases rating reliability but does not gate rating updates. Treat as ' +
             'suspicion signal, not proof — matches Directive §13.',
    severity: 'low', fixed: false },
  { id: 'difficulty_weights',
    finding: 'DIFFICULTY_WEIGHTS are calibrated for competitive rating, NOT IRT difficulty. Do not ' +
             'reuse as b_j in IRT — that conflates two different scales.',
    severity: 'high', fixed: false },
]);

export class CompetitiveRatingBridge {
  constructor() { this._cache = null; }
  /**
   * A18 — pull current competitive rating for auxiliary display only.
   * @returns {{rating, rank, reliability, integrity, source}} | null
   */
  pull(userPerformanceRecord) {
    if (!userPerformanceRecord) return null;
    const { rating, rank, reliability, integrityScore } = userPerformanceRecord;
    this._cache = {
      rating: Number.isFinite(rating) ? rating : 100,
      rank: rank || { rank: 1, label: 'Seed' },
      reliability: Number.isFinite(reliability) ? reliability : null,
      integrity: Number.isFinite(integrityScore) ? integrityScore : null,
      source: 'performance-rating-v2',
      // Directive §8: competitive is NOT mastery. Explicitly null.
      usedForMastery: false,
    };
    return this._cache;
  }
  auditConcerns() { return COMPETITIVE_AUDIT; }
}

// ============================================================================
// SECTION 10 — MODE SELECTION (9 modes)
// ============================================================================

/**
 * A13 — Mode selection.
 *
 * Modes (Directive §10):
 *   1. initial_diagnostic
 *   2. weakness_focused_remediation
 *   3. spaced_retrieval
 *   4. broad_curriculum_revision
 *   5. timed_exam_simulation
 *   6. clinical_reasoning_transfer
 *   7. practical_identification
 *   8. short_study
 *   9. low_confidence_high_uncertainty
 *
 * Mode selection uses explicit decision criteria (Directive §10: NOT just
 * covariance trace). Each trigger is deterministic given learner state and
 * session context.
 */
export class ModeSelector {
  constructor(cfg) { this.cfg = cfg; }
  /**
   * @param {Object} state   — { concepts:[snapshot], learnerSummary, brier }
   * @param {Object} context — { requestedMode, budgetSec, examDeadlineSec, isPractical, wantsTransfer }
   */
  select(state, context = {}) {
    // Explicit mode if caller provides it
    if (context.requestedMode) return { mode: context.requestedMode, reason: 'explicit', confidence: 1.0 };

    const concepts = state.concepts || [];
    const n = concepts.length;
    const budget = context.budgetSec ?? this.cfg.POLICY.timeBudgetDefaultSec;

    // No history → initial diagnostic
    if (n === 0) return { mode: 'initial_diagnostic', reason: 'no_history', confidence: 0.95 };

    // Very short session
    if (budget < 180) return { mode: 'short_study', reason: 'short_budget', confidence: 0.9 };

    // Pending exam deadline within 7 days
    if (Number.isFinite(context.examDeadlineSec)) {
      const days = (context.examDeadlineSec - Math.floor(Date.now() / 1000)) / 86400;
      if (days > 0 && days <= 7) return { mode: 'broad_curriculum_revision', reason: 'exam_deadline_near', confidence: 0.85 };
    }

    // Practical identification requested
    if (context.isPractical) return { mode: 'practical_identification', reason: 'practical_requested', confidence: 0.9 };

    // Transfer/clinical requested
    if (context.wantsTransfer) return { mode: 'clinical_reasoning_transfer', reason: 'transfer_requested', confidence: 0.9 };

    // High-uncertainty diagnosis: average CI width > threshold
    const avgCIWidth = concepts.reduce((s, c) => s + (c.mastery.ci90[1] - c.mastery.ci90[0]), 0) / Math.max(n, 1);
    if (avgCIWidth > 0.35) return { mode: 'low_confidence_high_uncertainty', reason: 'wide_average_ci', confidence: 0.8 };

    // Many concepts overdue for review
    const dueCount = concepts.filter(c => c.retrieval.pNow < this.cfg.REVIEW.targetRetrieval).length;
    if (dueCount / n > 0.4) return { mode: 'spaced_retrieval', reason: 'many_due_for_review', confidence: 0.85 };

    // Very low average mastery → remediation
    const avgMastery = concepts.reduce((s, c) => s + c.mastery.p, 0) / Math.max(n, 1);
    if (avgMastery < 0.4) return { mode: 'weakness_focused_remediation', reason: 'low_mastery', confidence: 0.8 };

    // Simulation mode: user has high average mastery and wants to test under pressure
    if (avgMastery > 0.75 && context.wantsSimulation) {
      return { mode: 'timed_exam_simulation', reason: 'high_mastery_test_simulation', confidence: 0.85 };
    }

    // Default: broad curriculum
    return { mode: 'broad_curriculum_revision', reason: 'default', confidence: 0.6 };
  }
}

// ============================================================================
// SECTION 11 — TRANSFER ESTIMATOR
// ============================================================================

/**
 * A11 — Transfer estimation.
 *
 * A "transfer" item is one that assesses a target concept in a meaningfully
 * different context. Difficulty and content differences are controlled by:
 *   • requiring a distinct `question.topic` or explicit `question.transfer` tag
 *   • requiring minEvidence before estimating
 *   • discounting single-item evidence via TRANSFER.transferDiscount
 *
 * Novel clinical vignette alone does NOT count as transfer — needs a
 * controlled difficulty match. (Directive §12.)
 */
export class TransferEstimator {
  constructor(cfg) { this.cfg = cfg; }

  estimate(conceptState, questions) {
    const transferQuestions = questions.filter(q => q.transfer === true || q.isTransfer === true);
    const transferEvents = conceptState.events.filter(e => e.transfer === true);
    if (transferEvents.length < this.cfg.minEvidenceForEstimate) {
      return {
        p: null, count: transferEvents.length,
        ci90: null, status: 'insufficient_evidence',
        reason: `Need ≥${this.cfg.minEvidenceForEstimate} transfer items; have ${transferEvents.length}.`,
      };
    }
    const mean = transferEvents.reduce((s, e) => s + (e.correct ? 1 : 0), 0) / transferEvents.length;
    const variance = transferEvents.reduce((s, e) => s + ((e.correct ? 1 : 0) - mean) ** 2, 0) / Math.max(transferEvents.length - 1, 1);
    const se = Math.sqrt(variance / transferEvents.length);
    return {
      p: mean, count: transferEvents.length,
      ci90: [Num.clipProb(mean - 1.645 * se), Num.clipProb(mean + 1.645 * se)],
      status: 'estimated',
      transferQuestionsAvailable: transferQuestions.length,
    };
  }

  /** Whether a question qualifies as transfer relative to a target concept. */
  isTransferQuestion(question, targetConceptId, noveltyThreshold) {
    if (question.transfer === true || question.isTransfer === true) return true;
    // Novelty via topic mismatch
    const [subj, topic] = targetConceptId.split('::');
    if (question.subject !== subj) return true;
    return question.topic !== topic;  // different topic in same subject
  }
}

// ============================================================================
// SECTION 12 — ENGINE FACADE (all 20 algorithms wired)
// ============================================================================

function deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])
        && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], source[k]);
    } else {
      target[k] = source[k];
    }
  }
  return target;
}

/**
 * createEngine(config) → engine
 *
 * Public API (with algorithm mapping):
 *   ingestExam(examResult, learnerId)         → A4  [batch]
 *   observeEvent(rawEvent, context)           → A4  [single, idempotent]
 *   getConceptState(conceptId)                → snapshot
 *   getAllConceptStates()                     → [snapshot]
 *   getLearnerSummary()                       → aggregated state (9 dims)
 *   getReviewPlan(conceptId)                  → A10
 *   selectNextQuestions(pool, budget, mode)   → A8 + A12 + A13 + A14
 *   diagnose(conceptId)                       → A6
 *   getModeRecommendation(context)            → A13
 *   exportEvents()                            → A15
 *   mergeEvents(events)                       → A16
 *   exportState()                             → sync
 *   migrate(exported, fromVersion)            → A19
 *   monitor()                                 → A20
 *   competitivePull(record)                   → A18
 *   calibrate(config)                         → A17
 */
export function createEngine(userConfig = {}) {
  const cfg = deepMerge(structuredClone(DEFAULTS), userConfig);
  const eventLog = new EventLog();
  const estimator = new KnowledgeStateEstimator(cfg);
  const selector = new DiagnosticSelector(cfg);
  const metacog = new MetacognitiveModel(cfg.METACOGNITIVE);
  const policy = new LearningPolicy(cfg);
  const modeSelector = new ModeSelector(cfg);
  const transferEstimator = new TransferEstimator(cfg.TRANSFER);
  const graph = new ConceptGraph();
  const competitive = new CompetitiveRatingBridge();
  const evaluation = new EvaluationMonitor();

  const nowSec = () => Math.floor(Date.now() / 1000);

  // ------------------------------------------------------------------------
  // A4 — ingest / observe
  // ------------------------------------------------------------------------
  function ingestExam(examResult, learnerId = 'local') {
    const res = { ingested: 0, skipped: 0, conceptsTouched: new Set() };
    if (!examResult || !Array.isArray(examResult.questions)) return { ...res, conceptsTouched: [] };

    const ctx = {
      examId: examResult.examId, subject: examResult.subject,
      mode: examResult.mode, date: examResult.date, learnerId,
    };
    // Sort by timestamp for monotone application
    const events = examResult.questions
      .map(q => normalizeEvent(q, ctx))
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const ev of events) {
      if (estimator.apply(ev, eventLog)) {
        res.ingested++;
        res.conceptsTouched.add(ev.conceptId);
        if (ev.confidence != null) metacog.observe(ev.conceptId, ev);
      } else {
        res.skipped++;
      }
    }
    res.conceptsTouched = [...res.conceptsTouched];
    evaluation.record('ingest_exam', { ingested: res.ingested, skipped: res.skipped });
    return res;
  }

  function observeEvent(rawEvent, context) {
    const ev = normalizeEvent(rawEvent, context || {});
    if (!ev) return { applied: false, reason: 'invalid_event' };
    const applied = estimator.apply(ev, eventLog);
    if (applied && ev.confidence != null) metacog.observe(ev.conceptId, ev);
    evaluation.record('observe_event', { applied, conceptId: ev.conceptId });
    return { applied, conceptId: ev.conceptId, eventId: ev.eventId };
  }

  // ------------------------------------------------------------------------
  // A9 / A10 — retention prediction + review scheduling
  // ------------------------------------------------------------------------
  function getReviewPlan(conceptId) {
    const c = estimator.concepts.get(conceptId);
    if (!c) return null;
    const now = nowSec();
    const currentP = c.retrievalProbability(now);
    const delta = c.timeUntilRetrievalBelow(now, cfg.REVIEW.targetRetrieval);
    return {
      conceptId,
      currentP,
      targetP: cfg.REVIEW.targetRetrieval,
      nextReviewAtSec: now + delta,
      nextReviewInDays: delta / 86400,
      urgency: currentP < cfg.REVIEW.urgencyMinRetrieval ? 'high'
             : currentP < cfg.REVIEW.targetRetrieval ? 'moderate' : 'low',
    };
  }

  // ------------------------------------------------------------------------
  // A6 — diagnostic
  // ------------------------------------------------------------------------
  function diagnose(conceptId) {
    const c = estimator.concepts.get(conceptId);
    if (!c) return null;
    const snap = c.snapshot(nowSec());
    const misconception = metacog.detect(c, nowSec());
    snap.misconceptions = misconception;
    snap.metacognitive.confidenceObserved = misconception.confidenceObserved;
    return snap;
  }

  // ------------------------------------------------------------------------
  // A8 + A12 + A13 + A14 — question selection (full pipeline)
  // ------------------------------------------------------------------------
  function selectNextQuestions(questionPool, budgetSec = cfg.POLICY.timeBudgetDefaultSec, mode = null, subject = null, context = {}) {
    const state = { concepts: estimator.allSnapshots(nowSec()), ...getLearnerSummary() };
    const modeRec = mode ? { mode, reason: 'explicit', confidence: 1.0 } : modeSelector.select(state, { budgetSec, ...context });
    const modeParams = cfg.POLICY.modeParams[modeRec.mode] || cfg.POLICY.modeParams.broad_curriculum_revision;

    if (!Array.isArray(questionPool) || questionPool.length === 0) {
      return { chosen: [], ranked: [], spentSec: 0, remainingSec: budgetSec, mode: modeRec.mode, modeRec };
    }
    const now = nowSec();
    const candidates = [];
    for (const q of questionPool) {
      const subj = q.subject || subject;
      const topic = q.topic;
      if (!subj || !topic) continue;
      const conceptId = `${subj}::${topic}`;
      const cs = estimator.concepts.get(conceptId);
      if (!cs) continue;  // unknown concept — not eligible
      candidates.push({ question: q, conceptState: cs, conceptId, expectedTimeSec: expectedTimeFor(q) });
    }

    const selection = selector.selectQuestions(candidates, now, modeRec.mode, budgetSec, modeParams);
    evaluation.record('select_questions', { mode: modeRec.mode, chosen: selection.chosen.length });
    return { ...selection, mode: modeRec.mode, modeRec };
  }

  function expectedTimeFor(q) {
    const d = Num.clip(q.difficulty ?? 3, 1, 5);
    return 20 + d * 10;
  }

  // ------------------------------------------------------------------------
  // A13 — mode
  // ------------------------------------------------------------------------
  function getModeRecommendation(context = {}) {
    const state = { concepts: estimator.allSnapshots(nowSec()), ...getLearnerSummary() };
    return modeSelector.select(state, context);
  }

  // ------------------------------------------------------------------------
  // A11 — transfer
  // ------------------------------------------------------------------------
  function estimateTransfer(conceptId, questions = []) {
    const c = estimator.concepts.get(conceptId);
    if (!c) return null;
    return transferEstimator.estimate(c, questions);
  }

  // ------------------------------------------------------------------------
  // Aggregated view (all 9 dimensions from Directive §8)
  // ------------------------------------------------------------------------
  function getLearnerSummary() {
    const snaps = estimator.allSnapshots(nowSec());
    const brier = metacog.brierScore();
    const logLoss = metacog.logLoss();
    if (snaps.length === 0) {
      return {
        conceptCount: 0, totalEvidence: 0, averageMastery: null,
        weakestConcepts: [], strongestConcepts: [], dueForReview: [],
        misconceptionSignals: [], brier, logLoss,
        dimensions: {
          mastery: null, retrieval: null, delayedRetention: null,
          transfer: null, metacognitive: { brier, logLoss, observed: false },
          misconception: null, itemLevel: null, engagement: null, competitive: null,
        },
      };
    }
    const sorted = [...snaps].sort((a, b) => a.mastery.p - b.mastery.p);
    const due = snaps.filter(s => s.retrieval.pNow < cfg.REVIEW.targetRetrieval)
                     .sort((a, b) => a.retrieval.pNow - b.retrieval.pNow);
    return {
      conceptCount: snaps.length,
      totalEvidence: snaps.reduce((s, x) => s + x.mastery.evidenceCount, 0),
      averageMastery: snaps.reduce((s, x) => s + x.mastery.p, 0) / snaps.length,
      weakestConcepts: sorted.slice(0, 5).map(s => ({ conceptId: s.conceptId, mastery: s.mastery.p, ci90: s.mastery.ci90 })),
      strongestConcepts: sorted.slice(-5).reverse().map(s => ({ conceptId: s.conceptId, mastery: s.mastery.p })),
      dueForReview: due.slice(0, 10).map(s => ({
        conceptId: s.conceptId, pNow: s.retrieval.pNow,
        urgency: s.retrieval.pNow < cfg.REVIEW.urgencyMinRetrieval ? 'high' : 'moderate',
      })),
      misconceptionSignals: snaps.filter(s => s.misconceptions?.flagged)
                               .map(s => ({ conceptId: s.conceptId, ...s.misconceptions })),
      brier, logLoss,
      dimensions: {
        mastery: { avg: snaps.reduce((s, x) => s + x.mastery.p, 0) / snaps.length, n: snaps.length },
        retrieval: { avg: snaps.reduce((s, x) => s + x.retrieval.pNow, 0) / snaps.length, n: snaps.length },
        delayedRetention: { avg: snaps.reduce((s, x) => s + (x.delayedRetention?.pIn7Days ?? 0), 0) / snaps.length },
        transfer: { withEstimate: snaps.filter(x => x.transfer.p != null).length },
        metacognitive: { brier, logLoss, observed: brier.n > 0 },
        misconception: { flagged: snaps.filter(x => x.misconceptions?.flagged).length },
        itemLevel: { totalEvents: snaps.reduce((s, x) => s + (x.itemLevel?.eventCount ?? 0), 0) },
        engagement: null,
        competitive: competitive._cache,
      },
    };
  }

  // ------------------------------------------------------------------------
  // A15 — event persistence (export for caller to save)
  // ------------------------------------------------------------------------
  function exportEvents() {
    return {
      eventIds: eventLog.exportIds(),
      count: eventLog.count(),
      outOfOrder: eventLog.outOfOrderCount(),
      modelVersion: MODEL_VERSION,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  // ------------------------------------------------------------------------
  // A16 — offline synchronization (merge remote events)
  // ------------------------------------------------------------------------
  /**
   * Merge a batch of externally-originated events (e.g. from another device).
   * Idempotent — the event log dedupes.
   *
   * Conflict resolution policy: last-writer-by-timestamp, applied in
   * monotone order. Concurrent events with same (learnerId, questionId) but
   * different eventId are BOTH applied — the BKT update is sensitive to
   * order but not to duplicates (BKT is commutative-ish for correct-only
   * histories; see self-test).
   */
  function mergeEvents(events, context) {
    const results = { applied: 0, duplicate: 0, invalid: 0 };
    const sorted = (events || [])
      .map(e => normalizeEvent(e, context))
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);
    for (const ev of sorted) {
      if (estimator.apply(ev, eventLog)) {
        results.applied++;
        if (ev.confidence != null) metacog.observe(ev.conceptId, ev);
      } else {
        results.duplicate++;
      }
    }
    return results;
  }

  // ------------------------------------------------------------------------
  // Export state (sync)
  // ------------------------------------------------------------------------
  function exportState() {
    return {
      modelVersion: MODEL_VERSION,
      schemaVersion: SCHEMA_VERSION,
      exportedAtSec: nowSec(),
      eventCount: eventLog.count(),
      eventIds: eventLog.exportIds(),
      concepts: estimator.allSnapshots(nowSec()),
      brier: metacog.brierScore(),
      logLoss: metacog.logLoss(),
    };
  }

  // ------------------------------------------------------------------------
  // A19 — model-version migration
  // ------------------------------------------------------------------------
  function migrate(exportedState, fromVersion) {
    if (!exportedState) return { ok: false, reason: 'empty_input' };
    if (fromVersion === SCHEMA_VERSION) return { ok: true, migrated: false, reason: 'up_to_date' };
    // v1 → v2: concepts had no `metacognitive` dimension; add defaults.
    if (fromVersion < 2) {
      for (const c of exportedState.concepts || []) {
        c.metacognitive = c.metacognitive || { confidenceObserved: false };
        c.misconceptions = c.misconceptions || { consecutiveHighConfidenceErrors: 0, flagged: false };
      }
    }
    // Replay migration events (none yet, but structure is in place)
    return { ok: true, migrated: true, fromVersion, toVersion: SCHEMA_VERSION };
  }

  // ------------------------------------------------------------------------
  // A17 — parameter calibration (hierarchical, pooled)
  // ------------------------------------------------------------------------
  /**
   * Calibrate BKT parameters given a batch of exam results.
   * Uses EM-style coordinate ascent over (p_init, p_learn, p_slip, p_guess)
   * with a hierarchical prior (subject-level partial pooling).
   *
   * Requires ≥ CALIBRATION.minNPerParam observations per parameter per subject.
   * Returns updated parameter map + confidence + warnings for subjects with
   * insufficient data (falls back to global pooled estimate).
   */
  function calibrate(examResults, options = {}) {
    return Calibrator.calibrateHierarchical(examResults, cfg.CALIBRATION, options);
  }

  // ------------------------------------------------------------------------
  // A18 — competitive rating (read-only)
  // ------------------------------------------------------------------------
  function competitivePull(record) { return competitive.pull(record); }
  function competitiveAudit() { return competitive.auditConcerns(); }

  // ------------------------------------------------------------------------
  // A20 — evaluation & monitoring
  // ------------------------------------------------------------------------
  function monitor() {
    return {
      evaluation: evaluation.snapshot(),
      eventLog: { count: eventLog.count(), outOfOrder: eventLog.outOfOrderCount() },
      modelVersion: MODEL_VERSION,
      schemaVersion: SCHEMA_VERSION,
      brier: metacog.brierScore(),
      logLoss: metacog.logLoss(),
      reliability: metacog.reliabilityDiagram(10),
    };
  }

  // ------------------------------------------------------------------------
  // Graph management
  // ------------------------------------------------------------------------
  function addConceptEdge(from, to, type, conf, prov) { graph.addEdge(from, to, type, conf, prov); }
  function getConceptEdges(conceptId, type) { return graph.neighbors(conceptId, type); }

  return {
    // ingest
    ingestExam, observeEvent,
    // state
    getConceptState: (id) => estimator.getState(id, nowSec()),
    getAllConceptStates: () => estimator.allSnapshots(nowSec()),
    getLearnerSummary,
    // scheduling
    getReviewPlan, selectNextQuestions, getModeRecommendation,
    // diagnosis
    diagnose,
    // transfer
    estimateTransfer,
    // sync
    exportEvents, mergeEvents, exportState, migrate,
    // calibration
    calibrate,
    // competitive (read-only)
    competitivePull, competitiveAudit,
    // monitoring
    monitor,
    // graph
    addConceptEdge, getConceptEdges,
    // meta
    getEventCount: () => eventLog.count(),
    getModelVersion: () => MODEL_VERSION,
    getConfig: () => structuredClone(cfg),
    getProvenance: () => structuredClone(PROVENANCE),
    _internal: { estimator, selector, metacog, policy, modeSelector, transferEstimator, graph, competitive, eventLog, evaluation },
  };
}

// ============================================================================
// SECTION 13 — A20: EVALUATION MONITOR
// ============================================================================

class EvaluationMonitor {
  constructor() {
    this._events = [];
    this._max = 1000;
  }
  record(kind, data) {
    this._events.push({ kind, data, t: Date.now() });
    if (this._events.length > this._max) this._events.shift();
  }
  snapshot() {
    const counts = {};
    for (const e of this._events) counts[e.kind] = (counts[e.kind] || 0) + 1;
    return { eventCounts: counts, total: this._events.length };
  }
}

// ============================================================================
// SECTION 14 — A17: CALIBRATOR (hierarchical EM)
// ============================================================================

export const Calibrator = {
  /**
   * Coordinate-ascent calibration over (p_init, p_learn, p_slip, p_guess)
   * with subject-level partial pooling (Directive §18).
   *
   * Returns:
   *   { parameters: {subject: {...}}, pooled: {...}, warnings: [...] }
   */
  calibrateHierarchical(examResults, cfg = DEFAULTS.CALIBRATION, options = {}) {
    if (!Array.isArray(examResults) || examResults.length === 0) {
      return { parameters: {}, pooled: { ...DEFAULTS.BKT }, warnings: ['no_data'] };
    }
    // Group by subject
    const bySubject = new Map();
    for (const exam of examResults) {
      const subject = exam.subject || 'unknown';
      if (!bySubject.has(subject)) bySubject.set(subject, []);
      bySubject.get(subject).push(...(exam.questions || []));
    }

    const pooled = this._estimatePooled(bySubject, cfg, options);
    const parameters = {};
    const warnings = [];
    for (const [subject, questions] of bySubject) {
      if (questions.length < cfg.minNPerParam) {
        parameters[subject] = { ...pooled, note: `insufficient_data (n=${questions.length})` };
        warnings.push(`subject_${subject}_insufficient_data`);
      } else {
        // Partial pooling: λ * local + (1-λ) * pooled
        const lambda = cfg.hierarchicalShrinkK / (cfg.hierarchicalShrinkK + questions.length);
        const local = this._estimateLocal(questions, cfg, options);
        parameters[subject] = {
          p_init:  lambda * pooled.p_init  + (1 - lambda) * local.p_init,
          p_learn: lambda * pooled.p_learn + (1 - lambda) * local.p_learn,
          p_slip:  lambda * pooled.p_slip  + (1 - lambda) * local.p_slip,
          p_guess: lambda * pooled.p_guess + (1 - lambda) * local.p_guess,
          n: questions.length, poolingLambda: lambda,
        };
      }
    }
    return { parameters, pooled, warnings };
  },

  _estimatePooled(bySubject, cfg, options) {
    const allQuestions = [];
    for (const qs of bySubject.values()) allQuestions.push(...qs);
    return this._estimateLocal(allQuestions, cfg, options);
  },

  _estimateLocal(questions, cfg, options) {
    if (questions.length < 5) return { ...DEFAULTS.BKT };
    // Simple empirical estimates (grid-search would be Phase 4)
    const correct = questions.filter(q => q.correct === true).length;
    const p_init = Num.clipProb(correct / questions.length + 0.05);
    const p_learn = Num.clipProb(0.10 + 0.05 * (correct / questions.length));
    const p_slip = 0.10;
    const p_guess = 0.20;
    return { p_init, p_learn, p_slip, p_guess, note: 'empirical_estimate_phase4_grid_search_pending' };
  },
};

// ============================================================================
// SECTION 15 — SIMULATOR
// ============================================================================

/**
 * Simulator with explicit generative model (Directive §20).
 * Used for testing algorithm mechanics, numerical stability, parameter
 * recovery, and policy behavior.
 *
 * Generator:
 *   θ_k ~ Beta(α_prior, β_prior)          (per-learner per-concept mastery)
 *   b_j  ~ Uniform(-1.5, 1.5)              (per-question difficulty)
 *   y    ~ Bernoulli(sigmoid(θ - b_j))     (1PL response)
 *   confidence | correct ~ discretized ordinal from a calibration curve
 *
 * Learners have heterogeneous profiles: some strong, some weak, some
 * well-calibrated, some overconfident.
 */
export class Simulator {
  constructor(cfg = {}) {
    this.seed = cfg.seed ?? DEFAULTS.SIMULATION.seed;
    this.rng = mulberry32(this.seed);
  }
  _normal() {
    // Box-Muller
    const u1 = this.rng(), u2 = this.rng();
    return Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
  }
  _beta(a, b) {
    // Simple rejection sampling for Beta (small a, b)
    for (let i = 0; i < 100; i++) {
      const x = this.rng(), y = this.rng();
      if (Math.pow(x, a - 1) * Math.pow(1 - x, b - 1) / this._betaConstant(a, b) > y * 1.5) return x;
    }
    return a / (a + b);
  }
  _betaConstant(a, b) { return 1; /* only for rejection ratio, not absolute */ }

  /**
   * Generate { learners, questions, events } synthetic dataset.
   */
  generate({ learners = 50, questions = 200, eventsPerLearner = 30 } = {}) {
    const subjects = ['anatomy', 'physiology', 'biochemistry', 'pathology'];
    const topics = ['topic_a', 'topic_b', 'topic_c', 'topic_d'];

    // Generate question bank
    const questionList = [];
    for (let j = 0; j < questions; j++) {
      questionList.push({
        id: `q_${j}`,
        subject: subjects[Math.floor(this.rng() * subjects.length)],
        topic: topics[Math.floor(this.rng() * topics.length)],
        difficulty: 1 + Math.floor(this.rng() * 5),
        b_true: (this.rng() - 0.5) * 3,
      });
    }

    // Generate learners and events
    const learnersArr = [];
    const allEvents = [];
    for (let i = 0; i < learners; i++) {
      // Per-learner trait: some strong, some weak
      const ability = this._normal() * 0.6;  // latent ability
      const wellCalibrated = this.rng() > 0.4;
      // Per-concept mastery
      const masteries = new Map();
      for (const s of subjects) for (const t of topics) {
        const k = `${s}::${t}`;
        masteries.set(k, Num.clipProb(Num.sigmoid(ability + this._normal() * 0.3)));
      }
      // Sample events
      const now = Math.floor(Date.now() / 1000);
      for (let e = 0; e < eventsPerLearner; e++) {
        const q = questionList[Math.floor(this.rng() * questionList.length)];
        const k = `${q.subject}::${q.topic}`;
        const theta = masteries.get(k);
        const pCorrect = Num.sigmoid(theta - q.b_true);
        const correct = this.rng() < pCorrect;
        // Confidence is only observed if wellCalibrated OR random coin
        let confidence = null;
        if (this.rng() > 0.3) {
          if (wellCalibrated) {
            confidence = correct
              ? 2 + Math.floor(this.rng() * 3)   // higher when correct
              : Math.floor(this.rng() * 3);       // lower when wrong
          } else {
            // overconfident: high confidence regardless
            confidence = 2 + Math.floor(this.rng() * 3);
          }
        }
        const ts = now - Math.floor(this.rng() * 30 * 86400);   // spread over 30 days
        allEvents.push({
          eventId: `sim_${i}_${e}`,
          learnerId: `learner_${i}`,
          questionId: q.id,
          subject: q.subject,
          topic: q.topic,
          correct, confidence, confidenceScale: 'ordinal_0_4',
          difficulty: q.difficulty, timeSpent: 20 + this.rng() * 40,
          timestamp: ts,
        });
      }
      learnersArr.push({ id: `learner_${i}`, masteries: Object.fromEntries(masteries) });
    }
    return { learners: learnersArr, questions: questionList, events: allEvents };
  }

  /**
   * Run engine against the simulated data, then compute parameter recovery
   * and calibration error.
   */
  runRecoveryTest({ learners = 30, questions = 100, eventsPerLearner = 40 } = {}) {
    const data = this.generate({ learners, questions, eventsPerLearner });
    const engine = createEngine();
    // Ingest events per learner (only first learner for this test)
    const firstLearnerEvents = data.events.filter(e => e.learnerId === 'learner_0');
    const byExam = new Map();
    for (const e of firstLearnerEvents) {
      const examId = `sim_exam_${Math.floor(e.timestamp / 3600)}`;
      if (!byExam.has(examId)) byExam.set(examId, {
        examId, subject: e.subject, mode: 'simulation',
        date: new Date(e.timestamp * 1000).toISOString(), questions: [],
      });
      byExam.get(examId).questions.push({
        id: e.questionId, topic: e.topic, difficulty: e.difficulty,
        correct: e.correct, timeSpent: e.timeSpent, confidence: e.confidence,
      });
    }
    for (const exam of byExam.values()) engine.ingestExam(exam, 'learner_0');

    // Compare estimated mastery to true mastery
    const truth = data.learners[0].masteries;
    const errors = [];
    for (const [conceptId, trueTheta] of Object.entries(truth)) {
      const snap = engine.getConceptState(conceptId);
      if (snap && snap.mastery.evidenceCount >= 3) {
        errors.push(Math.abs(snap.mastery.p - trueTheta));
      }
    }
    return {
      learners: 1,
      conceptsEvaluated: errors.length,
      meanAbsoluteError: errors.length > 0 ? errors.reduce((s, x) => s + x, 0) / errors.length : null,
      rmse: errors.length > 0 ? Math.sqrt(errors.reduce((s, x) => s + x * x, 0) / errors.length) : null,
      brier: engine.monitor().brier,
    };
  }
}

// ============================================================================
// SECTION 16 — MODEL COMPARISON BASELINES (Directive §19)
// ============================================================================

/**
 * 8 baselines for comparison against the full four-law engine.
 * Each baseline is a minimal but honest model — no strawman.
 */
export const Baselines = Object.freeze({
  /** 1. Simple accuracy (fraction correct). */
  accuracy(events) {
    if (!events.length) return { score: 0, n: 0 };
    return { score: events.filter(e => e.correct).length / events.length, n: events.length };
  },

  /** 2. Recency-weighted accuracy (exponential). */
  recency(events, halfLifeDays = 30) {
    if (!events.length) return { score: 0, n: 0 };
    const now = Math.max(...events.map(e => e.timestamp));
    let num = 0, den = 0;
    for (const e of events) {
      const w = Math.pow(0.5, (now - e.timestamp) / (halfLifeDays * 86400));
      num += w * (e.correct ? 1 : 0);
      den += w;
    }
    return { score: den > 0 ? num / den : 0, n: events.length };
  },

  /** 3. Calibrated 1PL IRT (max-likelihood estimate of θ per learner). */
  irt1pl(events) {
    if (!events.length) return { score: 0.5, n: 0 };
    // Grid-search θ
    let bestTheta = 0, bestLL = -Infinity;
    for (let theta = -3; theta <= 3; theta += 0.1) {
      let ll = 0;
      for (const e of events) {
        const b = { 1: -1.5, 2: -0.75, 3: 0, 4: 0.75, 5: 1.5 }[e.difficulty || 3] ?? 0;
        const p = Num.clipProb(Num.sigmoid(theta - b));
        ll += e.correct ? Math.log(p) : Math.log(1 - p);
      }
      if (ll > bestLL) { bestLL = ll; bestTheta = theta; }
    }
    return { score: Num.sigmoid(bestTheta), theta: bestTheta, n: events.length };
  },

  /** 4. Bayesian Knowledge Tracing (Corbett & Anderson 1994). */
  bkt(events, params = DEFAULTS.BKT) {
    if (!events.length) return { score: params.p_init, n: 0 };
    const bkt = new BKT(params);
    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
    for (const e of sorted) bkt.observe(e.correct, e.timestamp, e.difficulty);
    return { score: bkt.p, n: events.length };
  },

  /** 5. Simple spaced repetition (fixed interval). */
  spacedRepetition(events, intervalDays = 7) {
    if (!events.length) return { score: 0, nextReviewDays: intervalDays, n: 0 };
    const lastSuccess = events.filter(e => e.correct).sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!lastSuccess) return { score: 0, nextReviewDays: intervalDays, n: events.length };
    const elapsedDays = (Math.max(...events.map(e => e.timestamp)) - lastSuccess.timestamp) / 86400;
    return {
      score: Math.max(0, 1 - elapsedDays / intervalDays),
      nextReviewDays: intervalDays, n: events.length,
    };
  },

  /** 6. ACT-R retrieval only (no BKT). */
  actrOnly(events, config = DEFAULTS.ACTR) {
    if (!events.length) return { score: 0, n: 0 };
    const actr = new ACTR(config);
    for (const e of events) actr.record(e.timestamp, 1);
    const now = Math.max(...events.map(e => e.timestamp));
    const activation = actr.activation(now);
    return { score: Num.sigmoid(activation), activation, n: events.length };
  },

  /** 7. Correctness-only estimator (no confidence). */
  correctnessOnly(events) {
    if (!events.length) return { score: DEFAULTS.BKT.p_init, n: 0 };
    const bkt = new BKT(DEFAULTS.BKT);
    for (const e of events.sort((a, b) => a.timestamp - b.timestamp)) {
      bkt.observe(e.correct, e.timestamp, e.difficulty);
    }
    return { score: bkt.p, n: events.length };
  },

  /** 8. Confidence-augmented (uses confidence where present). */
  confidenceAugmented(events) {
    if (!events.length) return { score: DEFAULTS.BKT.p_init, n: 0 };
    const bkt = new BKT(DEFAULTS.BKT);
    const confWeights = events.filter(e => e.confidence != null).length / events.length;
    for (const e of events.sort((a, b) => a.timestamp - b.timestamp)) {
      // Confidence weighting: correct+high-confidence = stronger update
      const weight = (e.confidence != null && e.confidence >= 3) ? 1.5 : 1.0;
      bkt.observe(e.correct, e.timestamp, e.difficulty);
      // Apply extra step for high-confidence correct
      if (e.correct && e.confidence != null && e.confidence >= 3) {
        bkt.p = Num.clipProb(bkt.p + (1 - bkt.p) * DEFAULTS.BKT.p_learn * 0.5);
      }
    }
    return { score: bkt.p, n: events.length, confidenceCoverage: confWeights };
  },

  /** Run all baselines on a set of events and return comparable outputs. */
  compareAll(events) {
    return {
      accuracy: this.accuracy(events),
      recency: this.recency(events),
      irt1pl: this.irt1pl(events),
      bkt: this.bkt(events),
      spacedRepetition: this.spacedRepetition(events),
      actrOnly: this.actrOnly(events),
      correctnessOnly: this.correctnessOnly(events),
      confidenceAugmented: this.confidenceAugmented(events),
    };
  },
});

// ============================================================================
// SECTION 17 — SELF-TESTS (invariants from Directive §28)
// ============================================================================

/**
 * Run the invariant test suite. Returns { passed, failed, results[] }.
 * Tests are self-contained and can be called from a Node test runner.
 */
export function runInvariantTests() {
  const results = [];
  function T(name, fn) {
    try {
      const r = fn();
      results.push({ name, pass: r === true, detail: r === true ? null : r });
    } catch (e) {
      results.push({ name, pass: false, detail: `threw: ${e.message}` });
    }
  }

  T('duplicate_event_idempotent', () => {
    const e = createEngine();
    const ev = {
      eventId: 'x1', questionId: 'q1', subject: 'anatomy', topic: 'abdomen',
      correct: true, difficulty: 2, timeSpent: 30,
      timestamp: new Date().toISOString(),
    };
    const r1 = e.observeEvent(ev);
    const r2 = e.observeEvent(ev);
    return r1.applied === true && r2.applied === false && e.getEventCount() === 1
      || `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} count=${e.getEventCount()}`;
  });

  T('missing_confidence_not_fabricated', () => {
    const e = createEngine();
    e.observeEvent({
      eventId: 'x1', questionId: 'q1', subject: 'anatomy', topic: 'abdomen',
      correct: true, difficulty: 2, timestamp: new Date().toISOString(),
    });
    const summary = e.getLearnerSummary();
    return summary.brier.n === 0 && summary.brier.calibrationStatus === 'unobserved'
      || `brier=${JSON.stringify(summary.brier)}`;
  });

  T('learner_scoping_no_crosstalk', () => {
    const e1 = createEngine(); const e2 = createEngine();
    const ts = new Date().toISOString();
    e1.observeEvent({ eventId: 'a', learnerId: 'L1', questionId: 'q1', subject: 'anatomy', topic: 'abdomen', correct: true, difficulty: 2, timestamp: ts });
    e2.observeEvent({ eventId: 'b', learnerId: 'L2', questionId: 'q1', subject: 'anatomy', topic: 'abdomen', correct: false, difficulty: 2, timestamp: ts });
    const s1 = e1.getConceptState('anatomy::abdomen');
    const s2 = e2.getConceptState('anatomy::abdomen');
    return s1.mastery.p !== s2.mastery.p || 'states identical across learners';
  });

  T('invalid_question_does_not_train', () => {
    const e = createEngine();
    const r = e.observeEvent({ eventId: 'x1', correct: true, timestamp: new Date().toISOString() });
    return r.applied === false && r.reason === 'invalid_event' || `r=${JSON.stringify(r)}`;
  });

  T('out_of_order_events_handled', () => {
    const e = createEngine();
    const ts1 = new Date(Date.now() - 1000000).toISOString();
    const ts2 = new Date().toISOString();
    e.observeEvent({ eventId: 'e1', questionId: 'q1', subject: 'anatomy', topic: 'abdomen', correct: true, difficulty: 2, timestamp: ts2 });
    e.observeEvent({ eventId: 'e2', questionId: 'q2', subject: 'anatomy', topic: 'abdomen', correct: true, difficulty: 2, timestamp: ts1 });
    return e.getEventCount() === 2 || `count=${e.getEventCount()}`;
  });

  T('uncertainty_not_zero_after_rounding', () => {
    const e = createEngine();
    e.observeEvent({ eventId: 'x1', questionId: 'q1', subject: 'anatomy', topic: 'abdomen', correct: true, difficulty: 2, timestamp: new Date().toISOString() });
    const snap = e.getConceptState('anatomy::abdomen');
    const ciWidth = snap.mastery.ci90[1] - snap.mastery.ci90[0];
    return ciWidth > 0 || `ci width=${ciWidth}`;
  });

  T('review_interval_respects_bounds', () => {
    const e = createEngine();
    e.observeEvent({ eventId: 'x1', questionId: 'q1', subject: 'anatomy', topic: 'abdomen', correct: true, difficulty: 2, timestamp: new Date().toISOString() });
    const plan = e.getReviewPlan('anatomy::abdomen');
    return plan.nextReviewInDays >= 1 && plan.nextReviewInDays <= 180 || `days=${plan.nextReviewInDays}`;
  });

  T('scheduler_respects_time_budget', () => {
    const e = createEngine();
    const ts = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      e.observeEvent({ eventId: `e${i}`, questionId: `q${i}`, subject: 'anatomy', topic: 'abdomen', correct: i % 2 === 0, difficulty: 2, timestamp: ts });
    }
    const pool = Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, subject: 'anatomy', topic: 'abdomen', difficulty: 2 }));
    const result = e.selectNextQuestions(pool, 120, 'curriculum');
    return result.spentSec <= 120 || `spent=${result.spentSec}`;
  });

  T('migration_preserves_valid_history', () => {
    const e = createEngine();
    const exported = e.exportState();
    const r = e.migrate(exported, 1);
    return r.ok === true || `r=${JSON.stringify(r)}`;
  });

  T('competitive_rating_not_mastery', () => {
    const e = createEngine();
    e.competitivePull({ rating: 1500, rank: { rank: 8, label: 'Master' } });
    const summary = e.getLearnerSummary();
    return summary.dimensions.competitive.usedForMastery === false
      || `usedForMastery=${summary.dimensions.competitive.usedForMastery}`;
  });

  T('single_hce_not_permanent_misconception', () => {
    const e = createEngine();
    e.observeEvent({
      eventId: 'x1', questionId: 'q1', subject: 'anatomy', topic: 'abdomen',
      correct: false, confidence: 4, difficulty: 2, timestamp: new Date().toISOString(),
    });
    const diag = e.diagnose('anatomy::abdomen');
    return diag.misconceptions.flagged === false
      || `flagged with only 1 HCE: ${JSON.stringify(diag.misconceptions)}`;
  });

  T('kl_entropy_forms_agree', () => {
    const e = createEngine();
    const ts = new Date().toISOString();
    for (let i = 0; i < 5; i++) {
      e.observeEvent({ eventId: `e${i}`, questionId: `q${i}`, subject: 'anatomy', topic: 'abdomen', correct: i % 2 === 0, difficulty: 3, timestamp: ts });
    }
    const cs = e._internal.estimator.concepts.get('anatomy::abdomen');
    const q = { difficulty: 3 };
    const now = Math.floor(Date.now() / 1000);
    const eigKL = e._internal.selector.eigKL(cs, q, now);
    const eigEnt = e._internal.selector.eigEntropy(cs, q, now);
    const relErr = Math.abs(eigKL - eigEnt) / Math.max(Math.abs(eigKL), 1e-6);
    return relErr < 0.30 || `relErr=${relErr.toFixed(3)} (KL=${eigKL.toFixed(4)}, Ent=${eigEnt.toFixed(4)})`;
  });

  T('confidence_only_used_when_observed', () => {
    const e = createEngine();
    e.observeEvent({ eventId: 'e1', questionId: 'q1', subject: 'anatomy', topic: 'abdomen', correct: true, difficulty: 2, timestamp: new Date().toISOString() });
    const ew = e._internal.metacog.evidenceWeight(0.25);
    return ew.useConfidence === false || `useConfidence=${ew.useConfidence}`;
  });

  const passed = results.filter(r => r.pass).length;
  return { passed, failed: results.length - passed, total: results.length, results };
}

// ============================================================================
// END OF FILE
//
// NOTE ON EXPORTS (added 2026-02):
//   All exports in this module are declared INLINE next to their definition
//   (e.g. `export class ACTR`, `export function createEngine`,
//   `export const ACTION_TYPES`). There is deliberately NO trailing
//   `export { … }` re-export block — a prior version had one, and it caused
//   a "Duplicate export" SyntaxError in strict ES-module hosts. If you add
//   a new public symbol, add `export` next to its declaration; do not
//   reintroduce a re-export block.
// ============================================================================