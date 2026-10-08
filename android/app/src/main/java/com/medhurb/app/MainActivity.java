package com.medhurb.app;

import android.content.Intent;
import android.os.Bundle;

import androidx.core.view.WindowCompat;

import com.getcapacitor.BridgeActivity;

import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

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
        //   • MedvixAppPlugin         — deep links, lifecycle, app info.
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
}