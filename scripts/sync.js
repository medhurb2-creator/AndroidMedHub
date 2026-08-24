// scripts/sync.js

import * as utils from './utils.js';
import * as db from './db.js';
import * as auth from './auth.js';
import * as subscription from './subscription.js';
import { convexHttpClient } from './convex-client.js';
import { navigateTo } from './router.js';

// ==================== CONSTANTS ====================

const SYNC_INTERVAL_MS = 30 * 60 * 1000;     // 30 minutes (background check)
const SYNC_COOLDOWN_MS = 60 * 60 * 1000;     // 1 hour (minimum time between full syncs)
const SYNC_STATE_KEY = 'sync_state';
const SYNC_TIMER_KEY = 'sync_timer';

// ==================== SYNC TIMER ====================

function getLastSyncTime() {
    const stored = localStorage.getItem(SYNC_TIMER_KEY);
    if (stored === null) return 0;
    const parsed = parseInt(stored, 10);
    return isNaN(parsed) ? 0 : parsed;
}

function setLastSyncTime(ts) {
    localStorage.setItem(SYNC_TIMER_KEY, String(ts));
}

function isSyncAllowed() {
    const last = getLastSyncTime();
    const now = Date.now();
    return (now - last) > SYNC_COOLDOWN_MS;
}

// ==================== SYNC STATE ====================

let syncState = {
    lastFullSync: 0,
    lastPush: { exams: 0, notes: 0 },
    lastPull: { exams: 0, notes: 0 }
};

function loadSyncState() {
    const stored = utils.getLocalStorage(SYNC_STATE_KEY);
    if (stored) {
        try {
            syncState = JSON.parse(stored);
        } catch (e) {
            syncState = getDefaultSyncState();
        }
    } else {
        syncState = getDefaultSyncState();
    }
}

function getDefaultSyncState() {
    return {
        lastFullSync: 0,
        lastPush: { exams: 0, notes: 0 },
        lastPull: { exams: 0, notes: 0 }
    };
}

function saveSyncState() {
    utils.setLocalStorage(SYNC_STATE_KEY, syncState);
}

// ==================== NETWORK DETECTION ====================

let onlineStatus = navigator.onLine;

export function isOnline() {
    return navigator.onLine;
}

export function monitorConnection() {
    window.addEventListener('online', () => {
        onlineStatus = true;
        syncData().catch(() => {});
    });
    window.addEventListener('offline', () => {
        onlineStatus = false;
    });
}

// ==================== TOKEN HELPERS (with refresh) ====================

function getAuthToken() {
    const token = utils.getLocalStorage('accessToken');
    if (!token) {
        console.warn('[Sync] No token found in localStorage');
        return null;
    }
    return token;
}

async function ensureValidToken() {
    let token = getAuthToken();
    if (!token) return null;

    // Try using current token first; if it fails, we'll refresh in the caller.
    return token;
}

async function refreshTokenIfNeeded() {
    console.log('[Sync] Attempting to refresh token...');
    const refreshed = await auth.refreshSession();
    if (refreshed) {
        console.log('[Sync] Token refreshed successfully.');
        return getAuthToken();
    }
    console.warn('[Sync] Token refresh failed.');
    return null;
}

// Helper to execute an action with retry after token refresh
async function withTokenRetry(action) {
    let token = getAuthToken();
    if (!token) throw new Error('No authentication token');

    try {
        return await action(token);
    } catch (error) {
        const message = error?.message || error?.toString() || '';
        const isTokenError =
            message.includes('invalid_token') ||
            message.includes('session_expired') ||
            message.includes('verify authentication token') ||
            message.includes('Failed to verify authentication token') ||
            message.includes('Unauthorized') ||
            message.includes('authentication failed') ||
            message.includes('token') ||
            message.includes('JWT verification error') ||
            message.includes('jwt expired') ||
            message.includes('TokenExpiredError');

        if (!isTokenError) {
            throw error; // Not a token error, rethrow
        }

        console.warn('[Sync] Token error detected, attempting refresh...');
        const newToken = await refreshTokenIfNeeded();
        if (!newToken) {
            // Refresh failed, throw original error
            throw error;
        }
        // Retry once with new token
        console.log('[Sync] Retrying with refreshed token...');
        return await action(newToken);
    }
}

// ==================== LOCAL HELPER FOR SYNC QUEUE ====================

async function addToSyncQueue(type, data, attempts = 0) {
    const user = auth.getUser();
    const item = {
        type,
        data,
        userId: user?.id || user?._id || 'anonymous',
        timestamp: Date.now(),
        attempts: attempts
    };
    await db.addToSyncQueue(item);
}

// ==================== SYNC DATA (MAIN) ====================

export async function syncData(force = false) {
    if (!onlineStatus) {
        console.log('[Sync] Skipped: offline');
        return;
    }

    if (!force && !isSyncAllowed()) {
        const last = getLastSyncTime();
        const nextAllowed = last + SYNC_COOLDOWN_MS;
        if (last !== 0) {
            console.log(`[Sync] Cooldown active (next sync at ${new Date(nextAllowed).toLocaleTimeString()}). Skipping.`);
            return;
        }
    }

    console.log('[Sync] Starting full sync...');

    try {
        const user = auth.getUser();
        if (!user) {
            console.warn('[Sync] No authenticated user');
            return;
        }

        // Use withTokenRetry for each step to handle token refresh
        await withTokenRetry(async (token) => {
            await pushAllData(user, token);
        });

        await withTokenRetry(async (token) => {
            await processSyncQueue(token);
        });

        await withTokenRetry(async (token) => {
            await pullAllData(user, token);
        });

        const now = Date.now();
        syncState.lastFullSync = now;
        setLastSyncTime(now);
        saveSyncState();

        console.log('[Sync] Full sync completed successfully.');
    } catch (err) {
        console.error('[Sync] Sync failed:', err);
        // Only force logout if token refresh also failed and it's a token error
        const message = err?.message || err?.toString() || '';
        if (message.includes('token') || message.includes('Unauthorized')) {
            console.warn('[Sync] Token error and refresh failed, logging out.');
            utils.removeLocalStorage('accessToken');
            utils.removeLocalStorage('user');
            navigateTo('login');
        }
    }
}

// ==================== PUSH ====================

async function pushAllData(user, token) {
    await pushExamResults(user, token);
    await pushNotes(user, token);
}

async function pushExamResults(user, token) {
    const lastPushTime = syncState.lastPush.exams;
    const exams = await db.getAllExamResults();
    const newExams = exams.filter(e => {
        const date = new Date(e.date).getTime();
        return (date > lastPushTime || (e.updatedAt && e.updatedAt > lastPushTime)) && e.downloaded === true;
    });
    if (newExams.length === 0) {
        console.log('[Sync] No new downloaded exam results to push.');
        return;
    }

    console.log(`[Sync] Pushing ${newExams.length} downloaded exam results...`);

    const mappedResults = newExams.map(exam => {
        const scorePercentage = exam.scorePercentage ?? exam.score ?? 0;
        const correctAnswers = exam.correctAnswers ?? 0;
        const totalQuestions = exam.totalQuestions ?? 0;
        const timeSpent = exam.timeSpent ?? 0;
        const averageTimePerQuestion = exam.averageTimePerQuestion ?? (timeSpent / (totalQuestions || 1));

        let topicPerformance = [];
        if (Array.isArray(exam.topicPerformance)) {
            topicPerformance = exam.topicPerformance.map(tp => ({
                topic: tp.topic,
                correct: tp.correct ?? Math.round((tp.score || 0) / 100 * (tp.questions || 1)),
                questions: tp.questions ?? 1,
                percentage: tp.percentage ?? tp.score ?? 0,
                averageTime: tp.averageTime ?? tp.timePerQuestion ?? 0
            }));
        }

        let questions = [];
        let answers = [];
        if (exam.downloaded === true) {
            questions = exam.questions || [];
            answers = (exam.answers || []).map(a => ({
                questionId: a.questionId,
                selectedAnswer: a.selectedAnswer ?? '',
                isCorrect: a.isCorrect ?? false,
                timeSpent: a.timeSpent ?? 0
            }));
        }

        return {
            examId: exam.examId || exam._id,
            completedAt: new Date(exam.date).getTime(),
            scorePercentage,
            correctAnswers,
            totalQuestions,
            subject: exam.subject || '',
            mode: exam.mode || 'standard',
            timeSpent,
            averageTimePerQuestion,
            topicPerformance,
            weakAreas: exam.weakAreas || [],
            questions,
            answers
        };
    });

    const result = await convexHttpClient.action("examResults/mutations:syncExamResults", {
        token,
        results: mappedResults
    });

    if (result.success) {
        syncState.lastPush.exams = Date.now();
        saveSyncState();
        console.log(`[Sync] Pushed ${newExams.length} downloaded exam results.`);
    } else {
        throw new Error(result.message || 'Push failed');
    }
}

async function pushNotes(user, token) {
    const notes = await db.getNotesByUser(user._id);
    const newNotes = notes.filter(n => n.synced === false);
    if (newNotes.length === 0) {
        console.log('[Sync] No new notes to push.');
        return;
    }

    console.log(`[Sync] Pushing ${newNotes.length} notes...`);

    for (const note of newNotes) {
        const isAlreadySynced = !!note.serverId;
        let serverResult;
        if (!isAlreadySynced) {
            serverResult = await convexHttpClient.action("notes/actions:createNote", {
                token,
                title: note.title,
                content: note.content,
                plainText: note.plainText || '',
                isProtected: note.isProtected || false,
                password: note.password || undefined,
                subject: note.subject,
                topic: note.topic,
                questionId: note.questionId,
                tags: note.tags,
                attachments: note.attachments,
                flashcards: note.flashcards,
                shareWith: note.shareWith,
                sharedPublic: note.sharedPublic,
            });
        } else {
            serverResult = await convexHttpClient.action("notes/actions:updateNote", {
                token,
                noteId: note.serverId,
                title: note.title,
                content: note.content,
                plainText: note.plainText || '',
                isProtected: note.isProtected || false,
                password: note.password || undefined,
                subject: note.subject,
                topic: note.topic,
                questionId: note.questionId,
                tags: note.tags,
                attachments: note.attachments,
                flashcards: note.flashcards,
                shareWith: note.shareWith,
                sharedPublic: note.sharedPublic,
            });
        }
        if (!serverResult.success) throw new Error(serverResult.message || 'Note sync failed');
        const serverId = isAlreadySynced ? note.serverId : serverResult.data.noteId;
        await db.saveNote({
            ...note,
            serverId: serverId,
            synced: true,
            updatedAt: Date.now()
        });
    }
    syncState.lastPush.notes = Date.now();
    saveSyncState();
    console.log(`[Sync] Pushed ${newNotes.length} notes.`);
}

// ==================== PUSH SINGLE NOTE ====================

export async function pushSingleNote(noteId) {
    if (!onlineStatus) {
        throw new Error('Cannot push note while offline');
    }

    const token = getAuthToken();
    if (!token) throw new Error('Not authenticated');

    const note = await db.getNote(noteId);
    if (!note) throw new Error('Note not found locally');

    const isAlreadySynced = !!note.serverId;

    let serverResult;
    if (!isAlreadySynced) {
        serverResult = await convexHttpClient.action("notes/actions:createNote", {
            token,
            title: note.title,
            content: note.content,
            plainText: note.plainText || '',
            isProtected: note.isProtected || false,
            password: note.password || undefined,
            subject: note.subject,
            topic: note.topic,
            questionId: note.questionId,
            tags: note.tags,
            attachments: note.attachments,
            flashcards: note.flashcards,
            shareWith: note.shareWith,
            sharedPublic: note.sharedPublic,
        });
    } else {
        serverResult = await convexHttpClient.action("notes/actions:updateNote", {
            token,
            noteId: note.serverId,
            title: note.title,
            content: note.content,
            plainText: note.plainText || '',
            isProtected: note.isProtected || false,
            password: note.password || undefined,
            subject: note.subject,
            topic: note.topic,
            questionId: note.questionId,
            tags: note.tags,
            attachments: note.attachments,
            flashcards: note.flashcards,
            shareWith: note.shareWith,
            sharedPublic: note.sharedPublic,
        });
    }

    if (!serverResult.success) throw new Error(serverResult.message || 'Note sync failed');
    const serverId = isAlreadySynced ? note.serverId : serverResult.data.noteId;
    await db.saveNote({
        ...note,
        serverId: serverId,
        synced: true,
        updatedAt: Date.now()
    });

    syncState.lastPush.notes = Date.now();
    saveSyncState();
    console.log(`[Sync] Pushed single note ${noteId} successfully.`);
}

// ==================== PULL ====================

async function pullAllData(user, token) {
    await pullExamResults(user, token);
    await pullNotes(user, token);
}

async function pullExamResults(user, token) {
    const lastPullTime = syncState.lastPull.exams;
    try {
        const result = await convexHttpClient.action("examResults/actions:getExamHistory", {
            token,
            limit: 100,
            since: lastPullTime,
        });
        if (result.success && result.data && result.data.results && result.data.results.length > 0) {
            const newExams = result.data.results;
            for (const exam of newExams) {
                const local = await db.getExamResultByExamId(exam.examId);
                if (local && local.updatedAt && local.updatedAt > exam.completedAt) continue;
                const localExam = {
                    examId: exam.examId,
                    score: exam.scorePercentage ?? 0,
                    correctAnswers: exam.correctAnswers ?? 0,
                    totalQuestions: exam.totalQuestions ?? 0,
                    scorePercentage: exam.scorePercentage ?? 0,
                    subject: exam.subject || '',
                    mode: exam.mode || 'standard',
                    date: new Date(exam.completedAt).toISOString(),
                    timeSpent: exam.timeSpent ?? 0,
                    averageTimePerQuestion: exam.averageTimePerQuestion ?? 0,
                    topicPerformance: (exam.topicPerformance || []).map(tp => ({
                        topic: tp.topic,
                        correct: tp.correct ?? 0,
                        questions: tp.questions ?? 1,
                        percentage: tp.percentage ?? 0,
                        averageTime: tp.averageTime ?? 0,
                        score: tp.percentage ?? 0,
                        timePerQuestion: tp.averageTime ?? 0
                    })),
                    weakAreas: exam.weakAreas || [],
                    questions: exam.questions || [],
                    answers: (exam.answers || []).map(a => ({
                        questionId: a.questionId,
                        selectedAnswer: a.selectedAnswer,
                        isCorrect: a.isCorrect,
                        timeSpent: a.timeSpent
                    })),
                    downloaded: true,
                    updatedAt: exam.completedAt
                };
                await db.saveExamResult(localExam);
            }
            syncState.lastPull.exams = Date.now();
            saveSyncState();
            console.log(`[Sync] Pulled ${newExams.length} exam results.`);
        } else {
            console.log('[Sync] No new exam results pulled.');
        }
    } catch (err) {
        console.error('[Sync] Pull exam results failed:', err);
    }
}

async function pullNotes(user, token) {
    const lastPullTime = syncState.lastPull.notes;
    try {
        const result = await convexHttpClient.action("notes/actions:getUserNotes", {
            token,
            limit: 100,
            since: lastPullTime,
        });
        if (result.success && result.data && result.data.notes && result.data.notes.length > 0) {
            const newNotes = result.data.notes;
            for (const serverNote of newNotes) {
                const existing = await db.getNoteByServerId(serverNote._id);
                if (existing && existing.updatedAt && existing.updatedAt > serverNote.updatedAt) continue;
                if (existing) {
                    await db.saveNote({
                        ...existing,
                        title: serverNote.title,
                        content: serverNote.content,
                        plainText: serverNote.plainText || '',
                        isProtected: serverNote.isProtected || false,
                        subject: serverNote.subject,
                        topic: serverNote.topic,
                        questionId: serverNote.questionId,
                        tags: serverNote.tags || [],
                        attachments: serverNote.attachments || [],
                        flashcards: serverNote.flashcards || [],
                        shareWith: serverNote.shareWith || [],
                        sharedPublic: serverNote.sharedPublic || false,
                        sharedToken: serverNote.sharedToken || null,
                        lastReviewed: serverNote.lastReviewed,
                        reviewCount: serverNote.reviewCount || 0,
                        updatedAt: serverNote.updatedAt,
                        synced: true,
                        serverId: serverNote._id
                    });
                } else {
                    const newId = 'note_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                    await db.saveNote({
                        id: newId,
                        userId: user._id,
                        title: serverNote.title,
                        content: serverNote.content,
                        plainText: serverNote.plainText || '',
                        isProtected: serverNote.isProtected || false,
                        subject: serverNote.subject,
                        topic: serverNote.topic,
                        questionId: serverNote.questionId,
                        tags: serverNote.tags || [],
                        attachments: serverNote.attachments || [],
                        flashcards: serverNote.flashcards || [],
                        shareWith: serverNote.shareWith || [],
                        sharedPublic: serverNote.sharedPublic || false,
                        sharedToken: serverNote.sharedToken || null,
                        lastReviewed: serverNote.lastReviewed,
                        reviewCount: serverNote.reviewCount || 0,
                        createdAt: serverNote.createdAt || serverNote.updatedAt,
                        updatedAt: serverNote.updatedAt,
                        synced: true,
                        serverId: serverNote._id
                    });
                }
            }
            syncState.lastPull.notes = Date.now();
            saveSyncState();
            console.log(`[Sync] Pulled ${newNotes.length} notes.`);
        } else {
            console.log('[Sync] No new notes pulled.');
        }
    } catch (err) {
        console.error('[Sync] Pull notes failed:', err);
    }
}

// ==================== SYNC QUEUE PROCESSING ====================

async function processSyncQueue(token) {
    const queue = await db.getSyncQueue();
    if (queue.length === 0) return;
    console.log(`[Sync] Processing ${queue.length} sync queue items...`);

    for (const item of queue) {
        try {
            await processSyncItem(item, token);
            await db.removeFromSyncQueue(item.id);
        } catch (err) {
            console.error(`[Sync] Failed to process queue item ${item.id}:`, err);
            if (item.type === 'note_delete' && err.message && (err.message.includes('not found') || err.message.includes('does not exist'))) {
                console.warn(`[Sync] Removing note_delete item ${item.id} because note was not found on server.`);
                await db.removeFromSyncQueue(item.id);
            } else {
                const attempts = (item.attempts || 0) + 1;
                if (attempts > 3) {
                    console.error(`[Sync] Item ${item.id} exceeded max attempts. Removing from queue.`);
                    await db.removeFromSyncQueue(item.id);
                } else {
                    await db.removeFromSyncQueue(item.id);
                    await addToSyncQueue(item.type, item.data, attempts);
                }
            }
        }
    }
}

async function processSyncItem(item, token) {
    switch (item.type) {
        case 'note_delete':
            await processNoteDeletion(item.data, token);
            break;
        case 'exam_results':
            await pushExamResultsForItem(item.data, token);
            break;
        case 'profile_update':
            await convexHttpClient.mutation("users/mutations:updateProfile", {
                token,
                ...item.data
            });
            break;
        case 'subscription':
            await processSubscriptionItem(item.data, token);
            break;
        default:
            console.warn(`[Sync] Unknown queue item type: ${item.type}`);
    }
}

async function processNoteDeletion(data, token) {
    if (!data || !data.serverId) {
        console.warn('[Sync] Invalid note deletion data:', data);
        return;
    }
    try {
        const result = await convexHttpClient.action("notes/actions:deleteNote", {
            token,
            noteId: data.serverId
        });
        if (!result.success) {
            throw new Error(result.message || 'Server deletion failed');
        }
        console.log(`[Sync] Successfully deleted note ${data.serverId} from server`);
    } catch (err) {
        if (err.message && (err.message.includes('not found') || err.message.includes('does not exist') || err.message.includes('404'))) {
            console.warn(`[Sync] Note ${data.serverId} already deleted on server.`);
            return;
        }
        throw err;
    }
}

async function pushExamResultsForItem(data, token) {
    if (!data) return;
    const result = await convexHttpClient.action("examResults/mutations:syncExamResults", {
        token,
        results: [data]
    });
    if (!result.success) throw new Error(result.message);
}

async function processSubscriptionItem(data, token) {
    if (!data) return;
    if (data.planId && data.phoneNumber) {
        await convexHttpClient.mutation("subscriptions/mutations:purchaseSubscription", {
            token,
            planName: data.planId,
            deviceFingerprint: data.deviceFingerprint || 'unknown'
        });
    } else if (data.trial === true) {
        await convexHttpClient.mutation("subscriptions/mutations:startFreeTrial", {
            token,
            deviceFingerprint: data.deviceFingerprint || 'unknown'
        });
    } else if (data.cancel === true) {
        await convexHttpClient.mutation("subscriptions/mutations:cancelSubscription", { token });
    } else {
        console.log('[Sync] Subscription data does not match any mutation; skipping.');
    }
}

// ==================== SYNC USER DATA (from app.js) ====================

async function _syncUserProfile() {
    if (!navigator.onLine) return false;

    try {
        const result = await withTokenRetry(async (token) => {
            return await convexHttpClient.query("users/queries:getProfile", { token });
        });

        if (result && result.success && result.data && result.data.user) {
            const freshUser = result.data.user;
            console.log('[Sync] Fetched user profile from backend:', freshUser);
            await auth.setUser(freshUser);
            return true;
        } else if (result && !result.success) {
            console.warn('[Sync] Profile sync failed:', result.message);
        }
    } catch (err) {
        console.warn('[Sync] Could not sync user profile', err);
    }
    return false;
}

async function _syncSubscriptionStatus() {
    if (!navigator.onLine) return false;

    try {
        const freshSub = await withTokenRetry(async (token) => {
            return await subscription.getSubscriptionStatus(true);
        });
        if (freshSub) {
            await subscription.setSubscription(freshSub);
            return true;
        }
    } catch (err) {
        console.warn('[Sync] Could not sync subscription status', err);
    }
    return false;
}

export async function syncUserData() {
    console.log('[Sync] Syncing user data from backend...');
    await Promise.all([_syncUserProfile(), _syncSubscriptionStatus()]);
}

export async function triggerFullSync() {
    console.log('[Sync] Triggering full sync...');
    await syncData();
}

// ==================== LEGACY SYNC FUNCTIONS ====================

export async function syncExamResults(result) {
    if (!result) {
        console.warn('[Sync] syncExamResults called with undefined result, skipping.');
        return;
    }

    if (onlineStatus) {
        try {
            const user = auth.getUser();
            const token = getAuthToken();
            if (!token) return;
            await pushExamResults(user, token);
        } catch (err) {
            console.warn('[Sync] Immediate exam sync failed:', err);
            await addToSyncQueue('exam_results', result);
        }
    } else {
        await addToSyncQueue('exam_results', result);
    }
}

export async function syncUserProfile(updates) {
    if (onlineStatus) {
        try {
            const token = getAuthToken();
            if (!token) return;
            await convexHttpClient.mutation("users/mutations:updateProfile", {
                token,
                ...updates
            });
        } catch (err) {
            console.error('[Sync] Profile sync failed:', err);
            await addToSyncQueue('profile_update', updates);
        }
    } else {
        await addToSyncQueue('profile_update', updates);
    }
}

export async function syncSubscription(data) {
    if (!onlineStatus) {
        await addToSyncQueue('subscription', data);
        return;
    }

    try {
        const token = getAuthToken();
        if (!token) return;
        if (data.planId && data.phoneNumber) {
            await convexHttpClient.mutation("subscriptions/mutations:purchaseSubscription", {
                token,
                planName: data.planId,
                deviceFingerprint: data.deviceFingerprint || 'unknown'
            });
        } else if (data.trial === true) {
            await convexHttpClient.mutation("subscriptions/mutations:startFreeTrial", {
                token,
                deviceFingerprint: data.deviceFingerprint || 'unknown'
            });
        } else if (data.cancel === true) {
            await convexHttpClient.mutation("subscriptions/mutations:cancelSubscription", { token });
        } else {
            console.log('[Sync] Subscription data does not match any mutation; skipping.');
        }
    } catch (err) {
        console.error('[Sync] Subscription sync failed:', err);
        await addToSyncQueue('subscription', data);
    }
}

// ==================== BACKGROUND SYNC ====================

let syncInterval = null;

export function setupBackgroundSync() {
    if (syncInterval) clearInterval(syncInterval);
    const interval = SYNC_INTERVAL_MS + Math.floor(Math.random() * 5 * 60 * 1000);
    syncInterval = setInterval(() => {
        if (onlineStatus) {
            syncData(false).catch(err => console.warn('[Sync] Background sync failed', err));
        }
    }, interval);
}

export function triggerBackgroundSync() {
    if (onlineStatus) {
        syncData(true).catch(err => console.warn('[Sync] Manual sync failed', err));
    }
}

// ==================== STATUS REPORTING ====================

export async function getSyncStatus() {
    const queue = await db.getSyncQueue();
    return {
        online: onlineStatus,
        pending: queue.length,
        items: queue,
        lastFullSync: syncState.lastFullSync,
        lastPush: syncState.lastPush,
        lastPull: syncState.lastPull
    };
}

export async function getLastSync() {
    return syncState.lastFullSync;
}

export async function getPendingSyncs() {
    const queue = await db.getSyncQueue();
    return queue.length;
}

export function resetSyncTimer() {
    console.log('[Sync] Resetting sync timer (force sync on next call)');
    setLastSyncTime(0);
}

// ==================== INITIALIZATION ====================

loadSyncState();
monitorConnection();
setupBackgroundSync();

// ==================== EXPOSE GLOBALLY ====================

window.sync = {
    syncData,
    syncExamResults,
    syncUserProfile,
    syncSubscription,
    monitorConnection,
    isOnline,
    getSyncStatus,
    getLastSync,
    getPendingSyncs,
    triggerBackgroundSync,
    pushSingleNote,
    resetSyncTimer,
    syncUserData,
    triggerFullSync
};