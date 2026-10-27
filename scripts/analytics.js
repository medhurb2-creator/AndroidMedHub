// scripts/analytics.js

/**
 * Performance Analytics Module — ENGINE-BACKED (offline, no LLM)
 *
 * Calculates exam statistics, subject progress, weak areas, trends, and
 * recommendations. All data is derived from exam results stored in IndexedDB.
 *
 * IMPORTANT ARCHITECTURAL NOTE (2026-02):
 *   The LLM (`generateAIInsightsFromRaw` from performance-ai.js) has been
 *   REMOVED. Personalized learning intelligence is now produced entirely
 *   by the local Bayesian / psychometric / decision-theoretic engine in
 *   medvix-engine.js + medvix-narrator.js, accessed via medvix.js.
 *
 *   Why this is strictly better:
 *     • Offline — no network, no API cost, no latency
 *     • Deterministic — same learner + same data → same output
 *     • Truthful by construction — every number comes from the engine's
 *       posterior; the narrator refuses to invent numbers
 *     • Uncertainty-aware — every claim carries a CI / certainty band
 *     • Fast — ~20ms on a low-end Android device
 *
 *   The `aiInsights` key is retained for API compatibility with existing
 *   callers (performance.js), but its value is now produced locally.
 *   Its `source` field is `'medvix-local'`.
 *
 * Uses cached performance/leaderboard from db.js (populated by sync.js) to
 * provide offline capabilities.
 */

import * as utils from './utils.js';
import * as db from './db.js';
import * as sync from './sync.js';
import * as performanceRating from './performance-rating-v2.js';
import * as auth from './auth.js';
import { convexHttpClient } from './convex-client.js';  // leaderboard only
import * as medvix from './medvix.js';                  // ← THE ENGINE

// ==================== CONSTANTS ====================

const MASTERY_THRESHOLDS = {
    EXPERT: 90,
    ADVANCED: 80,
    INTERMEDIATE: 70,
    BEGINNER: 60,
};

// ==================== HELPER: FILTER VALID EXAMS ====================

function filterValidExams(exams) {
    return exams.filter(
        (exam) =>
            exam &&
            exam.examId &&
            exam.totalQuestions > 0 &&
            exam.scorePercentage !== undefined
    );
}

// ==================== SUBJECT PROGRESS ====================

export async function getSubjectProgress() {
    try {
        const exams = filterValidExams(await db.getAllExamResults());
        if (!exams || exams.length === 0) return {};

        const subjectStats = {};
        exams.forEach((exam) => {
            const subject = exam.subject;
            if (!subject) return;
            if (!subjectStats[subject]) {
                subjectStats[subject] = { totalQuestions: 0, correct: 0 };
            }
            subjectStats[subject].totalQuestions += exam.totalQuestions || 0;
            subjectStats[subject].correct += exam.correctAnswers || 0;
        });

        const progress = {};
        Object.entries(subjectStats).forEach(([subject, stats]) => {
            progress[subject] = Math.round((stats.correct / stats.totalQuestions) * 100) || 0;
        });
        return progress;
    } catch (e) {
        console.warn('getSubjectProgress failed', e);
        return {};
    }
}

// ==================== RECENT TOPICS ====================

export async function getRecentTopics(subjectId, limit = 3) {
    try {
        const exams = filterValidExams(await db.getAllExamResults());
        if (!exams || exams.length === 0) return [];

        const subjectExams = exams
            .filter((exam) => exam.subject === subjectId)
            .sort((a, b) => new Date(b.date || b.examId) - new Date(a.date || a.examId));

        const topicsMap = new Map();
        subjectExams.forEach((exam) => {
            if (exam.topics && Array.isArray(exam.topics)) {
                exam.topics.forEach((topic) => {
                    if (!topicsMap.has(topic.id)) {
                        topicsMap.set(topic.id, {
                            subjectId,
                            topicId: topic.id,
                            topicName: topic.name,
                            questions: topic.questions || 0,
                            lastStudied: exam.date || new Date().toISOString(),
                        });
                    }
                });
            }
        });

        return Array.from(topicsMap.values())
            .sort((a, b) => new Date(b.lastStudied) - new Date(a.lastStudied))
            .slice(0, limit);
    } catch (e) {
        console.warn('getRecentTopics failed', e);
        return [];
    }
}

// ==================== WEAK AREAS (with engine enrichment) ====================

export async function identifyWeakAreas() {
    try {
        const exams = filterValidExams(await db.getAllExamResults());
        if (!exams || exams.length === 0) return [];

        const topicStats = {};
        exams.forEach((exam) => {
            if (!exam.questions || !Array.isArray(exam.questions)) return;
            exam.questions.forEach((q) => {
                const topic = q.topic;
                if (!topic) return;
                if (!topicStats[topic]) topicStats[topic] = { total: 0, correct: 0 };
                topicStats[topic].total++;
                if (q.correct) topicStats[topic].correct++;
            });
        });

        const weakAreas = [];
        Object.entries(topicStats).forEach(([topic, stats]) => {
            const percentage = (stats.correct / stats.total) * 100;
            if (percentage < 70) {
                weakAreas.push({
                    topic,
                    score: percentage,
                    questions: stats.total,
                    priority: percentage < 50 ? 'high' : 'medium',
                });
            }
        });

        // Enrich with engine mastery/retrieval (best-effort, non-fatal)
        await enrichWeakAreasWithEngine(weakAreas);

        return weakAreas.sort((a, b) => a.score - b.score);
    } catch (e) {
        console.warn('identifyWeakAreas failed', e);
        return [];
    }
}

async function enrichWeakAreasWithEngine(weakAreas) {
    if (!Array.isArray(weakAreas) || weakAreas.length === 0) return;
    try {
        const snapshots = await medvix.getAllConceptStates();
        if (!snapshots || snapshots.length === 0) return;

        // Group engine concepts by raw topic
        const byTopic = new Map();
        for (const s of snapshots) {
            if (!s.topic) continue;
            if (!byTopic.has(s.topic)) byTopic.set(s.topic, []);
            byTopic.get(s.topic).push(s);
        }

        for (const w of weakAreas) {
            const snaps = byTopic.get(w.topic) || [];
            if (snaps.length === 0) {
                w.engineMastery = null;
                w.engineRetrieval = null;
                w.engineConceptCount = 0;
                continue;
            }
            const avgM = snaps.reduce((s, x) => s + (x.mastery?.p ?? 0), 0) / snaps.length;
            const avgR = snaps.reduce((s, x) => s + (x.retrieval?.pNow ?? 0), 0) / snaps.length;
            w.engineMastery = Number.isFinite(avgM) ? avgM : null;
            w.engineRetrieval = Number.isFinite(avgR) ? avgR : null;
            w.engineConceptCount = snaps.length;
        }
    } catch (e) {
        console.warn('[Analytics] enrichWeakAreasWithEngine failed (non-fatal):', e);
    }
}

// ==================== ENGINE-BACKED INSIGHTS ====================
//
// Replaces the deleted LLM call. Returns the SAME SHAPE callers expect,
// but the content is composed from the local MedVix engine + narrator.
//
// The function name `generateAIInsights` is retained for API compatibility
// with existing code (`performance.js`, `refreshAnalytics`, etc.) but the
// `source` field is always 'medvix-local'.
//
// No caching, no network, no LLM.

export async function generateAIInsights(/* forceRefresh — kept for API compat, unused */) {
    try {
        const digest = await medvix.narrateLearningDigest('friendly');

        if (!digest || digest.evidenceCount === 0) {
            return {
                source: 'medvix-local',
                insights:
                    'Complete a few questions and the learning engine will start reporting here.',
                recommendations: [],
                focusTopics: [],
                digest: null,
                brier: null,
            };
        }

        // Assemble the main prose from narrator output.
        // Order: retention risks first (immediate action), then weak concepts.
        const insightLines = [];
        for (const r of digest.riskNarrations) insightLines.push(r.narration.text);
        for (const w of digest.weakNarrations) insightLines.push(w.narration.text);

        // Fallback if narrator produced nothing but engine has data
        if (insightLines.length === 0 && Number.isFinite(digest.averageMastery)) {
            insightLines.push(
                `You have ${digest.totalConcepts} concepts tracked with an average mastery of ${Math.round(
                    digest.averageMastery * 100
                )}%.`
            );
        }

        // Recommendations: prefer narrator-generated review targets.
        const recommendations = [];
        for (const t of digest.targets) recommendations.push(t.narration.text);
        if (recommendations.length === 0) {
            for (const w of digest.weakNarrations.slice(0, 3)) {
                recommendations.push(w.narration.text);
            }
        }

        return {
            source: 'medvix-local',
            insights: insightLines.join(' ').trim(),
            recommendations,
            focusTopics: digest.weakNarrations.map((w) => w.conceptId),
            digest,
            brier: digest.brier,
        };
    } catch (e) {
        console.warn('[Analytics] Local insights failed:', e);
        return {
            source: 'medvix-local',
            insights:
                'Learning engine warming up — take a few questions and this will fill in.',
            recommendations: [],
            focusTopics: [],
            digest: null,
            brier: null,
        };
    }
}

// ==================== NEW PUBLIC API (engine direct access) ====================
//
// These extend the analytics surface so pages can query the engine without
// importing medvix.js themselves. All are thin, safe pass-throughs.

export async function getLearningDigest(register = 'friendly') {
    try {
        return await medvix.narrateLearningDigest(register);
    } catch (e) {
        console.warn('getLearningDigest failed', e);
        return null;
    }
}

export async function getLearnerModel() {
    try {
        return await medvix.getLearnerSummary();
    } catch (e) {
        console.warn('getLearnerModel failed', e);
        return null;
    }
}

export async function getConceptSnapshot(conceptId) {
    try {
        return await medvix.getConceptState(conceptId);
    } catch (e) {
        console.warn('getConceptSnapshot failed', e);
        return null;
    }
}

export async function getConceptDiagnostic(conceptId) {
    try {
        return await medvix.getDiagnose(conceptId);
    } catch (e) {
        console.warn('getConceptDiagnostic failed', e);
        return null;
    }
}

export async function getConceptReviewPlan(conceptId) {
    try {
        return await medvix.getReviewPlan(conceptId);
    } catch (e) {
        console.warn('getConceptReviewPlan failed', e);
        return null;
    }
}

export async function getReviewTargets(limit = 3) {
    try {
        return await medvix.getTopReviewTargets(limit);
    } catch (e) {
        console.warn('getReviewTargets failed', e);
        return [];
    }
}

export async function getAdaptiveQuestionPool(pool, budgetSec = 600, mode = null, subject = null) {
    try {
        return await medvix.selectNextQuestions(pool, budgetSec, mode, subject);
    } catch (e) {
        console.warn('getAdaptiveQuestionPool failed', e);
        return null;
    }
}

export async function getRecommendedMode(context = {}) {
    try {
        return await medvix.getModeRecommendation(context);
    } catch (e) {
        console.warn('getRecommendedMode failed', e);
        return null;
    }
}

// ==================== ANALYTICS CALCULATIONS ====================

export async function calculateAllAnalytics(results = null) {
    try {
        const rawExams = results || (await db.getAllExamResults()) || [];
        const exams = filterValidExams(rawExams);

        // Engine-backed insights — no network, no gate, always attempts.
        let aiInsights = null;
        try {
            aiInsights = await generateAIInsights();
        } catch (e) {
            console.warn('[Analytics] Local insights failed (non-fatal):', e);
        }

        const ratingInfo = await getUserRatingInfo();
        const weakAreas = await identifyWeakAreas();
        const subjectAnalysis = analyzeSubjects(exams);

        // Enrich subjectAnalysis with engine state (mutates, non-fatal)
        await enrichSubjectAnalysisWithEngine(subjectAnalysis);

        return {
            summary: calculateSummary(exams),
            trends: calculateTrends(exams),
            subjectAnalysis,
            studyPatterns: analyzeStudyPatterns(exams),
            weakAreas,
            recommendations: generateRecommendations(exams, aiInsights),
            rating: ratingInfo,
            aiInsights,               // ← now engine-backed, source: 'medvix-local'
            exams,
        };
    } catch (e) {
        console.warn('calculateAllAnalytics failed', e);
        return {
            summary: {},
            trends: [],
            subjectAnalysis: [],
            studyPatterns: {},
            weakAreas: [],
            recommendations: [],
            rating: null,
            aiInsights: null,
            exams: [],
        };
    }
}

async function enrichSubjectAnalysisWithEngine(subjectAnalysis) {
    if (!Array.isArray(subjectAnalysis) || subjectAnalysis.length === 0) return;
    try {
        const snapshots = await medvix.getAllConceptStates();
        if (!snapshots || snapshots.length === 0) return;

        const bySubject = new Map();
        for (const s of snapshots) {
            if (!s.subject) continue;
            if (!bySubject.has(s.subject)) bySubject.set(s.subject, []);
            bySubject.get(s.subject).push(s);
        }

        for (const subj of subjectAnalysis) {
            const snaps = bySubject.get(subj.subject) || [];
            if (snaps.length === 0) {
                subj.engineMastery = null;
                subj.engineRetrieval = null;
                subj.engineConceptCount = 0;
                continue;
            }
            const avgM = snaps.reduce((s, x) => s + (x.mastery?.p ?? 0), 0) / snaps.length;
            const avgR = snaps.reduce((s, x) => s + (x.retrieval?.pNow ?? 0), 0) / snaps.length;
            subj.engineMastery = Number.isFinite(avgM) ? avgM : null;
            subj.engineRetrieval = Number.isFinite(avgR) ? avgR : null;
            subj.engineConceptCount = snaps.length;
        }
    } catch (e) {
        console.warn('[Analytics] enrichSubjectAnalysisWithEngine failed (non-fatal):', e);
    }
}

export async function refreshAnalytics(forceSync = false) {
    if (sync.isOnline()) {
        console.log('[Analytics] Syncing data before analytics...');
        await sync.syncData();
    } else if (forceSync) {
        console.warn('[Analytics] Force sync requested but device is offline.');
    }
    // No AI cache to invalidate anymore — the engine is derived from
    // IndexedDB and always reflects the latest exams. Just recompute.
    return await calculateAllAnalytics();
}

// ==================== USER RATING INFO (cached-first) ====================

export async function getUserRatingInfo() {
    try {
        // 1. Try cached performance from IndexedDB (populated by sync.js)
        const cachedPerf = await db.getUserPerformance();
        if (cachedPerf) {
            return {
                rating: cachedPerf.rating || 100,
                rank: cachedPerf.rank || { rank: 1, label: 'Seed', title: 'Starting Out' },
                historyEWMA: cachedPerf.historyEWMA || 0.5,
                completedExams: cachedPerf.completedExams || 0,
                reliability: cachedPerf.startedExams
                    ? Math.min(1, (cachedPerf.completedExams || 0) / (cachedPerf.startedExams || 1))
                    : 1,
                lastExamPR: cachedPerf.lastExamPR || null,
                leaderboardPoints: cachedPerf.leaderboardPoints || 0,
                completedChallenges: cachedPerf.completedChallenges || 0,
                integrityScore: cachedPerf.integrityScore || 1,
                achievements: cachedPerf.achievements || [],
            };
        }

        // 2. Fallback to local user object
        const user = auth.getUser();
        if (!user) return null;

        const rating = user.rating || 100;
        const rank = performanceRating.getRank(rating);
        const historyEWMA = user.historyEWMA || 0.5;
        const completedExams = user.completedExams || 0;
        const reliability = user.startedExams
            ? Math.min(1, completedExams / (user.startedExams || 1))
            : 1;

        return {
            rating,
            rank,
            historyEWMA,
            completedExams,
            reliability,
            lastExamPR: user.lastExamPR || null,
            leaderboardPoints: user.leaderboardPoints || 0,
            completedChallenges: user.completedChallenges || 0,
            integrityScore: user.integrityScore || 1,
            achievements: user.achievements || [],
        };
    } catch (e) {
        console.warn('getUserRatingInfo failed', e);
        return null;
    }
}

// ==================== LEADERBOARD (cached-first) ====================
//
// Note: leaderboard uses convexHttpClient for FRESH competition data
// (multi-user rankings). This is a data fetch, not AI. It stays.

export async function getLeaderboard(limit = 100) {
    try {
        // 1. Try cached leaderboard from IndexedDB (populated by sync.js)
        const cached = await db.getLeaderboard();
        if (cached && cached.length > 0) {
            return cached.slice(0, limit);
        }

        // 2. If online, fetch from backend and cache
        if (navigator.onLine && auth.getToken()) {
            const result = await convexHttpClient.action('users/queries:getLeaderboard', {
                token: auth.getToken(),
                limit,
            });
            if (result.success && result.data) {
                await db.saveLeaderboard(result.data);
                return result.data.slice(0, limit);
            }
        }

        // 3. Fallback to local users
        const users = await db.getAllUsers();
        return users
            .filter((u) => u.rating && u.rating > 0)
            .sort((a, b) => b.rating - a.rating)
            .slice(0, limit)
            .map((u) => ({
                id: u._id,
                name: u.name || 'Anonymous',
                rating: u.rating,
                rank: performanceRating.getRank(u.rating),
                completedExams: u.completedExams || 0,
                lastExamPR: u.lastExamPR || null,
            }));
    } catch (e) {
        console.warn('getLeaderboard failed', e);
        return [];
    }
}

// ==================== RATING HISTORY ====================

export async function getRatingHistory(userId = null, limit = 30) {
    try {
        const targetUserId = userId || auth.getUser()?._id;
        if (!targetUserId) return [];

        const exams = await db.getAllExamResults();
        const userExams = exams
            .filter((e) => e.userId === targetUserId && e.newRating !== undefined)
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .slice(-limit);

        return userExams.map((e) => ({
            date: e.date,
            rating: e.newRating,
            change: e.ratingChange || 0,
            pr: e.performanceRatio || null,
            examId: e.examId,
        }));
    } catch (e) {
        console.warn('getRatingHistory failed', e);
        return [];
    }
}

// ==================== HELPER FUNCTIONS (INTERNAL) ====================

function calculateSummary(exams) {
    if (!exams.length) {
        return {
            totalExams: 0,
            totalQuestions: 0,
            averageScore: 0,
            totalStudyTime: 0,
            totalStudyTimeSeconds: 0,
            bestScore: 0,
            worstScore: 0,
            correct: 0
        };
    }

    const totalExams = exams.length;
    const totalQuestions = exams.reduce((sum, e) => sum + (e.totalQuestions || 0), 0);
    const totalCorrect = exams.reduce((sum, e) => {
        if (e.correctAnswers !== undefined) return sum + e.correctAnswers;
        const score = e.scorePercentage || 0;
        const questions = e.totalQuestions || 1;
        return sum + Math.round((score / 100) * questions);
    }, 0);

    const averageScore = totalQuestions ? (totalCorrect / totalQuestions) * 100 : 0;
    const totalMs = exams.reduce((sum, e) => sum + (e.timeSpent || 0), 0);
    const totalMinutes = totalMs / (1000 * 60);
    const totalHours = totalMinutes / 60;
    const scores = exams.map((e) => e.scorePercentage || 0);
    const bestScore = Math.max(...scores, 0);
    const worstScore = Math.min(...scores, 0);

    return {
        totalExams,
        totalQuestions,
        averageScore: Math.round(averageScore),
        totalStudyTime: Math.round(totalHours * 10) / 10,      // legacy: hours (rounded)
        totalStudyTimeSeconds: Math.round(totalMs / 1000),     // NEW: raw seconds for adaptive display
        bestScore: Math.round(bestScore),
        worstScore: Math.round(worstScore),
        correct: totalCorrect
    };
}

function calculateTrends(exams) {
    if (!exams.length) return [];

    const grouped = {};
    exams.forEach((exam, index) => {
        let dateStr;
        if (exam.date) {
            dateStr = exam.date.split('T')[0];
        } else if (exam.examId && typeof exam.examId === 'string') {
            const parts = exam.examId.split('_');
            if (parts.length > 1) {
                const ts = parseInt(parts[1]);
                if (!isNaN(ts) && ts > 1000000000) {
                    dateStr = new Date(ts).toISOString().split('T')[0];
                }
            }
        }
        if (!dateStr) {
            const now = new Date();
            now.setDate(now.getDate() - (exams.length - 1 - index));
            dateStr = now.toISOString().split('T')[0];
        }

        if (!grouped[dateStr]) {
            grouped[dateStr] = { scores: [], totalQuestions: 0, timeMs: 0 };
        }
        grouped[dateStr].scores.push(exam.scorePercentage || 0);
        grouped[dateStr].totalQuestions += exam.totalQuestions || 0;
        grouped[dateStr].timeMs += exam.timeSpent || 0;
    });

    return Object.entries(grouped)
        .map(([date, data]) => ({
            date,
            score: data.scores.reduce((a, b) => a + b, 0) / data.scores.length,
            questions: data.totalQuestions,
            time: data.timeMs / (1000 * 60),
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
}

function analyzeSubjects(exams) {
    if (!exams.length) return [];

    const subjectData = {};
    exams.forEach((exam) => {
        const subject = exam.subject;
        if (!subject) return;
        if (!subjectData[subject]) {
            subjectData[subject] = { exams: 0, questions: 0, correct: 0, timeMs: 0 };
        }
        subjectData[subject].exams++;
        subjectData[subject].questions += exam.totalQuestions || 0;
        subjectData[subject].correct += exam.correctAnswers || 0;
        subjectData[subject].timeMs += exam.timeSpent || 0;
    });

    return Object.entries(subjectData).map(([subject, data]) => {
        const percentage = data.questions ? (data.correct / data.questions) * 100 : 0;
        const avgTimeSec = data.questions ? Math.round(data.timeMs / data.questions / 1000) : 0;
        return {
            subject,
            exams: data.exams,
            questions: data.questions,
            correct: data.correct,
            percentage: Math.round(percentage),
            averageTime: avgTimeSec,
            mastery: calculateMasteryLevel(percentage),
            // Engine fields populated by enrichSubjectAnalysisWithEngine()
            engineMastery: null,
            engineRetrieval: null,
            engineConceptCount: 0,
        };
    });
}

function calculateMasteryLevel(percentage) {
    if (percentage >= MASTERY_THRESHOLDS.EXPERT) return 'expert';
    if (percentage >= MASTERY_THRESHOLDS.ADVANCED) return 'advanced';
    if (percentage >= MASTERY_THRESHOLDS.INTERMEDIATE) return 'intermediate';
    if (percentage >= MASTERY_THRESHOLDS.BEGINNER) return 'beginner';
    return 'needs-work';
}

function analyzeStudyPatterns(exams) {
    if (!exams.length) return {};

    const byDay = {
        Monday: { count: 0, totalScore: 0 },
        Tuesday: { count: 0, totalScore: 0 },
        Wednesday: { count: 0, totalScore: 0 },
        Thursday: { count: 0, totalScore: 0 },
        Friday: { count: 0, totalScore: 0 },
        Saturday: { count: 0, totalScore: 0 },
        Sunday: { count: 0, totalScore: 0 },
    };

    const byHour = Array(24).fill().map(() => ({ count: 0, totalScore: 0 }));

    exams.forEach((exam) => {
        if (!exam.date) return;
        const date = new Date(exam.date);
        if (isNaN(date)) return;
        const day = date.toLocaleDateString('en-US', { weekday: 'long' });
        const hour = date.getHours();
        if (byDay[day]) {
            byDay[day].count++;
            byDay[day].totalScore += exam.scorePercentage || 0;
        }
        if (byHour[hour]) {
            byHour[hour].count++;
            byHour[hour].totalScore += exam.scorePercentage || 0;
        }
    });

    let bestDay = null;
    let bestDayScore = 0;
    Object.entries(byDay).forEach(([day, data]) => {
        if (data.count > 0) {
            const avg = data.totalScore / data.count;
            if (avg > bestDayScore) {
                bestDayScore = avg;
                bestDay = day;
            }
        }
    });

    let bestHour = null;
    let bestHourScore = 0;
    byHour.forEach((data, hour) => {
        if (data.count > 0) {
            const avg = data.totalScore / data.count;
            if (avg > bestHourScore) {
                bestHourScore = avg;
                bestHour = hour;
            }
        }
    });

    const totalDays = 30;
    const uniqueDays = new Set(exams.map((e) => e.date?.split('T')[0])).size;
    const consistency = Math.min(100, (uniqueDays / totalDays) * 100);

    const totalMs = exams.reduce((sum, e) => sum + (e.timeSpent || 0), 0);
    const totalMinutes = totalMs / (1000 * 60);
    const avgSession = exams.length ? totalMinutes / exams.length : 0;

    let totalQuestions = 0;
    let longestSession = 0;
    let sessionCount = 0;
    exams.forEach((e) => {
        totalQuestions += e.totalQuestions || 0;
        const duration = (e.timeSpent || 0) / (1000 * 60);
        if (duration > longestSession) longestSession = Math.round(duration);
        sessionCount++;
    });
    const avgQuestionsPerDay = uniqueDays > 0 ? Math.round(totalQuestions / uniqueDays) : 0;

    return {
        bestDay,
        bestDayScore: Math.round(bestDayScore),
        bestHour,
        bestHourScore: Math.round(bestHourScore),
        averageSessionTime: Math.round(avgSession),
        consistency: Math.round(consistency),
        streak: calculateStreak(exams),
        weeksActive: Math.ceil(uniqueDays / 7) || 1,
        averageQuestionsPerDay: avgQuestionsPerDay,
        longestSession: longestSession,
        sessionCount: sessionCount,
    };
}

function calculateStreak(exams) {
    if (!exams.length) return 0;
    const dates = exams
        .map((e) => e.date?.split('T')[0])
        .filter((d) => d)
        .sort((a, b) => new Date(b) - new Date(a));
    if (dates.length === 0) return 0;

    let streak = 1;
    for (let i = 1; i < dates.length; i++) {
        const prevDate = new Date(dates[i - 1]);
        const thisDate = new Date(dates[i]);
        const diffDays = Math.round((prevDate - thisDate) / (1000 * 60 * 60 * 24));
        if (diffDays === 1) {
            streak++;
        } else if (diffDays > 1) {
            break;
        }
    }
    return streak;
}

function generateRecommendations(exams, aiInsights = null) {
    const recommendations = [];

    if (!exams.length) {
        recommendations.push({
            type: 'info',
            message: 'Take your first exam to get personalized recommendations!',
        });
        return recommendations;
    }

    // ── 1. Retention risks FIRST — most urgent (engine-sourced) ──
    if (aiInsights?.digest?.riskNarrations?.length > 0) {
        for (const r of aiInsights.digest.riskNarrations.slice(0, 2)) {
            recommendations.push({
                type: 'retention_risk',
                conceptId: r.conceptId,
                priority: 'high',
                source: 'medvix-local',
                action: r.narration.text,
            });
        }
    }

    // ── 2. Weak areas (exam-accuracy, engine-narrated when possible) ──
    const weakAreas = identifyWeakAreasSync(exams);
    if (weakAreas.length > 0) {
        weakAreas.slice(0, 3).forEach((area) => {
            // Try to match to an engine narrator line
            const engineNarr = aiInsights?.digest?.weakNarrations?.find(
                (w) => w.conceptId && w.conceptId.endsWith('::' + area.topic)
            );
            recommendations.push({
                type: 'focus_subject',
                subject: area.topic,
                currentScore: Math.round(area.score),
                targetScore: 80,
                priority: area.priority,
                source: engineNarr ? 'medvix-local' : 'exam-accuracy',
                action: engineNarr
                    ? engineNarr.narration.text
                    : `Focus on ${area.topic} — your score is ${Math.round(area.score)}%.`,
            });
        });
    }

    // ── 3. Time management ──
    const avgTime = exams.reduce((sum, e) => sum + (e.averageTimePerQuestion || 0), 0) / exams.length;
    if (avgTime > 45) {
        recommendations.push({
            type: 'time_management',
            issue: 'Answering questions too slowly',
            current: `${Math.round(avgTime)}s per question`,
            target: '30s',
            priority: 'medium',
            action: 'Practice with timed quizzes focusing on speed.',
        });
    }

    // ── 4. Consistency ──
    const streak = calculateStreak(exams);
    if (streak < 3) {
        recommendations.push({
            type: 'consistency',
            issue: 'Inconsistent study habits',
            current: `${streak} day streak`,
            target: '7+ days',
            priority: 'medium',
            action: 'Set daily reminder for 20-minute study sessions.',
        });
    }

    // ── 5. Engine narrative summary — the overall learning insights ──
    if (aiInsights?.insights) {
        recommendations.push({
            type: 'learning_insights',
            source: aiInsights.source || 'medvix-local',
            insights: aiInsights.insights,
            recommendations: aiInsights.recommendations || [],
            focusTopics: aiInsights.focusTopics || [],
            brier: aiInsights.brier || null,
            priority: 'high',
        });
    }

    return recommendations;
}

function identifyWeakAreasSync(exams) {
    const topicStats = {};
    exams.forEach((exam) => {
        if (!exam.questions || !Array.isArray(exam.questions)) return;
        exam.questions.forEach((q) => {
            const topic = q.topic;
            if (!topic) return;
            if (!topicStats[topic]) topicStats[topic] = { total: 0, correct: 0 };
            topicStats[topic].total++;
            if (q.correct) topicStats[topic].correct++;
        });
    });

    const weak = [];
    Object.entries(topicStats).forEach(([topic, stats]) => {
        const percentage = (stats.correct / stats.total) * 100;
        if (percentage < 70) {
            weak.push({
                topic,
                score: percentage,
                priority: percentage < 50 ? 'high' : 'medium',
            });
        }
    });
    return weak.sort((a, b) => a.score - b.score);
}

// ==================== EXPOSE GLOBALLY ====================

window.analytics = {
    // Existing (unchanged API surface)
    getSubjectProgress,
    getRecentTopics,
    identifyWeakAreas,
    calculateAllAnalytics,
    refreshAnalytics,
    getUserRatingInfo,
    getLeaderboard,
    getRatingHistory,
    generateAIInsights,     // ← same name, now engine-backed
    calculateSummary,
    calculateTrends,
    analyzeSubjects,
    analyzeStudyPatterns,
    generateRecommendations,
    calculateStreak,

    // New — direct engine access
    getLearningDigest,
    getLearnerModel,
    getConceptSnapshot,
    getConceptDiagnostic,
    getConceptReviewPlan,
    getReviewTargets,
    getAdaptiveQuestionPool,
    getRecommendedMode,
};