// scripts/auth/google.js

/**
 * Environment-aware Google Sign-In dispatcher.
 *
 * Web:
 *   -> google-web.js
 *
 * Capacitor:
 *   -> google-native.js
 *
 * Both adapters are statically imported so Vite/Rollup
 * can resolve their actual source locations correctly.
 */

import * as web from './google-web.js';
import * as native from './google-native.js';

/**
 * Detect whether the app is currently running
 * inside a native Capacitor platform.
 */
function isNativePlatform() {
    return (
        typeof window !== 'undefined' &&
        !!window.Capacitor &&
        typeof window.Capacitor.isNativePlatform === 'function' &&
        window.Capacitor.isNativePlatform()
    );
}

/**
 * Web Google OAuth client ID.
 * Kept available for existing consumers.
 */
export const GOOGLE_WEB_CLIENT_ID = web.GOOGLE_WEB_CLIENT_ID;

/**
 * Initialize Google Sign-In.
 *
 * Web:
 *   Uses Google Identity Services.
 *
 * Native:
 *   Uses Capacitor Social Login.
 */
export async function initGoogleSignIn(opts) {
    if (isNativePlatform()) {
        await native.initGoogleSignInNative();
        await native.renderGoogleButtonNative(opts);
        return;
    }

    return web.initGoogleSignIn(opts);
}

/**
 * Disable Google automatic sign-in/select.
 */
export async function disableGoogleAutoSelect() {
    if (isNativePlatform()) {
        return native.disableGoogleAutoSelectNative();
    }

    return web.disableGoogleAutoSelect?.();
}

/**
 * Trigger Google One Tap.
 *
 * One Tap is only applicable to the web implementation.
 */
export function promptGoogleOneTap() {
    if (isNativePlatform()) {
        return;
    }

    return web.promptGoogleOneTap?.();
}

/**
 * Cancel the active web Google Sign-In flow.
 *
 * Native Google Sign-In manages its own native UI.
 */
export function cancelGoogleSignIn() {
    if (isNativePlatform()) {
        return;
    }

    return web.cancelGoogleSignIn?.();
}

/**
 * Check whether Google Identity Services is ready.
 *
 * Native is considered ready because the native adapter
 * handles its own initialization.
 */
export function isGisReady() {
    if (isNativePlatform()) {
        return true;
    }

    return web.isGisReady?.() ?? false;
}
