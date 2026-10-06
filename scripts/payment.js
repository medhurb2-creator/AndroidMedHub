// scripts/payment.js

/**
 * Payment processing – Convex integration
 *
 * Backend contract (unchanged):
 *   • purchaseSubscription        → action  { token, planId, phoneNumber, deviceId,
 *                                             deviceInfo, deviceCount, customAmount? }
 *   • checkPaymentStatus          → ACTION  { token, transactionId }
 *   • getPendingPaymentsByPhone   → ACTION  { token, phoneNumber }
 *   • claimManualPayment          → action  { token, mpesaCode?, phoneNumber? }
 *
 * NEW: on a `completed` status, this module now:
 *   1. Force-refreshes the subscription from the backend
 *      (subscription.refreshSubscription()) so the cached expiry is
 *      authoritative, not the locally-computed one.
 *   2. Builds a receipt payload.
 *   3. Emits it via:
 *        a) a `payment:completed` CustomEvent on `window`
 *        b) any callbacks registered via `Payment.onSuccess(cb)`
 *        c) built-in DOM fallback: fills the `#receipt-modal` element if
 *           present, wires its Continue button, and auto-navigates to
 *           `subjects` after 10s.
 *
 * Pages that want to override the receipt UI should register a callback
 * via `Payment.onSuccess(cb)` that returns a truthy value — the DOM
 * fallback is then skipped.
 */

import { convexHttpClient } from './convex-client.js';
import * as auth from './auth.js';
import * as security from './security.js';
import * as ui from './ui.js';
import * as subscription from './subscription.js';
import { navigateTo } from './router.js';

const RECEIPT_AUTO_NAV_SECONDS = 10;

// ==================== PLAN SELECTION ====================

let selectedPlan = null;

export function setSelectedPlan(plan) {
    selectedPlan = plan;
    if (plan) {
        sessionStorage.setItem('selectedPlan', JSON.stringify(plan));
    } else {
        sessionStorage.removeItem('selectedPlan');
    }
}

export function getSelectedPlan() {
    if (selectedPlan) return selectedPlan;
    const stored = sessionStorage.getItem('selectedPlan');
    if (stored) {
        try {
            selectedPlan = JSON.parse(stored);
            return selectedPlan;
        } catch (e) {}
    }
    return null;
}

// ==================== TRANSACTION ID ====================

let currentTransaction = null;

export function setCurrentTransaction(transactionId) {
    currentTransaction = transactionId;
}

export function getCurrentTransaction() {
    return currentTransaction;
}

// ==================== PAYMENT MANAGER ====================

class PaymentManager {
    constructor() {
        this.paymentStatus = {};
        this.paymentHistory = [];
        this.activePoll = null;
        this.isPolling = false;

        // Receipt / success flow state
        this.successCallbacks = [];
        this._receiptCountdownTimer = null;
        this._receiptNavTimeout = null;

        this.init();
    }

    init() {
        this.loadPaymentHistory();
        console.log('[Payment] Manager initialized with Convex backend');
    }

    loadPaymentHistory() {
        try {
            const saved = localStorage.getItem('payment_history');
            this.paymentHistory = saved ? JSON.parse(saved) : [];
        } catch (e) {
            this.paymentHistory = [];
        }
    }

    savePaymentHistory() {
        try {
            localStorage.setItem('payment_history', JSON.stringify(this.paymentHistory));
        } catch (e) {
            console.warn('[Payment] Could not save history', e);
        }
    }

    // ============================================================
    // 1. PHONE NUMBER VALIDATION
    // ============================================================
    validatePhoneNumber(phone) {
        const digits = phone.replace(/\D/g, '');
        if (digits.length === 9 && digits.startsWith('7')) return `254${digits}`;
        if (digits.length === 10 && digits.startsWith('07')) return `254${digits.substring(1)}`;
        if (digits.length === 12 && digits.startsWith('254')) return digits;
        return false;
    }

    formatPhoneDisplay(phone) {
        const formatted = this.validatePhoneNumber(phone);
        if (!formatted) return phone;
        const last9 = formatted.slice(-9);
        return `0${last9.slice(0, 2)} ${last9.slice(2, 5)} ${last9.slice(5)}`;
    }

    // ============================================================
    // 2. INITIATE M‑PESA PAYMENT
    // ============================================================
    async initiateMpesaPayment(paymentData) {
        try {
            const validation = this.validatePaymentData(paymentData);
            if (!validation.isValid) throw new Error(validation.errors[0]);

            const token = auth.getToken();
            if (!token) throw new Error('Not authenticated');

            const { deviceId, deviceInfo } = await security.buildDeviceIdentity();
            const normalizedPhone =
                this.validatePhoneNumber(paymentData.phoneNumber) || paymentData.phoneNumber;

            const planId = paymentData.planId || paymentData.plan;
            const deviceCount = Math.max(1, Math.min(paymentData.deviceCount ?? 1, 2));
            const isCustom = planId === 'custom';

            const actionArgs = {
                token,
                planId,
                phoneNumber: normalizedPhone,
                deviceId,
                deviceInfo,
                deviceCount,
            };
            if (isCustom) {
                if (!paymentData.amount || paymentData.amount < 50) {
                    throw new Error('Custom amount must be at least KES 50');
                }
                actionArgs.customAmount = paymentData.amount;
            }

            const result = await convexHttpClient.action(
                'subscriptions/actions:purchaseSubscription',
                actionArgs
            );

            if (!result.success) throw new Error(result.message);

            const {
                paymentId,
                transactionId,
                amount,
                deviceCount: returnedCount,
                status,
                message,
            } = result.data;

            const record = {
                id: transactionId,
                paymentId,
                phoneNumber: paymentData.phoneNumber,
                amount: amount ?? paymentData.amount,
                plan: planId,
                planName: paymentData.planName || this._humanPlan(planId),
                durationText: paymentData.durationText || null,
                deviceCount: returnedCount ?? deviceCount,
                description:
                    paymentData.description ||
                    `Subscription: ${planId}`,
                status: 'pending',
                initiatedAt: new Date().toISOString(),
                completedAt: null,
                expiryDate: null,
                mpesaReceipt: null,
                userId: auth.getUser()?._id || null,
                // internal flags
                _receiptHandled: false,
                _receiptPayload: null,
            };
            this.paymentStatus[transactionId] = {
                ...record,
                lastChecked: Date.now(),
                checkCount: 0,
            };
            this.paymentHistory.unshift(record);
            this.savePaymentHistory();

            console.log('[Payment] STK push initiated:', transactionId);

            return {
                success: true,
                transactionId,
                paymentId,
                message: message || 'Check your phone for M-Pesa prompt',
                polling: { interval: 15000, maxAttempts: 10 },
            };
        } catch (error) {
            console.error('[Payment] Initiation failed:', error);
            throw new Error(error.message || 'Payment initiation failed');
        }
    }

    // ============================================================
    // 3. CHECK PAYMENT STATUS
    // ============================================================
    async checkPaymentStatus(transactionId) {
        try {
            const token = auth.getToken();
            if (!token) {
                console.warn('[Payment] No token found, redirecting to login');
                window.location.href = '/pages/login.html';
                return { success: false, status: 'expired' };
            }

            const result = await convexHttpClient.action(
                'payments/queries:checkPaymentStatus',
                { token, transactionId }
            );

            if (!result?.success) {
                if (
                    result?.error === 'invalid_token' ||
                    result?.message?.toLowerCase().includes('token')
                ) {
                    console.warn('[Payment] Invalid token, logging out');
                    await auth.logout();
                    window.location.href = '/pages/login.html';
                    return { success: false, status: 'expired' };
                }
                throw new Error(result?.message || 'Status check failed');
            }

            const { status, receipt, amount, updatedAt } = result.data;

            const record = this.paymentStatus[transactionId];
            if (record) {
                const prevStatus = record.status;
                record.status = status;
                record.mpesaReceipt = receipt;
                record.updatedAt = updatedAt;
                if (['completed', 'failed', 'expired'].includes(status)) {
                    record.completedAt = record.completedAt || new Date().toISOString();
                }
                record.lastChecked = Date.now();
                record.checkCount++;

                const idx = this.paymentHistory.findIndex((p) => p.id === transactionId);
                if (idx !== -1) {
                    this.paymentHistory[idx] = { ...record };
                    this.savePaymentHistory();
                }

                // 🔔 Terminal success → kick off refresh + receipt (once)
                if (
                    status === 'completed' &&
                    prevStatus !== 'completed' &&
                    !record._receiptHandled
                ) {
                    // Fire-and-forget — the poll returns immediately with
                    // the status; the receipt flow completes asynchronously.
                    this._handleSuccessfulPayment(transactionId).catch((e) =>
                        console.warn('[Payment] Post-success handler failed', e)
                    );
                }
            }

            return {
                success: true,
                status,
                receipt,
                amount,
                updatedAt,
                payment: this.paymentStatus[transactionId] || null,
            };
        } catch (error) {
            console.error('[Payment] Status check failed:', error);
            if (error.message?.toLowerCase().includes('token')) {
                await auth.logout();
                window.location.href = '/pages/login.html';
                return { success: false, status: 'expired' };
            }
            return { success: false, status: 'unknown', message: error.message };
        }
    }

    // ============================================================
    // 4. POLL PAYMENT STATUS
    // ============================================================
    async pollPaymentStatus(transactionId, callbacks = {}, interval = 15000, maxAttempts = 10) {
        this.cancelPolling();

        let attempts = 0;
        let timedOut = false;
        let cancelled = false;

        const poll = async () => {
            if (cancelled) return;
            attempts++;
            console.log(`[Payment] Poll attempt ${attempts}/${maxAttempts} for ${transactionId}`);

            const result = await this.checkPaymentStatus(transactionId);
            const status = result.status || 'unknown';
            const payment = this.paymentStatus[transactionId] || null;

            if (callbacks.onUpdate) {
                callbacks.onUpdate({ status, payment, attempt: attempts });
            }

            if (['completed', 'failed', 'expired'].includes(status)) {
                this.isPolling = false;
                if (callbacks.onComplete) {
                    callbacks.onComplete({ status, payment, attempts, timedOut: false });
                }
                return;
            }

            if (attempts < maxAttempts && !cancelled) {
                this.activePoll = setTimeout(poll, interval);
            } else if (!cancelled) {
                timedOut = true;
                this.isPolling = false;
                if (callbacks.onComplete) {
                    callbacks.onComplete({ status, payment, attempts, timedOut: true });
                }
                ui.showToast(
                    'Payment status not confirmed after 150 seconds. Please check your M-Pesa app or contact support.',
                    'warning'
                );
            }
        };

        this.isPolling = true;
        await poll();

        return () => {
            cancelled = true;
            this.cancelPolling();
        };
    }

    cancelPolling() {
        if (this.activePoll) {
            clearTimeout(this.activePoll);
            this.activePoll = null;
        }
        this.isPolling = false;
    }

    // ============================================================
    // 5. MANUAL CLAIM
    // ============================================================
    async claimManualPayment({ mpesaCode, phoneNumber }) {
        try {
            const token = auth.getToken();
            if (!token) throw new Error('Not authenticated');

            const payload = { token };
            if (mpesaCode) payload.mpesaCode = mpesaCode;
            if (phoneNumber) {
                payload.phoneNumber =
                    this.validatePhoneNumber(phoneNumber) || phoneNumber;
            }

            const result = await convexHttpClient.action(
                'payments/actions:claimManualPayment',
                payload
            );

            if (!result.success) throw new Error(result.message);

            await subscription.refreshSubscription();
            return result.data;
        } catch (error) {
            console.error('[Payment] Manual claim failed:', error);
            throw new Error(error.message || 'Failed to claim payment');
        }
    }

    // ============================================================
    // 6. GET PENDING PAYMENTS
    // ============================================================
    async getPendingPayments(phoneNumber) {
        try {
            const token = auth.getToken();
            if (!token) throw new Error('Not authenticated');

            const normalized =
                this.validatePhoneNumber(phoneNumber) || phoneNumber;

            const result = await convexHttpClient.action(
                'payments/queries:getPendingPaymentsByPhone',
                { token, phoneNumber: normalized }
            );

            if (!result?.success) throw new Error(result?.message || 'Failed');
            return result.data;
        } catch (error) {
            console.error('[Payment] Failed to fetch pending payments:', error);
            return [];
        }
    }

    // ============================================================
    // 7. SUCCESS HOOK + RECEIPT FLOW
    // ============================================================

    /**
     * Register a callback invoked when a payment completes.
     *
     * The callback receives the receipt payload. If it returns a truthy
     * value (anything except `false`), the built-in DOM fallback is
     * skipped — so pages that render their own receipt UI stay in control.
     *
     * @param {(receipt: Object) => any} callback
     * @returns {Function} unsubscribe function
     */
    onSuccess(callback) {
        if (typeof callback !== 'function') return () => {};
        this.successCallbacks.push(callback);
        return () => {
            const i = this.successCallbacks.indexOf(callback);
            if (i !== -1) this.successCallbacks.splice(i, 1);
        };
    }

    /**
     * Internal: fires once per transaction when the status first hits
     * `completed`. Refreshes the subscription, builds the receipt,
     * and dispatches to listeners / fallback.
     */
    async _handleSuccessfulPayment(transactionId) {
        const payment = this.paymentStatus[transactionId];
        if (!payment) return null;

        // Idempotency — only run once per transaction
        if (payment._receiptHandled) return payment._receiptPayload || null;
        payment._receiptHandled = true;

        // 1. Force-refresh subscription from backend
        let freshSub = null;
        try {
            freshSub = await subscription.refreshSubscription();
            if (!freshSub) freshSub = await subscription.getSubscription();
        } catch (e) {
            console.warn('[Payment] Force-refresh subscription failed; using cache', e);
            try { freshSub = await subscription.getSubscription(); } catch (_) {}
        }

        // Persist fresh expiry onto the local record
        if (freshSub?.expiryDate) {
            payment.expiryDate = freshSub.expiryDate;
        }

        // 2. Build receipt payload
        const payload = this.buildReceiptPayload(payment, freshSub);
        payment._receiptPayload = payload;

        // Persist again so history reflects the receipt snapshot
        const idx = this.paymentHistory.findIndex((p) => p.id === transactionId);
        if (idx !== -1) {
            this.paymentHistory[idx] = { ...payment };
            this.savePaymentHistory();
        }

        // 3. Notify listeners + optional DOM fallback
        this._emitReceipt(payload);

        return payload;
    }

    /**
     * Build the receipt payload that gets handed to listeners / the
     * built-in DOM renderer.
     */
    buildReceiptPayload(payment, subscriptionData) {
        const devices = Number(
            payment.deviceCount ?? subscriptionData?.devices ?? 1
        );
        const deviceLabel =
            devices <= 1
                ? '1 device · 📱'
                : devices === 2
                ? '2 devices · 📱 + 💻'
                : `${devices} devices`;

        const expiry = payment.expiryDate || subscriptionData?.expiryDate || null;
        const completedAt = payment.completedAt || new Date().toISOString();

        return {
            transactionId: payment.id,
            paymentId: payment.paymentId || null,
            mpesaReceipt: payment.mpesaReceipt || null,
            status: payment.status,
            amount: Number(payment.amount) || 0,
            amountLabel: `KES ${Number(payment.amount || 0).toLocaleString()}`,
            planId: payment.plan,
            planName: payment.planName || this._humanPlan(payment.plan),
            durationText: payment.durationText || null,
            phoneNumber: payment.phoneNumber,
            phoneDisplay: this.formatPhoneDisplay(payment.phoneNumber),
            completedAt,
            dateLabel: new Date(completedAt).toLocaleString(),
            devices,
            deviceLabel,
            expiryDate: expiry,
            expiryLabel: expiry ? this._formatDateOnly(expiry) : '—',
        };
    }

    _humanPlan(planId) {
        if (!planId) return 'Subscription';
        return String(planId).charAt(0).toUpperCase() + String(planId).slice(1);
    }

    _formatDateOnly(ts) {
        if (!ts) return '—';
        const d = ts instanceof Date ? ts : new Date(ts);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
        });
    }

    /**
     * Dispatch the receipt to every consumer:
     *   1. `payment:completed` CustomEvent on window
     *   2. Registered `onSuccess` callbacks
     *   3. Built-in DOM fallback (only if no callback handled it)
     */
    _emitReceipt(receipt) {
        // 1. Global event
        try {
            window.dispatchEvent(new CustomEvent('payment:completed', { detail: receipt }));
        } catch (e) {
            /* extremely unlikely */
        }

        // 2. Registered callbacks
        let handled = false;
        for (const cb of this.successCallbacks.slice()) {
            try {
                const result = cb(receipt);
                if (result !== false) handled = true;
            } catch (e) {
                console.warn('[Payment] onSuccess callback error', e);
            }
        }

        // 3. DOM fallback
        if (!handled) {
            this._renderReceiptDom(receipt);
        }
    }

    /**
     * Fill in the built-in receipt modal if present in the DOM.
     * Wires Continue + auto-navigate countdown. Falls back to
     * a plain navigation if no modal exists.
     */
    _renderReceiptDom(receipt) {
        const modal = document.getElementById('receipt-modal');
        if (!modal) {
            // No receipt UI — just navigate after a short pause
            this._scheduleNavigation(800);
            return;
        }

        const setText = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };
        setText('receipt-ref',      receipt.transactionId || '—');
        setText('receipt-plan',     receipt.planName || '—');
        setText('receipt-devices',  receipt.deviceLabel || '—');
        setText('receipt-amount',   receipt.amountLabel || '—');
        setText('receipt-duration', receipt.durationText || '—');
        setText('receipt-expiry',   receipt.expiryLabel || '—');
        setText('receipt-date',     receipt.dateLabel || '—');

        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');

        // Continue button — clone to drop any prior listener
        const continueBtn = document.getElementById('receiptContinueBtn');
        if (continueBtn) {
            const fresh = continueBtn.cloneNode(true);
            continueBtn.parentNode.replaceChild(fresh, continueBtn);
            fresh.addEventListener(
                'click',
                () => this._closeReceiptAndNavigate(),
                { once: true }
            );
        }

        // Auto-navigate countdown
        this.cancelReceiptCountdown();
        let remaining = RECEIPT_AUTO_NAV_SECONDS;
        const countdownEl = document.getElementById('receipt-countdown');
        const tick = () => {
            if (countdownEl) countdownEl.textContent = `Continuing in ${remaining}s…`;
        };
        tick();

        this._receiptCountdownTimer = setInterval(() => {
            remaining -= 1;
            if (remaining <= 0) {
                this._closeReceiptAndNavigate();
                return;
            }
            tick();
        }, 1000);
    }

    _closeReceiptAndNavigate() {
        this.cancelReceiptCountdown();
        const modal = document.getElementById('receipt-modal');
        if (modal) {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
        }
        this._scheduleNavigation(200);
    }

    _scheduleNavigation(delayMs = 150) {
        if (this._receiptNavTimeout) clearTimeout(this._receiptNavTimeout);
        this._receiptNavTimeout = setTimeout(() => {
            this._receiptNavTimeout = null;
            try {
                navigateTo('subjects');
            } catch (e) {
                console.warn('[Payment] Navigation failed', e);
            }
        }, delayMs);
    }

    cancelReceiptCountdown() {
        if (this._receiptCountdownTimer) {
            clearInterval(this._receiptCountdownTimer);
            this._receiptCountdownTimer = null;
        }
    }

    /**
     * Public: cancel the receipt flow (countdown + pending navigation).
     * Call this from your page's `destroy()` to avoid stale timers.
     */
    cancelReceiptFlow() {
        this.cancelReceiptCountdown();
        if (this._receiptNavTimeout) {
            clearTimeout(this._receiptNavTimeout);
            this._receiptNavTimeout = null;
        }
        const modal = document.getElementById('receipt-modal');
        if (modal) {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
        }
    }

    /**
     * Public: manually show the receipt for a given transaction.
     * Useful for history views / re-print flows.
     */
    showReceipt(transactionId) {
        const payment = this.paymentStatus[transactionId];
        if (!payment) {
            ui.showToast('Payment record not found', 'error');
            return;
        }

        // If the payload already exists, just re-render
        if (payment._receiptPayload) {
            this._renderReceiptDom(payment._receiptPayload);
            return;
        }

        // Otherwise trigger the full success flow
        this._handleSuccessfulPayment(transactionId).catch((e) =>
            console.warn('[Payment] showReceipt failed', e)
        );
    }

    printReceipt(transactionId) {
        const payment = this.paymentStatus[transactionId];
        if (!payment) return;
        const deviceCount = payment.deviceCount ?? 1;
        const printContent = `
            <html><head><title>Receipt</title><style>body{font-family:Arial;margin:20px}.row{display:flex;justify-content:space-between;margin:8px 0}.label{font-weight:bold}</style></head>
            <body><div class="receipt"><h2>Medical Exam Room Pro</h2><h3>Payment Receipt</h3><p>${transactionId}</p>
            <div class="row"><span class="label">Date:</span><span>${payment.completedAt ? new Date(payment.completedAt).toLocaleString() : 'Pending'}</span></div>
            <div class="row"><span class="label">Amount:</span><span>KES ${Number(payment.amount).toFixed(2)}</span></div>
            <div class="row"><span class="label">Plan:</span><span>${String(payment.plan).toUpperCase()}</span></div>
            <div class="row"><span class="label">Devices:</span><span>${deviceCount}</span></div>
            <div class="row"><span class="label">Phone:</span><span>${this.formatPhoneDisplay(payment.phoneNumber)}</span></div>
            <div class="row"><span class="label">M-Pesa Receipt:</span><span>${payment.mpesaReceipt || 'N/A'}</span></div>
            <div class="row"><span class="label">Status:</span><span style="color:green;font-weight:bold">${payment.status.toUpperCase()}</span></div>
            <p>Thank you for your payment!</p></div></body></html>
        `;
        const win = window.open('', '_blank');
        win.document.write(printContent);
        win.document.close();
        win.print();
    }

    // ============================================================
    // 8. LEGACY / HELPER METHODS
    // ============================================================
    validatePaymentData(data) {
        const errors = [];
        if (!data.phoneNumber) {
            errors.push('Phone number is required');
        } else if (!this.validatePhoneNumber(data.phoneNumber)) {
            errors.push('Valid Kenyan phone number is required (format: 0712345678)');
        }
        const planId = data.planId || data.plan;
        if (!planId) {
            errors.push('Subscription plan is required');
        }
        if (planId === 'custom') {
            if (!data.amount || data.amount < 50) {
                errors.push('Amount must be at least KES 50');
            }
            if (data.amount > 150000) {
                errors.push('Amount cannot exceed KES 150,000');
            }
        }
        return { isValid: errors.length === 0, errors };
    }

    async recordManualPayment() {
        console.warn('[Payment] recordManualPayment is deprecated; use claimManualPayment');
        return { success: false, message: 'Use claimManualPayment instead' };
    }

    async processRefund() {
        console.warn('[Payment] Refunds not implemented');
        return { success: false, message: 'Refunds not supported yet' };
    }

    getPaymentMethods() {
        return [
            { id: 'mpesa', name: 'M-Pesa', description: 'Mobile money payment', icon: '💰', available: true },
            { id: 'cash',  name: 'Cash',   description: 'Manual cash payment (Buy Goods Till)', icon: '💵', available: true },
        ];
    }

    async getPlanDetails(planId) {
        try {
            const plans = await subscription.getSubscriptionPlans();
            return plans.find((p) => p.id === planId) || null;
        } catch {
            return null;
        }
    }

    calculateTaxAndFees(amount) {
        const vatRate = 0.16;
        const vat = amount * vatRate;
        return {
            subtotal: amount,
            vat,
            vatRate,
            total: amount + vat,
            currency: 'KES',
            breakdown: [
                { name: 'Subscription', amount },
                { name: 'VAT (16%)', amount: vat },
            ],
        };
    }

    clearPaymentData() {
        this.paymentStatus = {};
        this.paymentHistory = [];
        localStorage.removeItem('payment_history');
        console.log('[Payment] Data cleared');
        return true;
    }

    getPaymentHistory(limit = 20) {
        return this.paymentHistory
            .sort((a, b) => new Date(b.initiatedAt) - new Date(a.initiatedAt))
            .slice(0, limit);
    }

    getPaymentSummary() {
        const total = this.paymentHistory.length;
        const completed = this.paymentHistory.filter((p) => p.status === 'completed').length;
        const pending = this.paymentHistory.filter((p) => p.status === 'pending').length;
        const failed = this.paymentHistory.filter(
            (p) => p.status === 'failed' || p.status === 'expired'
        ).length;
        const totalAmount = this.paymentHistory
            .filter((p) => p.status === 'completed')
            .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
        return {
            total,
            completed,
            pending,
            failed,
            totalAmount,
            averageAmount: completed > 0 ? totalAmount / completed : 0,
        };
    }

    handlePaymentError(error, transactionId) {
        console.error('[Payment] Error:', error);
        const msg = error.message || 'Payment failed. Please try again.';
        if (transactionId && this.paymentStatus[transactionId]) {
            this.paymentStatus[transactionId].status = 'failed';
            this.paymentStatus[transactionId].error = msg;
        }
        ui.showToast(msg, 'error');
        return msg;
    }
}

// ==================== GLOBAL INSTANCE ====================
const Payment = new PaymentManager();

// ==================== EXPORTED WRAPPERS ====================

/**
 * Initiate M‑Pesa payment using the currently selected plan.
 *
 * @param {string} phoneNumber    – M‑Pesa number (raw; will be normalized)
 * @param {string} [planId]       – plan identifier (defaults to selected plan's id)
 * @param {number} [devicesOverride] – 1 or 2 (overrides the plan's device count)
 * @returns {Promise<{success:boolean, transactionId:string, paymentId:string}>}
 */
export async function initiateMPesaPayment(phoneNumber, planId, devicesOverride) {
    const plan = getSelectedPlan();
    if (!plan) {
        throw new Error('No plan selected. Please go back and choose a plan.');
    }

    const effectivePlanId = planId || plan.id || 'monthly';
    const amount = plan.price;
    const deviceCount = Math.max(
        1,
        Math.min(devicesOverride ?? plan.devices ?? 1, 2)
    );

    if (!amount || amount <= 0) {
        throw new Error('Invalid plan amount');
    }

    const paymentData = {
        phoneNumber,
        planId: effectivePlanId,
        plan: effectivePlanId, // legacy alias
        amount,
        deviceCount,
        planName: plan.name || effectivePlanId,
        durationText: plan.durationText || null,
        description: `Subscription: ${effectivePlanId} (${deviceCount} device${
            deviceCount > 1 ? 's' : ''
        })`,
    };

    const result = await Payment.initiateMpesaPayment(paymentData);
    return {
        success: result.success,
        transactionId: result.transactionId,
        paymentId: result.paymentId,
    };
}

/**
 * Check payment status (wrapper that returns just the status string).
 */
export async function checkPaymentStatus(transactionId) {
    const result = await Payment.checkPaymentStatus(transactionId);
    if (result.success) return result.status;
    return 'failed';
}

// Export the poll method for HTML use
export const pollPaymentStatus = Payment.pollPaymentStatus.bind(Payment);

// Expose Payment globally for window usage
window.Payment = Payment;