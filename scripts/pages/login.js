// scripts/pages/login.js
import * as auth from '../auth.js';
import * as ui from '../ui.js';
import * as router from '../router.js';
import * as redirect from '../redirect.js';
import * as validation from '../validation.js';
import * as security from '../security.js';
import * as utils from '../utils.js';
import { initGoogleSignIn, disableGoogleAutoSelect } from '../auth/google.js';

export async function init(context) {
    ui.applyTheme();

    // ── Redirect context ─────────────────────────────────────────
    // The redirect module owns the source of truth: it reads the
    // URL's ?returnTo= / ?redirect= first, then falls back to the
    // top of the return stack (so the context survives navigations
    // through intermediate pages like forgot-password).
    const redirectCtx = redirect.readRedirectContext();
    const redirectTarget = redirectCtx.returnTo || null;

    // If already authenticated → resolve any pending chain, else
    // land on the default.
    if (auth.checkAuth()) {
        redirect.consumeAndReturn('subjects');
        return;
    }

    // ---- DOM refs ----
    const $ = (sel) => context.root.querySelector(sel);

    const loginForm = $('#login-form');
    const emailInput = $('#email');
    const passwordInput = $('#password');
    const toggleBtn = $('#togglePassword');
    const rememberCheck = $('#remember');
    const forgotBtn = $('#forgotBtn');
    const signupBtn = $('#signupBtn');
    const backBtn = $('#backBtn');
    const themeToggle = $('#themeToggle');
    const googleContainer = $('#google-login-container');

    // ---- Live validation ----
    validation.setupLiveValidation('login-form', {
        email: { required: true, email: true },
        password: { required: true, min: 8 }
    });

    // ---- Remembered email ----
    const rememberedEmail = utils.getLocalStorage('rememberedEmail');
    if (rememberedEmail && emailInput) {
        emailInput.value = rememberedEmail;
        if (rememberCheck) rememberCheck.checked = true;
    }

    // ---- Theme toggle ----
    if (themeToggle) {
        themeToggle.addEventListener('click', () => ui.toggleTheme());
    }

    // ---- Toggle password visibility ----
    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            ui.togglePasswordVisibility('password');
        });
    }

    // ---- Forgot password ----
    // Propagate the redirect context as a URL param so it survives
    // even if the user later lands back on /login via a fresh
    // navigation (not via the SPA history). The stack remains the
    // primary source; this is belt-and-braces.
    if (forgotBtn) {
        forgotBtn.addEventListener('click', () => {
            let url = 'forgot-password';
            if (redirectTarget) {
                url += `?redirect=${encodeURIComponent(redirectTarget)}`;
                if (redirectCtx.reason) {
                    url += `&redirect_reason=${encodeURIComponent(redirectCtx.reason)}`;
                }
            }
            router.navigateTo(url);
        });
    }

    // ---- Signup ----
    if (signupBtn) {
        signupBtn.addEventListener('click', () => {
            let url = 'signup';
            if (redirectTarget) {
                url += `?redirect=${encodeURIComponent(redirectTarget)}`;
                if (redirectCtx.reason) {
                    url += `&redirect_reason=${encodeURIComponent(redirectCtx.reason)}`;
                }
            }
            router.navigateTo(url);
        });
    }

    // ---- Back ----
    // Explicit abandonment of the login flow: go to welcome. The
    // return chain is left intact in case the user comes back — a
    // subsequent arrival at /login will recover the context from
    // the stack.
    if (backBtn) {
        backBtn.addEventListener('click', () => router.navigateTo('welcome'));
    }

    // ============================================================
    // GOOGLE SIGN-IN
    // ============================================================
    if (googleContainer) {
        await initGoogleSignIn({
            container: googleContainer,
            text: 'continue_with',
            onCredential: async (response) => {
                await handleGoogleCredential(response.credential);
            },
        });
    }

    // ============================================================
    // PASSWORD LOGIN
    // ============================================================
    if (loginForm) {
        loginForm.addEventListener('submit', async (event) => {
            event.preventDefault();

            const email = emailInput.value.trim();
            const password = passwordInput.value;
            const remember = rememberCheck ? rememberCheck.checked : false;

            if (!validation.validateEmail(email) && !validation.validatePhone(email)) {
                ui.showToast('Enter a valid email or Kenyan phone', 'error');
                return;
            }
            if (!validation.validatePassword(password)) {
                ui.showToast('Password must be 8+ chars with upper, lower, number', 'error');
                return;
            }

            ui.showLoading();
            try {
                await auth.login(email, password);

                if (remember) utils.setLocalStorage('rememberedEmail', email);
                else utils.removeLocalStorage('rememberedEmail');

                ui.hideLoading();
                ui.showToast('Login successful!', 'success');

                // Pop the return stack — lands the user on the page
                // that gated them here (exam-room, ai, notes, ...).
                // Falls through to `subjects` when no chain exists.
                redirect.consumeAndReturn('subjects');
            } catch (error) {
                ui.hideLoading();

                // ---- DEVICE LIMIT REACHED (blocking modal, two variants) ----
                if (error.code === 'DEVICE_LIMIT_REACHED') {
                    openDeviceLimitModal(error.deviceLimitPayload, { redirectTarget });
                    return;
                }

                // ---- Account locked by security policy ----
                if (error.code === 'ACCOUNT_LOCKED') {
                    ui.showToast(error.message || 'Account locked.', 'error');
                    router.navigateTo('locked?reason=time_manipulation');
                    return;
                }

                ui.showToast(error.message || 'Login failed', 'error');
            }
        });
    }

    // ============================================================
    // GOOGLE CREDENTIAL HANDLER
    // ============================================================
    async function handleGoogleCredential(idToken) {
        ui.showLoading('Signing in with Google…');

        try {
            const result = await auth.loginWithGoogle(idToken);

            if (result.requiresLink) {
                ui.hideLoading();
                openGoogleLinkModal({
                    email: result.email,
                    linkToken: result.linkToken,
                    idToken,
                    deviceId: result.deviceId,
                    deviceInfo: result.deviceInfo,
                });
                return;
            }

            ui.hideLoading();
            ui.showToast(
                result.isNewUser ? 'Account created — welcome!' : 'Signed in with Google',
                'success'
            );

            redirect.consumeAndReturn('subjects');
        } catch (err) {
            ui.hideLoading();

            // ---- DEVICE LIMIT REACHED (from Google login) ----
            if (err.code === 'DEVICE_LIMIT_REACHED') {
                openDeviceLimitModal(err.deviceLimitPayload, { redirectTarget });
                return;
            }

            ui.showToast(err.message || 'Google sign-in failed', 'error');
        }
    }

    // ============================================================
    // DEVICE LIMIT MODAL
    // ------------------------------------------------------------
    // Shown when login() or loginWithGoogle() returns
    // DEVICE_LIMIT_REACHED.
    //
    // Two variants based on the user's active subscription:
    //
    //   • maxDevices === 1  → single-device plan at limit
    //       Offer BOTH paths:
    //         A) Remove the currently-signed-in device below
    //         B) Upgrade to the 2-device plan
    //
    //   • maxDevices >= 2   → multi-device plan at limit
    //       Offer ONLY the remove path (upgrading wouldn't help —
    //       they're already at the platform maximum)
    //
    // maxDevices and platformMax both come from the backend payload
    // / cached appConfig; never hardcoded.
    // ============================================================
    function openDeviceLimitModal(payload, { redirectTarget: redir }) {
        const { devices, maxDevices, devicesUsed, switchToken } = payload || {};

        if (!switchToken || !Array.isArray(devices)) {
            ui.showToast('Device limit reached but response was incomplete.', 'error');
            return;
        }

        const modal = $('#device-limit-modal');
        if (!modal) {
            ui.showToast(
                `You're already signed in on ${maxDevices} device(s). Remove one from Settings → Devices to continue.`,
                'warning',
                8000
            );
            return;
        }

        const titleEl = $('#device-limit-title');
        const messageEl = $('#device-limit-message');
        const listEl = $('#device-limit-list');
        const upgradeSection = $('#device-limit-upgrade-section');
        const upgradeBtn = $('#device-limit-upgrade');

        const max = maxDevices ?? 1;
        const used = devicesUsed ?? devices.length;

        // Platform maximum — never hardcode. Backend can send it,
        // or fall back to the cached appConfig.
        const platformMax =
            payload?.platformMaxDevices ??
            utils.getLocalStorage('appConfig', null)?.maxDevicesPerSubscription ??
            2;

        // ========================================================
        // VARIANT A: 1-device plan at limit → Remove OR Upgrade
        // ========================================================
        if (max === 1) {
            if (titleEl) titleEl.textContent = 'Device limit reached';

            if (messageEl) {
                messageEl.innerHTML = `
                    <p>Your plan supports <strong>1 device</strong>, and you're
                       already signed in on it.</p>
                    <p>To use this device too, you can either:</p>
                    <ul class="device-limit-options">
                        <li><strong>Remove</strong> the currently-signed-in device below, or</li>
                        <li><strong>Upgrade</strong> to the 2-device plan.</li>
                    </ul>
                `;
            }

            renderDeviceList(listEl, devices);

            // Show the upgrade path.
            //
            // Plain navigation — NOT navigateWithReturn. The user is
            // already authenticated at this point; the stack still
            // holds the ORIGINAL destination (e.g. /exam-room). The
            // subscription → payment chain will pop that entry when
            // payment succeeds, landing the user back on their
            // original page. Pushing /login here would break that.
            if (upgradeSection) upgradeSection.style.display = '';
            if (upgradeBtn) {
                upgradeBtn.onclick = () => {
                    modal.style.display = 'none';
                    const params = new URLSearchParams();
                    params.set('highlight', 'two-device');
                    // Preserve the returnTo param as a fallback in
                    // case sessionStorage was cleared between the
                    // login page and this navigation.
                    if (redir) params.set('redirect', redir);
                    router.navigateTo(`subscription?${params.toString()}`);
                };
            }
        }
        // ========================================================
        // VARIANT B: 2-device plan at limit → Remove only
        // ========================================================
        else {
            if (titleEl) titleEl.textContent = 'Device limit reached';

            if (messageEl) {
                messageEl.innerHTML = `
                    <p>You're signed in on <strong>${used}</strong> of
                       <strong>${max}</strong> allowed devices —
                       which is your plan's maximum.</p>
                    <p>Remove one of the devices below to continue on this device.</p>
                `;
            }

            renderDeviceList(listEl, devices);

            // No upgrade path — they're at max
            if (upgradeSection) upgradeSection.style.display = 'none';
        }

        modal.style.display = 'flex';

        // Cancel/close hidden — user must pick a valid action
        const cancelBtn = $('#device-limit-cancel');
        const closeBtn = $('#device-limit-close');
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (closeBtn) closeBtn.style.display = 'none';

        // Attach remove handlers
        if (listEl) {
            listEl.querySelectorAll('.btn-remove-device').forEach((btn) => {
                btn.addEventListener('click', async () => {
                    const deviceToRemoveId = btn.getAttribute('data-device-id');
                    if (!deviceToRemoveId) return;

                    btn.disabled = true;
                    btn.textContent = 'Removing…';

                    try {
                        await auth.removeDeviceAndContinue(switchToken, deviceToRemoveId);

                        modal.style.display = 'none';
                        ui.showToast('Device removed. You are now signed in here.', 'success');

                        // Authentication has succeeded. Pop the return
                        // stack and land the user on whatever gated
                        // page originally sent them to /login. Falls
                        // back to `subjects` when no chain exists.
                        redirect.consumeAndReturn('subjects');
                    } catch (err) {
                        ui.showToast(err.message || 'Could not remove device', 'error');
                        btn.disabled = false;
                        btn.textContent = 'Remove';
                    }
                });
            });
        }
    }

    // ------------------------------------------------------------
    // Shared renderer for the device list
    // ------------------------------------------------------------
    function renderDeviceList(listEl, devices) {
        if (!listEl) return;

        listEl.innerHTML = (devices || [])
            .map((d) => {
                const name = d.deviceName || d.deviceId || 'Unknown device';
                const platform = d.platform || 'unknown';
                const lastSeen = formatRelativeTime(d.lastSeen);
                const current = d.isCurrent
                    ? '<span class="device-current">This device</span>'
                    : '';
                const removeBtn = d.isCurrent
                    ? '<span class="device-current-note">Currently signing in here</span>'
                    : `<button class="btn-outline btn-remove-device" data-device-id="${escapeHtml(d.deviceId)}">Remove</button>`;

                return `
                    <li class="device-limit-item">
                        <div class="device-limit-info">
                            <div class="device-limit-name">${escapeHtml(name)} ${current}</div>
                            <div class="device-limit-meta">${escapeHtml(platform)} · ${lastSeen}</div>
                        </div>
                        <div class="device-limit-actions">${removeBtn}</div>
                    </li>
                `;
            })
            .join('');
    }

    // ============================================================
    // ACCOUNT LINKING MODAL
    // ------------------------------------------------------------
    // Shown when loginWithGoogle() returns requiresLink: true.
    // The user must enter their existing account password to prove
    // ownership, and the backend links the Google identity to it.
    // ============================================================
    function openGoogleLinkModal({
        email: linkedEmail,
        linkToken,
        idToken,
        deviceId,
        deviceInfo,
    }) {
        const modal = $('#google-link-modal');
        const emailEl = $('#google-link-email');
        const pwdInput = $('#google-link-password');
        const submitBtn = $('#google-link-submit');
        const cancelBtn = $('#google-link-cancel');
        const closeBtn = $('#google-link-close');

        emailEl.textContent = linkedEmail;
        pwdInput.value = '';
        modal.style.display = 'flex';
        setTimeout(() => pwdInput.focus(), 100);

        const close = () => {
            modal.style.display = 'none';
            disableGoogleAutoSelect?.();
        };

        const submit = async () => {
            const pwd = pwdInput.value;
            if (!pwd) {
                ui.showFormError('google-link-password', 'Password required');
                return;
            }
            ui.clearFormError('google-link-password');

            submitBtn.disabled = true;
            submitBtn.textContent = 'Connecting…';

            try {
                await auth.linkGoogleAccount({
                    linkToken,
                    password: pwd,
                    deviceId,
                    deviceInfo,
                });

                modal.style.display = 'none';
                ui.showToast('Google connected to your account', 'success');

                // Auth succeeded — pop the return stack.
                redirect.consumeAndReturn('subjects');
            } catch (err) {
                // ---- DEVICE LIMIT REACHED during linking ----
                if (err.code === 'DEVICE_LIMIT_REACHED') {
                    modal.style.display = 'none';
                    openDeviceLimitModal(err.deviceLimitPayload, { redirectTarget });
                    return;
                }

                ui.showToast(err.message || 'Could not connect Google', 'error');
                ui.showFormError('google-link-password', err.message || 'Invalid password');
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Connect Google';
            }
        };

        submitBtn.onclick = submit;
        cancelBtn.onclick = close;
        closeBtn.onclick = close;
        pwdInput.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
        };
    }

    // ============================================================
    // HELPERS
    // ============================================================
    function formatRelativeTime(ts) {
        if (!ts) return 'never';
        const diff = Date.now() - ts;
        const min = Math.floor(diff / 60000);
        if (min < 1) return 'active now';
        if (min < 60) return `${min}m ago`;
        const hr = Math.floor(min / 60);
        if (hr < 24) return `${hr}h ago`;
        const day = Math.floor(hr / 24);
        if (day < 7) return `${day}d ago`;
        const wk = Math.floor(day / 7);
        if (wk < 5) return `${wk}w ago`;
        const mo = Math.floor(day / 30);
        return `${mo}mo ago`;
    }

    function escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ── Snapshot drain ───────────────────────────────────────────
    // Login doesn't register a state adapter and normally has no
    // snapshot of its own — this call is a no-op in the common case.
    // It exists so that if a stale snapshot under /login is ever
    // left behind (e.g. by an unusual multi-redirect sequence), it
    // is cleaned up rather than accumulating in sessionStorage.
    //
    // NOTE: deliberately NO self-consume here. Login is a resolver,
    // not a target: the stack entry that got the user here must
    // survive until authentication succeeds, because that entry is
    // what consumeAndReturn() pops to send the user home.
    redirect.consumeSnapshot();

    console.log('[Login] Initialized.');
}

export function destroy() {
    // Nothing to clean up beyond what the page-manager handles.
}