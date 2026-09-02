// scripts/notifications.js

/**
 * MedVix Notification Engine – Fully Dynamic, Extensible
 * 
 * - Loads notifications from IndexedDB (fast) and Convex (backend).
 * - Renders notifications with HTML bodies directly (if they contain HTML).
 * - Uses event delegation on the container to handle all [data-action] buttons.
 * - Generic action handler: navigate, call API, or run registered custom action.
 * - No hard‑coded action cases; actions are resolved dynamically.
 */

import * as ui from './ui.js';
import * as router from './router.js';
import * as utils from './utils.js';
import * as db from './db.js';
import * as auth from './auth.js';
import * as events from './events.js';
import { convexHttpClient } from './convex-client.js';
import { getToken } from './auth.js';

// ==================== CONSTANTS ====================
const NOTIFICATION_COOLDOWN_MS = 3 * 60 * 1000; // 3 hours
const NOTIFICATION_TIMER_KEY = 'notification_timer';
const POLL_INTERVAL_MS = 30000; // 30 seconds

// ==================== ACTION REGISTRY ====================
// Custom actions can be registered here: actionHandlers['myAction'] = (element, notif) => {...}
const actionHandlers = {};

export function registerAction(name, handler) {
    if (typeof handler === 'function') {
        actionHandlers[name] = handler;
    }
}

// ==================== TIMER MANAGEMENT ====================
function getLastNotificationFetch() {
    const stored = localStorage.getItem(NOTIFICATION_TIMER_KEY);
    return stored ? parseInt(stored, 10) : 0;
}

function setLastNotificationFetch(ts) {
    localStorage.setItem(NOTIFICATION_TIMER_KEY, String(ts));
}

function isNotificationFetchAllowed() {
    const last = getLastNotificationFetch();
    const now = Date.now();
    return (now - last) > NOTIFICATION_COOLDOWN_MS;
}

// ==================== STATE ====================
let notifications = [];
let filteredNotifications = [];
let currentFilter = 'all';
let currentCategory = 'all';
let currentSort = 'newest';
let searchQuery = '';
let isLoaded = false;
let isInitialized = false;
let pollingInterval = null;

// DOM refs
let container;
let unreadBadge;
let loadingState;
let emptyState;
let errorState;
let searchInput;
let clearSearch;
let filterBtns;
let sortSelect;
let chips;
let stats;

// ==================== DOM REFS ====================
function getDomRefs() {
    return {
        container: document.getElementById('notificationContainer'),
        unreadBadge: document.getElementById('unreadBadge'),
        loadingState: document.getElementById('loadingState'),
        emptyState: document.getElementById('emptyState'),
        errorState: document.getElementById('errorState'),
        searchInput: document.getElementById('searchInput'),
        clearSearch: document.getElementById('clearSearch'),
        filterBtns: document.querySelectorAll('.filter-btn'),
        sortSelect: document.getElementById('sortSelect'),
        chips: document.querySelectorAll('.chip'),
        stats: {
            unread: document.getElementById('statUnread'),
            read: document.getElementById('statRead'),
            pinned: document.getElementById('statPinned'),
            archived: document.getElementById('statArchived'),
            critical: document.getElementById('statCritical'),
            today: document.getElementById('statToday')
        }
    };
}

// ==================== MAP BACKEND TO FRONTEND ====================
function mapBackendToFrontend(backendNotif) {
    const type = backendNotif.type || 'general';
    return {
        id: backendNotif._id || backendNotif.id,
        title: backendNotif.title || 'Notification',
        body: backendNotif.message || backendNotif.body || '',
        timestamp: backendNotif.createdAt || backendNotif.timestamp || Date.now(),
        read: backendNotif.read || false,
        category: type,
        data: backendNotif.data || null,
        senderId: backendNotif.senderId || null,
        pinned: backendNotif.pinned || false,
        archived: backendNotif.archived || false,
        important: backendNotif.important || false,
        priority: getPriority(type),
        icon: getIconForType(type),
        subtitle: getSubtitleForType(type, backendNotif.data),
        // Actions are NOT precomputed – they are embedded in the HTML body.
        actions: [],
        media: backendNotif.media || null,
        progress: backendNotif.progress || null,
        userId: backendNotif.userId || null,
    };
}

function getPriority(type) {
    const high = ['admin_broadcast', 'payment_failed', 'subscription_expiry', 'security'];
    if (high.includes(type)) return 'high';
    if (type === 'critical') return 'critical';
    return 'normal';
}

function getIconForType(type) {
    const safeType = type || 'general';
    const icons = {
        'admin_broadcast': '📢',
        'exam_shared': '📤',
        'note_shared': '📝',
        'note_shared_with_user': '📝',
        'subscription_expiry': '⏰',
        'subscription_expiry_warning': '⏰',
        'subscription_renewed': '✅',
        'subscription_cancelled': '❌',
        'challenge_invite': '🏆',
        'challenge_created': '🏆',
        'challenge_results': '📊',
        'challenge_timeout': '⏳',
        'payment_success': '💳',
        'payment_failed': '❌',
        'trial_started': '🎉',
        'exam_result': '📊',
        'account_created': '👋',
        'new_device': '🔐',
        'password_changed': '🔑',
        'password_reset_requested': '🔐',
        'password_reset_completed': '🔓',
        'system': '⚙️',
        'security': '🛡️',
        'referral_reward': '💰',
        'admin_account_locked': '🔒',
        'admin_account_unlocked': '🔓',
        'admin_role_changed': '👤',
        'admin_force_logout': '🚪',
        'admin_password_reset': '🔑',
        'admin_subscription_extended': '✅',
        'admin_subscription_terminated': '⛔',
        'admin_trial_granted': '🎉',
        'admin_manual_payment': '💳',
        'admin_withdrawal_processed': '💸',
        'admin_withdrawal_rejected': '❌',
        'admin_reversal_processed': '↩️',
        'admin_reversal_rejected': '↩️',
        'admin_agent_verified': '✅',
        'admin_system_lockdown': '🔧',
    };
    return icons[safeType] || '📩';
}

function getSubtitleForType(type, data) {
    const safeType = type || 'general';
    if (safeType === 'payment_success' && data?.plan) return `Plan: ${data.plan}`;
    if (safeType === 'payment_failed' && data?.reason) return `Reason: ${data.reason}`;
    if (safeType === 'exam_result' && data?.subject) return `Subject: ${data.subject}`;
    if (safeType === 'challenge_invite' && data?.challengeCode) return `Code: ${data.challengeCode}`;
    if (safeType === 'note_shared' && data?.noteTitle) return `Note: ${data.noteTitle}`;
    if (safeType === 'admin_broadcast') return 'Admin Announcement';
    return '';
}

// ==================== ENSURE USER READY ====================
async function ensureUserReady() {
    if (auth.getUser()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
}

// ==================== LOAD NOTIFICATIONS ====================
export async function loadNotifications(force = false) {
    await ensureUserReady();

    const refs = getDomRefs();
    container = refs.container;
    unreadBadge = refs.unreadBadge;
    loadingState = refs.loadingState;
    emptyState = refs.emptyState;
    errorState = refs.errorState;
    searchInput = refs.searchInput;
    clearSearch = refs.clearSearch;
    filterBtns = refs.filterBtns;
    sortSelect = refs.sortSelect;
    chips = refs.chips;
    stats = refs.stats;

    showLoading();

    try {
        const user = auth.getUser();
        if (!user) {
            showEmpty('Please log in to view notifications');
            return;
        }

        // 1. Load from IndexedDB immediately (fast)
        let localNotifs = await db.getNotifications(user._id, { limit: 50 });
        if (localNotifs && localNotifs.length > 0) {
            notifications = localNotifs.map(mapBackendToFrontend);
            isLoaded = true;
            applyFilters();
            render();
            updateStats();
            updateBadge();
            hideAllStates();
        }

        // 2. Fetch from backend only if allowed by cooldown (or forced)
        if (navigator.onLine && (force || isNotificationFetchAllowed())) {
            const token = getToken();
            if (token) {
                const result = await convexHttpClient.action("notifications/queries:getNotifications", {
                    token,
                    limit: 50,
                });
                if (result.success && result.data && result.data.notifications) {
                    const serverNotifs = result.data.notifications;
                    for (const notif of serverNotifs) {
                        const frontendNotif = mapBackendToFrontend(notif);
                        await db.saveNotification(frontendNotif);
                    }
                    localNotifs = await db.getNotifications(user._id, { limit: 50 });
                    notifications = localNotifs.map(mapBackendToFrontend);
                    isLoaded = true;
                    applyFilters();
                    render();
                    updateStats();
                    updateBadge();
                    hideAllStates();
                    setLastNotificationFetch(Date.now());
                }
            }
        } else if (!force) {
            console.log('[Notifications] Cooldown active – using cached data.');
        }

        if (!isLoaded) {
            showEmpty('No notifications found.');
        }
    } catch (err) {
        console.error('[Notifications] Load error:', err);
        showError();
    }
}

// ==================== POLLING ====================
export function startPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }

    const user = auth.getUser();
    if (!user || !navigator.onLine) {
        console.log('[Notifications] Not starting polling: offline or no user');
        return;
    }

    const token = getToken();
    if (!token) {
        console.log('[Notifications] No token, cannot poll');
        return;
    }

    console.log('[Notifications] Starting polling (every 30s, cooldown 3h)');

    pollingInterval = setInterval(async () => {
        try {
            const userNow = auth.getUser();
            if (!userNow || !navigator.onLine) {
                stopPolling();
                return;
            }
            const tokenNow = getToken();
            if (!tokenNow) {
                stopPolling();
                return;
            }

            if (!isNotificationFetchAllowed()) {
                return;
            }

            const lastTimestamp = notifications.length > 0
                ? Math.max(...notifications.map(n => n.timestamp))
                : 0;

            const result = await convexHttpClient.action("notifications/queries:getNotificationsSince", {
                token: tokenNow,
                since: lastTimestamp || 0,
                limit: 20,
            });

            if (result.success && result.data && result.data.notifications && result.data.notifications.length > 0) {
                const newNotifs = result.data.notifications;
                handleNewNotifications(newNotifs);
                setLastNotificationFetch(Date.now());
            }
        } catch (err) {
            console.warn('[Notifications] Polling error:', err);
        }
    }, POLL_INTERVAL_MS);
}

export function stopPolling() {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        console.log('[Notifications] Polling stopped.');
    }
}

// ==================== HANDLE NEW NOTIFICATIONS ====================
function handleNewNotifications(newNotifs) {
    if (!newNotifs || newNotifs.length === 0) return;

    const latest = newNotifs[newNotifs.length - 1];
    showNotificationToast(latest);

    addNotifications(newNotifs);
    updateBadge();
    events.events.emit('new-notification', { notifications: newNotifs });
}

function showNotificationToast(notif) {
    if (!notif) return;
    if (!ui.getAppSetting('notifications')) return;

    // Only show toast for critical or high priority notifications
    if (notif.priority !== 'critical' && notif.priority !== 'high') {
        return;
    }

    if (ui.getAppSetting('sound')) {
        try {
            const audio = new Audio('/assets/sounds/notification.mp3');
            audio.play().catch(() => {});
        } catch (e) { /* ignore */ }
    }

    // Generic message to avoid distraction
    const message = 'You have a new notification';
    if (ui && typeof ui.showToast === 'function') {
        ui.showToast(message, 'info', 5000);
    } else {
        console.log('[Notification]', message);
    }
}

// ==================== ADD NOTIFICATIONS ====================
export function addNotifications(newNotifs) {
    if (!newNotifs || newNotifs.length === 0) return;

    const user = auth.getUser();
    if (!user) return;

    newNotifs.forEach(async (notif) => {
        const frontendNotif = notif._id ? mapBackendToFrontend(notif) : notif;
        if (!frontendNotif.userId) frontendNotif.userId = user._id;
        await db.saveNotification(frontendNotif).catch(() => {});
    });

    db.getNotifications(user._id, { limit: 50 }).then(localNotifs => {
        if (localNotifs && localNotifs.length > 0) {
            notifications = localNotifs.map(mapBackendToFrontend);
            isLoaded = true;
            applyFilters();
            render();
            updateStats();
            updateBadge();
            hideAllStates();
        }
    }).catch(() => {});
}

export function getUnreadCount() {
    return notifications.filter(n => !n.read).length;
}

// ==================== RENDER ====================
export function render() {
    if (!isLoaded) return;
    if (!container) {
        const refs = getDomRefs();
        container = refs.container;
    }
    if (!container) return;

    container.innerHTML = '';

    if (filteredNotifications.length === 0) {
        if (searchQuery || currentFilter !== 'all' || currentCategory !== 'all') {
            const empty = document.createElement('div');
            empty.className = 'state-message empty';
            empty.innerHTML = `
                <div class="empty-icon">🔍</div>
                <h3>No matching notifications</h3>
                <p>Try adjusting your filters or search terms.</p>
                <button onclick="window.notifications?.resetFilters()" class="btn-secondary">Reset Filters</button>
            `;
            container.appendChild(empty);
        } else {
            if (emptyState) emptyState.style.display = 'block';
        }
        return;
    }

    const groups = groupNotifications(filteredNotifications);

    for (const [label, items] of Object.entries(groups)) {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'notification-group';
        const header = document.createElement('div');
        header.className = 'group-header';
        header.textContent = label;
        groupDiv.appendChild(header);

        items.forEach(notif => {
            const card = createCard(notif);
            groupDiv.appendChild(card);
        });
        container.appendChild(groupDiv);
    }

    // Event delegation for all action buttons
    container.addEventListener('click', (e) => {
        const actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;

        const notifCard = e.target.closest('.notif-card');
        const notifId = notifCard?.dataset.id;
        const notif = notifications.find(n => n.id === notifId);

        processAction(actionEl, notif);
    });
}

function groupNotifications(items) {
    const groups = {};
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    items.forEach(notif => {
        const date = new Date(notif.timestamp);
        const dateStr = date.toDateString();
        let label;
        if (dateStr === today) label = 'Today';
        else if (dateStr === yesterday) label = 'Yesterday';
        else if (date.getFullYear() === new Date().getFullYear()) {
            label = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
        } else {
            label = date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        }
        if (!groups[label]) groups[label] = [];
        groups[label].push(notif);
    });
    return groups;
}

function createCard(notif) {
    const template = document.getElementById('notificationCardTemplate');
    if (!template) {
        // Fallback if template missing – render raw HTML
        const div = document.createElement('div');
        div.className = 'notif-card';
        div.dataset.id = notif.id;
        // Add type class for styling
        div.classList.add(`type-${notif.category}`);
        const bodyContent = notif.body || '';
        if (bodyContent.trim().startsWith('<')) {
            div.innerHTML = bodyContent;
        } else {
            div.innerHTML = `
                <div class="card-header">
                    <div class="card-icon">${notif.icon || '📩'}</div>
                    <div class="card-title-area">
                        <div class="card-title">${notif.title || 'Notification'}</div>
                        <div class="card-subtitle">${notif.subtitle || ''}</div>
                    </div>
                </div>
                <div class="card-body">${bodyContent}</div>
                <div class="card-footer">
                    <span class="card-time">${utils.formatDate(notif.timestamp, 'full')}</span>
                </div>
            `;
        }
        return div;
    }

    const card = template.content.cloneNode(true).firstElementChild;
    card.dataset.id = notif.id;
    // Add type class for styling
    card.classList.add(`type-${notif.category}`);

    if (!notif.read) card.classList.add('unread');
    if (notif.pinned) card.classList.add('pinned');
    if (notif.priority === 'critical') card.classList.add('critical');

    const icon = card.querySelector('.card-icon');
    if (icon) icon.textContent = notif.icon || '📩';

    const titleEl = card.querySelector('.card-title');
    if (titleEl) titleEl.textContent = notif.title || 'Notification';

    const subtitleEl = card.querySelector('.card-subtitle');
    if (subtitleEl) subtitleEl.textContent = notif.subtitle || '';

    // Body – use innerHTML if body contains HTML, else textContent
    const body = card.querySelector('.card-body');
    if (body) {
        const rawBody = notif.body || '';
        if (rawBody.trim().startsWith('<')) {
            body.innerHTML = rawBody; // Unstyled HTML – CSS will style it
        } else {
            body.textContent = rawBody;
            if (rawBody.length > 100) {
                body.classList.add('collapsible');
                const showMore = document.createElement('span');
                showMore.className = 'more';
                showMore.textContent = '... Show more';
                body.appendChild(showMore);
                showMore.addEventListener('click', (e) => {
                    e.stopPropagation();
                    body.classList.toggle('expanded');
                    showMore.textContent = body.classList.contains('expanded') ? ' Show less' : '... Show more';
                });
            }
        }
    }

    // Media and progress (if provided)
    const mediaContainer = card.querySelector('.card-media');
    if (mediaContainer && notif.media) {
        if (notif.media.type === 'image') {
            const img = document.createElement('img');
            img.src = notif.media.url;
            img.alt = notif.media.alt || '';
            mediaContainer.appendChild(img);
        } else if (notif.media.type === 'video') {
            const video = document.createElement('video');
            video.src = notif.media.url;
            video.controls = true;
            mediaContainer.appendChild(video);
        }
    } else if (mediaContainer) {
        mediaContainer.style.display = 'none';
    }

    const progressContainer = card.querySelector('.card-progress');
    if (progressContainer && notif.progress) {
        const progress = document.createElement('progress');
        progress.value = notif.progress.value;
        progress.max = notif.progress.max || 100;
        progressContainer.appendChild(progress);
    } else if (progressContainer) {
        progressContainer.style.display = 'none';
    }

    // Buttons container – remove precomputed buttons; they are inside body HTML
    const btnContainer = card.querySelector('.card-buttons');
    if (btnContainer) btnContainer.style.display = 'none';

    const timeEl = card.querySelector('.card-time');
    if (timeEl) timeEl.textContent = utils.formatDate(notif.timestamp, 'full');

    const priorityEl = card.querySelector('.card-priority');
    if (priorityEl) {
        priorityEl.textContent = notif.priority || 'normal';
        priorityEl.className = `card-priority priority-${notif.priority || 'normal'}`;
    }

    const pinBtn = card.querySelector('.pin-btn');
    if (pinBtn) {
        pinBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            togglePin(notif.id);
        });
    }
    const archiveBtn = card.querySelector('.archive-btn');
    if (archiveBtn) {
        archiveBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleArchive(notif.id);
        });
    }
    const deleteBtn = card.querySelector('.delete-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteNotification(notif.id);
        });
    }

    card.addEventListener('click', () => {
        if (!notif.read) markRead(notif.id);
    });

    return card;
}

// ==================== DYNAMIC ACTION PROCESSOR ====================
function processAction(element, notif) {
    const action = element.dataset.action;
    const data = { ...element.dataset };
    delete data.action;

    console.log('[Notification Action]', action, data, 'notif:', notif?.id);

    // 1. Custom registered handler
    if (actionHandlers[action]) {
        actionHandlers[action](element, notif, data);
        if (!notif?.read) markRead(notif.id);
        return;
    }

    // 2. API call if data-api or action starts with "api:"
    const apiName = data.api || (action.startsWith('api:') ? action.slice(4) : null);
    if (apiName) {
        callBackendAction(apiName, data, notif);
        return;
    }

    // 3. Navigation if data-route present
    if (data.route) {
        const params = { ...data };
        delete params.route;
        delete params.api;
        delete params.action;
        router.navigateTo(data.route, params);
        if (!notif?.read) markRead(notif.id);
        return;
    }

    // 4. Fallback
    ui.showToast(`Action: ${action}`, 'info');
}

function callBackendAction(apiName, data, notif) {
    const token = getToken();
    if (!token) {
        ui.showToast('Not authenticated', 'error');
        return;
    }

    // Convert dataset to snake_case? We'll just pass the data object.
    const params = { token, ...data };
    delete params.action;
    delete params.api;

    // Show loading indicator (optional)
    ui.showLoading('Processing...');

    convexHttpClient.action(apiName, params)
        .then(() => {
            ui.hideLoading();
            ui.showToast('Action completed', 'success');
            if (notif && !notif.read) markRead(notif.id);
            // Optionally dismiss the notification
            if (notif && data.dismiss !== undefined) {
                deleteNotification(notif.id);
            }
        })
        .catch(err => {
            ui.hideLoading();
            console.error('Backend action failed:', err);
            ui.showToast('Action failed', 'error');
        });
}

// ==================== CRUD ====================
export async function markRead(id) {
    const notif = notifications.find(n => n.id === id);
    if (!notif) return;
    notif.read = true;
    try {
        const token = getToken();
        if (token) {
            await convexHttpClient.mutation("notifications/mutations:markNotificationRead", {
                token,
                notificationId: id,
            });
        }
    } catch (err) {
        console.warn('[Notifications] Mark read network error', err);
    }
    await db.markNotificationRead(id).catch(() => {});
    applyFilters();
    render();
    updateStats();
    updateBadge();
}

export async function markAllRead() {
    const user = auth.getUser();
    if (!user) return;
    notifications.forEach(n => n.read = true);
    try {
        const token = getToken();
        if (token) {
            await convexHttpClient.mutation("notifications/mutations:markAllNotificationsRead", {
                token,
            });
        }
    } catch (err) {
        console.warn('[Notifications] Mark all read network error', err);
    }
    await db.markAllNotificationsRead(user._id).catch(() => {});
    applyFilters();
    render();
    updateStats();
    updateBadge();
    ui.showToast('All notifications marked as read', 'success');
}

export function togglePin(id) {
    const notif = notifications.find(n => n.id === id);
    if (notif) {
        notif.pinned = !notif.pinned;
        db.updateNotification(id, { pinned: notif.pinned }).catch(() => {});
        applyFilters();
        render();
        updateStats();
    }
}

export function toggleArchive(id) {
    const notif = notifications.find(n => n.id === id);
    if (notif) {
        notif.archived = !notif.archived;
        db.updateNotification(id, { archived: notif.archived }).catch(() => {});
        applyFilters();
        render();
        updateStats();
    }
}

export function deleteNotification(id) {
    notifications = notifications.filter(n => n.id !== id);
    db.deleteNotification(id).catch(() => {});
    applyFilters();
    render();
    updateStats();
    updateBadge();
}

// ==================== FILTERS & SEARCH ====================
export function applyFilters() {
    let filtered = [...notifications];

    if (currentCategory !== 'all') {
        filtered = filtered.filter(n => n.category === currentCategory);
    }

    if (currentFilter === 'unread') {
        filtered = filtered.filter(n => !n.read);
    } else if (currentFilter === 'pinned') {
        filtered = filtered.filter(n => n.pinned);
    } else if (currentFilter === 'archived') {
        filtered = filtered.filter(n => n.archived);
    } else if (currentFilter === 'important') {
        filtered = filtered.filter(n => n.important);
    }

    if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        filtered = filtered.filter(n =>
            n.title.toLowerCase().includes(q) ||
            (n.body && n.body.toLowerCase().includes(q)) ||
            (n.subtitle && n.subtitle.toLowerCase().includes(q)) ||
            n.category.includes(q)
        );
    }

    if (currentSort === 'newest') {
        filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    } else if (currentSort === 'oldest') {
        filtered.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    } else if (currentSort === 'priority') {
        const order = { critical: 0, high: 1, normal: 2, low: 3, silent: 4 };
        filtered.sort((a, b) => (order[a.priority] || 2) - (order[b.priority] || 2));
    }

    filtered.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

    filteredNotifications = filtered;
}

export function setFilter(filter) {
    currentFilter = filter;
    filterBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    applyFilters();
    render();
}

export function setCategory(category) {
    currentCategory = category;
    chips.forEach(chip => {
        chip.classList.toggle('active', chip.dataset.category === category);
    });
    applyFilters();
    render();
}

export function setSort(sort) {
    currentSort = sort;
    applyFilters();
    render();
}

export function setSearch(query) {
    searchQuery = query;
    clearSearch.classList.toggle('visible', query.length > 0);
    applyFilters();
    render();
}

export function resetFilters() {
    currentFilter = 'all';
    currentCategory = 'all';
    searchQuery = '';
    searchInput.value = '';
    clearSearch.classList.remove('visible');
    filterBtns.forEach(btn => btn.classList.remove('active'));
    document.querySelector('.filter-btn[data-filter="all"]').classList.add('active');
    chips.forEach(chip => chip.classList.remove('active'));
    document.querySelector('.chip[data-category="all"]').classList.add('active');
    applyFilters();
    render();
}

// ==================== STATISTICS ====================
function updateStats() {
    if (!stats) {
        const refs = getDomRefs();
        stats = refs.stats;
    }
    if (!stats) return;

    const unread = notifications.filter(n => !n.read).length;
    const read = notifications.filter(n => n.read && !n.archived).length;
    const pinned = notifications.filter(n => n.pinned).length;
    const archived = notifications.filter(n => n.archived).length;
    const critical = notifications.filter(n => n.priority === 'critical').length;
    const today = notifications.filter(n => {
        const d = new Date(n.timestamp);
        return d.toDateString() === new Date().toDateString();
    }).length;

    if (stats.unread) stats.unread.textContent = unread;
    if (stats.read) stats.read.textContent = read;
    if (stats.pinned) stats.pinned.textContent = pinned;
    if (stats.archived) stats.archived.textContent = archived;
    if (stats.critical) stats.critical.textContent = critical;
    if (stats.today) stats.today.textContent = today;
}

function updateBadge() {
    if (!unreadBadge) {
        const refs = getDomRefs();
        unreadBadge = refs.unreadBadge;
    }
    if (!unreadBadge) return;

    const unread = notifications.filter(n => !n.read).length;
    unreadBadge.textContent = unread;
    unreadBadge.style.display = unread > 0 ? 'inline' : 'none';
}

// ==================== UI STATES ====================
function showLoading() {
    if (loadingState) loadingState.style.display = 'block';
    if (emptyState) emptyState.style.display = 'none';
    if (errorState) errorState.style.display = 'none';
    if (container) container.innerHTML = '';
}

function showError() {
    if (loadingState) loadingState.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    if (errorState) errorState.style.display = 'block';
}

function showEmpty(message = 'No notifications found.') {
    if (loadingState) loadingState.style.display = 'none';
    if (emptyState) {
        emptyState.style.display = 'block';
        const p = emptyState.querySelector('p');
        if (p) p.textContent = message;
    }
    if (errorState) errorState.style.display = 'none';
}

function hideAllStates() {
    if (loadingState) loadingState.style.display = 'none';
    if (emptyState) emptyState.style.display = 'none';
    if (errorState) errorState.style.display = 'none';
}

// ==================== HELP ====================
export function openHelp() {
    const overlay = document.getElementById('helpOverlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    import('./help.js').then(module => {
        module.renderHelp(overlay);
    }).catch(() => {
        ui.showToast('Help module not available', 'warning');
    });
}

// ==================== INITIALIZATION ====================
export function init() {
    if (isInitialized) return;
    isInitialized = true;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupEventListeners);
    } else {
        setupEventListeners();
    }
}

async function setupEventListeners() {
    const refs = getDomRefs();
    container = refs.container;
    unreadBadge = refs.unreadBadge;
    loadingState = refs.loadingState;
    emptyState = refs.emptyState;
    errorState = refs.errorState;
    searchInput = refs.searchInput;
    clearSearch = refs.clearSearch;
    filterBtns = refs.filterBtns;
    sortSelect = refs.sortSelect;
    chips = refs.chips;
    stats = refs.stats;

    if (filterBtns && filterBtns.length > 0) {
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                setFilter(btn.dataset.filter);
            });
        });
    }

    if (sortSelect) {
        sortSelect.addEventListener('change', () => {
            setSort(sortSelect.value);
        });
    }

    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            setSearch(e.target.value);
        });
    }
    if (clearSearch) {
        clearSearch.addEventListener('click', () => {
            searchInput.value = '';
            setSearch('');
        });
    }

    if (chips && chips.length > 0) {
        chips.forEach(chip => {
            chip.addEventListener('click', () => {
                setCategory(chip.dataset.category);
            });
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && e.ctrlKey) {
            e.preventDefault();
            if (searchInput) searchInput.focus();
        }
        if (e.key === 'Escape') {
            if (searchInput) searchInput.blur();
            const helpOverlay = document.getElementById('helpOverlay');
            if (helpOverlay && helpOverlay.style.display === 'flex') {
                helpOverlay.style.display = 'none';
            }
        }
    });

    events.events.on('new-notification', (data) => {
        if (data && data.notifications) {
            addNotifications(data.notifications);
        }
    });

    if (auth.getUser()) {
        loadNotifications(false);
        startPolling();
    } else {
        const checkUser = setInterval(async () => {
            if (auth.getUser()) {
                clearInterval(checkUser);
                await loadNotifications(false);
                startPolling();
            }
        }, 500);
        setTimeout(() => clearInterval(checkUser), 10000);
    }
}

// ==================== EXPOSE GLOBALLY ====================
window.notifications = {
    load: loadNotifications,
    render,
    markRead,
    markAllRead,
    togglePin,
    toggleArchive,
    deleteNotification,
    setFilter,
    setCategory,
    setSort,
    setSearch,
    resetFilters,
    openHelp,
    refresh: () => loadNotifications(true),
    init,
    addNotifications,
    getUnreadCount,
    startPolling,
    stopPolling,
    registerAction, // NEW: register custom actions
    // Expose internal for debugging
    _processAction: processAction
};

// ==================== AUTO-INIT ====================
if (document.readyState === 'complete') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init);
}

export default {
    loadNotifications,
    render,
    markRead,
    markAllRead,
    togglePin,
    toggleArchive,
    deleteNotification,
    applyFilters,
    setFilter,
    setCategory,
    setSort,
    setSearch,
    resetFilters,
    openHelp,
    init,
    addNotifications,
    getUnreadCount,
    startPolling,
    stopPolling,
    registerAction
};