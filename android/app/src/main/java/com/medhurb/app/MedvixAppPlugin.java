package com.medhurb.app;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * MedvixApp
 *
 * Deep-link, app-lifecycle, and app-info plugin. Replaces @capacitor/app
 * for every usage in the app:
 *
 *   • getLaunchUrl()          — cold-start URL
 *   • appUrlOpen event        — warm-start URL delivery
 *   • getInfo()               — version name / code / package
 *   • backButton event        — hardware back button interception
 *   • appStateChange event    — foreground/background transitions
 *   • exitApp()               — programmatic app exit
 *
 * Same design discipline as MedvixDevicePlugin: no exceptions reach the
 * bridge, no dynamic imports on the JS side, everything resolves.
 *
 * ─── BACK BUTTON ────────────────────────────────────────────────────────────
 * Capacitor v6 does not route the hardware back button through the plugin
 * base class — there is no `handleOnBackPressed` hook to override. Instead,
 * the plugin exposes a plain public method `dispatchBackButton()`, and
 * MainActivity.onBackPressed() calls it. If a JS 'backButton' listener is
 * registered, the event is dispatched and the method returns true — the
 * activity consumes the press. Otherwise it returns false and the activity
 * falls through to Android's default behaviour (WebView history, then
 * finish).
 *
 * The static `sInstance` reference is how MainActivity reaches the live
 * plugin instance — plugins are created and owned by the Capacitor bridge,
 * so MainActivity can't construct one itself.
 */
@CapacitorPlugin(name = "MedvixApp")
public class MedvixAppPlugin extends Plugin {

    /**
     * Reference to the currently loaded plugin instance. Set in load(),
     * cleared in handleOnDestroy(). Used by MainActivity.onBackPressed()
     * to dispatch back-button events to JS.
     */
    public static MedvixAppPlugin sInstance = null;

    private String launchUrl = null;

    // ========================================================================
    // Lifecycle
    // ========================================================================

    @Override
    public void load() {
        sInstance = this;
        try {
            Intent intent = getActivity() != null ? getActivity().getIntent() : null;
            if (intent != null && intent.getData() != null) {
                launchUrl = intent.getData().toString();
            }
        } catch (Exception ignored) {}
    }

    @Override
    protected void handleOnDestroy() {
        if (sInstance == this) sInstance = null;
        super.handleOnDestroy();
    }

    /**
     * Warm-start deep links — called by Capacitor's bridge whenever the
     * activity receives a new intent.
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null) return;

        Uri data = intent.getData();
        if (data == null) return;

        JSObject ret = new JSObject();
        ret.put("url", data.toString());
        notifyListeners("appUrlOpen", ret);
    }

    /**
     * Foreground transition. Fires the JS-visible 'appStateChange' event
     * with { isActive: true }.
     *
     * Only fires if a JS listener is registered, so the plugin stays
     * cheap on app launches that don't use the event.
     */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!hasListeners("appStateChange")) return;
        JSObject ret = new JSObject();
        ret.put("isActive", true);
        notifyListeners("appStateChange", ret);
    }

    /**
     * Background transition. Fires 'appStateChange' with { isActive: false }.
     */
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (!hasListeners("appStateChange")) return;
        JSObject ret = new JSObject();
        ret.put("isActive", false);
        notifyListeners("appStateChange", ret);
    }

    /**
     * Hardware back button — dispatched by MainActivity.onBackPressed().
     *
     * If a JS 'backButton' listener is registered, fires the event and
     * returns true. The caller (MainActivity) should then consume the
     * press and NOT call super.onBackPressed() — the WebView stays open
     * and JS gets to decide what to do (close a drawer, exit fullscreen,
     * dismiss a search bar, etc.).
     *
     * If no JS listener is registered, returns false. The caller falls
     * through to Android's default back behaviour: WebView history back
     * if there is history, then finish the activity.
     *
     * This is a plain public method, not a plugin hook. Capacitor v6 does
     * not route the back button through the plugin base class — see the
     * class docstring for why.
     */
    public boolean dispatchBackButton() {
        if (hasListeners("backButton")) {
            notifyListeners("backButton", new JSObject());
            return true;
        }
        return false;
    }

    // ========================================================================
    // JS-facing methods
    // ========================================================================

    @PluginMethod
    public void getLaunchUrl(PluginCall call) {
        JSObject ret = new JSObject();
        if (launchUrl != null && !launchUrl.isEmpty()) {
            ret.put("url", launchUrl);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject ret = new JSObject();
        String appId = "";
        try {
            appId = getContext().getPackageName();
        } catch (Exception ignored) {}

        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo pi = pm.getPackageInfo(appId, 0);

            ret.put("version", pi.versionName != null ? pi.versionName : "");
            long code = (Build.VERSION.SDK_INT >= 28)
                    ? pi.getLongVersionCode()
                    : pi.versionCode;
            ret.put("build", String.valueOf(code));
            ret.put("appId", appId);

            CharSequence label = (pi.applicationInfo != null)
                    ? pm.getApplicationLabel(pi.applicationInfo)
                    : null;
            ret.put("name", label != null ? label.toString() : "");
        } catch (Exception e) {
            if (!ret.has("version")) ret.put("version", "");
            if (!ret.has("build"))   ret.put("build", "0");
            if (!ret.has("appId"))   ret.put("appId", appId);
            if (!ret.has("name"))    ret.put("name", "");
        }

        call.resolve(ret);
    }

    /**
     * Programmatically exit the app. Called by the viewer's back-button
     * handler when the user has dismissed every overlay and the app
     * should close.
     */
    @PluginMethod
    public void exitApp(PluginCall call) {
        try {
            if (getActivity() != null) {
                getActivity().runOnUiThread(() -> {
                    try { getActivity().finish(); } catch (Exception ignored) {}
                });
            }
        } catch (Exception ignored) {}
        call.resolve();
    }
}