// scripts/auth/google-native.js

/**
 * Native Google Sign-In adapter for Capacitor (Android / iOS).
 *
 * Uses @capgo/capacitor-social-login (a maintained fork of the archived
 * @codetrix-studio/capacitor-google-auth). Returns an idToken from Google's
 * native SDK — a standard JWT that the Convex backend verifies identically
 * to the web GIS flow.
 *
 * The logo is Google's official "G" mark, sourced from Google's
 * signin-assets.zip. Files are served from /public/assets/icons/ by Vite:
 *   /assets/icons/google-g.svg        → light
 *   /assets/icons/google-g-dark.svg   → dark
 */

let plugin = null;

async function loadPlugin() {
    if (plugin) return plugin;
    try {
        const mod = await import('@capgo/capacitor-social-login');
        plugin = mod.SocialLogin;
        return plugin;
    } catch (e) {
        console.error('[Google Native] Plugin not available:', e);
        return null;
    }
}

// ============================================================
// STYLES — matching Google's official button spec
// ============================================================

const STYLE_ID = 'medvix-google-native-btn-styles';

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .google-native-btn-wrap {
            display: flex;
            justify-content: center;
            align-items: center;
            width: 100%;
            margin: 0.5rem 0;
        }

        .google-native-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 12px;

            min-height: 40px;
            padding: 0 16px;
            width: 100%;
            max-width: 400px;

            border: 1px solid #dadce0;
            border-radius: 4px;
            background: #ffffff;
            color: #3c4043;

            font-family: 'Roboto', -apple-system, BlinkMacSystemFont,
                         'Segoe UI', Arial, sans-serif;
            font-size: 14px;
            font-weight: 500;
            line-height: 1;
            letter-spacing: 0.25px;

            cursor: pointer;
            user-select: none;
            -webkit-tap-highlight-color: transparent;
            transition: background-color 0.15s ease,
                        border-color 0.15s ease,
                        box-shadow 0.15s ease;
        }

        .google-native-btn__logo {
            flex: 0 0 auto;
            width: 18px;
            height: 18px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .google-native-btn__logo img {
            width: 18px;
            height: 18px;
            display: block;
            object-fit: contain;
        }

        .google-native-btn__label {
            flex: 0 1 auto;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .google-native-btn:hover {
            background: #f8f9fa;
            border-color: #d2d5da;
        }

        .google-native-btn:focus-visible {
            outline: none;
            border-color: #4285f4;
            box-shadow: 0 0 0 3px rgba(66, 133, 244, 0.25);
        }

        .google-native-btn:active {
            background: #f1f3f4;
        }

        .google-native-btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }

        .google-native-btn__spinner {
            width: 18px;
            height: 18px;
            border: 2px solid #dadce0;
            border-top-color: #4285f4;
            border-radius: 50%;
            animation: google-native-spin 0.7s linear infinite;
            flex: 0 0 auto;
        }
        @keyframes google-native-spin {
            to { transform: rotate(360deg); }
        }

        html.dark-theme .google-native-btn,
        body.dark-theme .google-native-btn,
        .dark-theme .google-native-btn {
            background: #131314;
            color: #e3e3e3;
            border-color: #5f6368;
        }
        html.dark-theme .google-native-btn:hover,
        body.dark-theme .google-native-btn:hover,
        .dark-theme .google-native-btn:hover {
            background: #1f1f1f;
            border-color: #80868b;
        }
        html.dark-theme .google-native-btn:active,
        body.dark-theme .google-native-btn:active,
        .dark-theme .google-native-btn:active {
            background: #2a2a2a;
        }
        html.dark-theme .google-native-btn__spinner,
        body.dark-theme .google-native-btn__spinner,
        .dark-theme .google-native-btn__spinner {
            border-color: #5f6368;
            border-top-color: #8ab4f8;
        }
    `;
    document.head.appendChild(style);
}

// ============================================================
// LOGO — Google's official "G" mark
// ============================================================

const GOOGLE_G_HTML = `
<picture class="google-native-btn__logo">
    <source
        srcset="/assets/icons/google-g-dark.svg"
        media="(prefers-color-scheme: dark)"
    />
    <img
        src="/assets/icons/google-g.svg"
        alt=""
        width="18"
        height="18"
        aria-hidden="true"
        focusable="false"
    />
</picture>
`;

// ============================================================
// PUBLIC API
// ============================================================

let initialized = false;

/**
 * Initialise the native Google Auth plugin.
 * Safe to call multiple times — subsequent calls are no-ops.
 *
 * NOTE: @capgo/capacitor-social-login requires a Web Client ID across
 * all platforms. The Android OAuth client is registered in Google Cloud
 * Console for verification, but its ID is never referenced here.
 */
export async function initGoogleSignInNative() {
    if (initialized) return;

    const SocialLogin = await loadPlugin();
    if (!SocialLogin) {
        throw new Error('Native Google Sign-In plugin not installed.');
    }

    try {
        await SocialLogin.initialize({
            google: {
                webClientId: '811569563531-s9dhe1v0jvgdo0ii48ce7h933l07pq9k.apps.googleusercontent.com',
                // iOSClientId: '...'  ← add this when you build iOS
                mode: 'offline',      // replaces the old grantOfflineAccess: true
            },
        });
        initialized = true;
        console.log('[Google Native] Initialised.');
    } catch (e) {
        console.warn('[Google Native] Initialise failed:', e);
    }
}

/**
 * Render a native-styled Google Sign-In button into the given container.
 *
 * @param {Object}   opts
 * @param {HTMLElement} opts.container
 * @param {'continue_with'|'signin_with'|'signup_with'} [opts.text]
 * @param {Function} opts.onCredential - receives { credential: idToken }
 */
export async function renderGoogleButtonNative({
    container,
    text = 'continue_with',
    onCredential,
}) {
    if (!container) {
        console.warn('[Google Native] No container provided');
        return;
    }

    injectStyles();

    const labelMap = {
        continue_with: 'Continue with Google',
        signin_with:   'Sign in with Google',
        signup_with:   'Sign up with Google',
    };
    const label = labelMap[text] || labelMap.continue_with;

    container.innerHTML = `
        <div class="google-native-btn-wrap">
            <button type="button"
                    class="google-native-btn"
                    aria-label="${label}">
                ${GOOGLE_G_HTML}
                <span class="google-native-btn__label">${label}</span>
            </button>
        </div>
    `;

    const button = container.querySelector('.google-native-btn');
    if (!button) return;

    let inFlight = false;

    button.addEventListener('click', async () => {
        if (inFlight) return;
        inFlight = true;

        const originalHTML = button.innerHTML;
        button.disabled = true;
        button.innerHTML = `
            <span class="google-native-btn__spinner" aria-hidden="true"></span>
            <span class="google-native-btn__label">Signing in…</span>
        `;

        try {
            // Ensure the plugin is initialised on first use
            await initGoogleSignInNative();

            const SocialLogin = await loadPlugin();
            if (!SocialLogin) {
                throw new Error('Native Google Sign-In plugin not installed.');
            }

            // New API: SocialLogin.login({ provider: 'google', options: {...} })
            const res = await SocialLogin.login({
                provider: 'google',
                options: {
                    scopes: ['email', 'profile'],
                    forceRefreshToken: false,
                },
            });

            // The shape returned by @capgo/capacitor-social-login:
            //   { provider: 'google', result: { idToken, accessToken, profile } }
            const idToken =
                res?.result?.idToken ||
                res?.result?.authentication?.idToken ||   // defensive
                res?.idToken;                             // defensive

            if (!idToken) {
                console.error('[Google Native] No idToken in sign-in response', res);
                throw new Error('Google did not return an ID token.');
            }

            onCredential({ credential: idToken });
        } catch (err) {
            // Swallow user-cancelled sign-ins (code 12501 on Android)
            const code = err?.code || err?.errorCode;
            const msg = err?.message || '';
            if (
                code === '12501' ||
                code === 12501 ||
                /cancel/i.test(msg) ||
                /dismissed/i.test(msg)
            ) {
                console.log('[Google Native] User cancelled sign-in.');
            } else {
                console.warn('[Google Native] signIn failed:', err);
            }
        } finally {
            button.disabled = false;
            button.innerHTML = originalHTML;
            inFlight = false;
        }
    });
}

/**
 * Sign out from Google (clears the cached account on the device).
 */
export async function disableGoogleAutoSelectNative() {
    const SocialLogin = await loadPlugin();
    if (!SocialLogin) return;
    try {
        await SocialLogin.logout({ provider: 'google' });
    } catch (e) {
        // ignore
    }
}