// frontend-user/scripts/db.js

/**
 * IndexedDB Database Manager – OFFLINE SINGLE-USER VERSION (v11)
 * Provides persistent storage for user, exams, subscriptions, sync queue,
 * security logs, lock status, analytics, settings, questions, downloaded exams,
 * shared exams, seen questions, notes, chat history, conversations, shared conversations,
 * file blobs, notifications, AND public assets (blobs + version tracking).
 * Falls back to localStorage when IndexedDB fails.
 */

import * as utils from './utils.js';

const DB_NAME = 'MedExamDB';
const DB_VERSION = 12; // bumped to add publicAssets & publicAssetVersions

let db = null;
let dbInitPromise = null;

export function initDatabase() {
    if (db) return Promise.resolve(db);
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error('[DB] IndexedDB error:', event.target.error);
            reject(event.target.error);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('[DB] Opened successfully (v11)');
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            console.log('[DB] Upgrading schema to version', DB_VERSION);

            // --- Existing stores (unchanged) ---
            if (!db.objectStoreNames.contains('users')) {
                const userStore = db.createObjectStore('users', { keyPath: 'id' });
                userStore.createIndex('by_email', 'email', { unique: true });
                userStore.createIndex('by_phone', 'phone', { unique: true });
            }
            if (!db.objectStoreNames.contains('subscriptions')) {
                const subStore = db.createObjectStore('subscriptions', { keyPath: 'userId' });
                subStore.createIndex('by_userId', 'userId', { unique: true });
            }
            if (!db.objectStoreNames.contains('exams')) {
                const examStore = db.createObjectStore('exams', { keyPath: 'examId' });
                examStore.createIndex('by_date', 'date', { unique: false });
            }
            if (!db.objectStoreNames.contains('questions')) {
                const qStore = db.createObjectStore('questions', { keyPath: 'id' });
                qStore.createIndex('by_subject', 'subject', { unique: false });
                qStore.createIndex('by_topic', 'topic', { unique: false });
            }
            if (!db.objectStoreNames.contains('syncQueue')) {
                db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
            }
            if (!db.objectStoreNames.contains('security')) {
                db.createObjectStore('security', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('analytics')) {
                db.createObjectStore('analytics', { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains('settings')) {
                db.createObjectStore('settings', { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains('sharedExams')) {
                const shareStore = db.createObjectStore('sharedExams', { keyPath: 'token' });
                shareStore.createIndex('by_expiry', 'expiry', { unique: false });
            }
            if (!db.objectStoreNames.contains('notes')) {
                const noteStore = db.createObjectStore('notes', { keyPath: 'id' });
                noteStore.createIndex('by_userId', 'userId', { unique: false });
                noteStore.createIndex('by_subject', 'subject', { unique: false });
                noteStore.createIndex('by_topic', 'topic', { unique: false });
                noteStore.createIndex('by_updatedAt', 'updatedAt', { unique: false });
                noteStore.createIndex('by_questionId', 'questionId', { unique: false });
                noteStore.createIndex('by_sharedToken', 'sharedToken', { unique: true });
                noteStore.createIndex('serverId', 'serverId', { unique: false });
                console.log('[DB] Created notes store');
            }
            if (!db.objectStoreNames.contains('chatHistory')) {
                const chatStore = db.createObjectStore('chatHistory', { keyPath: 'id' });
                chatStore.createIndex('by_userId', 'userId', { unique: false });
                chatStore.createIndex('by_timestamp', 'timestamp', { unique: false });
                console.log('[DB] Created chatHistory store');
            }
            if (!db.objectStoreNames.contains('conversations')) {
                const convStore = db.createObjectStore('conversations', { keyPath: 'id' });
                convStore.createIndex('by_userId', 'userId', { unique: false });
                convStore.createIndex('by_updatedAt', 'updatedAt', { unique: false });
                convStore.createIndex('serverId', 'serverId', { unique: false });
                console.log('[DB] Created conversations store');
            }
            if (!db.objectStoreNames.contains('sharedConversations')) {
                const shareConvStore = db.createObjectStore('sharedConversations', { keyPath: 'token' });
                shareConvStore.createIndex('by_expiry', 'expiry', { unique: false });
                console.log('[DB] Created sharedConversations store');
            }
            if (!db.objectStoreNames.contains('files')) {
                db.createObjectStore('files', { keyPath: 'id' });
                console.log('[DB] Created files store');
            }
            if (!db.objectStoreNames.contains('notifications')) {
                const notifStore = db.createObjectStore('notifications', { keyPath: 'id' });
                notifStore.createIndex('by_userId', 'userId', { unique: false });
                notifStore.createIndex('by_read', 'read', { unique: false });
                notifStore.createIndex('by_category', 'category', { unique: false });
                notifStore.createIndex('by_timestamp', 'timestamp', { unique: false });
                notifStore.createIndex('by_serverId', 'serverId', { unique: false });
                notifStore.createIndex('by_pinned', 'pinned', { unique: false });
                notifStore.createIndex('by_archived', 'archived', { unique: false });
                console.log('[DB] Created notifications store');
            }

            // ==================== NEW: Public assets stores ====================
            if (!db.objectStoreNames.contains('publicAssets')) {
                const paStore = db.createObjectStore('publicAssets', { keyPath: 'key' });
                paStore.createIndex('by_updatedAt', 'updatedAt', { unique: false });
                console.log('[DB] Created publicAssets store');
            }
            if (!db.objectStoreNames.contains('publicAssetVersions')) {
                db.createObjectStore('publicAssetVersions', { keyPath: 'id' });
                console.log('[DB] Created publicAssetVersions store');
            }
        };
    });

    return dbInitPromise;
}

async function getStore(storeName, mode = 'readonly') {
    const database = await initDatabase();
    return database.transaction(storeName, mode).objectStore(storeName);
}

// ==================== USER OPERATIONS ====================
export async function saveUser(user) {
    if (!user || !user.id) return;
    try {
        const store = await getStore('users', 'readwrite');
        await new Promise((resolve, reject) => {
            const clearReq = store.clear();
            clearReq.onsuccess = resolve;
            clearReq.onerror = () => reject(clearReq.error);
        });
        return new Promise((resolve, reject) => {
            const request = store.put(user);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveUser failed, using localStorage fallback', e);
        utils.setLocalStorage('user', user);
    }
}

export async function getUser() {
    try {
        const store = await getStore('users', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const users = request.result;
                resolve(users.length > 0 ? users[0] : null);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getUser failed, using localStorage fallback', e);
        return utils.getLocalStorage('user', null);
    }
}

export async function getAllUsers() {
    try {
        const store = await getStore('users', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const user = utils.getLocalStorage('user', null);
        return user ? [user] : [];
    }
}

export async function deleteAllUsers() {
    try {
        const store = await getStore('users', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.removeLocalStorage('user');
    }
}

// ==================== SUBSCRIPTION OPERATIONS ====================
export async function saveSubscription(subscription) {
    if (!subscription || !subscription.userId) return;
    try {
        const store = await getStore('subscriptions', 'readwrite');
        const index = store.index('by_userId');
        const existing = await new Promise((resolve) => {
            const req = index.getAll(subscription.userId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve([]);
        });
        for (const sub of existing) {
            store.delete(sub.userId);
        }
        return new Promise((resolve, reject) => {
            const request = store.put(subscription);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.setLocalStorage('subscription', subscription);
    }
}

export async function getSubscription() {
    try {
        const store = await getStore('subscriptions', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                const subs = request.result;
                resolve(subs.length > 0 ? subs[0] : null);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return utils.getLocalStorage('subscription', null);
    }
}

export async function deleteSubscription() {
    try {
        const store = await getStore('subscriptions', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.removeLocalStorage('subscription');
    }
}

// ==================== EXAM RESULTS ====================
export async function saveExamResult(result) {
    if (!result || !result.examId) return;
    try {
        const store = await getStore('exams', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(result);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.setLocalStorage('lastExam', result);
    }
}

export async function getAllExamResults() {
    try {
        const store = await getStore('exams', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const last = utils.getLocalStorage('lastExam', null);
        return last ? [last] : [];
    }
}

export async function getExamResult(examId) {
    try {
        const store = await getStore('exams', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(examId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const last = utils.getLocalStorage('lastExam', null);
        return last?.examId === examId ? last : null;
    }
}

export async function getExamResultByExamId(examId) {
    return getExamResult(examId);
}

export async function getLastExam() {
    try {
        const store = await getStore('exams', 'readonly');
        const index = store.index('by_date');
        return new Promise((resolve, reject) => {
            const request = index.openCursor(null, 'prev');
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                resolve(cursor ? cursor.value : null);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return utils.getLocalStorage('lastExam', null);
    }
}

export async function deleteExamResult(examId) {
    try {
        const store = await getStore('exams', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(examId);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        // ignore
    }
}

export async function clearExamResults() {
    try {
        const store = await getStore('exams', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.removeLocalStorage('lastExam');
    }
}

// ==================== EXAM PROGRESS ====================
export async function saveExamProgress(progress) {
    if (!progress || !progress.examId) return;
    try {
        const store = await getStore('exams', 'readwrite');
        const key = `progress_${progress.examId}`;
        return new Promise((resolve, reject) => {
            const request = store.put({ ...progress, examId: key });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('saveExamProgress failed', e);
        utils.setLocalStorage(`exam_progress_${progress.examId}`, progress);
    }
}

export async function getExamProgress(examId) {
    try {
        const store = await getStore('exams', 'readonly');
        const key = `progress_${examId}`;
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return utils.getLocalStorage(`exam_progress_${examId}`, null);
    }
}

// ==================== SYNC QUEUE ====================
/**
 * Add item to sync queue with optional attempts count.
 * @param {string} type - type of item (e.g., 'note_delete')
 * @param {object} data - data to sync
 * @param {number} attempts - number of attempts (default 0)
 */
export async function addToSyncQueue(type, data, attempts = 0) {
    const user = await getUser().catch(() => null);
    const item = {
        type,
        data,
        userId: user?.id || 'anonymous',
        timestamp: Date.now(),
        attempts: attempts
    };
    try {
        const store = await getStore('syncQueue', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.add(item);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] addToSyncQueue failed', e);
    }
}

export async function getSyncQueue() {
    try {
        const store = await getStore('syncQueue', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return [];
    }
}

export async function removeFromSyncQueue(id) {
    try {
        const store = await getStore('syncQueue', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        // ignore
    }
}

export async function clearSyncQueue() {
    try {
        const store = await getStore('syncQueue', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        // ignore
    }
}

// ==================== SECURITY VIOLATIONS ====================
export async function saveSecurityViolations(violations) {
    try {
        const store = await getStore('security', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ id: 'violations', data: violations, updatedAt: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.setLocalStorage('securityViolations', violations);
    }
}

export async function getSecurityViolations() {
    try {
        const store = await getStore('security', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get('violations');
            request.onsuccess = () => resolve(request.result?.data || []);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return utils.getLocalStorage('securityViolations', []);
    }
}

export async function addSecurityLog(logEntry) {
    const entry = {
        ...logEntry,
        id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: Date.now()
    };
    try {
        const store = await getStore('security', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.add(entry);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const logs = utils.getLocalStorage('securityLogs', []);
        logs.push(entry);
        utils.setLocalStorage('securityLogs', logs.slice(-50));
    }
}

// ==================== LOCK STATUS ====================
export async function saveLockStatus(lockStatus) {
    try {
        const store = await getStore('security', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ id: 'lock', ...lockStatus });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.setLocalStorage('lockStatus', lockStatus);
    }
}

export async function getLockStatus() {
    try {
        const store = await getStore('security', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get('lock');
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return utils.getLocalStorage('lockStatus', null);
    }
}

// ==================== ANALYTICS ====================
export async function saveUserStatistics(stats) {
    try {
        const store = await getStore('analytics', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ id: 'userStats', ...stats, updatedAt: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.setLocalStorage('userStats', stats);
    }
}

export async function getUserStatistics() {
    try {
        const store = await getStore('analytics', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get('userStats');
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return utils.getLocalStorage('userStats', null);
    }
}

// ==================== SETTINGS ====================
export async function saveSetting(key, value) {
    try {
        const store = await getStore('settings', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ key, value });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.setLocalStorage(`setting_${key}`, value);
    }
}

export async function getSetting(key, defaultValue = null) {
    try {
        const store = await getStore('settings', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result?.value ?? defaultValue);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return utils.getLocalStorage(`setting_${key}`, defaultValue);
    }
}

// ==================== QUESTIONS ====================
export async function saveQuestions(questions) {
    if (!questions || !questions.length) return;
    try {
        const store = await getStore('questions', 'readwrite');
        const tx = store.transaction;
        return new Promise((resolve, reject) => {
            let completed = 0;
            questions.forEach(q => {
                if (!q.id) {
                    q.id = q.questionId || ('q_' + Math.random().toString(36).substr(2, 8));
                }
                const request = store.put(q);
                request.onsuccess = () => {
                    completed++;
                    if (completed === questions.length) resolve();
                };
                request.onerror = (err) => reject(err);
            });
        });
    } catch (e) {
        console.warn('[DB] saveQuestions failed', e);
    }
}

export async function getQuestions(query = {}) {
    try {
        const store = await getStore('questions', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => {
                let results = request.result;
                if (query.subject) results = results.filter(q => q.subject === query.subject);
                if (query.topic) results = results.filter(q => q.topic === query.topic);
                if (query.difficulty !== undefined) results = results.filter(q => q.difficulty === query.difficulty);
                if (query.limit) results = results.slice(0, query.limit);
                resolve(results);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return [];
    }
}

export async function getQuestionById(id) {
    try {
        const store = await getStore('questions', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return null;
    }
}

export async function getAllQuestions() {
    try {
        const store = await getStore('questions', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return [];
    }
}

// ==================== DOWNLOADED EXAMS ====================
export async function getDownloadedExams() {
    try {
        const store = await getStore('analytics', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get('downloadedExams');
            request.onsuccess = () => resolve(request.result?.data || []);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return utils.getLocalStorage('downloadedExams', []);
    }
}

export async function saveDownloadedExams(exams) {
    try {
        const store = await getStore('analytics', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ id: 'downloadedExams', data: exams, updatedAt: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.setLocalStorage('downloadedExams', exams);
    }
}

// ==================== SHARED EXAMS ====================
export async function saveSharedExam(token, examData, expiryHours = 24) {
    const expiry = Date.now() + expiryHours * 60 * 60 * 1000;
    try {
        const store = await getStore('sharedExams', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ token, examData, expiry });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('saveSharedExam failed', e);
    }
}

export async function getSharedExam(token) {
    try {
        const store = await getStore('sharedExams', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(token);
            request.onsuccess = () => {
                const entry = request.result;
                if (entry && entry.expiry > Date.now()) {
                    resolve(entry.examData);
                } else if (entry) {
                    store.delete(token);
                    resolve(null);
                } else {
                    resolve(null);
                }
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return null;
    }
}

export async function cleanupSharedExams() {
    try {
        const store = await getStore('sharedExams', 'readwrite');
        const now = Date.now();
        const index = store.index('by_expiry');
        return new Promise((resolve, reject) => {
            const request = index.openCursor(IDBKeyRange.upperBound(now));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        // ignore
    }
}

// ==================== SEEN QUESTIONS ====================
export async function getSeenQuestions(subject, topic = null) {
    const key = topic ? `seen_${subject}_${topic}` : `seen_${subject}`;
    try {
        const store = await getStore('analytics', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => {
                const data = request.result;
                resolve(new Set(data?.ids || []));
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return new Set();
    }
}

export async function addSeenQuestions(subject, questionIds, topic = null) {
    const key = topic ? `seen_${subject}_${topic}` : `seen_${subject}`;
    try {
        const store = await getStore('analytics', 'readwrite');
        return new Promise((resolve, reject) => {
            const getReq = store.get(key);
            getReq.onsuccess = () => {
                const existing = getReq.result?.ids || [];
                const newSet = [...new Set([...existing, ...questionIds])];
                const putReq = store.put({ id: key, ids: newSet, updatedAt: Date.now() });
                putReq.onsuccess = () => resolve();
                putReq.onerror = (err) => reject(err);
            };
            getReq.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('Failed to add seen questions', e);
    }
}

export async function clearSeenQuestions(subject, topic = null) {
    const key = topic ? `seen_${subject}_${topic}` : `seen_${subject}`;
    try {
        const store = await getStore('analytics', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        // ignore
    }
}

// ==================== NOTES ====================
export async function saveNote(note) {
    if (!note || !note.id) return;
    try {
        const store = await getStore('notes', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(note);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveNote failed, using localStorage fallback', e);
        const notes = utils.getLocalStorage('notes_fallback', {});
        notes[note.id] = note;
        utils.setLocalStorage('notes_fallback', notes);
    }
}

export async function getNote(noteId) {
    try {
        const store = await getStore('notes', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(noteId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const notes = utils.getLocalStorage('notes_fallback', {});
        return notes[noteId] || null;
    }
}

export async function getNoteById(noteId) {
    return getNote(noteId);
}

export async function getNoteByShareToken(token) {
    try {
        const store = await getStore('notes', 'readonly');
        return new Promise((resolve, reject) => {
            const index = store.index('by_sharedToken');
            const request = index.getAll(token);
            request.onsuccess = () => {
                const notes = request.result;
                resolve(notes.length > 0 ? notes[0] : null);
            };
            request.onerror = () => {
                const scanReq = store.getAll();
                scanReq.onsuccess = () => {
                    const all = scanReq.result;
                    const found = all.find(n => n.sharedToken === token);
                    resolve(found || null);
                };
                scanReq.onerror = () => resolve(null);
            };
        });
    } catch (e) {
        const notes = utils.getLocalStorage('notes_fallback', {});
        const found = Object.values(notes).find(n => n.sharedToken === token);
        return found || null;
    }
}

export async function getNotesByUser(userId) {
    try {
        const store = await getStore('notes', 'readonly');
        const index = store.index('by_userId');
        return new Promise((resolve, reject) => {
            const request = index.getAll(userId);
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const notes = utils.getLocalStorage('notes_fallback', {});
        return Object.values(notes).filter(n => n.userId === userId);
    }
}

export async function getNotesBySubject(subject, userId = null) {
    try {
        const store = await getStore('notes', 'readonly');
        const index = store.index('by_subject');
        return new Promise((resolve, reject) => {
            const request = index.getAll(subject);
            request.onsuccess = () => {
                let results = request.result;
                if (userId) results = results.filter(n => n.userId === userId);
                resolve(results);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const notes = utils.getLocalStorage('notes_fallback', {});
        let results = Object.values(notes).filter(n => n.subject === subject);
        if (userId) results = results.filter(n => n.userId === userId);
        return results;
    }
}

export async function getNoteByServerId(serverId) {
    try {
        const store = await getStore('notes', 'readonly');
        const index = store.index('serverId');
        return new Promise((resolve, reject) => {
            const request = index.get(serverId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        return null;
    }
}

export async function deleteNote(noteId) {
    try {
        const store = await getStore('notes', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(noteId);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const notes = utils.getLocalStorage('notes_fallback', {});
        delete notes[noteId];
        utils.setLocalStorage('notes_fallback', notes);
    }
}

export async function clearNotesByUser(userId) {
    try {
        const notes = await getNotesByUser(userId);
        const store = await getStore('notes', 'readwrite');
        const tx = store.transaction;
        return Promise.all(notes.map(note => {
            return new Promise((resolve, reject) => {
                const req = store.delete(note.id);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        }));
    } catch (e) {
        const notes = utils.getLocalStorage('notes_fallback', {});
        const filtered = Object.fromEntries(Object.entries(notes).filter(([_, n]) => n.userId !== userId));
        utils.setLocalStorage('notes_fallback', filtered);
    }
}

// ==================== CONVERSATIONS ====================
export async function saveConversation(conversation) {
    if (!conversation || !conversation.id) return;
    try {
        const store = await getStore('conversations', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(conversation);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveConversation failed, using localStorage fallback', e);
        const convs = utils.getLocalStorage('conversations_fallback', {});
        convs[conversation.id] = conversation;
        utils.setLocalStorage('conversations_fallback', convs);
    }
}

export async function getConversation(convId) {
    try {
        const store = await getStore('conversations', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(convId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const convs = utils.getLocalStorage('conversations_fallback', {});
        return convs[convId] || null;
    }
}

export async function getConversationById(convId) {
    return getConversation(convId);
}

export async function getConversationByServerId(serverId) {
    try {
        const store = await getStore('conversations', 'readonly');
        const index = store.index('serverId');
        return new Promise((resolve, reject) => {
            const request = index.get(serverId);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    } catch (e) {
        return null;
    }
}

export async function getConversationsByUser(userId, limit = 20) {
    try {
        const store = await getStore('conversations', 'readonly');
        const index = store.index('by_userId');
        return new Promise((resolve, reject) => {
            const request = index.getAll(userId);
            request.onsuccess = () => {
                let results = request.result || [];
                results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
                if (limit > 0) results = results.slice(0, limit);
                resolve(results);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const convs = utils.getLocalStorage('conversations_fallback', {});
        let results = Object.values(convs).filter(c => c.userId === userId);
        results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        if (limit > 0) results = results.slice(0, limit);
        return results;
    }
}

export async function deleteConversation(convId) {
    try {
        const store = await getStore('conversations', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(convId);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const convs = utils.getLocalStorage('conversations_fallback', {});
        delete convs[convId];
        utils.setLocalStorage('conversations_fallback', convs);
    }
}

// ==================== CONVERSATIONS (BULK OPERATIONS) ====================

/**
 * Save multiple conversations at once.
 * @param {Array} conversations - array of conversation objects
 * @returns {Promise<void>}
 */
export async function saveConversations(conversations) {
    if (!conversations || !conversations.length) return;
    try {
        const store = await getStore('conversations', 'readwrite');
        const tx = store.transaction;
        return new Promise((resolve, reject) => {
            let completed = 0;
            for (const conv of conversations) {
                if (!conv.id) {
                    conv.id = conv._id || ('conv_' + Math.random().toString(36).substr(2, 9));
                }
                const request = store.put(conv);
                request.onsuccess = () => {
                    completed++;
                    if (completed === conversations.length) resolve();
                };
                request.onerror = (err) => reject(err);
            }
        });
    } catch (e) {
        console.warn('[DB] saveConversations failed, using localStorage fallback', e);
        const all = utils.getLocalStorage('conversations_fallback', {});
        for (const conv of conversations) {
            if (conv.id) {
                all[conv.id] = conv;
            }
        }
        utils.setLocalStorage('conversations_fallback', all);
    }
}

/**
 * Get all conversations (optionally filtered by userId).
 * @param {string} userId - optional; if provided, returns only user's conversations
 * @returns {Promise<Array>}
 */
export async function getConversations(userId) {
    if (userId) {
        return getConversationsByUser(userId);
    }
    // If no userId, return all conversations (fallback)
    try {
        const store = await getStore('conversations', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const convs = utils.getLocalStorage('conversations_fallback', {});
        return Object.values(convs);
    }
}

/**
 * Clear all conversations.
 * @returns {Promise<void>}
 */
export async function clearConversations() {
    try {
        const store = await getStore('conversations', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        utils.removeLocalStorage('conversations_fallback');
    }
}

/**
 * Atomically update a conversation's ID (e.g., when a local ID is replaced by a server ID).
 * This deletes the old record and inserts the new one to prevent duplicates.
 * @param {string} oldId - the current local ID
 * @param {string} newId - the new server ID
 * @param {Object} updatedData - the full conversation object with the new ID
 * @returns {Promise<void>}
 */
export async function replaceConversationId(oldId, newId, updatedData) {
    if (!oldId || !newId || !updatedData) return;
    try {
        const store = await getStore('conversations', 'readwrite');
        // First, delete the old record
        await new Promise((resolve, reject) => {
            const delReq = store.delete(oldId);
            delReq.onsuccess = () => resolve();
            delReq.onerror = () => reject(delReq.error);
        });
        // Then insert the new record
        await new Promise((resolve, reject) => {
            const putReq = store.put(updatedData);
            putReq.onsuccess = () => resolve();
            putReq.onerror = () => reject(putReq.error);
        });
    } catch (e) {
        console.warn('[DB] replaceConversationId failed', e);
        // Fallback: try to save the new record and delete the old separately
        try {
            await saveConversation(updatedData);
            await deleteConversation(oldId);
        } catch (e2) {
            console.error('[DB] replaceConversationId fallback also failed', e2);
        }
    }
}
// ==================== SHARED CONVERSATIONS ====================
export async function saveSharedConversation(token, conversationData, expiryHours = 24) {
    const expiry = Date.now() + expiryHours * 60 * 60 * 1000;
    try {
        const store = await getStore('sharedConversations', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ token, data: conversationData, expiry });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveSharedConversation failed', e);
    }
}

export async function getSharedConversation(token) {
    try {
        const store = await getStore('sharedConversations', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(token);
            request.onsuccess = () => {
                const entry = request.result;
                if (entry && entry.expiry > Date.now()) {
                    resolve(entry.data);
                } else if (entry) {
                    store.delete(token);
                    resolve(null);
                } else {
                    resolve(null);
                }
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return null;
    }
}

export async function cleanupSharedConversations() {
    try {
        const store = await getStore('sharedConversations', 'readwrite');
        const now = Date.now();
        const index = store.index('by_expiry');
        return new Promise((resolve, reject) => {
            const request = index.openCursor(IDBKeyRange.upperBound(now));
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        // ignore
    }
}

// ==================== CHAT HISTORY ====================
export async function saveChatMessage(message) {
    if (!message || !message.id) return;
    try {
        const store = await getStore('chatHistory', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(message);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveChatMessage failed, using localStorage fallback', e);
        const history = utils.getLocalStorage('chatHistory_fallback', []);
        history.push(message);
        utils.setLocalStorage('chatHistory_fallback', history.slice(-100));
    }
}

export async function getChatHistory(userId, limit = 50) {
    try {
        const store = await getStore('chatHistory', 'readonly');
        const index = store.index('by_userId');
        return new Promise((resolve, reject) => {
            const request = index.getAll(userId);
            request.onsuccess = () => {
                let messages = request.result || [];
                messages.sort((a, b) => a.timestamp - b.timestamp);
                if (limit > 0) messages = messages.slice(-limit);
                resolve(messages);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const history = utils.getLocalStorage('chatHistory_fallback', []);
        const filtered = history.filter(m => m.userId === userId);
        filtered.sort((a, b) => a.timestamp - b.timestamp);
        return limit > 0 ? filtered.slice(-limit) : filtered;
    }
}

export async function clearChatHistory(userId) {
    try {
        const messages = await getChatHistory(userId, 0);
        const store = await getStore('chatHistory', 'readwrite');
        const tx = store.transaction;
        return Promise.all(messages.map(msg => {
            return new Promise((resolve, reject) => {
                const req = store.delete(msg.id);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        }));
    } catch (e) {
        const history = utils.getLocalStorage('chatHistory_fallback', []);
        const filtered = history.filter(m => m.userId !== userId);
        utils.setLocalStorage('chatHistory_fallback', filtered);
    }
}

// ==================== FILE BLOBS ====================
export async function saveFileBlob(id, blob) {
    try {
        const store = await getStore('files', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ id, blob, storedAt: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveFileBlob failed', e);
    }
}

export async function getFileBlob(id) {
    try {
        const store = await getStore('files', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result?.blob || null);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getFileBlob failed', e);
        return null;
    }
}

export async function deleteFileBlob(id) {
    try {
        const store = await getStore('files', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] deleteFileBlob failed', e);
    }
}

export async function hasFileBlob(id) {
    try {
        const store = await getStore('files', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(!!request.result);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        return false;
    }
}

// ==================== THUMBNAIL BLOBS (offline thumbnails) ====================
// Uses the same 'files' store with a 'thumb_' prefix to avoid collisions with main file blobs.

const THUMB_PREFIX = 'thumb_';

/**
 * Save a thumbnail blob for a resource.
 * @param {string} id - resource ID (will be prefixed internally)
 * @param {Blob} blob - thumbnail image blob
 */
export async function saveThumbnailBlob(id, blob) {
    if (!id || !blob) return;
    const key = THUMB_PREFIX + id;
    try {
        const store = await getStore('files', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put({ id: key, blob, storedAt: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveThumbnailBlob failed', e);
    }
}

/**
 * Retrieve a stored thumbnail blob for a resource.
 * @param {string} id - resource ID
 * @returns {Promise<Blob|null>}
 */
export async function getThumbnailBlob(id) {
    if (!id) return null;
    const key = THUMB_PREFIX + id;
    try {
        const store = await getStore('files', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result?.blob || null);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getThumbnailBlob failed', e);
        return null;
    }
}

/**
 * Delete a stored thumbnail blob.
 * @param {string} id - resource ID
 */
export async function deleteThumbnailBlob(id) {
    if (!id) return;
    const key = THUMB_PREFIX + id;
    try {
        const store = await getStore('files', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] deleteThumbnailBlob failed', e);
    }
}

// ==================== NOTIFICATIONS ====================

/**
 * Save a notification to IndexedDB.
 * @param {Object} notification - { id, userId, title, body, category, priority, read, pinned, archived, timestamp, serverId, data, icon, actions, media, progress }
 * @returns {Promise<void>}
 */
export async function saveNotification(notification) {
    if (!notification || !notification.id) return;
    try {
        const store = await getStore('notifications', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.put(notification);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveNotification failed, using localStorage fallback', e);
        const notifs = utils.getLocalStorage('notifications_fallback', []);
        const existing = notifs.findIndex(n => n.id === notification.id);
        if (existing > -1) {
            notifs[existing] = notification;
        } else {
            notifs.push(notification);
        }
        utils.setLocalStorage('notifications_fallback', notifs);
    }
}

/**
 * Get all notifications for a user with optional filters.
 * @param {string} userId
 * @param {Object} filters - { read, pinned, archived, category, limit, offset }
 * @returns {Promise<Array>}
 */
export async function getNotifications(userId, filters = {}) {
    try {
        const store = await getStore('notifications', 'readonly');
        let notifications = [];
        const index = store.index('by_userId');
        const request = index.getAll(userId);
        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                let results = request.result || [];
                // Apply filters
                if (filters.read !== undefined) {
                    results = results.filter(n => n.read === filters.read);
                }
                if (filters.pinned !== undefined) {
                    results = results.filter(n => n.pinned === filters.pinned);
                }
                if (filters.archived !== undefined) {
                    results = results.filter(n => n.archived === filters.archived);
                }
                if (filters.category) {
                    results = results.filter(n => n.category === filters.category);
                }
                // Sort by timestamp descending
                results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                if (filters.limit) {
                    results = results.slice(0, filters.limit);
                }
                resolve(results);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getNotifications failed, using localStorage fallback', e);
        const notifs = utils.getLocalStorage('notifications_fallback', []);
        let results = notifs.filter(n => n.userId === userId);
        // Apply filters same as above
        if (filters.read !== undefined) {
            results = results.filter(n => n.read === filters.read);
        }
        if (filters.pinned !== undefined) {
            results = results.filter(n => n.pinned === filters.pinned);
        }
        if (filters.archived !== undefined) {
            results = results.filter(n => n.archived === filters.archived);
        }
        if (filters.category) {
            results = results.filter(n => n.category === filters.category);
        }
        results.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        if (filters.limit) {
            results = results.slice(0, filters.limit);
        }
        return results;
    }
}

/**
 * Get a single notification by ID.
 * @param {string} id
 * @returns {Promise<Object|null>}
 */
export async function getNotificationById(id) {
    try {
        const store = await getStore('notifications', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const notifs = utils.getLocalStorage('notifications_fallback', []);
        return notifs.find(n => n.id === id) || null;
    }
}

/**
 * Update a notification (partial update).
 * @param {string} id
 * @param {Object} updates
 * @returns {Promise<void>}
 */
export async function updateNotification(id, updates) {
    try {
        const notif = await getNotificationById(id);
        if (!notif) throw new Error('Notification not found');
        Object.assign(notif, updates);
        await saveNotification(notif);
    } catch (e) {
        console.warn('[DB] updateNotification failed', e);
        const notifs = utils.getLocalStorage('notifications_fallback', []);
        const idx = notifs.findIndex(n => n.id === id);
        if (idx > -1) {
            Object.assign(notifs[idx], updates);
            utils.setLocalStorage('notifications_fallback', notifs);
        }
    }
}

/**
 * Mark a notification as read.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function markNotificationRead(id) {
    await updateNotification(id, { read: true });
}

/**
 * Mark all notifications for a user as read.
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function markAllNotificationsRead(userId) {
    try {
        const notifications = await getNotifications(userId);
        for (const notif of notifications) {
            if (!notif.read) {
                notif.read = true;
                await saveNotification(notif);
            }
        }
    } catch (e) {
        console.warn('[DB] markAllNotificationsRead failed', e);
        const notifs = utils.getLocalStorage('notifications_fallback', []);
        const updated = notifs.map(n => {
            if (n.userId === userId) n.read = true;
            return n;
        });
        utils.setLocalStorage('notifications_fallback', updated);
    }
}

/**
 * Delete a notification.
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteNotification(id) {
    try {
        const store = await getStore('notifications', 'readwrite');
        return new Promise((resolve, reject) => {
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const notifs = utils.getLocalStorage('notifications_fallback', []);
        const filtered = notifs.filter(n => n.id !== id);
        utils.setLocalStorage('notifications_fallback', filtered);
    }
}

/**
 * Get unread notification count for a user.
 * @param {string} userId
 * @returns {Promise<number>}
 */
export async function getUnreadNotificationCount(userId) {
    try {
        const notifications = await getNotifications(userId, { read: false });
        return notifications.length;
    } catch (e) {
        const notifs = utils.getLocalStorage('notifications_fallback', []);
        return notifs.filter(n => n.userId === userId && !n.read).length;
    }
}

/**
 * Clear all notifications for a user.
 * @param {string} userId
 * @returns {Promise<void>}
 */
export async function clearNotifications(userId) {
    try {
        const store = await getStore('notifications', 'readwrite');
        const index = store.index('by_userId');
        const request = index.openCursor(IDBKeyRange.only(userId));
        return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        const notifs = utils.getLocalStorage('notifications_fallback', []);
        const filtered = notifs.filter(n => n.userId !== userId);
        utils.setLocalStorage('notifications_fallback', filtered);
    }
}

// ==================== PUBLIC ASSETS ====================

/**
 * Save a public asset blob and metadata to IndexedDB.
 * @param {string} key - unique identifier (e.g., 'resources-update')
 * @param {Blob} blob - file content
 * @param {Object} metadata - { version, fileHash, fileSize, fileType, description, updatedAt }
 * @returns {Promise<void>}
 */
export async function savePublicAsset(key, blob, metadata) {
    if (!key || !blob) return;
    try {
        const store = await getStore('publicAssets', 'readwrite');
        const entry = {
            key,
            blob,
            metadata,
            updatedAt: Date.now(),
        };
        return new Promise((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] savePublicAsset failed, using localStorage fallback', e);
        // For JSON, store raw string; for other blobs, store base64
        if (metadata?.fileType === 'json') {
            const text = await blob.text();
            utils.setLocalStorage(`publicAsset_${key}`, text);
        } else {
            const reader = new FileReader();
            reader.onload = () => {
                utils.setLocalStorage(`publicAsset_${key}`, reader.result);
            };
            reader.readAsDataURL(blob);
        }
    }
}

/**
 * Retrieve a public asset blob by key.
 * @param {string} key - unique identifier
 * @returns {Promise<Blob|null>}
 */
export async function getPublicAsset(key) {
    try {
        const store = await getStore('publicAssets', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => {
                const entry = request.result;
                resolve(entry ? entry.blob : null);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getPublicAsset failed, using localStorage fallback', e);
        const stored = utils.getLocalStorage(`publicAsset_${key}`, null);
        if (!stored) return null;
        // If it's a data URL, convert to blob
        if (stored.startsWith('data:')) {
            try {
                const blob = await fetch(stored).then(r => r.blob());
                return blob;
            } catch {
                return null;
            }
        }
        // Assume it's a JSON string
        try {
            return new Blob([stored], { type: 'application/json' });
        } catch {
            return null;
        }
    }
}

/**
 * Save the version map of public assets.
 * @param {Object} versions - { key: versionNumber, ... }
 * @returns {Promise<void>}
 */
export async function savePublicAssetVersions(versions) {
    try {
        const store = await getStore('publicAssetVersions', 'readwrite');
        const entry = {
            id: 'versions',
            data: versions,
            updatedAt: Date.now(),
        };
        return new Promise((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] savePublicAssetVersions failed, using localStorage fallback', e);
        utils.setLocalStorage('publicAssetVersions', versions);
    }
}

/**
 * Retrieve the version map of public assets.
 * @returns {Promise<Object>}
 */
export async function getPublicAssetVersions() {
    try {
        const store = await getStore('publicAssetVersions', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get('versions');
            request.onsuccess = () => {
                const entry = request.result;
                resolve(entry ? entry.data : {});
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getPublicAssetVersions failed, using localStorage fallback', e);
        return utils.getLocalStorage('publicAssetVersions', {});
    }
}


// ==================== REFERRAL DATA CACHE ====================

/**
 * Save referral data (dashboard/agent) to IndexedDB.
 * @param {string} key - 'referral' or 'agent'
 * @param {Object} data - the data to cache (e.g., dashboard response)
 * @returns {Promise<void>}
 */
export async function saveReferralData(key, data) {
    if (!key) return;
    try {
        const store = await getStore('analytics', 'readwrite');
        const entry = {
            id: `referral_${key}`,
            data,
            updatedAt: Date.now()
        };
        return new Promise((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveReferralData failed, using localStorage fallback', e);
        utils.setLocalStorage(`referral_cache_${key}`, { data, timestamp: Date.now() });
    }
}

/**
 * Retrieve referral data from IndexedDB.
 * @param {string} key - 'referral' or 'agent'
 * @returns {Promise<Object|null>} cached data or null
 */
export async function getReferralData(key) {
    if (!key) return null;
    try {
        const store = await getStore('analytics', 'readonly');
        const id = `referral_${key}`;
        return new Promise((resolve, reject) => {
            const request = store.get(id);
            request.onsuccess = () => {
                const entry = request.result;
                resolve(entry ? entry.data : null);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getReferralData failed, using localStorage fallback', e);
        const cached = utils.getLocalStorage(`referral_cache_${key}`, null);
        return cached ? cached.data : null;
    }
}

// ==================== PERFORMANCE & LEADERBOARD CACHE ====================

/**
 * Save user performance data to IndexedDB.
 * @param {Object} data - performance data from users/queries:getUserPerformance
 */
export async function saveUserPerformance(data) {
    try {
        const store = await getStore('analytics', 'readwrite');
        const entry = {
            id: 'userPerformance',
            data,
            updatedAt: Date.now()
        };
        return new Promise((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveUserPerformance failed, using localStorage fallback', e);
        utils.setLocalStorage('userPerformance', data);
    }
}

/**
 * Retrieve user performance data from IndexedDB.
 * @returns {Promise<Object|null>} cached performance data
 */
export async function getUserPerformance() {
    try {
        const store = await getStore('analytics', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get('userPerformance');
            request.onsuccess = () => {
                resolve(request.result?.data || null);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getUserPerformance failed, using localStorage fallback', e);
        return utils.getLocalStorage('userPerformance', null);
    }
}

/**
 * Save leaderboard data to IndexedDB.
 * @param {Array} data - leaderboard array from users/queries:getLeaderboard
 */
export async function saveLeaderboard(data) {
    try {
        const store = await getStore('analytics', 'readwrite');
        const entry = {
            id: 'leaderboard',
            data,
            updatedAt: Date.now()
        };
        return new Promise((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveLeaderboard failed, using localStorage fallback', e);
        utils.setLocalStorage('leaderboard', data);
    }
}

/**
 * Retrieve leaderboard data from IndexedDB.
 * @returns {Promise<Array|null>} cached leaderboard array
 */
export async function getLeaderboard() {
    try {
        const store = await getStore('analytics', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get('leaderboard');
            request.onsuccess = () => {
                resolve(request.result?.data || null);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getLeaderboard failed, using localStorage fallback', e);
        return utils.getLocalStorage('leaderboard', null);
    }
}

/**
 * Save challenge history data to IndexedDB.
 * @param {Object} data - challenge history from challenges/queries:getUserChallengeHistory
 */
export async function saveChallengeHistory(data) {
    try {
        const store = await getStore('analytics', 'readwrite');
        const entry = {
            id: 'challengeHistory',
            data,
            updatedAt: Date.now()
        };
        return new Promise((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] saveChallengeHistory failed, using localStorage fallback', e);
        utils.setLocalStorage('challengeHistory', data);
    }
}

/**
 * Retrieve challenge history data from IndexedDB.
 * @returns {Promise<Object|null>} cached challenge history
 */
export async function getChallengeHistory() {
    try {
        const store = await getStore('analytics', 'readonly');
        return new Promise((resolve, reject) => {
            const request = store.get('challengeHistory');
            request.onsuccess = () => {
                resolve(request.result?.data || null);
            };
            request.onerror = (err) => reject(err);
        });
    } catch (e) {
        console.warn('[DB] getChallengeHistory failed, using localStorage fallback', e);
        return utils.getLocalStorage('challengeHistory', null);
    }
}

// ==================== CLEAR DATABASE ====================
export async function clearDatabase() {
    try {
        const database = await initDatabase();
        const stores = database.objectStoreNames;
        const tx = database.transaction(stores, 'readwrite');
        return Promise.all(Array.from(stores).map(storeName => {
            return new Promise((resolve, reject) => {
                const store = tx.objectStore(storeName);
                const req = store.clear();
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
            });
        }));
    } catch (e) {
        localStorage.clear();
    }
}

// Auto‑initialize
initDatabase().catch(err => console.warn('[DB] Init failed, fallback to localStorage', err));