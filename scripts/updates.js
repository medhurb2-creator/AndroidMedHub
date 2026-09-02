// scripts/updates.js

/**
 * Service Worker Update Management
 * Handles detection of new SW versions and prompts the user to update.
 */

import * as ui from './ui.js';

// ==================== STATE ====================
let updatePending = false;

// ==================== REGISTER LISTENER ====================
export function registerUpdateListener() {
    if ('serviceWorker' in navigator) {
        // When the SW updates and takes over, reload the page
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            console.log('[Updates] Service worker controller changed');
            window.location.reload();
        });

        // Check if there's a waiting SW on registration
        navigator.serviceWorker.ready.then(registration => {
            if (registration.waiting) {
                updatePending = true;
                showUpdatePrompt();
            }
        });

        // Listen for messages from the SW (e.g., UPDATE_FOUND)
        navigator.serviceWorker.addEventListener('message', event => {
            if (event.data && event.data.type === 'UPDATE_FOUND') {
                updatePending = true;
                showUpdatePrompt();
            }
        });
    }
}

// ==================== PROMPT ====================
export function showUpdatePrompt() {
    if (!updatePending) return;
    const updateModal = document.createElement('div');
    updateModal.className = 'modal-overlay';
    updateModal.innerHTML = `
        <div class="modal">
            <h3>Update Available</h3>
            <p>A new version of MedVix is available. Refresh to get the latest features.</p>
            <div style="display: flex; gap: 0.5rem; justify-content: flex-end; margin-top: 1rem;">
                <button id="update-refresh" class="btn-primary">Refresh Now</button>
                <button id="update-later" class="btn-secondary">Later</button>
            </div>
        </div>
    `;
    document.body.appendChild(updateModal);

    document.getElementById('update-refresh').addEventListener('click', () => {
        updateModal.remove();
        skipWaitingAndReload();
    });
    document.getElementById('update-later').addEventListener('click', () => {
        updateModal.remove();
    });
}

// ==================== SKIP WAITING AND RELOAD ====================
export async function skipWaitingAndReload() {
    if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration && registration.waiting) {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
    }
    window.location.reload();
}

// ==================== CHECK FOR UPDATES (manual trigger) ====================
export async function checkForUpdates() {
    if (!navigator.onLine) return;
    if ('serviceWorker' in navigator) {
        try {
            const registration = await navigator.serviceWorker.getRegistration();
            if (registration) {
                registration.update().then(() => {
                    if (registration.waiting) {
                        updatePending = true;
                        showUpdatePrompt();
                    }
                }).catch(err => console.warn('Update check failed', err));
            } else {
                console.log('No service worker registered');
            }
        } catch (err) {
            console.warn('Update check error', err);
        }
    }
}