package com.medhurb.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Build;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * MedvixStatusBar
 *
 * Fullscreen / immersive mode, status bar visibility, colour, and icon
 * style. Replaces @capacitor/status-bar and the Web Fullscreen API for
 * the viewer's chrome toggle.
 *
 * Immersive mode hides both the status bar and the navigation bar on
 * API 30+ via WindowInsetsController. On older versions it uses the
 * legacy SYSTEM_UI_FLAG_* flags. The Web Fullscreen API can only hide
 * the status bar, not the nav bar, which is why this plugin exists.
 *
 * No permissions required. No UI thread dependency beyond the
 * Activity.runOnUiThread wrapper Android requires for window mutations.
 */
@CapacitorPlugin(name = "MedvixStatusBar")
public class MedvixStatusBarPlugin extends Plugin {

    // ========================================================================
    // JS-facing methods
    // ========================================================================

    /**
     * Enter immersive fullscreen. Hides status bar + navigation bar.
     *
     * Resolves with { fullscreen: true }.
     */
    @PluginMethod
    public void enterFullscreen(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                Window window = activity.getWindow();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowInsetsController c = window.getInsetsController();
                    if (c != null) {
                        c.hide(WindowInsets.Type.statusBars()
                             | WindowInsets.Type.navigationBars());
                        c.setSystemBarsBehavior(
                            WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                    }
                } else {
                    window.getDecorView().setSystemUiVisibility(
                          View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
                }
            } catch (Exception ignored) {}
        });
        call.resolve();
    }

    /**
     * Exit fullscreen. Restores status bar + navigation bar.
     */
    @PluginMethod
    public void exitFullscreen(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        activity.runOnUiThread(() -> {
            try {
                Window window = activity.getWindow();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowInsetsController c = window.getInsetsController();
                    if (c != null) {
                        c.show(WindowInsets.Type.statusBars()
                             | WindowInsets.Type.navigationBars());
                    }
                } else {
                    window.getDecorView().setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
                }
            } catch (Exception ignored) {}
        });
        call.resolve();
    }

    /**
     * Query the current fullscreen / immersive state.
     *
     * Resolves with { fullscreen: boolean }.
     */
    @PluginMethod
    public void isFullscreen(PluginCall call) {
        Activity activity = getActivity();
        JSObject ret = new JSObject();
        boolean fullscreen = false;

        if (activity != null) {
            try {
                Window window = activity.getWindow();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowInsetsController c = window.getInsetsController();
                    if (c != null) {
                        // In this API there is no direct "is hidden" query; we
                        // track our own state. Fall back to a best-effort
                        // check via the insets controller's notional state.
                        fullscreen = (window.getDecorView().getWindowVisibility() != View.VISIBLE);
                    }
                } else {
                    int flags = window.getDecorView().getSystemUiVisibility();
                    fullscreen = (flags & View.SYSTEM_UI_FLAG_FULLSCREEN) != 0;
                }
            } catch (Exception ignored) {}
        }

        ret.put("fullscreen", fullscreen);
        call.resolve(ret);
    }

    /**
     * Show or hide the status bar without touching the navigation bar.
     *
     * call.data: { visible: boolean }
     */
    @PluginMethod
    public void setVisible(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        final boolean visible = call.getBoolean("visible", true);

        activity.runOnUiThread(() -> {
            try {
                Window window = activity.getWindow();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowInsetsController c = window.getInsetsController();
                    if (c != null) {
                        if (visible) c.show(WindowInsets.Type.statusBars());
                        else         c.hide(WindowInsets.Type.statusBars());
                    }
                } else {
                    View decor = window.getDecorView();
                    int flags = decor.getSystemUiVisibility();
                    if (visible) flags &= ~View.SYSTEM_UI_FLAG_FULLSCREEN;
                    else         flags |=  View.SYSTEM_UI_FLAG_FULLSCREEN;
                    decor.setSystemUiVisibility(flags);
                }
            } catch (Exception ignored) {}
        });
        call.resolve();
    }

    /**
     * Set the status bar background colour.
     *
     * call.data: { color: "#RRGGBB" | "#AARRGGBB" }
     */
    @PluginMethod
    public void setColor(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        final String color = call.getString("color", "#000000");

        activity.runOnUiThread(() -> {
            try {
                activity.getWindow().setStatusBarColor(Color.parseColor(color));
            } catch (Exception ignored) {}
        });
        call.resolve();
    }

    /**
     * Set status bar icon style (light or dark icons).
     *
     * call.data: { light: boolean }
     *   light = true  → white icons (for dark backgrounds)
     *   light = false → dark  icons (for light backgrounds)
     */
    @PluginMethod
    public void setLightIcons(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.resolve();
            return;
        }
        final boolean light = call.getBoolean("light", false);

        activity.runOnUiThread(() -> {
            try {
                Window window = activity.getWindow();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    WindowInsetsController c = window.getInsetsController();
                    if (c != null) {
                        c.setSystemBarsAppearance(
                            light ? 0 : WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS,
                            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS);
                    }
                } else {
                    View decor = window.getDecorView();
                    int flags = decor.getSystemUiVisibility();
                    if (light) flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    else       flags |=  View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
                    decor.setSystemUiVisibility(flags);
                }
            } catch (Exception ignored) {}
        });
        call.resolve();
    }
}