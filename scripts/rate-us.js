// scripts/rate-us.js
// MedVix — Google Play In-App Review service with 45-day cooldown
//
// Wraps the native MedvixReviewPlugin (registered in MainActivity).
// The native side is authoritative: it has its own 45-day gate and
// stamps its SharedPreferences timestamp only after the Play review
// flow actually launched. This module adds a cheap JS-side pre-filter
// and mirrors the cooldown into localStorage so subsequent launches
// skip the native round-trip.
//
// Contract:
//   requestAppReview()          → respects both JS and native cooldown.
//   requestAppReview(true)      → skips the JS pre-filter only.
//                                 Native cooldown still applies.
//
// Resolution shape:
//   { success: true }                                  — Play accepted the
//                                                        request and the
//                                                        cooldown was
//                                                        stamped.
//   { success: false, reason: 'unsupported' }          — not native, or
//                                                        plugin missing.
//   { success: false, reason: 'cooldown_active' }      — 45-day gate
//                                                        (JS or native).
//   { success: false, reason: 'in_flight' }            — another call
//                                                        already running.
//   { success: false, reason: 'activity_unavailable' } — Activity is
//                                                        finishing /
//                                                        destroyed.
//   { success: false, reason: 'native_failed',
//     detail: <string> }                               — Play Core
//                                                        failed after
//                                                        retries; cooldown
//                                                        NOT stamped.

const PLUGIN_NAME = 'Review';
const PREF_KEY = 'medvix_last_review_request';
const COOLDOWN_PERIOD_MS = 45 * 24 * 60 * 60 * 1000; // 45 days

// Guard against concurrent calls from rapid double-taps. The native
// side would dedupe anyway (the second call sees the cooldown the
// first just stamped and rejects with "cooldown active"), but that
// produces a confusing failure toast. Blocking client-side is cleaner.
let IN_FLIGHT = false;

function plugin() {
    const C = typeof window !== 'undefined' ? window.Capacitor : null;
    if (!C) return null;
    if (typeof C.isNativePlatform === 'function' && !C.isNativePlatform()) return null;
    if (typeof C.isPluginAvailable === 'function' && !C.isPluginAvailable(PLUGIN_NAME)) return null;

    if (typeof C.registerPlugin === 'function') {
        return C.registerPlugin(PLUGIN_NAME);
    } else if (C.Plugins && C.Plugins[PLUGIN_NAME]) {
        return C.Plugins[PLUGIN_NAME];
    }
    return null;
}

export async function requestAppReview(force = false) {
    const p = plugin();
    if (!p) {
        console.log('[RateUs] In-app review plugin not available (non-native or unsupported)');
        return { success: false, reason: 'unsupported' };
    }

    // ── JS-side pre-filter ──────────────────────────────────────────
    //
    // Cheap check that avoids a native round-trip when the user is
    // clearly inside the cooldown. Not authoritative — native enforces
    // its own gate and will reject even when this passes (e.g. after
    // localStorage was cleared but native prefs survived). We just
    // want the common case to short-circuit here.
    //
    // force=true skips this check but NOT the native one. Play's own
    // quota prevents spamming regardless, and we deliberately do not
    // let a JS-side flag override the native 45-day gate.
    if (!force) {
        const lastRequestTime = Number(localStorage.getItem(PREF_KEY) || 0);
        if (Date.now() - lastRequestTime < COOLDOWN_PERIOD_MS) {
            console.log('[RateUs] Skipped: JS cooldown active.');
            return { success: false, reason: 'cooldown_active' };
        }
    }

    if (IN_FLIGHT) {
        console.log('[RateUs] Skipped: request already in flight.');
        return { success: false, reason: 'in_flight' };
    }

    IN_FLIGHT = true;
    try {
        const result = await p.requestReview();

        // Native resolved → Play accepted the request, the sheet was
        // launched, and the native cooldown has been stamped. Mirror
        // the timestamp locally so subsequent launches skip the
        // native round-trip. We use Date.now() here (not the moment
        // we started) — the sheet may have been up for a while, and
        // we want the cooldown clock to start from when the flow
        // actually finished.
        localStorage.setItem(PREF_KEY, String(Date.now()));

        console.log('[RateUs] Review flow completed successfully', result);
        return { success: true, ...(result || {}) };
    } catch (e) {
        const msg = (e && e.message) || String(e) || '';

        // Native rejected because its own 45-day gate is still
        // running. This happens when JS was eligible (force=true, or
        // localStorage was cleared/wiped) but the native prefs were
        // not. Native is authoritative — report as cooldown, not as
        // an error.
        if (/cooldown active/i.test(msg)) {
            console.log('[RateUs] Native cooldown active.');
            return { success: false, reason: 'cooldown_active' };
        }

        // Native rejected because the Activity is finishing or
        // destroyed. Typically a race during navigation/teardown —
        // not worth surfacing to the user.
        if (/activity not available/i.test(msg)) {
            console.warn('[RateUs] Activity unavailable for review.');
            return { success: false, reason: 'activity_unavailable' };
        }

        // "Review flow failed: <reason>" — Play Core exhausted its
        // in-session retries. The native cooldown was NOT stamped, so
        // the next launch is still eligible. We do NOT write a
        // localStorage timestamp here either.
        console.warn('[RateUs] Native review flow failed:', msg);
        return { success: false, reason: 'native_failed', detail: msg };
    } finally {
        IN_FLIGHT = false;
    }
}