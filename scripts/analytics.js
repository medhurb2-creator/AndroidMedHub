// scripts/analytics.js

/**
 * Performance Analytics Module
 * Calculates exam statistics, subject progress, weak areas, trends, and recommendations.
 * All data is derived from exam results stored in IndexedDB.
 * Integrates with the Performance Rating Engine for user ratings and rankings.
 * Also uses AI to generate personalized insights and recommendations.
 *
 * Now uses cached performance/leaderboard from db.js (populated by sync.js)
 * to provide offline capabilities.
 */

import * as utils from './utils.js';
import * as db from './db.js';
import * as sync from './sync.js';
import * as performanceRating from './performance-rating-v2.js';
import * as auth from './auth.js';
import { convexHttpClient } from './convex-client.js';
import { generateAIInsightsFromRaw } from './performance-ai.js';

// ==================== CONSTANTS ====================

const MASTERY_THRESHOLDS = {
    EXPERT: 90,
    ADVANCED: 80,
    INTERMEDIATE: 70,
    BEGINNER: 60
};

// Cache for AI-generated insights (to avoid repeated calls)
let aiInsightsCache = null;
let aiInsightsCacheTime = 0;
const AI_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// ==================== HELPER: FILTER VALID EXAMS ====================

function filterValidExams(exams) {
    return exams.filter(exam =>
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

        exams.forEach(exam => {
            const subject = exam.subject;
            if (!subject) return;

            if (!subjectStats[subject]) {
                subjectStats[subject] = {
                    totalQuestions: 0,
                    correct: 0
                };
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
            .filter(exam => exam.subject === subjectId)
            .sort((a, b) => new Date(b.date || b.examId) - new Date(a.date || a.examId));

        const topicsMap = new Map();
        subjectExams.forEach(exam => {
            if (exam.topics && Array.isArray(exam.topics)) {
                exam.topics.forEach(topic => {
                    if (!topicsMap.has(topic.id)) {
                        topicsMap.set(topic.id, {
                            subjectId,
                            topicId: topic.id,
                            topicName: topic.name,
                            questions: topic.questions || 0,
                            lastStudied: exam.date || new Date().toISOString()
                        });
                    }
                });
            }
        });

        const topics = Array.from(topicsMap.values())
            .sort((a, b) => new Date(b.lastStudied) - new Date(a.lastStudied))
            .slice(0, limit);

        return topics;
    } catch (e) {
        console.warn('getRecentTopics failed', e);
        return [];
    }
}

// ==================== WEAK AREAS ====================

export async function identifyWeakAreas() {
    try {
        const exams = filterValidExams(await db.getAllExamResults());
        if (!exams || exams.length === 0) return [];

        const topicStats = {};

        exams.forEach(exam => {
            if (!exam.questions || !Array.isArray(exam.questions)) return;
            exam.questions.forEach(q => {
                const topic = q.topic;
                if (!topic) return;
                if (!topicStats[topic]) {
                    topicStats[topic] = { total: 0, correct: 0 };
                }
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
                    priority: percentage < 50 ? 'high' : 'medium'
                });
            }
        });

        return weakAreas.sort((a, b) => a.score - b.score);
    } catch (e) {
        console.warn('identifyWeakAreas failed', e);
        return [];
    }
}

// ==================== AI-POWERED INSIGHTS ====================

export async function generateAIInsights(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && aiInsightsCache && (now - aiInsightsCacheTime) < AI_CACHE_TTL) {
        return aiInsightsCache;
    }

    try {
        const exams = filterValidExams(await db.getAllExamResults());
        if (!exams.length) {
            aiInsightsCache = { insights: 'Complete your first exam to get personalized AI insights!' };
            aiInsightsCacheTime = now;
            return aiInsightsCache;
        }

        const rawData = {
            exams,
            weakAreas: await identifyWeakAreas(),
            trends: calculateTrends(exams),
            studyPatterns: analyzeStudyPatterns(exams),
            subjectAnalysis: analyzeSubjects(exams)
        };

        const aiResult = await generateAIInsightsFromRaw(rawData);

        if (aiResult) {
            aiInsightsCache = aiResult;
            aiInsightsCacheTime = now;
            return aiResult;
        } else {
            const fallback = {
                insights: 'AI insights currently unavailable. Review your weak areas and practice consistently.',
                recommendations: ['Focus on weak topics', 'Practice timed exams'],
                focusTopics: (await identifyWeakAreas()).map(w => w.topic).slice(0, 3)
            };
            aiInsightsCache = fallback;
            aiInsightsCacheTime = now;
            return fallback;
        }
    } catch (e) {
        console.warn('generateAIInsights failed, using fallback', e);
        const fallback = {
            insights: 'AI insights currently unavailable. Review your weak areas and practice consistently.',
            recommendations: ['Focus on weak topics', 'Practice timed exams'],
            focusTopics: (await identifyWeakAreas()).map(w => w.topic).slice(0, 3)
        };
        aiInsightsCache = fallback;
        aiInsightsCacheTime = now;
        return fallback;
    }
}

// ==================== ANALYTICS CALCULATIONS ====================

export async function calculateAllAnalytics(results = null) {
    try {
        const rawExams = results || (await db.getAllExamResults()) || [];
        const exams = filterValidExams(rawExams);

        let aiInsights = null;
        if (navigator.onLine) {
            try {
                aiInsights = await generateAIInsights(false);
            } catch (e) {
                // ignore
            }
        }

        // Get rating info from cache or local user
        const ratingInfo = await getUserRatingInfo();

        return {
            summary: calculateSummary(exams),
            trends: calculateTrends(exams),
            subjectAnalysis: analyzeSubjects(exams),
            studyPatterns: analyzeStudyPatterns(exams),
            weakAreas: await identifyWeakAreas(),
            recommendations: generateRecommendations(exams, aiInsights),
            rating: ratingInfo,
            aiInsights: aiInsights,
            exams: exams
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
            exams: []
        };
    }
}

export async function refreshAnalytics(forceSync = false) {
    if (sync.isOnline()) {
        console.log('[Analytics] Syncing data before analytics...');
        await sync.syncData();
    } else if (forceSync) {
        console.warn('[Analytics] Force sync requested but device is offline.');
    }
    await generateAIInsights(true);
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
                reliability: cachedPerf.startedExams ? Math.min(1, (cachedPerf.completedExams || 0) / (cachedPerf.startedExams || 1)) : 1,
                lastExamPR: cachedPerf.lastExamPR || null,
                leaderboardPoints: cachedPerf.leaderboardPoints || 0,
                completedChallenges: cachedPerf.completedChallenges || 0,
                integrityScore: cachedPerf.integrityScore || 1,
                achievements: cachedPerf.achievements || []
            };
        }

        // 2. Fallback to local user object
        const user = auth.getUser();
        if (!user) return null;

        const rating = user.rating || 100;
        const rank = performanceRating.getRank(rating);
        const historyEWMA = user.historyEWMA || 0.5;
        const completedExams = user.completedExams || 0;
        const reliability = user.startedExams ? 
            Math.min(1, completedExams / (user.startedExams || 1)) : 1;

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
            achievements: user.achievements || []
        };
    } catch (e) {
        console.warn('getUserRatingInfo failed', e);
        return null;
    }
}

// ==================== LEADERBOARD (cached-first) ====================

export async function getLeaderboard(limit = 100) {
    try {
        // 1. Try cached leaderboard from IndexedDB (populated by sync.js)
        const cached = await db.getLeaderboard();
        if (cached && cached.length > 0) {
            // If online, we may want to refresh, but for now use cache
            return cached.slice(0, limit);
        }

        // 2. If online, fetch from backend and cache
        if (navigator.onLine && auth.getToken()) {
            const result = await convexHttpClient.action("users/queries:getLeaderboard", {
                token: auth.getToken(),
                limit
            });
            if (result.success && result.data) {
                await db.saveLeaderboard(result.data);
                return result.data.slice(0, limit);
            }
        }

        // 3. Fallback to local users
        const users = await db.getAllUsers();
        return users
            .filter(u => u.rating && u.rating > 0)
            .sort((a, b) => b.rating - a.rating)
            .slice(0, limit)
            .map(u => ({
                id: u._id,
                name: u.name || 'Anonymous',
                rating: u.rating,
                rank: performanceRating.getRank(u.rating),
                completedExams: u.completedExams || 0,
                lastExamPR: u.lastExamPR || null
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
            .filter(e => e.userId === targetUserId && e.newRating !== undefined)
            .sort((a, b) => new Date(a.date) - new Date(b.date))
            .slice(-limit);

        return userExams.map(e => ({
            date: e.date,
            rating: e.newRating,
            change: e.ratingChange || 0,
            pr: e.performanceRatio || null,
            examId: e.examId
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
    const scores = exams.map(e => e.scorePercentage || 0);
    const bestScore = Math.max(...scores, 0);
    const worstScore = Math.min(...scores, 0);

    return {
        totalExams,
        totalQuestions,
        averageScore: Math.round(averageScore),
        totalStudyTime: Math.round(totalHours * 10) / 10,
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
            time: data.timeMs / (1000 * 60)
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
}

function analyzeSubjects(exams) {
    if (!exams.length) return [];

    const subjectData = {};

    exams.forEach(exam => {
        const subject = exam.subject;
        if (!subject) return;

        if (!subjectData[subject]) {
            subjectData[subject] = {
                exams: 0,
                questions: 0,
                correct: 0,
                timeMs: 0
            };
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
            mastery: calculateMasteryLevel(percentage)
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
        Sunday: { count: 0, totalScore: 0 }
    };

    const byHour = Array(24).fill().map(() => ({ count: 0, totalScore: 0 }));

    exams.forEach(exam => {
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
    const uniqueDays = new Set(exams.map(e => e.date?.split('T')[0])).size;
    const consistency = Math.min(100, (uniqueDays / totalDays) * 100);

    const totalMs = exams.reduce((sum, e) => sum + (e.timeSpent || 0), 0);
    const totalMinutes = totalMs / (1000 * 60);
    const avgSession = exams.length ? totalMinutes / exams.length : 0;

    let totalQuestions = 0;
    let longestSession = 0;
    let sessionCount = 0;
    exams.forEach(e => {
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
        sessionCount: sessionCount
    };
}

function calculateStreak(exams) {
    if (!exams.length) return 0;

    const dates = exams
        .map(e => e.date?.split('T')[0])
        .filter(d => d)
        .sort((a, b) => new Date(b) - new Date(a));

    if (dates.length === 0) return 0;

    let streak = 1;
    let currentDate = new Date(dates[0]);

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
            message: 'Take your first exam to get personalized recommendations!'
        });
        return recommendations;
    }

    const weakAreas = identifyWeakAreasSync(exams);
    if (weakAreas.length > 0) {
        weakAreas.slice(0, 3).forEach(area => {
            recommendations.push({
                type: 'focus_subject',
                subject: area.topic,
                currentScore: Math.round(area.score),
                targetScore: 80,
                priority: area.priority,
                action: `Focus on ${area.topic} – your score is ${Math.round(area.score)}%.`
            });
        });
    }

    const avgTime = exams.reduce((sum, e) => sum + (e.averageTimePerQuestion || 0), 0) / exams.length;
    if (avgTime > 45) {
        recommendations.push({
            type: 'time_management',
            issue: 'Answering questions too slowly',
            current: `${Math.round(avgTime)}s per question`,
            target: '30s',
            priority: 'medium',
            action: 'Practice with timed quizzes focusing on speed.'
        });
    }

    const streak = calculateStreak(exams);
    if (streak < 3) {
        recommendations.push({
            type: 'consistency',
            issue: 'Inconsistent study habits',
            current: `${streak} day streak`,
            target: '7+ days',
            priority: 'medium',
            action: 'Set daily reminder for 20-minute study sessions.'
        });
    }

    if (aiInsights) {
        recommendations.push({
            type: 'ai_insights',
            insights: aiInsights.insights,
            recommendations: aiInsights.recommendations || [],
            focusTopics: aiInsights.focusTopics || [],
            priority: 'high'
        });
    }

    return recommendations;
}

function identifyWeakAreasSync(exams) {
    const topicStats = {};

    exams.forEach(exam => {
        if (!exam.questions || !Array.isArray(exam.questions)) return;
        exam.questions.forEach(q => {
            const topic = q.topic;
            if (!topic) return;
            if (!topicStats[topic]) {
                topicStats[topic] = { total: 0, correct: 0 };
            }
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
                priority: percentage < 50 ? 'high' : 'medium'
            });
        }
    });

    return weak.sort((a, b) => a.score - b.score);
}

// ==================== EXPOSE GLOBALLY ====================

window.analytics = {
    getSubjectProgress,
    getRecentTopics,
    identifyWeakAreas,
    calculateAllAnalytics,
    refreshAnalytics,
    getUserRatingInfo,
    getLeaderboard,
    getRatingHistory,
    generateAIInsights,
    calculateSummary,
    calculateTrends,
    analyzeSubjects,
    analyzeStudyPatterns,
    generateRecommendations,
    calculateStreak
};