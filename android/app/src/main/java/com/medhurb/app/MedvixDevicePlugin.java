package com.medhurb.app;

import android.content.ContentResolver;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.UUID;

/**
 * MedvixDevice
 *
 * Minimal, synchronous device identity plugin. Replaces @capacitor/device
 * for every code path that needs a stable device ID or basic device
 * metadata.
 *
 * Design goals:
 *
 *   1. No exceptions ever reach the bridge. Every method resolves, even
 *      on failure. A rejected bridge call on some Capacitor versions
 *      leaves the JS promise in an inconsistent state, so we never
 *      reject — we return a fallback payload instead.
 *
 *   2. No UI thread dependency. Nothing here touches Activity or
 *      getActivity(). All reads come from ContentResolver, Build, or
 *      SharedPreferences, all of which are safe from any thread.
 *
 *   3. Fast. Two ContentResolver reads (ANDROID_ID) and a handful of
 *      Build field reads. No I/O beyond SharedPreferences, which the
 *      OS caches.
 *
 *   4. Stable identity. Prefers ANDROID_ID. Falls back to a persisted
 *      UUID in SharedPreferences if ANDROID_ID is unavailable (rare,
 *      but it happens on some restricted OEM ROMs). The fallback
 *      survives app restarts but not app uninstall — same semantics
 *      as the primary path.
 *
 * No Android permissions required. Settings.Secure.ANDROID_ID,
 * Build.MODEL, Build.MANUFACTURER, and Build.VERSION.RELEASE are all
 * readable from any normal app process.
 */
@CapacitorPlugin(name = "MedvixDevice")
public class MedvixDevicePlugin extends Plugin {

    private static final String TAG = "MedvixDevice";

    /**
     * SharedPreferences file for the fallback identifier. Uses the
     * application context so it persists across all activity instances
     * and plugin instances.
     */
    private static final String PREFS_NAME = "medvix_device";
    private static final String PREF_FALLBACK_ID = "fallback_device_id";

    /**
     * Well-known ANDROID_ID that some early Android builds returned
     * unconditionally. It is not unique per device, so we treat it as
     * "unavailable" and use the fallback path instead.
     */
    private static final String BROKEN_ANDROID_ID = "9774d56d682e549c";

    // ========================================================================
    // JS-facing methods
    // ========================================================================

    /**
     * Returns the stable device identifier.
     *
     * Resolves with:
     *   { deviceId: string }
     *
     * The value is either the raw ANDROID_ID or a persisted UUID. It is
     * NOT hashed here — hashing happens on the JS side in
     * security/device.js so that the ID namespace stays consistent
     * across platforms.
     */
    @PluginMethod
    public void getDeviceId(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("deviceId", resolveDeviceId());
        call.resolve(ret);
    }

    /**
     * Returns the device identifier plus basic metadata in one call.
     * Preferred over calling getDeviceId() and getDeviceInfo() separately
     * — one bridge round-trip instead of two.
     *
     * Resolves with:
     *   {
     *     deviceId:     string,
     *     platform:     "android",
     *     manufacturer: string,   // e.g. "samsung"
     *     model:        string,   // e.g. "SM-S911B"
     *     osName:       "Android",
     *     osVersion:    string,   // e.g. "14"
     *     sdkVersion:   number,   // Android API level
     *     isVirtual:    boolean,  // true on emulators
     *   }
     *
     * The JS side trims this to whatever the UI needs. Returning the
     * full set keeps the plugin stable even if the UI adds a field
     * later — no plugin update needed.
     */
    @PluginMethod
    public void getDeviceInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("deviceId",     resolveDeviceId());
        ret.put("platform",     "android");
        ret.put("manufacturer", safe(Build.MANUFACTURER));
        ret.put("model",        safe(Build.MODEL));
        ret.put("osName",       "Android");
        ret.put("osVersion",    safe(Build.VERSION.RELEASE));
        ret.put("sdkVersion",   Build.VERSION.SDK_INT);
        ret.put("isVirtual",    isVirtualDevice());
        call.resolve(ret);
    }

    // ========================================================================
    // Device identifier resolution
    // ========================================================================

    /**
     * Prefer ANDROID_ID. Fall back to a persisted UUID if it is
     * unavailable or known-broken. Neither path throws.
     */
    private String resolveDeviceId() {
        String androidId = readAndroidId();
        if (androidId != null) return androidId;
        return readOrCreateFallbackId();
    }

    /**
     * Reads Settings.Secure.ANDROID_ID. Returns null if the value is
     * missing, empty, or the known-broken constant.
     *
     * On a normal device this always returns a value. The null path
     * exists for the handful of budget ROMs that block the read.
     */
    private String readAndroidId() {
        try {
            ContentResolver cr = getContext().getContentResolver();
            String id = Settings.Secure.getString(cr, Settings.Secure.ANDROID_ID);
            if (id == null)                return null;
            if (id.isEmpty())              return null;
            if (BROKEN_ANDROID_ID.equals(id)) return null;
            return id;
        } catch (Exception e) {
            Log.w(TAG, "ANDROID_ID read failed", e);
            return null;
        }
    }

    /**
     * Reads a previously generated UUID from SharedPreferences, or
     * generates and persists a new one.
     *
     * Stable across app restarts. Lost on app uninstall — same lifetime
     * semantics as ANDROID_ID, which is what we want.
     */
    private String readOrCreateFallbackId() {
        try {
            SharedPreferences prefs =
                    getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

            String existing = prefs.getString(PREF_FALLBACK_ID, null);
            if (existing != null && !existing.isEmpty()) return existing;

            String fresh = UUID.randomUUID().toString();
            prefs.edit().putString(PREF_FALLBACK_ID, fresh).apply();
            return fresh;
        } catch (Exception e) {
            // SharedPreferences failing is essentially impossible on a
            // real device, but if it does, we still need to return
            // something. A per-process UUID is unstable but better than
            // throwing.
            Log.w(TAG, "SharedPreferences unavailable, using ephemeral ID", e);
            return UUID.randomUUID().toString();
        }
    }

    // ========================================================================
    // Metadata helpers
    // ========================================================================

    /**
     * Emulator detection. Used by analytics and licensing rules that
     * want to distinguish physical devices from virtual ones. False
     * positives are harmless; false negatives are too. Best effort.
     */
    private boolean isVirtualDevice() {
        try {
            String fp      = safe(Build.FINGERPRINT).toLowerCase();
            String model   = safe(Build.MODEL).toLowerCase();
            String product = safe(Build.PRODUCT).toLowerCase();
            String hardware= safe(Build.HARDWARE).toLowerCase();

            return fp.contains("generic")
                || fp.contains("emulator")
                || fp.contains("vbox")
                || model.contains("emulator")
                || model.contains("android sdk built for")
                || product.contains("sdk")
                || product.contains("emulator")
                || hardware.contains("goldfish")
                || hardware.contains("ranchu")
                || hardware.contains("vbox");
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Null-safe string. Build.MODEL and friends are usually non-null but
     * are not contractually guaranteed to be.
     */
    private static String safe(String s) {
        return s == null ? "" : s;
    }
}