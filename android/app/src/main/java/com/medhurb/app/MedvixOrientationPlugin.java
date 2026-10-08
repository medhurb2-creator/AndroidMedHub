package com.medhurb.app;

import android.app.Activity;
import android.content.pm.ActivityInfo;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * MedvixOrientation
 *
 * Locks and unlocks the Activity's requested orientation. Replaces
 * @capacitor/screen-orientation for the only thing the app uses it for:
 * holding the splash screen to portrait, then releasing orientation
 * after the app is fully booted.
 *
 * Design notes:
 *
 *   - getActivity() is checked for null. When the WebView calls before
 *     the Activity is fully resumed, the method resolves without doing
 *     anything. The next call will succeed.
 *
 *   - The actual setRequestedOrientation call runs on the UI thread.
 *     Android requires this — calling it from a background thread is
 *     silently ignored on some OEM builds.
 *
 *   - Both methods always resolve. No rejections reach the bridge.
 *
 *   - No manifest change required. The Activity does not declare a
 *     fixed screenOrientation; the requested orientation is set at
 *     runtime and released with SCREEN_ORIENTATION_UNSPECIFIED, which
 *     lets the OS pick based on the sensor and the user's auto-rotate
 *     setting.
 */
@CapacitorPlugin(name = "MedvixOrientation")
public class MedvixOrientationPlugin extends Plugin {

    /**
     * Locks the Activity to the requested orientation.
     *
     * call.data:
     *   { orientation: "portrait" | "landscape" }
     *
     * Defaults to portrait when the key is missing.
     */
    @PluginMethod
    public void lock(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            // No Activity yet — resolve silently. The caller can retry.
            call.resolve();
            return;
        }

        final String orientation = call.getString("orientation", "portrait");
        final int requested = "landscape".equals(orientation)
                ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;

        activity.runOnUiThread(() -> {
            try {
                activity.setRequestedOrientation(requested);
            } catch (Exception ignored) {
                // Some OEM ROMs throw on certain orientation constants.
                // Swallow — the user's screen orientation is not critical.
            }
        });

        call.resolve();
    }

    /**
     * Releases the orientation lock. The OS is free to rotate the
     * Activity based on the sensor and the user's auto-rotate setting.
     */
    @PluginMethod
    public void unlock(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }

        activity.runOnUiThread(() -> {
            try {
                activity.setRequestedOrientation(
                        ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            } catch (Exception ignored) {
                // Same as above — best effort.
            }
        });

        call.resolve();
    }
}