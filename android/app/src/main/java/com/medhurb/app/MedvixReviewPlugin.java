package com.medhurb.app;

import android.app.Activity;
import android.util.Log;

import androidx.annotation.Nullable;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor bridge for the Google Play In-App Review flow.
 *
 * This class exists because ReviewManagerHelper is a plain helper, not
 * a Capacitor plugin — it cannot be reached from JavaScript. This thin
 * wrapper exposes it to the WebView.
 *
 * The plugin name MUST stay "Review" — scripts/rate-us.js looks it up
 * via:
 *
 *     const p = Capacitor.registerPlugin('Review');   // or Plugins.Review
 *     await p.requestReview();
 *
 * Renaming the class is fine; renaming @CapacitorPlugin(name = ...)
 * without renaming PLUGIN_NAME in rate-us.js silently disables the
 * flow (isPluginAvailable('Review') returns false, rate-us.js returns
 * { success: false, reason: 'unsupported' }, and nothing ever happens).
 *
 * Registered in MainActivity.onCreate() BEFORE super.onCreate(), next
 * to the other registerPlugin(...) calls — Capacitor builds its plugin
 * registry inside super.onCreate(), so registering after that point
 * leaves the plugin invisible to JavaScript.
 *
 * JS contract (see scripts/rate-us.js):
 *
 *     requestReview() → resolves  when the Play review flow has been
 *                                 launched and the native 45-day
 *                                 cooldown has been stamped.
 *                    → rejects  with "Activity not available" if the
 *                                 host activity is gone.
 *                    → rejects  with "Review flow skipped: cooldown
 *                                 active" if the native cooldown is
 *                                 still running (native is
 *                                 authoritative over the JS-side
 *                                 localStorage timestamp).
 *                    → rejects  with "Review flow failed: <reason>"
 *                                 if Play Core failed after all
 *                                 in-session retries. The cooldown
 *                                 was NOT stamped, so the next launch
 *                                 can try again.
 *
 * Note on resolve semantics: Play does not disclose whether the user
 * actually submitted a review or dismissed the sheet. "Resolved" means
 * "we handed the request to Play and it accepted the launch" — nothing
 * more. Do not use this signal to gate analytics or rewards on a
 * positive rating; that information is not available.
 */
@CapacitorPlugin(name = "Review")
public class MedvixReviewPlugin extends Plugin {

    private static final String TAG = "MedvixReviewPlugin";

    @PluginMethod
    public void requestReview(PluginCall call) {
        final Activity activity = getActivity();

        // Activity is null during bridge teardown; also check the two
        // lifecycle flags so we don't hand a dying Activity to Play Core.
        if (activity == null || activity.isFinishing() || activity.isDestroyed()) {
            Log.w(TAG, "requestReview called but Activity is not usable");
            call.reject("Activity not available");
            return;
        }

        // Play Core requires requestReviewFlow() and launchReviewFlow()
        // to be called from the UI thread. Plugin methods run off the
        // UI thread by default, so hop over before touching the helper.
        activity.runOnUiThread(() -> {
            boolean started;
            try {
                started = ReviewManagerHelper.checkAndTriggerReview(
                        activity,
                        new ReviewManagerHelper.ReviewFlowCallback() {
                            @Override
                            public void onReviewCompleted() {
                                // Play accepted the request, the sheet
                                // was launched, and the cooldown has
                                // been stamped. By the time this fires
                                // the sheet may already be gone (user
                                // submitted or dismissed) — that is
                                // all the API exposes.
                                Log.d(TAG, "Review flow completed — resolving");
                                call.resolve();
                            }

                            @Override
                            public void onReviewFailed(@Nullable String reason) {
                                // All in-session retries were exhausted
                                // without a successful launch. The
                                // native cooldown was NOT stamped, so
                                // the next launch (or a forced retry)
                                // will be eligible again.
                                Log.w(TAG, "Review flow failed — rejecting: " + reason);
                                call.reject("Review flow failed: " + reason);
                            }
                        });

            } catch (Exception e) {
                // Defensive: should not happen given the guards above,
                // but Play Core has thrown on some OEMs at cold start.
                Log.e(TAG, "Review flow threw synchronously", e);
                call.reject("Review flow threw: " + e.getMessage(), e);
                return;
            }

            if (!started) {
                // Cooldown still active. JS normally catches this first
                // via its own localStorage timestamp, but the two
                // stores can drift (JS storage cleared, native prefs
                // not, or vice versa) — native is authoritative, so
                // report it explicitly.
                Log.d(TAG, "Review flow skipped — native cooldown active");
                call.reject("Review flow skipped: cooldown active");
            }
            // else: the callback resolves or rejects asynchronously
            // once the flow finishes or all retries are exhausted.
        });
    }
}