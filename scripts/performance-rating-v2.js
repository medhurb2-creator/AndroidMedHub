// scripts/performance-rating-v2.js

/**
 * MedVix Performance Rating Engine v2 (MPREv2) – Final Production Version
 * 
 * Based on extensive review and feedback, this version incorporates:
 *   - 10 ranks (Seed → Luminary)
 *   - Rating starts at 100 (Rank 1)
 *   - Confidence Factor capped at 200 exams
 *   - Minimum realistic time for speed bonus
 *   - Rating update based on relative performance (vs. lobby average)
 *   - Reliability Factor separated (for matchmaking, anti-cheat)
 *   - Integrity Score (for detecting suspicious behaviour)
 * 
 * Factors and Weights (unchanged):
 *   C (Correct)        0.43
 *   D (Difficulty)     0.25
 *   T (Time)           0.10
 *   H (History EWMA)   0.08
 *   R (Rank)           0.05
 *   A (Attempt)        0.04
 *   CF (Confidence)    0.02
 *   S (Consistency)    0.03
 * 
 * PR = C^0.43 × D^0.25 × T^0.10 × H^0.08 × R^0.05 × A^0.04 × CF^0.02 × S^0.03
 */

import * as db from './db.js';
import * as utils from './utils.js';
import { getUser } from './auth.js';  // ✅ changed from './app.js'

// ==================== CONSTANTS ====================

const BASE_RATING = 100;
const RANK_GROWTH_FACTOR = 1.8;
const MAX_RANKS = 10;
const RATING_SMOOTHING = 3000;
const EWMA_ALPHA = 0.20;
const TIME_DECAY_ALPHA = 0.8;
const K_FACTOR = 32;
const CONFIDENCE_DECAY = 50;
const CONFIDENCE_CAP = 200; // max completed exams for confidence factor
const MIN_TIME_PER_QUESTION = 4; // seconds
const PR_PRECISION = 6;

// Calibrated difficulty weights
const DIFFICULTY_WEIGHTS = {
    1: 1.00,
    2: 1.50,
    3: 2.30,
    4: 3.50,
    5: 5.20
};

// ==================== RANK DEFINITIONS ====================

const RANK_NAMES = [
    'Seed',      // rank 1
    'Aspire',    // rank 2
    'Scholar',   // rank 3
    'Proficient',// rank 4
    'Advanced',  // rank 5
    'Expert',    // rank 6
    'Elite',     // rank 7
    'Master',    // rank 8
    'Apex',      // rank 9
    'Luminary'   // rank 10
];

const RANK_TITLES = [
    'Starting Out',
    'Rising',
    'Learning',
    'Capable',
    'Skilled',
    'Expert',
    'Elite',
    'Master',
    'Apex',
    'Luminary'
];

/**
 * Get rank information based on rating.
 * @param {number} rating - Current rating (minimum BASE_RATING)
 * @returns {Object} { rank, ratingRequired, label, title }
 */
function getRank(rating) {
    const effectiveRating = Math.max(rating, BASE_RATING);
    
    for (let i = MAX_RANKS - 1; i >= 0; i--) {
        const required = BASE_RATING * Math.pow(RANK_GROWTH_FACTOR, i);
        if (effectiveRating >= required) {
            return {
                rank: i + 1,
                ratingRequired: Math.round(required),
                label: RANK_NAMES[i],
                title: RANK_TITLES[i]
            };
        }
    }
    // Should never reach here because rating >= BASE_RATING
    return {
        rank: 1,
        ratingRequired: BASE_RATING,
        label: RANK_NAMES[0],
        title: RANK_TITLES[0]
    };
}

// ==================== FACTOR COMPUTATIONS ====================

// 1. Correct Answer Factor
function computeCorrectFactor(correct, total) {
    if (total === 0) return 0;
    return Math.min(1, correct / total);
}

// 2. Difficulty Factor (calibrated weights)
function computeDifficultyFactor(questions, answers) {
    if (!questions || !answers || questions.length === 0) return 0;
    let earned = 0, maximum = 0;
    questions.forEach((q, idx) => {
        const weight = DIFFICULTY_WEIGHTS[q.difficulty] || 1;
        maximum += weight;
        const answer = answers[idx];
        if (answer && answer.selectedOption === q.correct) {
            earned += weight;
        }
    });
    if (maximum === 0) return 0;
    return Math.min(1, earned / maximum);
}

// 3. Time Factor (exponential decay with minimum realistic time)
function computeTimeFactor(timeUsed, timeLimit, questionCount) {
    if (timeLimit <= 0) return 1;
    if (timeUsed <= 0) return 1;
    // Minimum realistic time: cannot be faster than MIN_TIME_PER_QUESTION per question
    const minTime = questionCount * MIN_TIME_PER_QUESTION;
    const effectiveTime = Math.max(timeUsed, minTime);
    const ratio = Math.min(effectiveTime / timeLimit, 3);
    return Math.exp(-TIME_DECAY_ALPHA * ratio);
}

// 4. History Factor – true EWMA
function computeHistoryFactor(historyEWMA) {
    if (typeof historyEWMA !== 'number' || isNaN(historyEWMA)) return 0.5;
    return Math.min(1, Math.max(0, historyEWMA));
}

// 5. Rank Factor
function computeRankFactor(rating) {
    if (rating <= 0) return 0;
    return 1 - Math.exp(-rating / RATING_SMOOTHING);
}

// 6. Attempt Factor
function computeAttemptFactor(attempted, total) {
    if (total === 0) return 0;
    return Math.min(1, attempted / total);
}

// 7. Confidence Factor (capped at 200 exams)
function computeConfidenceFactor(completedExams) {
    const capped = Math.min(completedExams, CONFIDENCE_CAP);
    return 1 - Math.exp(-capped / CONFIDENCE_DECAY);
}

// 8. Consistency Factor (weighted by average PR)
function computeConsistencyFactor(previousPRs, avgPR) {
    if (!previousPRs || previousPRs.length < 3) return 0.5;
    const avg = avgPR || previousPRs.reduce((s, v) => s + v, 0) / previousPRs.length;
    const variance = previousPRs.reduce((s, v) => s + (v - avg) ** 2, 0) / previousPRs.length;
    const stdDev = Math.sqrt(variance);
    const normalized = Math.min(stdDev, 0.5) / 0.5;
    const consistency = 1 - normalized;
    return Math.min(1, Math.max(0, consistency * avg));
}

// ==================== PERFORMANCE RATIO (PR) ====================

function computePerformanceRatio(data) {
    const {
        correct,
        total,
        questions,
        answers,
        timeUsed,
        timeLimit,
        historyEWMA = 0.5,
        rating = BASE_RATING,
        completedExams = 1,
        previousPRs = []
    } = data;

    const C = computeCorrectFactor(correct, total);
    const D = computeDifficultyFactor(questions, answers);
    const T = computeTimeFactor(timeUsed, timeLimit, total);
    const H = computeHistoryFactor(historyEWMA);
    const R = computeRankFactor(rating);
    const A = computeAttemptFactor(answers?.filter(a => a.selectedOption !== null).length || 0, total);
    const CF = computeConfidenceFactor(completedExams);
    const avgPR = previousPRs.length > 0 ? previousPRs.reduce((s, v) => s + v, 0) / previousPRs.length : 0.5;
    const S = computeConsistencyFactor(previousPRs, avgPR);

    let pr = Math.pow(C, 0.43) *
             Math.pow(D, 0.25) *
             Math.pow(T, 0.10) *
             Math.pow(H, 0.08) *
             Math.pow(R, 0.05) *
             Math.pow(A, 0.04) *
             Math.pow(CF, 0.02) *
             Math.pow(S, 0.03);

    pr = Math.min(1, Math.max(0, pr));
    return {
        pr: Math.round(pr * Math.pow(10, PR_PRECISION)) / Math.pow(10, PR_PRECISION),
        factors: { C, D, T, H, R, A, CF, S }
    };
}

// ==================== RATING UPDATE (relative performance) ====================

/**
 * Update rating based on relative performance within a lobby.
 * @param {number} currentRating - User's current rating
 * @param {number} pr - User's Performance Ratio
 * @param {number} lobbyAvgPR - Average PR of all participants in the exam
 * @param {number} opponentAvgRating - Average rating of opponents (for Elo adjustment)
 * @param {number} kFactor - K-factor
 * @returns {number} new rating
 */
function updateRatingRelative(currentRating, pr, lobbyAvgPR = 0.5, opponentAvgRating = 0, kFactor = K_FACTOR) {
    // Performance difference: how much better (or worse) than the average participant
    const performanceDiff = pr - lobbyAvgPR;
    
    // Convert to a probability-like value (0-1)
    // Using a logistic function to map performance difference to a win probability
    // Higher performanceDiff -> higher probability of being the top performer
    const winProbability = 1 / (1 + Math.exp(-4 * performanceDiff));
    
    // Elo expected score based on rating difference
    const ratingDiff = opponentAvgRating - currentRating;
    const eloExpected = 1 / (1 + Math.pow(10, ratingDiff / 400));
    
    // Combine both signals: winProbability (from PR) and eloExpected (from ratings)
    const actual = winProbability;
    const expected = eloExpected;
    
    const change = kFactor * (actual - expected);
    return Math.max(BASE_RATING, Math.round(currentRating + change));
}

// ==================== HISTORY UPDATE (EWMA) ====================

function updateHistoryEWMA(previousEWMA, pr, alpha = EWMA_ALPHA) {
    const prev = typeof previousEWMA === 'number' ? previousEWMA : 0.5;
    return alpha * pr + (1 - alpha) * prev;
}

// ==================== INTEGRITY SCORE (anti-cheat) ====================

/**
 * Compute an integrity score (0-1) to detect suspicious exam attempts.
 * Higher score = more trustworthy.
 * @param {Object} data - exam attempt data
 * @returns {Object} { score, flags: [] }
 */
function computeIntegrityScore(data) {
    const { timeUsed, totalQuestions, answers, userAgent, deviceFingerprint } = data;
    let flags = [];
    let score = 1.0;

    // 1. Impossible speed: finishing too fast
    const minPossibleTime = totalQuestions * 2; // absolute minimum 2 seconds per question
    if (timeUsed < minPossibleTime) {
        score -= 0.5;
        flags.push('impossibly_fast');
    }

    // 2. Suspicious answer patterns: all answers identical (e.g., all 'A')
    if (answers && answers.length > 5) {
        const answerCounts = {};
        let maxCount = 0;
        answers.forEach(a => {
            const key = a.selectedOption || 'null';
            answerCounts[key] = (answerCounts[key] || 0) + 1;
            if (answerCounts[key] > maxCount) maxCount = answerCounts[key];
        });
        if (maxCount / answers.length > 0.9) {
            score -= 0.3;
            flags.push('monotonous_answers');
        }
    }

    // 3. Device fingerprint mismatch (if previously used different device)
    const user = getUser();  // ✅ now uses the imported function
    if (user && user.deviceFingerprint && deviceFingerprint && user.deviceFingerprint !== deviceFingerprint) {
        score -= 0.1;
        flags.push('device_change');
    }

    // Clamp score to [0,1]
    score = Math.min(1, Math.max(0, score));
    return { score, flags };
}

// ==================== DATA RETRIEVAL ====================

async function getPerformanceData(examId, userId) {
    const exam = await db.getExamResult(examId);
    if (!exam) throw new Error('Exam not found');

    const user = getUser();  // ✅ now uses the imported function
    const rating = user?.rating ?? BASE_RATING;
    const historyEWMA = user?.historyEWMA ?? 0.5;
    const completedExams = user?.completedExams ?? 0;
    const startedExams = user?.startedExams ?? 0;

    const allExams = await db.getAllExamResults();
    const previousExams = allExams
        .filter(e => e.examId !== examId && e.date < exam.date)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

    const previousPRs = [];
    for (const prev of previousExams.slice(-20)) {
        try {
            const result = computePerformanceRatio({
                correct: prev.correctAnswers,
                total: prev.totalQuestions,
                questions: prev.questions || [],
                answers: prev.answers || [],
                timeUsed: prev.timeSpent / 1000,
                timeLimit: prev.timeAllocated || prev.totalQuestions * 30,
                historyEWMA: 0.5,
                rating: rating,
                completedExams: completedExams
            });
            previousPRs.push(result.pr);
        } catch (e) { /* skip */ }
    }

    const completedCount = completedExams + 1;

    return {
        correct: exam.correctAnswers,
        total: exam.totalQuestions,
        questions: exam.questions || [],
        answers: exam.answers || [],
        timeUsed: exam.timeSpent / 1000,
        timeLimit: exam.timeAllocated || exam.totalQuestions * 30,
        historyEWMA,
        rating,
        completedExams: completedCount,
        previousPRs,
        examData: exam,
        user,
        startedExams
    };
}

// ==================== MAIN API ====================

async function computeFullPerformance(examId, userId, lobbyAvgPR = 0.5, opponentAvgRating = BASE_RATING) {
    const data = await getPerformanceData(examId, userId);
    const result = computePerformanceRatio(data);

    const rank = getRank(data.rating);
    const newRating = updateRatingRelative(data.rating, result.pr, lobbyAvgPR, opponentAvgRating);

    const newHistory = updateHistoryEWMA(data.historyEWMA, result.pr);

    const achievements = checkAchievements({
        pr: result.pr,
        rating: newRating,
        examData: data.examData,
        factors: result.factors,
        rank
    });

    // Integrity check
    const integrity = computeIntegrityScore({
        timeUsed: data.timeUsed,
        totalQuestions: data.total,
        answers: data.answers,
        userAgent: navigator.userAgent,
        deviceFingerprint: utils.getLocalStorage('deviceFingerprint')
    });

    const reliability = data.startedExams ? 
        Math.min(1, (data.completedExams) / (data.startedExams + 1)) : 1;

    return {
        pr: result.pr,
        factors: result.factors,
        previousRating: data.rating,
        newRating,
        ratingChange: newRating - data.rating,
        rank,
        achievements,
        historyEWMA: newHistory,
        reliability,
        integrity,
        historyCount: data.previousPRs.length
    };
}

// ==================== ACHIEVEMENTS ====================

function checkAchievements(data) {
    const { pr, rating, examData, factors, rank } = data;
    const unlocked = [];

    if (pr >= 0.95 && examData.correctAnswers === examData.totalQuestions) {
        unlocked.push({ id: 'perfect_score', name: 'Perfect Score', description: 'Got 100% on an exam', icon: '⭐' });
    }
    if (factors.T > 0.8 && examData.scorePercentage >= 80) {
        unlocked.push({ id: 'speed_demon', name: 'Speed Demon', description: 'Completed an exam in under half the time with 80%+ score', icon: '⚡' });
    }
    if (rank.rank >= 4) {
        unlocked.push({ id: 'rank_proficient', name: 'Proficient', description: 'Reached Proficient rank', icon: '📚' });
    }
    if (rank.rank >= 6) {
        unlocked.push({ id: 'rank_expert', name: 'Expert', description: 'Reached Expert rank', icon: '🚀' });
    }
    if (rank.rank >= 8) {
        unlocked.push({ id: 'rank_master', name: 'Master', description: 'Reached Master rank', icon: '👑' });
    }
    if (rank.rank >= 10) {
        unlocked.push({ id: 'rank_luminary', name: 'Luminary', description: 'Reached Luminary rank', icon: '🌟' });
    }
    if (factors.S > 0.85) {
        unlocked.push({ id: 'consistent', name: 'Consistent', description: 'Maintained high consistency across exams', icon: '📊' });
    }
    return unlocked;
}

// ==================== EXPOSE GLOBALLY ====================

window.performanceRating = {
    computePerformanceRatio,
    updateRatingRelative,
    getRank,
    computeFullPerformance,
    getPerformanceData,
    checkAchievements,
    updateHistoryEWMA,
    computeIntegrityScore,
    computeCorrectFactor,
    computeDifficultyFactor,
    computeTimeFactor,
    computeHistoryFactor,
    computeRankFactor,
    computeAttemptFactor,
    computeConfidenceFactor,
    computeConsistencyFactor
};

// ==================== SINGLE EXPORT ====================
// All exports are defined here – no duplicates.
export {
    computePerformanceRatio,
    updateRatingRelative,
    getRank,
    computeFullPerformance,
    getPerformanceData,
    checkAchievements,
    updateHistoryEWMA,
    computeIntegrityScore,
    computeCorrectFactor,
    computeDifficultyFactor,
    computeTimeFactor,
    computeHistoryFactor,
    computeRankFactor,
    computeAttemptFactor,
    computeConfidenceFactor,
    computeConsistencyFactor
};