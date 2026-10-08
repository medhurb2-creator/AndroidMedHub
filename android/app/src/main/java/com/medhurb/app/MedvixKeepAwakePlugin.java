package com.medhurb.app;

import android.app.Activity;
import android.view.WindowManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * MedvixKeepAwake
 *
 * Screen wake lock. Replaces @capacitor-community/keep-awake.
 *
 * Uses WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON on the activity
 * window. Unlike navigator.wakeLock, this flag is not released when the
 * app is backgrounded and re-acquired when foregrounded — it stays set
 * until allowSleep() is called, which matches the viewer's intent: keep
 * the screen on for the whole time a document is open.
 *
 * No permissions required.
 */
@CapacitorPlugin(name = "MedvixKeepAwake")
public class MedvixKeepAwakePlugin extends Plugin {

    /**
     * Prevent the screen from sleeping.
     */
    @PluginMethod
    public void keepAwake(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                try {
                    activity.getWindow().addFlags(
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } catch (Exception ignored) {}
            });
        }
        call.resolve();
    }

    /**
     * Re-allow screen sleep.
     */
    @PluginMethod
    public void allowSleep(PluginCall call) {
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                try {
                    activity.getWindow().clearFlags(
                        WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } catch (Exception ignored) {}
            });
        }
        call.resolve();
    }
}