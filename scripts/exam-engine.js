// scripts/exam-engine.js

/**
 * Core Exam Engine — ENGINE-INTEGRATED
 * Supports Standard, Revision, Challenge, Shared, and Adaptive modes.
 * Manages exam lifecycle: question selection, answers, navigation,
 * auto-save, results calculation, engine ingestion, and seen questions.
 *
 * ── ENGINE INTEGRATION (2026-02) ───────────────────────────────────────
 *
 *   1. ADAPTIVE QUESTION SELECTION (opt-in)
 *      Pass `adaptive: true` in the config. The engine (CL-B + CL-D) will
 *      rank the pool by expected information gain per minute and return
 *      the highest-utility questions, topped up with random if the engine
 *      doesn't have enough history to fill the session.
 *
 *      Optional config fields:
 *        adaptive        boolean   default false
 *        engineMode      string    engine selection mode (auto if omitted)
 *        timeBudgetSec   number    default questionCount * 30
 *        excludeIds      string[]  question ids to skip
 *
 *      Non-adaptive configs behave EXACTLY as before — no behavior change.
 *
 *   2. RESULTS ENRICHMENT (always on)
 *      After every exam, `results.medvix` is populated with:
 *        • ingested flag + counts
 *        • per-concept diagnostics (mastery, retrieval, misconceptions)
 *        • per-concept review plans (urgency, next review date)
 *        • a one-line session narration (friendly register)
 *        • per-concept narrations (first 5 concepts)
 *      The results page can display this without any further work. If the
 *      engine is cold or errors, `results.medvix.ingested` is false and
 *      everything still works.
 *
 *   Neither feature adds user-facing latency. Enrichment runs after the
 *   exam is already saved; every engine call is try/catch'ed.
 *
 * ── BACKWARD COMPATIBILITY ──────────────────────────────────────────────
 *   All existing exports are preserved unchanged. `examEngine` gains three
 *   new members: `buildAdaptiveExamConfig`, `isAdaptiveMode`, `getEngineMode`.
 */

import * as utils from './utils.js';
import * as questions from './questions.js';
import * as db from './db.js';
import * as ui from './ui.js';
import * as performanceRating from './performance-rating-v2.js';
import * as auth from './auth.js';
import { convexHttpClient } from './convex-client.js';
import * as rateUs from './rate-us.js';
import * as medvix from './medvix.js';   // ← engine + narrator

// Internal state (not exported)
let examState = {
    config: null,
    questions: [],
    answers: [],
    currentIndex: 0,
    startTime: null,
    isFinished: false,
    examId: null,

    submittedQuestions: [],
    showExplanation: [],
    seed: null,
    cycle: 1,
    challengeId: null,
    challengeCode: null,
    opponent: null,
    lobbyAvgPR: null,
    opponentRating: null,
};

// ==================== Helpers ====================

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function getCorrectAnswerLetter(q) {
    if (!q || !q.options || !Array.isArray(q.options)) return 'A';
    if (typeof q.options[0] === 'object') {
        const idx = q.options.findIndex(opt => opt.isCorrect === true);
        if (idx >= 0) {
            return String.fromCharCode(65 + idx);
        }
    }
    return q.correct || 'A';
}

// ==================== ENGINE ENRICHMENT (private) ====================

/**
 * Enrich a finished exam result with engine diagnostics + narration.
 *
 * Idempotent: re-ingesting the same exam is safe (EventLog dedupes by
 * eventId). Always leaves `results.medvix` present, even on failure.
 *
 * The engine is NOT required for the exam to complete — every call is
 * try/catch'ed and the function never throws.
 *
 * @param {Object} results — finished exam results object (mutated)
 */
async function enrichResultsWithMedvix(results) {
    const empty = {
        ingested: false,
        ingestedCount: 0,
        skippedCount: 0,
        conceptsTouched: [],
        diagnostics: {},
        reviewPlans: {},
        sessionNarration: null,
        conceptNarrations: {},
    };

    if (!results || !Array.isArray(results.questions) || results.questions.length === 0) {
        results.medvix = { ...empty, reason: 'no_questions' };
        return;
    }

    const enrichment = { ...empty };

    // ── 1. Ingest the exam into the engine ──
    try {
        const ingest = await medvix.ingestExam(results, 'local');
        if (ingest) {
            enrichment.ingested = (ingest.ingested || 0) > 0;
            enrichment.ingestedCount = ingest.ingested || 0;
            enrichment.skippedCount = ingest.skipped || 0;
            enrichment.conceptsTouched = Array.isArray(ingest.conceptsTouched)
                ? ingest.conceptsTouched
                : [];
        }
    } catch (e) {
        console.warn('[ExamEngine] medvix.ingestExam failed:', e);
        results.medvix = { ...empty, error: String(e) };
        return;
    }

    // ── 2. Per-concept diagnostics ──
    for (const conceptId of enrichment.conceptsTouched) {
        try {
            const diag = await medvix.getDiagnose(conceptId);
            if (diag) {
                enrichment.diagnostics[conceptId] = {
                    mastery: diag.mastery || null,
                    retrieval: diag.retrieval || null,
                    misconceptions: diag.misconceptions || null,
                    metacognitive: diag.metacognitive || null,
                };
            }
        } catch (e) {
            console.warn(`[ExamEngine] diagnose(${conceptId}) failed:`, e);
        }
    }

    // ── 3. Per-concept review plans ──
    for (const conceptId of enrichment.conceptsTouched) {
        try {
            const plan = await medvix.getReviewPlan(conceptId);
            if (plan) {
                enrichment.reviewPlans[conceptId] = {
                    currentP: plan.currentP,
                    targetP: plan.targetP,
                    nextReviewAtSec: plan.nextReviewAtSec,
                    nextReviewInDays: plan.nextReviewInDays,
                    urgency: plan.urgency,
                };
            }
        } catch (e) {
            console.warn(`[ExamEngine] reviewPlan(${conceptId}) failed:`, e);
        }
    }

    // ── 4. Session narration (one-line friendly summary) ──
    try {
        const sessionSummary = {
            n_questions: results.totalQuestions || 0,
            n_concepts: enrichment.conceptsTouched.length
                || (Array.isArray(results.topics) ? results.topics.length : 0),
            n_improved: 0,
            n_declined: Array.isArray(results.weakAreas) ? results.weakAreas.length : 0,
        };
        const narr = await medvix.narrateSession(sessionSummary, 'friendly');
        if (narr && narr.valid && typeof narr.text === 'string') {
            enrichment.sessionNarration = narr.text;
        }
    } catch (e) {
        console.warn('[ExamEngine] narrateSession failed:', e);
    }

    // ── 5. Per-concept narrations (cap to 5 to keep results page fast) ──
    for (const conceptId of enrichment.conceptsTouched.slice(0, 5)) {
        try {
            const narr = await medvix.narrateConcept(conceptId, 'friendly');
            if (narr && narr.valid && typeof narr.text === 'string') {
                enrichment.conceptNarrations[conceptId] = narr.text;
            }
        } catch (e) {
            console.warn(`[ExamEngine] narrateConcept(${conceptId}) failed:`, e);
        }
    }

    results.medvix = enrichment;
}

// ==================== ADAPTIVE CONFIG BUILDER ====================

/**
 * Build an exam configuration that will use the engine to select questions.
 *
 * If `preferredEngineMode` is omitted, the engine recommends a mode based
 * on the learner's current state (initial diagnostic, remediation,
 * spaced retrieval, etc.).
 *
 * @param {Object} options
 * @param {string} options.subject
 * @param {string[]} options.topics
 * @param {number} [options.questionCount=20]
 * @param {number} [options.timeBudgetSec]        default questionCount * 30
 * @param {string} [options.preferredExamMode='standard']
 *        Exam behavior mode: 'standard' | 'revision' | 'challenge' | 'shared'
 * @param {string} [options.preferredEngineMode]
 *        Engine selection mode: 'initial_diagnostic' | 'weakness_focused_remediation'
 *        | 'spaced_retrieval' | 'broad_curriculum_revision' | 'timed_exam_simulation'
 *        | 'clinical_reasoning_transfer' | 'practical_identification'
 *        | 'short_study' | 'low_confidence_high_uncertainty'
 * @param {string[]} [options.excludeIds=[]]
 * @returns {Promise<Object>} config ready to pass to createExam()
 */
export async function buildAdaptiveExamConfig(options) {
    const {
        subject,
        topics,
        questionCount = 20,
        timeBudgetSec = null,
        preferredExamMode = 'standard',
        preferredEngineMode = null,
        excludeIds = [],
    } = options || {};

    if (!subject) throw new Error('buildAdaptiveExamConfig: subject required');
    if (!Array.isArray(topics) || topics.length === 0) {
        throw new Error('buildAdaptiveExamConfig: topics required');
    }

    const budget = (Number.isFinite(timeBudgetSec) && timeBudgetSec > 0)
        ? timeBudgetSec
        : Math.max(60, questionCount * 30);

    let recommendation = null;
    try {
        recommendation = await medvix.getModeRecommendation({
            budgetSec: budget,
            subject,
        });
    } catch (e) {
        console.warn('[ExamEngine] getModeRecommendation failed (non-fatal):', e);
    }

    const engineMode = preferredEngineMode
        || (recommendation && recommendation.mode)
        || 'broad_curriculum_revision';

    return {
        subject,
        topics,
        questionCount,
        mode: preferredExamMode,       // exam behavior mode
        engineMode,                    // engine selection mode
        adaptive: true,
        timeBudgetSec: budget,
        excludeIds,
        engineRecommendation: recommendation,   // included for UI display
    };
}

// ==================== Initialization ====================

/**
 * Create a new exam based on configuration.
 *
 * Backward-compatible: when `config.adaptive` is falsy, this behaves
 * exactly as before (random selection). When `config.adaptive === true`,
 * the engine ranks the candidate pool first.
 *
 * @param {Object} config - from app.getExamConfig()
 * @returns {Promise<void>}
 */
export async function createExam(config) {
    if (!config) throw new Error('No exam configuration provided');
    examState.config = { ...config };
    examState.startTime = Date.now();
    examState.examId = 'exam_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8);
    examState.currentIndex = 0;
    examState.isFinished = false;
    examState.seed = config.seed || null;
    examState.cycle = config.cycle || 1;
    examState.challengeId = config.challengeId || null;
    examState.challengeCode = config.challengeCode || null;
    examState.opponent = config.opponent || null;
    examState.lobbyAvgPR = config.lobbyAvgPR || 0.5;
    examState.opponentRating = config.opponentRating || 100;

    // Load questions — pass adaptive flags through to the question bank.
    //
    // Note on `mode`: `config.mode` is the EXAM behavior mode (standard /
    // revision / challenge / shared). The engine selector wants a different
    // set of mode names — that's `config.engineMode`. We pass ONLY the
    // engine mode to the question bank so it can't be confused.
    const questionList = await questions.getQuestionsForExam({
        ...config,
        seed: examState.seed,
        cycle: examState.cycle,
        mode: config.engineMode || null,
        adaptive: !!config.adaptive,
        timeBudgetSec: config.timeBudgetSec,
        excludeIds: config.excludeIds,
    });
    if (!questionList || questionList.length === 0) {
        throw new Error('No questions available for the selected topics');
    }

    // Shuffle options per question (unchanged)
    questionList.forEach(q => {
        if (q.options && Array.isArray(q.options)) {
            shuffleArray(q.options);
        }
    });

    examState.questions = questionList;
    examState.answers = questionList.map(() => ({
        selectedOption: null,
        timeSpent: 0,
        flagged: false,
    }));
    examState.submittedQuestions = questionList.map(() => false);
    examState.showExplanation = questionList.map(() => false);
}

export function startExam() {
    // Nothing extra needed – exam is ready
}

// ==================== Adaptive helpers (exported) ====================

/** True when the current exam was started with `adaptive: true`. */
export function isAdaptiveMode() {
    return !!examState.config?.adaptive;
}

/** Returns the engine selection mode used for the current exam, or null. */
export function getEngineMode() {
    return examState.config?.engineMode || null;
}

// ==================== Getters ====================

export function getCurrentQuestion() {
    if (examState.isFinished || !examState.questions.length) return null;
    return examState.questions[examState.currentIndex];
}

export function getCurrentAnswer() {
    return examState.answers[examState.currentIndex];
}

export function getAnswer(index) {
    if (index < 0 || index >= examState.answers.length) return null;
    return examState.answers[index];
}

export function getSubject() {
    return examState.config?.subject || 'Unknown';
}

export function getConfig() {
    return examState.config;
}

export function totalQuestions() {
    return examState.questions.length;
}

export function currentIndex() {
    return examState.currentIndex;
}

export function hasNext() {
    return examState.currentIndex < examState.questions.length - 1;
}

export function hasPrev() {
    return examState.currentIndex > 0;
}

export function getQuestionState(index) {
    const answer = examState.answers[index];
    return {
        answered: !!answer?.selectedOption,
        flagged: answer?.flagged || false,
        visited: answer?.timeSpent > 0 || index < examState.currentIndex,
    };
}

export function getMode() {
    return examState.config?.mode || 'standard';
}

export function getSeed() {
    return examState.seed;
}

export function getCycle() {
    return examState.cycle;
}

export function getChallengeCode() {
    return examState.challengeCode;
}

export function getChallengeId() {
    return examState.challengeId;
}

export function getOpponent() {
    return examState.opponent;
}

export function isRevisionMode() {
    return examState.config?.mode === 'revision';
}

export function isChallengeMode() {
    return examState.config?.mode === 'challenge';
}

export function isQuestionSubmitted(index = examState.currentIndex) {
    return examState.submittedQuestions[index] || false;
}

export function getRevisionFeedback() {
    const idx = examState.currentIndex;
    const q = examState.questions[idx];
    const answer = examState.answers[idx];
    if (!q || !answer || !answer.selectedOption) return null;

    const selectedLetter = answer.selectedOption;
    const correctLetter = getCorrectAnswerLetter(q);
    const isCorrect = selectedLetter === correctLetter;

    const selectedIdx = selectedLetter.charCodeAt(0) - 65;
    const correctIdx = correctLetter.charCodeAt(0) - 65;

    const selectedObj = q.options?.[selectedIdx] || {};
    const correctObj = q.options?.[correctIdx] || {};

    return {
        selectedOption: selectedLetter,
        correctOption: correctLetter,
        selectedText: selectedObj.text || 'Option not available',
        correctText: correctObj.text || 'Option not available',
        selectedExplanation: selectedObj.explanation || 'No explanation for your choice.',
        correctExplanation: correctObj.explanation || 'No explanation for the correct answer.',
        overallExplanation: q.explanation || { overview: 'No overall explanation available.' },
        isCorrect,
    };
}

export function getAllQuestions() {
    return examState.questions;
}

// ==================== Actions ====================

export function submitAnswer(selectedOption, timeSpent) {
    if (examState.isFinished) return;

    const idx = examState.currentIndex;
    if (examState.submittedQuestions[idx]) return;

    const answer = examState.answers[idx];
    answer.selectedOption = selectedOption;
    answer.timeSpent = timeSpent;

    examState.submittedQuestions[idx] = true;

    if (isRevisionMode()) {
        examState.showExplanation[idx] = true;
    }
}

export function submitAnswerAtIndex(index, selectedOption, timeSpent) {
    if (examState.isFinished) return;
    if (index < 0 || index >= examState.questions.length) return;

    const answer = examState.answers[index];
    answer.selectedOption = selectedOption;
    answer.timeSpent = timeSpent;
    examState.submittedQuestions[index] = true;

    if (isRevisionMode()) {
        examState.showExplanation[index] = true;
    }
}

export function toggleCurrentFlag() {
    if (examState.isFinished) return false;
    const answer = examState.answers[examState.currentIndex];
    answer.flagged = !answer.flagged;
    return answer.flagged;
}

export function toggleFlagAtIndex(index) {
    if (examState.isFinished) return false;
    if (index < 0 || index >= examState.answers.length) return false;
    examState.answers[index].flagged = !examState.answers[index].flagged;
    return examState.answers[index].flagged;
}

export function isCurrentQuestionFlagged() {
    return examState.answers[examState.currentIndex]?.flagged || false;
}

export function next() {
    if (examState.isFinished) return false;
    if (hasNext()) {
        examState.currentIndex++;
        return true;
    }
    return false;
}

export function prev() {
    if (examState.isFinished) return false;
    if (hasPrev()) {
        examState.currentIndex--;
        return true;
    }
    return false;
}

export function goTo(index) {
    if (examState.isFinished) return false;
    if (index >= 0 && index < examState.questions.length) {
        examState.currentIndex = index;
        return true;
    }
    return false;
}

// ==================== Auto‑save ====================

export async function autoSave() {
    if (examState.isFinished) return;
    const progress = {
        examId: examState.examId,
        config: examState.config,
        questions: examState.questions.map(q => q.id),
        answers: examState.answers,
        currentIndex: examState.currentIndex,
        startTime: examState.startTime,
        timeSpent: Date.now() - examState.startTime,
        submittedQuestions: examState.submittedQuestions,
        showExplanation: examState.showExplanation,
        seed: examState.seed,
        cycle: examState.cycle,
        challengeId: examState.challengeId,
        challengeCode: examState.challengeCode,
    };
    await db.saveExamProgress(progress).catch(err => console.warn('Auto-save failed', err));
}

export async function loadSavedExam() {
    const saved = await db.getExamProgress();
    if (!saved) return null;

    const questionList = await questions.getQuestionsByIds(saved.questions);
    if (!questionList || questionList.length === 0) return null;

    examState.examId = saved.examId;
    examState.config = saved.config;
    examState.questions = questionList;
    examState.answers = saved.answers;
    examState.currentIndex = saved.currentIndex;
    examState.startTime = saved.startTime;
    examState.isFinished = false;
    examState.submittedQuestions = saved.submittedQuestions || questionList.map(() => false);
    examState.showExplanation = saved.showExplanation || questionList.map(() => false);
    examState.seed = saved.seed || null;
    examState.cycle = saved.cycle || 1;
    examState.challengeId = saved.challengeId || null;
    examState.challengeCode = saved.challengeCode || null;
    return examState.config;
}

// ==================== Finish & Results ====================

export async function endExam() {
    examState.isFinished = true;
    const totalTime = Date.now() - examState.startTime;

    let timeAllocated = 0;
    if (examState.config.timingMode === 'fixed') {
        timeAllocated = examState.config.questionCount * (examState.config.fixedTimePerQuestion || 30);
    } else if (examState.config.timingMode === 'adaptive') {
        timeAllocated = examState.questions.reduce((sum, q) => sum + (q.difficulty * 10 + 20), 0);
    } else {
        timeAllocated = examState.config.questionCount * 30;
    }

    const results = {
        examId: examState.examId,
        subject: examState.config.subject,
        mode: examState.config.mode,
        date: new Date().toISOString(),
        totalQuestions: examState.questions.length,
        correctAnswers: 0,
        scorePercentage: 0,
        timeSpent: totalTime,
        timeAllocated,
        averageTimePerQuestion: totalTime / examState.questions.length / 1000,
        questions: [],
        topics: [],
        weakAreas: [],
        seed: examState.seed,
        cycle: examState.cycle,
        challengeId: examState.challengeId,
        challengeCode: examState.challengeCode,
        // Adaptive metadata — persisted so the results page knows it was adaptive
        adaptive: !!examState.config.adaptive,
        engineMode: examState.config.engineMode || null,
        revisionCompleted: examState.submittedQuestions.every(v => v),
        performanceRatio: null,
        factors: null,
        previousRating: null,
        newRating: null,
        ratingChange: null,
        rank: null,
        achievements: [],
        historyEWMA: null,
        reliability: null,
        integrity: null,
        historyCount: 0,
        // Populated by enrichResultsWithMedvix() below
        medvix: null,
    };

    const topicMap = {};

    examState.questions.forEach((q, idx) => {
        const answer = examState.answers[idx];
        const correctLetter = getCorrectAnswerLetter(q);
        const isCorrect = answer.selectedOption === correctLetter;
        if (isCorrect) results.correctAnswers++;

        const qResult = {
            id: q.id,
            question: q.question,
            options: q.options,
            correctAnswer: correctLetter,
            userAnswer: answer.selectedOption,
            timeSpent: answer.timeSpent,
            correct: isCorrect,
            explanation: q.explanation,
            topic: q.topic,
            difficulty: q.difficulty,
            image: q.image || null,
            flagged: answer.flagged,
            submitted: examState.submittedQuestions[idx],
        };
        results.questions.push(qResult);

        if (!topicMap[q.topic]) {
            topicMap[q.topic] = { total: 0, correct: 0, totalTime: 0 };
        }
        topicMap[q.topic].total++;
        if (isCorrect) topicMap[q.topic].correct++;
        topicMap[q.topic].totalTime += answer.timeSpent;
    });

    results.scorePercentage = (results.correctAnswers / results.totalQuestions) * 100;
    results.topics = Object.entries(topicMap).map(([topic, data]) => ({
        topic,
        questions: data.total,
        correct: data.correct,
        percentage: (data.correct / data.total) * 100,
        averageTime: data.totalTime / data.total,
    }));
    results.weakAreas = results.topics.filter(t => t.percentage < 70).map(t => t.topic);

    // ============================================================
    // 1. SAVE THE EXAM FIRST (durability)
    // ============================================================
    await db.saveExamResult(results);

    // ============================================================
    // 2. PERFORMANCE RATING ENGINE INTEGRATION
    // ============================================================
    try {
        const user = auth.getUser();
        if (user && user._id) {
            const prResult = await performanceRating.computeFullPerformance(
                results.examId,
                user._id,
                examState.lobbyAvgPR || 0.5,
                examState.opponentRating || 100
            );

            results.performanceRatio = prResult.pr;
            results.factors = prResult.factors;
            results.previousRating = prResult.previousRating;
            results.newRating = prResult.newRating;
            results.ratingChange = prResult.ratingChange;
            results.rank = prResult.rank;
            results.achievements = prResult.achievements;
            results.historyEWMA = prResult.historyEWMA;
            results.reliability = prResult.reliability;
            results.integrity = prResult.integrity;
            results.historyCount = prResult.historyCount;

            user.rating = prResult.newRating;
            user.rank = prResult.rank.rank;
            user.historyEWMA = prResult.historyEWMA;
            user.completedExams = (user.completedExams || 0) + 1;
            user.lastExamPR = prResult.pr;
            await db.saveUser(user);
        }
    } catch (err) {
        console.warn('Performance Rating computation failed:', err);
    }

    // ============================================================
    // 3. SUBMIT CHALLENGE RESULT (if applicable)
    // ============================================================
    if (examState.config.mode === 'challenge' || examState.config.mode === 'shared') {
        await submitChallengeResult(results);
    }

    // ============================================================
    // 4. MEDVIX ENGINE INGESTION + ENRICHMENT
    // ============================================================
    // Ingests this exam into the adaptive engine so future sessions benefit,
    // and enriches results.medvix with diagnostics, review plans, and
    // narrator text for the results page. Non-fatal: failures are logged
    // and results.medvix will be set with `ingested: false`.
    try {
        await enrichResultsWithMedvix(results);
    } catch (err) {
        console.warn('[ExamEngine] MedVix enrichment failed (non-fatal):', err);
        results.medvix = { ingested: false, error: String(err) };
    }

    // ============================================================
    // 5. FINAL SAVE — everything (rating + challenge + medvix)
    // ============================================================
    await db.saveExamResult(results);

    // ============================================================
    // 6. RECORD SEEN QUESTIONS (except challenge mode)
    // ============================================================
    if (examState.config.mode !== 'challenge') {
        const byTopic = {};
        results.questions.forEach(q => {
            if (!byTopic[q.topic]) byTopic[q.topic] = [];
            byTopic[q.topic].push(q.id);
        });
        for (const [topic, ids] of Object.entries(byTopic)) {
            await db.addSeenQuestions(results.subject, ids, topic);
        }
    }

    // ============================================================
    // 7. IN-APP REVIEW (cooldown-respecting)
    // ============================================================
    try {
        await rateUs.requestAppReview();
    } catch (err) {
        console.warn('[ExamEngine] RateUs trigger failed:', err);
    }

    return results;
}

// ==================== Challenge Result Submission ====================

async function submitChallengeResult(results) {
    const token = auth.getToken();
    if (!token) return;

    const challengeId = examState.challengeId || examState.challengeCode;
    if (!challengeId) return;

    const totalQuestions = results.totalQuestions;
    const correctCount = results.correctAnswers;
    const percentage = results.scorePercentage;
    const timeSpent = results.timeSpent / 1000;

    let difficultySum = 0;
    let difficultyCount = 0;
    results.questions.forEach(q => {
        if (typeof q.difficulty === 'number' && q.difficulty > 0) {
            difficultySum += q.difficulty;
            difficultyCount++;
        }
    });
    const difficultyFactor = difficultyCount > 0 ? (difficultySum / difficultyCount) : 1;

    const payload = {
        token,
        challengeId,
        score: correctCount,
        totalQuestions,
        percentage,
        timeSpent,
        difficultyFactor,
    };

    if (navigator.onLine) {
        try {
            await convexHttpClient.action('challenges/actions:submitResult', payload);
            console.log('Challenge result submitted successfully');
            results.challengeResultSubmitted = true;
            await db.saveExamResult(results);
        } catch (err) {
            console.error('Challenge result submission failed:', err);
            await queueChallengeResult(payload);
        }
    } else {
        console.warn('Offline – queuing challenge result for later');
        await queueChallengeResult(payload);
    }
}

async function queueChallengeResult(payload) {
    await db.addToSyncQueue('challenge_result', payload);
}

// ==================== Exam Config Management ====================

export function setExamConfig(config) {
    examState.config = config;
    if (config) {
        sessionStorage.setItem('examConfig', JSON.stringify(config));
    } else {
        sessionStorage.removeItem('examConfig');
    }
}

export function getExamConfig() {
    if (examState.config) return examState.config;
    const saved = sessionStorage.getItem('examConfig');
    if (saved) {
        try {
            examState.config = JSON.parse(saved);
            return examState.config;
        } catch {
            examState.config = null;
        }
    }
    return null;
}

export function clearExamConfig() {
    examState.config = null;
    sessionStorage.removeItem('examConfig');
}

export function clearExamState() {
    examState.config = null;
    examState.questions = [];
    examState.answers = [];
    examState.currentIndex = 0;
    examState.startTime = null;
    examState.isFinished = false;
    examState.examId = null;
    examState.submittedQuestions = [];
    examState.showExplanation = [];
    examState.seed = null;
    examState.cycle = 1;
    examState.challengeId = null;
    examState.challengeCode = null;
    examState.opponent = null;
    examState.lobbyAvgPR = null;
    examState.opponentRating = null;
}

// ==================== Export ====================

// Live proxy for `import { config } from ...`
export const config = new Proxy({}, {
    get(_, prop) { return examState.config?.[prop]; },
    set(_, prop, value) { if (examState.config) { examState.config[prop] = value; return true; } return false; },
    has(_, prop) { return examState.config ? prop in examState.config : false; },
    ownKeys() { return examState.config ? Object.keys(examState.config) : []; },
    getOwnPropertyDescriptor(_, prop) {
        if (examState.config && prop in examState.config) {
            return { configurable: true, enumerable: true, value: examState.config[prop] };
        }
        return undefined;
    },
});

export const examEngine = {
    // Existing API — unchanged
    createExam,
    startExam,
    getConfig,
    getCurrentQuestion,
    getCurrentAnswer,
    getAnswer,
    getAllQuestions,
    submitAnswer,
    submitAnswerAtIndex,
    toggleCurrentFlag,
    toggleFlagAtIndex,
    isCurrentQuestionFlagged,
    next,
    prev,
    goTo,
    getQuestionState,
    hasNext,
    hasPrev,
    totalQuestions,
    currentIndex,
    getSubject,
    autoSave,
    loadSavedExam,
    endExam,
    getMode,
    getSeed,
    getCycle,
    getChallengeCode,
    getChallengeId,
    getOpponent,
    isRevisionMode,
    isChallengeMode,
    isQuestionSubmitted,
    getRevisionFeedback,
    setExamConfig,
    getExamConfig,
    clearExamConfig,
    clearExamState,

    // NEW — engine-aware
    buildAdaptiveExamConfig,
    isAdaptiveMode,
    getEngineMode,
};