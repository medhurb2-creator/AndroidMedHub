package com.medhurb.app;

import android.content.Context;
import android.os.Build;
import android.os.VibrationEffect;
import android.os.Vibrator;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * MedvixHaptics
 *
 * Vibration and haptic feedback. Replaces @capacitor/haptics.
 *
 * On API 29+ uses VibrationEffect.createPredefined with the system's
 * CLICK / TICK / HEAVY_CLICK effects, which route through the haptic
 * engine on devices that have one (most modern phones). On older
 * versions falls back to createOneShot with the default amplitude.
 *
 * Requires the VIBRATE permission — already declared in
 * AndroidManifest.xml.
 */
@CapacitorPlugin(name = "MedvixHaptics")
public class MedvixHapticsPlugin extends Plugin {

    private Vibrator getVibrator() {
        try {
            return (Vibrator) getContext().getSystemService(Context.VIBRATOR_SERVICE);
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Fire a predefined effect. Used internally by the named methods.
     */
    private void firePredefined(int effectId) {
        Vibrator v = getVibrator();
        if (v == null || !v.hasVibrator()) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                v.vibrate(VibrationEffect.createPredefined(effectId));
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(20, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(20);
            }
        } catch (Exception ignored) {}
    }

    /**
     * Fire a one-shot vibration with an explicit duration.
     */
    private void fireOneShot(long ms) {
        Vibrator v = getVibrator();
        if (v == null || !v.hasVibrator()) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                v.vibrate(ms);
            }
        } catch (Exception ignored) {}
    }

    /** Light impact — tap confirmations. */
    @PluginMethod
    public void light(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            firePredefined(VibrationEffect.EFFECT_TICK);
        } else {
            fireOneShot(10);
        }
        call.resolve();
    }

    /** Medium impact — page snap, drawer open. */
    @PluginMethod
    public void medium(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            firePredefined(VibrationEffect.EFFECT_CLICK);
        } else {
            fireOneShot(20);
        }
        call.resolve();
    }

    /** Heavy impact — destructive actions. */
    @PluginMethod
    public void heavy(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            firePredefined(VibrationEffect.EFFECT_HEAVY_CLICK);
        } else {
            fireOneShot(40);
        }
        call.resolve();
    }

    /**
     * Raw vibration. call.data: { duration: number } in milliseconds.
     */
    @PluginMethod
    public void vibrate(PluginCall call) {
        int duration = call.getInt("duration", 20);
        fireOneShot(duration);
        call.resolve();
    }
}