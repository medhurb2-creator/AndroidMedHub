// scripts/ui.js

/**
 * UI Controller
 * Handles loading overlays, toasts, modals, theme switching, form utilities,
 * password visibility, auto-save indicators, PWA install prompt, and page-specific renderers.
 * Used on all pages.
 */

import * as utils from './utils.js';

// ==================== APP SETTINGS ====================

export const defaultSettings = {
    theme: 'auto',
    notifications: true,
    sound: true
};

let appSettings = { ...defaultSettings };

export function setAppSetting(key, value) {
    appSettings[key] = value;
    utils.setLocalStorage('appSettings', appSettings);
}

export function getAppSetting(key) {
    return appSettings[key];
}

export function getAppSettings() {
    return appSettings;
}

/**
 * Bulk update app settings.
 * @param {Object} settings - Partial settings object to merge.
 */
export function setAppSettings(settings) {
    appSettings = { ...appSettings, ...settings };
    utils.setLocalStorage('appSettings', appSettings);
}

// ==================== LOADING OVERLAY ====================

/**
 * Two-stage loading-overlay budget.
 *
 *   SOFT_MS    — after this long, the overlay is still up but the label
 *                switches to a "still working…" message. Purely
 *                informational: nothing is torn down, the request is
 *                untouched. Exists because an unlabelled spinner that
 *                has been running for more than a few seconds reads as
 *                "hung", and users force-quit. A visible acknowledgement
 *                of the wait keeps them on the page.
 *
 *   BASE_MS    — how long a "normal" operation is allowed to take before
 *                we consider it slow. Historically this was the whole
 *                budget; it is now the middle stage.
 *
 *   MERCY_MS   — extra room granted on top of BASE_MS. A genuinely slow
 *                network call (cold Convex function, weak mobile data,
 *                first-render bundle) often needs a few more seconds
 *                than the baseline. Without this, the spinner is torn
 *                down while the request is still in flight and the user
 *                sees "took too long" for a call that was about to
 *                succeed.
 *
 *   TIMEOUT_MS — BASE + MERCY. The moment the overlay is force-hidden
 *                and the error toast is raised.
 *
 * Timeline: soft message at 5 s, hard kill at 14 s.
 * Change MERCY_MS to widen or narrow the grace period without touching
 * the baseline.
 */
const LOADING_SOFT_MS    =  5000;   // soft stage — label switches
const LOADING_BASE_MS    = 10000;   // baseline — 10 s
const LOADING_MERCY_MS   =  4000;   // mercy window — +4 s
const LOADING_TIMEOUT_MS = LOADING_BASE_MS + LOADING_MERCY_MS;   // = 14000

const LOADING_DEFAULT_MESSAGE = 'Loading...';
const LOADING_SOFT_MESSAGE    = 'Still working… slow connection.';

let loadingOverlay      = null;
let loadingLabel        = null;
let loadingTimeout      = null;
let loadingKillTimeout  = null;

export function showLoading(message = LOADING_DEFAULT_MESSAGE) {
    if (!loadingOverlay) {
        loadingOverlay = document.createElement('div');
        loadingOverlay.className = 'loading-overlay';
        loadingOverlay.innerHTML = `
            <div class="spinner"></div>
            <div class="loading-label"></div>
        `;
        document.body.appendChild(loadingOverlay);
        loadingLabel = loadingOverlay.querySelector('.loading-label');
    }

    // Reset the label to the caller's message on every fresh show. If a
    // previous call had swapped it to the soft-stage string, this puts
    // it back.
    if (loadingLabel) loadingLabel.textContent = message;

    loadingOverlay.classList.remove('hidden');

    // Clear any timers left over from a previous show.
    if (loadingTimeout)     clearTimeout(loadingTimeout);
    if (loadingKillTimeout) clearTimeout(loadingKillTimeout);

    // ── Stage 1: soft acknowledgment ────────────────────────────────
    // Fires while the overlay is still visible. If hideLoading() has
    // already run by then, the overlay will be hidden — check and bail.
    loadingTimeout = setTimeout(() => {
        if (!loadingOverlay || loadingOverlay.classList.contains('hidden')) return;
        const label = loadingOverlay.querySelector('.loading-label');
        if (label) label.textContent = LOADING_SOFT_MESSAGE;
    }, LOADING_SOFT_MS);

    // ── Stage 2: hard kill ──────────────────────────────────────────
    // Force-hides the overlay and surfaces the error toast. Called only
    // when the operation genuinely failed to complete in the full
    // budget — a slow-but-eventually-successful request never reaches
    // here because hideLoading() clears this timer first.
    loadingKillTimeout = setTimeout(() => {
        hideLoading();
        showToast('Loading took too long. Please try again.', 'error', 5000);
    }, LOADING_TIMEOUT_MS);
}

export function hideLoading() {
    if (loadingOverlay) {
        loadingOverlay.classList.add('hidden');
    }
    if (loadingTimeout) {
        clearTimeout(loadingTimeout);
        loadingTimeout = null;
    }
    if (loadingKillTimeout) {
        clearTimeout(loadingKillTimeout);
        loadingKillTimeout = null;
    }
}

// ==================== TOAST NOTIFICATIONS ====================

let toastContainer = null;

function ensureToastContainer() {
    if (!toastContainer) {
        toastContainer = document.querySelector('.toast-container');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.className = 'toast-container';
            document.body.appendChild(toastContainer);
        }
    }
}

export function showToast(message, type = 'info', duration = 3000) {
    ensureToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (toast.parentNode) toast.remove();
        }, 300);
    }, duration);
}

// ==================== MODAL DIALOGS ====================

// Shared modal overlay for both confirmation and generic modals
let modalOverlay = null;

function ensureModalOverlay() {
    if (!modalOverlay) {
        modalOverlay = document.createElement('div');
        modalOverlay.className = 'modal-overlay';
        modalOverlay.style.display = 'none';
        modalOverlay.style.alignItems = 'center';
        modalOverlay.style.justifyContent = 'center';
        modalOverlay.style.position = 'fixed';
        modalOverlay.style.inset = '0';
        modalOverlay.style.zIndex = '1000';
        modalOverlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
        modalOverlay.style.backdropFilter = 'blur(4px)';
        document.body.appendChild(modalOverlay);

        // Click outside to close (for generic modals only)
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                // Only close if it's a generic modal (not a confirmation)
                if (!modalOverlay.dataset.isConfirmation) {
                    hideModal();
                }
            }
        });
    }
}

// ==================== CONFIRMATION DIALOG ====================

export function showConfirmationDialog(title, message, type = 'info') {
    return new Promise((resolve) => {
        ensureModalOverlay();
        modalOverlay.dataset.isConfirmation = 'true';

        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.innerHTML = `
            <div class="modal-header">
                <h3>${title}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                <p>${message}</p>
            </div>
            <div class="modal-footer">
                <button class="btn-secondary" id="modal-cancel">Cancel</button>
                <button class="btn-${type === 'critical' ? 'danger' : 'primary'}" id="modal-confirm">OK</button>
            </div>
        `;

        modalOverlay.innerHTML = '';
        modalOverlay.appendChild(modal);
        modalOverlay.style.display = 'flex';

        const closeModal = (result) => {
            modalOverlay.style.display = 'none';
            modalOverlay.innerHTML = '';
            delete modalOverlay.dataset.isConfirmation;
            resolve(result);
        };

        modal.querySelector('.modal-close').addEventListener('click', () => closeModal(false));
        modal.querySelector('#modal-cancel').addEventListener('click', () => closeModal(false));
        modal.querySelector('#modal-confirm').addEventListener('click', () => closeModal(true));

        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeModal(false);
        });
    });
}

// ==================== GENERIC MODAL ====================

/**
 * Show a generic modal with arbitrary HTML content.
 * @param {Object} options - { title, content, size?, onClose? }
 */
export function showModal(options) {
    ensureModalOverlay();
    // Remove confirmation flag so click-outside works
    delete modalOverlay.dataset.isConfirmation;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.style.cssText = `
        background: var(--bg-card);
        border-radius: var(--radius-lg);
        padding: 1.5rem;
        max-width: ${options.size === 'medium' ? '480px' : '400px'};
        width: 90%;
        max-height: 90vh;
        overflow-y: auto;
        box-shadow: var(--shadow-lg);
        animation: modalSlideUp 0.25s ease;
    `;

    modal.innerHTML = `
        <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
            <h3 style="margin:0;">${options.title || ''}</h3>
            <button class="modal-close" style="background:none; border:none; font-size:1.5rem; cursor:pointer; color:var(--text-muted);">×</button>
        </div>
        <div class="modal-body" style="color:var(--text-secondary);">${options.content || ''}</div>
    `;

    modalOverlay.innerHTML = '';
    modalOverlay.appendChild(modal);
    modalOverlay.style.display = 'flex';

    // Close button
    modal.querySelector('.modal-close').addEventListener('click', () => {
        hideModal();
        if (options.onClose) options.onClose();
    });

    // Click outside to close (generic modal)
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) {
            hideModal();
            if (options.onClose) options.onClose();
        }
    });
}

/**
 * Hide the currently open modal (both confirmation and generic).
 */
export function hideModal() {
    if (modalOverlay) {
        modalOverlay.style.display = 'none';
        modalOverlay.innerHTML = '';
        delete modalOverlay.dataset.isConfirmation;
    }
}

// ==================== THEME MANAGEMENT ====================

export function setTheme(theme) {
    if (theme === 'auto') {
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.classList.toggle('dark-theme', prefersDark);
    } else {
        document.body.classList.toggle('dark-theme', theme === 'dark');
    }
    utils.setLocalStorage('theme', theme);
    // Update appSettings as well
    appSettings.theme = theme;
    utils.setLocalStorage('appSettings', appSettings);
}

export function getTheme() {
    return utils.getLocalStorage('theme', 'auto');
}

export function applyTheme() {
    const theme = getTheme();
    setTheme(theme);
}

export function toggleTheme() {
    const current = getTheme();
    let next;
    if (current === 'auto') {
        const isDark = document.body.classList.contains('dark-theme');
        next = isDark ? 'light' : 'dark';
    } else if (current === 'dark') {
        next = 'light';
    } else {
        next = 'dark';
    }
    setTheme(next);
    showToast(`Switched to ${next} mode`, 'info', 1500);
}

// ==================== FORM HANDLING ====================

export function disableForm(form) {
    const formEl = typeof form === 'string' ? document.getElementById(form) : form;
    if (!formEl) return;
    formEl.querySelectorAll('input, select, textarea, button').forEach(el => el.disabled = true);
}

export function enableForm(form) {
    const formEl = typeof form === 'string' ? document.getElementById(form) : form;
    if (!formEl) return;
    formEl.querySelectorAll('input, select, textarea, button').forEach(el => el.disabled = false);
}

export function resetForm(form) {
    const formEl = typeof form === 'string' ? document.getElementById(form) : form;
    if (formEl) formEl.reset();
}

export function showFormError(fieldId, message) {
    const field = document.getElementById(fieldId);
    if (!field) return;

    let errorEl = document.querySelector(`.error-message[data-for="${fieldId}"]`);
    if (!errorEl) {
        errorEl = document.createElement('div');
        errorEl.className = 'error-message';
        errorEl.setAttribute('data-for', fieldId);
        field.parentNode.appendChild(errorEl);
    }
    errorEl.textContent = message;
    field.classList.add('error');
}

export function clearFormError(fieldId) {
    const field = document.getElementById(fieldId);
    if (!field) return;
    const errorEl = document.querySelector(`.error-message[data-for="${fieldId}"]`);
    if (errorEl) errorEl.textContent = '';
    field.classList.remove('error');
}

// ==================== PASSWORD VISIBILITY TOGGLE ====================

export function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const type = input.type === 'password' ? 'text' : 'password';
    input.type = type;
}

// ==================== VALIDATION SUMMARY ====================

export function showValidationSummary(errors) {
    if (!errors || errors.length === 0) return;
    const message = errors.join('\n');
    showToast(message, 'error', 5000);
}

// ==================== PASSWORD STRENGTH INDICATOR ====================

export function updatePasswordStrength(strength) {
    const meter = document.getElementById('password-strength');
    if (!meter) return;

    meter.className = 'strength-meter';
    meter.innerHTML = '';

    const fill = document.createElement('div');
    fill.className = 'fill';
    meter.appendChild(fill);

    if (strength.score === 0) {
        fill.style.width = '0%';
        meter.classList.add('strength-weak');
    } else if (strength.score <= 1) {
        fill.style.width = '33%';
        meter.classList.add('strength-weak');
    } else if (strength.score === 2) {
        fill.style.width = '66%';
        meter.classList.add('strength-medium');
    } else {
        fill.style.width = '100%';
        meter.classList.add('strength-strong');
    }
}

// ==================== AUTO-SAVE INDICATOR ====================

let autoSaveTimer;
export function showAutoSaveIndicator() {
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        showToast('Progress auto-saved', 'info', 1500);
    }, 500);
}

// ==================== INSTALL PROMPT ====================

let deferredPrompt;
export function setupInstallPrompt(buttonId) {
    const installBtn = document.getElementById(buttonId);
    if (!installBtn) return;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        installBtn.style.display = 'inline-block';
    });

    installBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        if (outcome === 'accepted') {
            showToast('Thank you for installing!', 'success');
        }
        deferredPrompt = null;
        installBtn.style.display = 'none';
    });
}

// ==================== FEATURE GRID RENDERING ====================

export function renderFeatureGrid(containerId, features) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = features.map(f => `
        <div class="feature-card">
            <div class="feature-icon">${f.icon}</div>
            <h3>${f.title}</h3>
            <p>${f.desc}</p>
        </div>
    `).join('');
}

// ==================== TESTIMONIALS RENDERING ====================

export function renderTestimonials(containerId, testimonials) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = testimonials.map(t => `
        <div class="testimonial">
            <p>"${t.text}"</p>
            <cite>— ${t.name}</cite>
        </div>
    `).join('');
}

// ==================== FAQ RENDERING ====================

export function renderFaq(containerId, faqs) {
    const container = document.getElementById(containerId);
    if (!container) return;

    container.innerHTML = faqs.map((f, i) => `
        <div class="faq-item" id="faq-${i}">
            <div class="faq-question" onclick="document.getElementById('faq-${i}').classList.toggle('active')">
                <span>${f.q}</span>
                <span class="faq-icon">▼</span>
            </div>
            <div class="faq-answer">${f.a}</div>
        </div>
    `).join('');
}

// ==================== TAB SWITCHING ====================

export function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));

    const tab = document.getElementById(tabId);
    if (tab) tab.classList.add('active');

    const buttons = document.querySelectorAll('.tab-button');
    buttons.forEach(b => {
        if (b.textContent.toLowerCase().includes(tabId.replace('-tab', ''))) {
            b.classList.add('active');
        }
    });
}

// ==================== EXAM ROOM UI HELPERS ====================

export function updateTimerDisplay(timerElement, remainingMs, totalMs) {
    if (!timerElement) return;

    const percentage = remainingMs / totalMs;
    const seconds = Math.floor(remainingMs / 1000);
    timerElement.textContent = utils.formatTime(seconds);

    timerElement.classList.remove('green', 'yellow', 'red', 'flash');
    if (percentage > 0.7) {
        timerElement.classList.add('green');
    } else if (percentage > 0.3) {
        timerElement.classList.add('yellow');
    } else if (percentage > 0.05) {
        timerElement.classList.add('red');
    } else {
        timerElement.classList.add('red', 'flash');
    }
}

// ==================== PROGRESS BAR UPDATE ====================

export function updateProgressBar(elementId, percentage) {
    const bar = document.getElementById(elementId);
    if (bar) {
        bar.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
    }
}

// ==================== EXPOSE GLOBALLY FOR INLINE SCRIPTS ====================

window.ui = {
    showToast,
    showLoading,
    hideLoading,
    showConfirmationDialog,
    hideModal,
    showModal,           // ✅ Added
    toggleTheme,
    applyTheme,
    getTheme,
    setTheme,
    disableForm,
    enableForm,
    resetForm,
    showFormError,
    clearFormError,
    togglePasswordVisibility,
    showValidationSummary,
    updatePasswordStrength,
    showAutoSaveIndicator,
    setupInstallPrompt,
    renderFeatureGrid,
    renderTestimonials,
    renderFaq,
    switchTab,
    updateTimerDisplay,
    updateProgressBar,
    // App settings
    setAppSetting,
    getAppSetting,
    getAppSettings,
    setAppSettings,
    defaultSettings
};