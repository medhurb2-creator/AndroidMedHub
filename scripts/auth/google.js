// scripts/auth/google.js

/**
 * Environment-aware Google Sign-In dispatcher.
 * Delegates to google-web.js on the browser and google-native.js on Capacitor.
 */

import * as web from './google-web.js';

const isNative = typeof window !== 'undefined' &&
    !!window.Capacitor &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();

let native = null;
async function loadNative() {
    if (native) return native;
    native = await import('./google-native.js');
    return native;
}

export const GOOGLE_WEB_CLIENT_ID = web.GOOGLE_WEB_CLIENT_ID;

export async function initGoogleSignIn(opts) {
    if (isNative) {
        const n = await loadNative();
        await n.initGoogleSignInNative();
        await n.renderGoogleButtonNative(opts);
        return;
    }
    // Web: existing GIS flow
    return web.initGoogleSignIn(opts);
}

export async function disableGoogleAutoSelect() {
    if (isNative) {
        const n = await loadNative();
        return n.disableGoogleAutoSelectNative();
    }
    return web.disableGoogleAutoSelect?.();
}

export function promptGoogleOneTap() {
    if (isNative) return;   // N/A on native
    return web.promptGoogleOneTap?.();
}

export function cancelGoogleSignIn() {
    if (isNative) return;
    return web.cancelGoogleSignIn?.();
}

export function isGisReady() {
    if (isNative) return true;
    return web.isGisReady?.() ?? false;
}