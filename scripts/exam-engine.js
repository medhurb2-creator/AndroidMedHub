// scripts/exam-engine.js

/**
 * Core Exam Engine
 * Supports Standard, Revision, and Challenge modes.
 * Manages exam lifecycle: question selection, answers, navigation,
 * auto-save, results calculation, and records seen questions.
 *
 * Updated for new JSON structure:
 *   - options: [{ text, isCorrect, explanation }]
 *   - explanation: { overview, highYield, clinicalCorrelation }
 *
 * Options are shuffled after loading to avoid pattern bias.
 */

import * as utils from './utils.js';
import * as questions from './questions.js';
import * as db from './db.js';
import * as ui from './ui.js';
import * as performanceRating from './performance-rating-v2.js';
import * as auth from './auth.js';
import { convexHttpClient } from './convex-client.js';

// Internal state (not exported)
let examState = {
    config: null,
    questions: [],          // array of question objects
    answers: [],            // array of { selectedOption, timeSpent, flagged }
    currentIndex: 0,
    startTime: null,
    isFinished: false,
    examId: null,

    // Revision / Challenge additions
    submittedQuestions: [],  // boolean array: has this question been submitted?
    showExplanation: [],    // boolean array: should explanation be visible?
    seed: null,
    cycle: 1,
    challengeId: null,
    challengeCode: null,
    opponent: null,
    lobbyAvgPR: null,        // for performance rating
    opponentRating: null     // for performance rating
};

// ==================== Helpers ====================

/**
 * Fisher–Yates shuffle (in‑place). Returns the same array reference.
 * @param {Array} arr
 * @returns {Array}
 */
function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Determine the correct answer letter from the new option objects.
 * Falls back to old `q.correct` if options are plain strings.
 * @param {Object} q - question object
 * @returns {string} e.g. 'A'
 */
function getCorrectAnswerLetter(q) {
    if (!q || !q.options || !Array.isArray(q.options)) return 'A';
    // Check if options are objects (new format)
    if (typeof q.options[0] === 'object') {
        const idx = q.options.findIndex(opt => opt.isCorrect === true);
        if (idx >= 0) {
            return String.fromCharCode(65 + idx);
        }
    }
    // Fallback for old format (option strings + q.correct)
    return q.correct || 'A';
}

// ==================== Initialization ====================

/**
 * Create a new exam based on configuration.
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
    examState.lobbyAvgPR = config.lobbyAvgPR || 0.5; // default if not provided
    examState.opponentRating = config.opponentRating || 100;

    // Load questions from questions.js (passing seed, cycle, mode)
    const questionList = await questions.getQuestionsForExam({
        ...config,
        seed: examState.seed,
        cycle: examState.cycle,
        mode: config.mode
    });
    if (!questionList || questionList.length === 0) {
        throw new Error('No questions available for the selected topics');
    }

    // 🔀 Shuffle options for every question (in‑place, stays same for session)
    questionList.forEach(q => {
        if (q.options && Array.isArray(q.options)) {
            // Shuffle the options array – the correct answer will be at a random position
            shuffleArray(q.options);
        }
    });

    examState.questions = questionList;
    const qCount = questionList.length;
    examState.answers = questionList.map(() => ({
        selectedOption: null,
        timeSpent: 0,
        flagged: false
    }));
    examState.submittedQuestions = questionList.map(() => false);
    examState.showExplanation = questionList.map(() => false);
}

export function startExam() {
    // Nothing extra needed – exam is ready
}

// ==================== Getters ====================

export function getCurrentQuestion() {
    if (examState.isFinished || !examState.questions.length) return null;
    return examState.questions[examState.currentIndex];
}

export function getCurrentAnswer() {
    return examState.answers[examState.currentIndex];
}

/**
 * Get the answer object for a specific question index.
 * @param {number} index
 * @returns {Object|null}
 */
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

/**
 * Get the state of a question (answered, flagged, visited).
 * @param {number} index
 * @returns {Object}
 */
export function getQuestionState(index) {
    const answer = examState.answers[index];
    return {
        answered: !!answer?.selectedOption,
        flagged: answer?.flagged || false,
        visited: answer?.timeSpent > 0 || index < examState.currentIndex // approximate
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

/**
 * Get revision feedback for the current question (new format).
 * @returns {Object|null} 
 *  { selectedOption, correctOption, selectedText, correctText,
 *    selectedExplanation, correctExplanation, overallExplanation, isCorrect }
 */
export function getRevisionFeedback() {
    const idx = examState.currentIndex;
    const q = examState.questions[idx];
    const answer = examState.answers[idx];
    if (!q || !answer || !answer.selectedOption) return null;

    const selectedLetter = answer.selectedOption;
    const correctLetter = getCorrectAnswerLetter(q);
    const isCorrect = selectedLetter === correctLetter;

    // Find the option objects
    const selectedIdx = selectedLetter.charCodeAt(0) - 65;
    const correctIdx = correctLetter.charCodeAt(0) - 65;

    const selectedObj = q.options?.[selectedIdx] || {};
    const correctObj = q.options?.[correctIdx] || {};

    // Build feedback: use option text and its specific explanation
    return {
        selectedOption: selectedLetter,
        correctOption: correctLetter,
        selectedText: selectedObj.text || 'Option not available',
        correctText: correctObj.text || 'Option not available',
        selectedExplanation: selectedObj.explanation || 'No explanation for your choice.',
        correctExplanation: correctObj.explanation || 'No explanation for the correct answer.',
        overallExplanation: q.explanation || { overview: 'No overall explanation available.' },
        isCorrect
    };
}

/**
 * Get all questions (used by shared mode to render everything at once).
 * @returns {Array}
 */
export function getAllQuestions() {
    return examState.questions;
}

// ==================== Actions ====================

/**
 * Submit an answer for the current question.
 */
export function submitAnswer(selectedOption, timeSpent) {
    if (examState.isFinished) return;

    // Prevent resubmission in Revision mode
    const idx = examState.currentIndex;
    if (examState.submittedQuestions[idx]) return;

    const answer = examState.answers[idx];
    answer.selectedOption = selectedOption;
    answer.timeSpent = timeSpent;

    // Mark as submitted
    examState.submittedQuestions[idx] = true;

    // If Revision mode, show explanation immediately
    if (isRevisionMode()) {
        examState.showExplanation[idx] = true;
    }
}

/**
 * Submit an answer for a specific question index (used by shared mode).
 * @param {number} index
 * @param {string} selectedOption - e.g., 'A'
 * @param {number} timeSpent - seconds
 */
export function submitAnswerAtIndex(index, selectedOption, timeSpent) {
    if (examState.isFinished) return;
    if (index < 0 || index >= examState.questions.length) return;

    // In shared mode we allow resubmission (override previous answer)
    const answer = examState.answers[index];
    answer.selectedOption = selectedOption;
    answer.timeSpent = timeSpent;
    examState.submittedQuestions[index] = true;

    // If Revision mode (though shared uses its own logic), show explanation
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

/**
 * Toggle the flagged state for a specific question index.
 * @param {number} index
 * @returns {boolean} new flagged state
 */
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
        challengeCode: examState.challengeCode
    };
    await db.saveExamProgress(progress).catch(err => console.warn('Auto-save failed', err));
}

export async function loadSavedExam() {
    const saved = await db.getExamProgress();
    if (!saved) return null;

    // Restore questions from IDs
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

    // Calculate total allocated time (in seconds)
    let timeAllocated = 0;
    if (examState.config.timingMode === 'fixed') {
        timeAllocated = examState.config.questionCount * (examState.config.fixedTimePerQuestion || 30);
    } else if (examState.config.timingMode === 'adaptive') {
        timeAllocated = examState.questions.reduce((sum, q) => sum + (q.difficulty * 10 + 20), 0);
    } else {
        timeAllocated = examState.config.questionCount * 30;
    }

    // Build local results
    const results = {
        examId: examState.examId,
        subject: examState.config.subject,
        mode: examState.config.mode,
        date: new Date().toISOString(),
        totalQuestions: examState.questions.length,
        correctAnswers: 0,
        scorePercentage: 0,
        timeSpent: totalTime,
        timeAllocated: timeAllocated,
        averageTimePerQuestion: totalTime / examState.questions.length / 1000,
        questions: [],
        topics: [],
        weakAreas: [],
        seed: examState.seed,
        cycle: examState.cycle,
        challengeId: examState.challengeId,
        challengeCode: examState.challengeCode,
        revisionCompleted: examState.submittedQuestions.every(v => v),
        // Performance Rating fields (will be filled later)
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
        historyCount: 0
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
            flagged: answer.flagged,
            submitted: examState.submittedQuestions[idx]
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
        averageTime: data.totalTime / data.total
    }));
    results.weakAreas = results.topics.filter(t => t.percentage < 70).map(t => t.topic);

    // ============================================================
    // 1. SAVE THE EXAM FIRST (so it exists in the database)
    // ============================================================
    await db.saveExamResult(results);

    // ============================================================
    // 2. PERFORMANCE RATING ENGINE INTEGRATION
    // ============================================================
    try {
        const user = auth.getUser();
        if (user && user._id) {
            const prResult = await performanceRating.computeFullPerformance(
                results.examId,          // examId string
                user._id,                // userId string
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

            // Update user
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
    // 3. SUBMIT CHALLENGE RESULT (if mode is challenge/shared)
    // ============================================================
    if (examState.config.mode === 'challenge' || examState.config.mode === 'shared') {
        await submitChallengeResult(results);
    }

    // ============================================================
    // 4. UPDATE THE EXAM RECORD WITH RATING DATA (already saved)
    // ============================================================
    await db.saveExamResult(results);

    // ============================================================
    // 5. RECORD SEEN QUESTIONS (except challenge mode)
    // ============================================================
    if (examState.config.mode !== 'challenge') {
        const questionIds = results.questions.map(q => q.id);
        const byTopic = {};
        results.questions.forEach(q => {
            if (!byTopic[q.topic]) byTopic[q.topic] = [];
            byTopic[q.topic].push(q.id);
        });
        for (const [topic, ids] of Object.entries(byTopic)) {
            await db.addSeenQuestions(results.subject, ids, topic);
        }
    }

    return results;
}


// ==================== Challenge Result Submission ====================

/**
 * Submit challenge result to backend, or queue if offline.
 * @param {Object} results - exam results object
 */
async function submitChallengeResult(results) {
    const token = auth.getToken();
    if (!token) return;

    // Use challengeId if available, otherwise fall back to challengeCode
    const challengeId = examState.challengeId || examState.challengeCode;
    if (!challengeId) return;

    const totalQuestions = results.totalQuestions;
    const correctCount = results.correctAnswers;
    const percentage = results.scorePercentage;
    const timeSpent = results.timeSpent / 1000; // convert to seconds

    // Compute mean difficulty from all questions
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
        challengeId,          // ✅ backend expects challengeId
        score: correctCount,
        totalQuestions,
        percentage,
        timeSpent,
        difficultyFactor,
    };

    if (navigator.onLine) {
        try {
            // Use the correct Convex mutation name
            await convexHttpClient.mutation("challenges/mutations:submitResult", payload);
            console.log('Challenge result submitted successfully');
            // Mark as submitted to prevent duplicate push via sync
            results.challengeResultSubmitted = true;
            // Re‑save the exam with this flag
            await db.saveExamResult(results);
        } catch (err) {
            console.error('Challenge result submission failed:', err);
            // Queue for later sync
            await queueChallengeResult(payload);
        }
    } else {
        console.warn('Offline – queuing challenge result for later');
        await queueChallengeResult(payload);
    }
}

/**
 * Queue challenge result for later submission.
 * @param {Object} payload - challenge result payload
 */
async function queueChallengeResult(payload) {
    await db.addToSyncQueue('challenge_result', payload);
}

// ==================== Exam Config Management ====================

/**
 * Store exam configuration in the state and optionally in sessionStorage.
 * @param {Object} config - exam configuration object
 */
export function setExamConfig(config) {
    examState.config = config;
    if (config) {
        sessionStorage.setItem('examConfig', JSON.stringify(config));
    } else {
        sessionStorage.removeItem('examConfig');
    }
}

/**
 * Retrieve the current exam configuration from state, or from sessionStorage as fallback.
 * @returns {Object|null}
 */
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

/**
 * Clear the exam configuration from state and sessionStorage.
 */
export function clearExamConfig() {
    examState.config = null;
    sessionStorage.removeItem('examConfig');
}

/**
 * Clear the entire exam state (for logout, reset, etc.)
 */
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

// Live proxy for backward compatibility with `import { config } from ...`
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
  }
});

// Standard object literal – uses function hoisting, no issues
export const examEngine = {
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
    clearExamState
};