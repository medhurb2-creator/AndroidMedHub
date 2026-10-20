package com.medhurb.app;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.google.android.play.core.review.ReviewInfo;
import com.google.android.play.core.review.ReviewManager;
import com.google.android.play.core.review.ReviewManagerFactory;
import com.google.android.play.core.tasks.OnCompleteListener;
import com.google.android.play.core.tasks.Task;

/**
 * Drives the Google Play In-App Review flow with:
 *
 *   • a 45-day cooldown, persisted in SharedPreferences;
 *   • in-session retry on transient Play Core failures;
 *   • success-only cooldown stamping — a failed attempt never locks
 *     the user out of a review they never saw.
 *
 * Not a Capacitor plugin — MedvixReviewPlugin wraps this and exposes
 * it to JavaScript. See that class for the JS contract.
 */
public class ReviewManagerHelper {

    private static final String TAG = "ReviewManagerHelper";
    private static final String PREF_NAME = "MedVixReviewPrefs";
    private static final String KEY_LAST_REVIEW_TIME = "last_review_request_timestamp";

    // 45-day cool-down period to prevent spamming users and respect API quotas
    private static final long COOLDOWN_PERIOD_MS = 45L * 24L * 60L * 60L * 1000L;

    // ── Retry policy ───────────────────────────────────────────────
    //
    // Play Core can fail transiently at cold start — Play Store not
    // warm yet, quota handshake incomplete, brief network blip. A
    // short in-session retry turns a flaky attempt into a working one.
    //
    //   attempt 0 → immediate
    //   attempt 1 → after 1000 ms
    //   attempt 2 → after 3000 ms
    //
    // The cooldown timestamp is written ONLY after launchReviewFlow
    // completes successfully. Any failure — including exhausting all
    // retries — leaves the timestamp untouched, so the NEXT launch is
    // still eligible.
    private static final int    REVIEW_MAX_ATTEMPTS    = 3;
    private static final long[] REVIEW_RETRY_DELAYS_MS = { 0L, 1000L, 3000L };

    /**
     * Callback fired exactly once per checkAndTriggerReview() call that
     * returned true. Both methods run on the main thread.
     *
     *   onReviewCompleted() — Play accepted the request, the sheet was
     *                          launched, and the cooldown has been
     *                          stamped. Play does not disclose whether
     *                          the user submitted or dismissed; this
     *                          means "we spent our shot."
     *
     *   onReviewFailed(reason) — the flow could not be launched even
     *                             after retries. The cooldown has NOT
     *                             been stamped; the next launch is
     *                             still eligible.
     */
    public interface ReviewFlowCallback {
        void onReviewCompleted();
        void onReviewFailed(@Nullable String reason);
    }

    /**
     * Checks the 45-day cooldown and, if eligible, drives the review
     * flow with in-session retry.
     *
     * The cooldown timestamp is written only on success — a failed
     * attempt does not penalise the user.
     *
     * @return true if the cooldown had elapsed and an attempt was
     *         started (the callback will fire asynchronously);
     *         false if the cooldown is still active (no attempt,
     *         callback is never invoked).
     */
    public static boolean checkAndTriggerReview(@NonNull final Activity activity,
                                                @NonNull final ReviewFlowCallback callback) {
        final SharedPreferences prefs = activity.getSharedPreferences(
                PREF_NAME, Context.MODE_PRIVATE);

        final long lastRequestTime = prefs.getLong(KEY_LAST_REVIEW_TIME, 0L);
        final long currentTime     = System.currentTimeMillis();

        if (currentTime - lastRequestTime <= COOLDOWN_PERIOD_MS) {
            Log.d(TAG, "Review prompt skipped: Cool-down period active.");
            return false;
        }

        requestReviewAttempt(activity, prefs, 0, callback);
        return true;
    }

    private static void requestReviewAttempt(@NonNull final Activity activity,
                                             @NonNull final SharedPreferences prefs,
                                             final int attempt,
                                             @NonNull final ReviewFlowCallback callback) {
        // Activity may have gone away between retries.
        if (activity.isFinishing() || activity.isDestroyed()) {
            Log.w(TAG, "Activity gone — abandoning review attempt " + attempt);
            callback.onReviewFailed("Activity not available");
            return;
        }

        final ReviewManager manager = ReviewManagerFactory.create(activity);
        final Task<ReviewInfo> request = manager.requestReviewFlow();

        request.addOnCompleteListener(new OnCompleteListener<ReviewInfo>() {
            @Override
            public void onComplete(@NonNull Task<ReviewInfo> task) {
                if (!task.isSuccessful()) {
                    final Exception e = task.getException();
                    Log.w(TAG, "requestReviewFlow failed (attempt " + attempt + ")", e);
                    scheduleRetry(activity, prefs, attempt, callback,
                            e != null ? e.getMessage() : "requestReviewFlow failed");
                    return;
                }

                final ReviewInfo reviewInfo = task.getResult();
                final Task<Void> flow = manager.launchReviewFlow(activity, reviewInfo);

                flow.addOnCompleteListener(new OnCompleteListener<Void>() {
                    @Override
                    public void onComplete(@NonNull Task<Void> flowTask) {
                        if (!flowTask.isSuccessful()) {
                            final Exception e = flowTask.getException();
                            Log.w(TAG, "launchReviewFlow failed (attempt " + attempt + ")", e);
                            scheduleRetry(activity, prefs, attempt, callback,
                                    e != null ? e.getMessage() : "launchReviewFlow failed");
                            return;
                        }

                        // ── Success — freeze the cooldown ────────
                        //
                        // Play does not disclose whether the user
                        // actually submitted a review or dismissed the
                        // sheet; the task completes either way. Treat
                        // this as "we spent our shot" and stamp the
                        // timestamp now — not before the call.
                        prefs.edit()
                                .putLong(KEY_LAST_REVIEW_TIME,
                                        System.currentTimeMillis())
                                .apply();

                        Log.d(TAG, "In-app review flow completed (attempt "
                                + attempt + ").");
                        callback.onReviewCompleted();
                    }
                });
            }
        });
    }

    private static void scheduleRetry(@NonNull final Activity activity,
                                      @NonNull final SharedPreferences prefs,
                                      final int attempt,
                                      @NonNull final ReviewFlowCallback callback,
                                      @NonNull final String reason) {
        final int next = attempt + 1;

        if (next >= REVIEW_MAX_ATTEMPTS) {
            Log.w(TAG, "Review flow failed after " + REVIEW_MAX_ATTEMPTS
                    + " attempts: " + reason
                    + " — will retry on next app launch");
            // No timestamp written — user stays eligible.
            callback.onReviewFailed(reason);
            return;
        }

        final long delay = REVIEW_RETRY_DELAYS_MS[
                Math.min(next, REVIEW_RETRY_DELAYS_MS.length - 1)];

        Log.i(TAG, "Retrying review flow in " + delay + "ms "
                + "(attempt " + next + "/" + (REVIEW_MAX_ATTEMPTS - 1) + ")");

        new Handler(Looper.getMainLooper()).postDelayed(
                () -> requestReviewAttempt(activity, prefs, next, callback),
                delay);
    }
}