package com.medhurb.app;

import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

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
 *   • getPendingDeepLink()    — deferred route from Play Install Referrer
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
 *
 * ─── DEFERRED DEEP LINKS ────────────────────────────────────────────────────
 * MainActivity writes a pending route into SharedPreferences when the
 * Install Referrer API returns a valid deep_link payload on first install.
 * getPendingDeepLink() reads it, returns it once, and deletes it. The
 * "checked" flag in the result tells JavaScript whether the native side
 * has finished its (async) referrer lookup — the JS layer polls until
 * checked=true so it never mistakes "not ready yet" for "no deferred link".
 *
 * Staleness: MainActivity also writes the capture timestamp alongside the
 * route (pending_route_at). If the referrer lookup failed on launch #1
 * and only succeeded days later, the route would otherwise fire on an
 * unrelated launch and take the user somewhere they did not ask to go.
 * getPendingDeepLink() drops any route older than STALE_AFTER_MS and
 * returns no url, but still reports checked=true so JavaScript stops
 * polling.
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

    // ── Deferred deep-link storage keys ─────────────────────────────
    //
    // Must match the constants in MainActivity.java. If either side is
    // renamed, both must change together.
    private static final String REFERRER_PREFS        = "medvix_deferred_links";
    private static final String KEY_PENDING_ROUTE     = "pending_route";
    private static final String KEY_PENDING_ROUTE_AT  = "pending_route_at";
    private static final String KEY_REFERRER_CHECKED  = "referrer_checked";

    /**
     * A deferred route is considered fresh for this long after it was
     * captured. Beyond that, we drop it on read and log a warning. Ten
     * minutes is generous enough to cover any reasonable install →
     * first-launch gap, but short enough that a route recovered days
     * later cannot hijack a normal launch.
     */
    private static final long STALE_AFTER_MS = 10 * 60 * 1000L;

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

    /**
     * Returns a deferred route that was captured from the Play Install
     * Referrer on first install, if any.
     *
     * Response shape:
     *   { url?: string, checked: boolean }
     *
     *   • url      — present only if a valid route is waiting AND it is
     *                still fresh (captured less than STALE_AFTER_MS ago).
     *                Consumed on read: the next call returns nothing.
     *   • checked  — true once the native referrer lookup has finished
     *                (success OR permanent failure). JavaScript polls
     *                this method until checked=true so it doesn't mistake
     *                an in-flight lookup for "no deferred link".
     *
     * The route and its timestamp are written by
     * MainActivity.retrieveInstallReferrer() into the
     * "medvix_deferred_links" SharedPreferences file. Both sides must
     * use the same file name and keys.
     *
     * Consuming the route: whether the route is fresh (returned) or
     * stale (dropped), both the route and its timestamp are removed
     * from SharedPreferences so the next call sees an empty slot.
     */
    @PluginMethod
    public void getPendingDeepLink(PluginCall call) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(
                    REFERRER_PREFS,
                    android.content.Context.MODE_PRIVATE
            );

            String  route      = prefs.getString(KEY_PENDING_ROUTE, null);
            long    capturedAt = prefs.getLong(KEY_PENDING_ROUTE_AT, 0L);
            boolean checked    = prefs.getBoolean(KEY_REFERRER_CHECKED, false);

            JSObject result = new JSObject();
            result.put("checked", checked);

            if (route != null && !route.isEmpty()) {
                // Freshness check. A route with no timestamp (0L) is
                // treated as stale — MainActivity always writes both
                // keys together, so a missing timestamp means the data
                // is corrupt or from a pre-timestamp build.
                boolean fresh = capturedAt > 0L
                        && (System.currentTimeMillis() - capturedAt) < STALE_AFTER_MS;

                if (fresh) {
                    result.put("url", route);
                } else {
                    long ageMs = capturedAt > 0L
                            ? (System.currentTimeMillis() - capturedAt)
                            : -1L;
                    Log.w("MedvixApp",
                            "Discarding stale deferred route (age "
                                    + ageMs + "ms)");
                }

                // Consume either way — the slot is spent, fresh or not.
                // Removing the timestamp alongside the route keeps the
                // two keys from drifting out of sync.
                prefs.edit()
                        .remove(KEY_PENDING_ROUTE)
                        .remove(KEY_PENDING_ROUTE_AT)
                        .apply();
            }

            call.resolve(result);
        } catch (Exception e) {
            call.reject("Unable to retrieve pending deep link");
        }
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