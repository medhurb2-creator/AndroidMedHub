package com.medhurb.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;

import androidx.core.view.WindowCompat;

import com.android.installreferrer.api.InstallReferrerClient;
import com.android.installreferrer.api.InstallReferrerStateListener;
import com.android.installreferrer.api.ReferrerDetails;
import com.getcapacitor.BridgeActivity;

import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    // ── Deferred deep-link storage ──────────────────────────────────
    //
    // Shared with MedvixAppPlugin.getPendingDeepLink(). The plugin reads
    // the same file name and keys, so both sides must stay in sync if
    // either is renamed.
    private static final String REFERRER_PREFS     = "medvix_deferred_links";
    private static final String KEY_PENDING_ROUTE  = "pending_route";
    private static final String KEY_REFERRER_CHECKED = "referrer_checked";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins BEFORE super.onCreate().
        //
        // Capacitor's BridgeActivity builds its plugin registry inside
        // super.onCreate(). Calling registerPlugin() after that point
        // leaves the plugin invisible to JavaScript — the native class
        // exists, but window.Capacitor.Plugins.<Name> is undefined on
        // the WebView side.
        //
        // Registered plugins:
        //
        //   App-side (scripts/app.js, security/device.js):
        //   • AppUpdatePlugin         — Google Play in-app updates.
        //   • FileOpenPlugin          — files the OS hands to the app via
        //                               the "Open with" chooser.
        //   • MedvixDevicePlugin      — device identity + metadata.
        //   • MedvixAppPlugin         — deep links, lifecycle, app info,
        //                               back-button dispatch.
        //   • MedvixOrientationPlugin — portrait lock during splash.
        //
        //   Viewer-side (scripts/viewer/native-bridge.js):
        //   • MedvixStatusBarPlugin   — immersive mode, status bar control.
        //   • MedvixKeepAwakePlugin   — screen wake lock.
        //   • MedvixSharePlugin       — text + file share sheet.
        //   • MedvixHapticsPlugin     — vibration / haptic feedback.
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(FileOpenPlugin.class);
        registerPlugin(MedvixDevicePlugin.class);
        registerPlugin(MedvixAppPlugin.class);
        registerPlugin(MedvixOrientationPlugin.class);
        registerPlugin(MedvixStatusBarPlugin.class);
        registerPlugin(MedvixKeepAwakePlugin.class);
        registerPlugin(MedvixSharePlugin.class);
        registerPlugin(MedvixHapticsPlugin.class);

        super.onCreate(savedInstanceState);

        // ── Deferred deep link (Play Install Referrer) ──────────────────
        //
        // If the user tapped an app.medvix.co.ke link, found no app, was
        // sent to Play, installed, and then tapped "Open" (or later
        // launched from the launcher), Play stores the original referrer
        // payload. We read it here on the FIRST post-install launch and
        // stash the destination in SharedPreferences for JavaScript to
        // drain via MedvixAppPlugin.getPendingDeepLink().
        //
        // The lookup is asynchronous — it returns immediately and the
        // callback fires whenever Play Services answers. Javascript polls
        // MedvixAppPlugin until the "checked" flag flips true.
        //
        // Safe to call on every cold start: the method itself short-
        // circuits once the check has succeeded, and it's a no-op on
        // warm starts (onCreate runs once per Activity instance).
        retrieveInstallReferrer();

        // ── Window layout — reserve the system bars ─────────────────────
        //
        // Android 15 (API 35) forces every app to draw edge-to-edge:
        // the WebView fills the whole screen, including the area under
        // the status bar (battery, time, network) and the navigation
        // bar. On older Android versions the theme's
        // windowTranslucentStatus controlled this; on 15+ the OS
        // overrides it and the flag is ignored.
        //
        // setDecorFitsSystemWindows(getWindow(), true) tells the OS to
        // lay out this Activity's content inside the safe area — below
        // the status bar, above the navigation bar. The WebView viewport
        // starts at the bottom edge of the status bar, so no page-level
        // content can overlap the system icons.
        //
        // This is the correct place to fix the overlap:
        //
        //   • It runs once at startup and applies to the whole WebView,
        //     so every page, every route, every transition is covered
        //     without any CSS or per-page coordination.
        //
        //   • It applies before the first paint, so the splash and the
        //     initial render are already inside the safe area — no
        //     moment of overlap, no layout shift.
        //
        //   • It also covers native UI (system dialogs the app opens,
        //     the WebView's own error pages, etc.) which CSS cannot
        //     reach.
        //
        // This must go AFTER super.onCreate(). Before that call the
        // Activity has no window yet, and setDecorFitsSystemWindows
        // would throw.
        //
        // WindowCompat.setDecorFitsSystemWindows works on every Android
        // version from API 21 through the current release. On API 30+
        // it maps to Window.setDecorFitsSystemWindows; below that it
        // maps to the corresponding system UI flags. Same effect on
        // every version.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), true);

        // ── Storage bridge ──────────────────────────────────────────────
        //
        // Expose the native file system to JavaScript as
        // window.MedVixStorage.
        //
        // MUST go AFTER super.onCreate() — bridge.getWebView() returns
        // null until Capacitor finishes building the WebView, which it
        // does inside super.onCreate().
        //
        // Why addJavascriptInterface and not a Capacitor plugin:
        //
        // The storage layer is called synchronously from JS many times
        // per file operation (write chunk, stat, rename, list, ...).
        // Capacitor's plugin protocol round-trips through the bridge
        // with per-call overhead — fine for one-off plugin methods like
        // getDeviceId(), too slow for chunked writes of a 500 MB PDF.
        //
        // addJavascriptInterface gives us a direct, synchronous method
        // table. The trade-off is that anything running in the WebView
        // can call these methods — but the WebView runs only our app's
        // JavaScript (no remote content is loaded, no eval of untrusted
        // strings), and every path is canonicalized and confined to the
        // app's own private storage directory by MedVixStorage itself.
        //
        // Nothing here hands a file to another app. Sharing/printing go
        // through MedvixSharePlugin, which writes a transient file to
        // cacheDir and hands off a one-shot FileProvider grant. The
        // content/ tree is never exposed outside the app.
        bridge.getWebView().addJavascriptInterface(
                new MedVixStorage(this),
                "MedVixStorage"
        );

        // ── Cold-start file open ────────────────────────────────────────
        //
        // If the app was launched by a file-open intent (the user tapped a
        // PDF in Files and chose MedVix), the intent arrives here before
        // the WebView has parsed. FileOpenPlugin stashes the URI for
        // viewer.js to drain via getPendingFile() once it loads.
        //
        // Safe to call unconditionally: a normal launcher tap produces an
        // intent with action MAIN, which FileOpenPlugin.extractUris()
        // filters out.
        FileOpenPlugin.deliverIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);

        // Update the activity's current intent so getIntent() reflects the
        // most recent launch. Without this, a subsequent Activity
        // recreation (rotation, process death) would re-deliver the FIRST
        // intent, which is stale by then.
        setIntent(intent);

        // ── Warm-start file open ────────────────────────────────────────
        //
        // The app is already running. If the intent carries a file URI,
        // FileOpenPlugin dispatches it immediately via notifyListeners,
        // and viewer.js's persistent 'fileOpen' handler loads it into the
        // running instance — replacing whatever document was on screen.
        FileOpenPlugin.deliverIntent(intent);

        // ── Warm-start deep link ────────────────────────────────────────
        //
        // MedvixAppPlugin.handleOnNewIntent is called automatically by
        // Capacitor's bridge (it walks every registered plugin). Nothing
        // to invoke here — the plugin fires the 'appUrlOpen' event on
        // its own, and app.js's listener dispatches the route.
    }

    /**
     * Hardware back button.
     *
     * Android calls this when the user presses back and nothing earlier
     * in the focus chain has consumed the event.
     *
     * We give MedvixAppPlugin first refusal. If a JS 'backButton'
     * listener is registered — the viewer's native-bridge.js attaches
     * one when the viewer mounts — the plugin fires the event and
     * returns true, and we consume the press. The WebView stays open,
     * and JS decides what to do: close a drawer, dismiss the search
     * bar, exit fullscreen, or navigate back in the SPA router.
     *
     * If no JS listener is registered (the user is on a page that
     * doesn't handle back), the plugin returns false and we fall
     * through to super.onBackPressed(). Android then does its default
     * thing — WebView history back if there is history, otherwise
     * finish the activity.
     *
     * Capacitor v6 does not route the back button through the plugin
     * base class, which is why this explicit dispatch exists. See
     * MedvixAppPlugin.dispatchBackButton() for the other half.
     */
    @Override
    public void onBackPressed() {
        if (MedvixAppPlugin.sInstance != null
                && MedvixAppPlugin.sInstance.dispatchBackButton()) {
            return;
        }
        super.onBackPressed();
    }

    /**
     * Required by @capgo/capacitor-social-login.
     *
     * The plugin checks at runtime that MainActivity implements
     * ModifiedMainActivityForSocialLoginPlugin before allowing Google
     * Sign-In. The method body is intentionally empty — the Credential
     * Manager API handles its own activity results internally.
     */
    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {
        // Intentionally empty — the method exists only as a marker.
    }

    // ========================================================================
    // Deferred deep-link retrieval (Play Install Referrer)
    // ========================================================================

    /**
     * Asks Google Play for the install referrer that was attached to the
     * Play Store link the user tapped to install the app.
     *
     * The website passes the original destination as the "deep_link"
     * query parameter of the referrer payload, e.g.
     *
     *   https://play.google.com/store/apps/details?id=com.medhurb.app
     *     &referrer=deep_link%3D%252Fshared-note%252F%253Ftoken%253Dabc
     *
     * Play decodes that once and hands us a string like:
     *
     *   deep_link=%2Fshared-note%2F%3Ftoken%3Dabc
     *
     * We extract, validate, and persist the destination. The lookup only
     * succeeds once per install — after that the referrer value stays
     * cached forever and would point at a stale route, so we set
     * KEY_REFERRER_CHECKED on success and never look again.
     */
    private void retrieveInstallReferrer() {
        SharedPreferences prefs = getSharedPreferences(REFERRER_PREFS, MODE_PRIVATE);

        // The initial-install referrer is only meaningful once.
        if (prefs.getBoolean(KEY_REFERRER_CHECKED, false)) {
            return;
        }

        final InstallReferrerClient client =
                InstallReferrerClient.newBuilder(this).build();

        client.startConnection(new InstallReferrerStateListener() {
            @Override
            public void onInstallReferrerSetupFinished(int responseCode) {
                try {
                    if (responseCode ==
                            InstallReferrerClient.InstallReferrerResponse.OK) {

                        ReferrerDetails details = client.getInstallReferrer();
                        String referrer = details.getInstallReferrer();

                        String destination = extractDeepLink(referrer);

                        if (destination != null) {
                            String safeRoute = validateDeferredRoute(destination);

                            if (safeRoute != null
                                    && !prefs.contains(KEY_PENDING_ROUTE)) {
                                prefs.edit()
                                        .putString(KEY_PENDING_ROUTE, safeRoute)
                                        .apply();
                            }
                        }

                        prefs.edit()
                                .putBoolean(KEY_REFERRER_CHECKED, true)
                                .apply();

                    } else if (responseCode ==
                                   InstallReferrerClient.InstallReferrerResponse.SERVICE_UNAVAILABLE
                            || responseCode ==
                                   InstallReferrerClient.InstallReferrerResponse.FEATURE_NOT_SUPPORTED) {

                        // Transient — do NOT mark as checked. Play Services
                        // is often not ready to answer at cold start on a
                        // brand-new install. The next cold launch retries,
                        // and by then it succeeds.
                        Log.w("MedVixReferrer",
                                "Install Referrer unavailable: " + responseCode);
                    }
                } catch (Exception e) {
                    Log.e("MedVixReferrer",
                            "Unable to process Install Referrer", e);
                } finally {
                    try { client.endConnection(); } catch (Exception ignored) {}
                }
            }

            @Override
            public void onInstallReferrerServiceDisconnected() {
                try { client.endConnection(); } catch (Exception ignored) {}
            }
        });
    }

    /**
     * Extracts the "deep_link" query parameter from the referrer string.
     *
     * We do not use Uri.parse() here because the referrer value we get
     * back from Play is a bare query string (no scheme, no host), and the
     * destination may itself contain characters that would confuse URI
     * parsing. Splitting on '&' and decoding manually is more robust.
     *
     * Example input:  deep_link=%2Fshared-note%2F%3Ftoken%3Dabc123
     * Example output: /shared-note/?token=abc123
     */
    private String extractDeepLink(String referrer) {
        if (referrer == null || referrer.isEmpty()) return null;

        for (String pair : referrer.split("&")) {
            int eq = pair.indexOf('=');
            if (eq <= 0) continue;

            String key = Uri.decode(pair.substring(0, eq));
            if (!"deep_link".equals(key)) continue;

            return Uri.decode(pair.substring(eq + 1));
        }
        return null;
    }

    /**
     * Validates a deferred destination before persisting it.
     *
     * Rules:
     *   • Must be a relative path starting with a single '/'.
     *   • Must not be a protocol-relative URL ('//evil.com').
     *   • Must not contain backslashes or line breaks (header-injection
     *     style attacks against downstream parsers).
     *   • Path must be one of the known share routes.
     *
     * Query parameters (e.g. ?token=...) are allowed and preserved.
     */
    private String validateDeferredRoute(String destination) {
        if (destination == null || destination.isEmpty()) return null;

        if (!destination.startsWith("/")
                || destination.startsWith("//")
                || destination.contains("\\")
                || destination.indexOf('\n') >= 0
                || destination.indexOf('\r') >= 0) {
            return null;
        }

        Uri uri = Uri.parse(destination);
        String path = uri.getPath();

        if (path == null || path.isEmpty()) return null;

        if (!path.equals("/shared-note/")
                && !path.equals("/shared-note")
                && !path.equals("/shared-exam/")
                && !path.equals("/shared-exam")) {
            return null;
        }

        return uri.toString();
    }
}