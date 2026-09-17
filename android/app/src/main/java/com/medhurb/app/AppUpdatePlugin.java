package com.medhurb.app;

import android.app.Activity;
import android.content.SharedPreferences;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.android.play.core.appupdate.AppUpdateInfo;
import com.google.android.play.core.appupdate.AppUpdateManager;
import com.google.android.play.core.appupdate.AppUpdateManagerFactory;
import com.google.android.play.core.appupdate.AppUpdateOptions;
import com.google.android.play.core.install.InstallStateUpdatedListener;
import com.google.android.play.core.install.model.AppUpdateType;
import com.google.android.play.core.install.model.InstallStatus;
import com.google.android.play.core.install.model.UpdateAvailability;

@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    private static final String TAG = "AppUpdatePlugin";
    private static final int REQUEST_CODE = 9001;
    private static final String PREFS = "medvix_app_update";
    private static final String KEY_PENDING_TYPE = "pending_update_type";

    private AppUpdateManager manager;
    private InstallStateUpdatedListener installListener;

    /** AppUpdateType.FLEXIBLE (0) or IMMEDIATE (1); -1 = none. */
    private int pendingUpdateType = -1;

    @Override
    public void load() {
        manager = AppUpdateManagerFactory.create(getContext());

        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, 0);
        pendingUpdateType = prefs.getInt(KEY_PENDING_TYPE, -1);

        installListener = state -> {
            int status = state.installStatus();

            JSObject ret = new JSObject();
            ret.put("status", status);
            ret.put("statusName", statusName(status));
            ret.put("bytesDownloaded", state.bytesDownloaded());
            ret.put("totalBytes", state.totalBytesToDownload());

            switch (status) {
                case InstallStatus.DOWNLOADED:
                    notifyListeners("updateDownloaded", ret);
                    break;
                case InstallStatus.FAILED:
                    clearPendingType();
                    notifyListeners("updateFailed", ret);
                    break;
                case InstallStatus.CANCELED:
                    clearPendingType();
                    notifyListeners("updateCanceled", ret);
                    break;
                default:
                    notifyListeners("downloadProgress", ret);
                    break;
            }
        };

        manager.registerListener(installListener);
    }

    // ---------- JS-facing methods ----------

    @PluginMethod
    public void check(PluginCall call) {
        manager.getAppUpdateInfo()
            .addOnSuccessListener(info -> call.resolve(toJs(info)))
            .addOnFailureListener(e -> {
                Log.e(TAG, "check failed", e);
                call.reject("Play update check failed: " + e.getMessage());
            });
    }

    @PluginMethod
    public void startFlexible(PluginCall call) {
        startUpdate(call, AppUpdateType.FLEXIBLE);
    }

    @PluginMethod
    public void startImmediate(PluginCall call) {
        startUpdate(call, AppUpdateType.IMMEDIATE);
    }

    @PluginMethod
    public void completeUpdate(PluginCall call) {
        manager.completeUpdate()
            .addOnSuccessListener(v -> {
                clearPendingType();
                call.resolve();
            })
            .addOnFailureListener(e -> call.reject("completeUpdate failed: " + e.getMessage()));
    }

    // ---------- internals ----------

    private void startUpdate(PluginCall call, int type) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No foreground activity");
            return;
        }

        manager.getAppUpdateInfo()
            .addOnSuccessListener(info -> {
                int availability = info.updateAvailability();
                boolean available =
                        availability == UpdateAvailability.UPDATE_AVAILABLE
                     || availability == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS;

                if (!available) {
                    call.resolve(result(false, "no_update_available"));
                    return;
                }
                if (!info.isUpdateTypeAllowed(type)) {
                    call.resolve(result(false, "update_type_not_allowed"));
                    return;
                }

                try {
                    setPendingType(type);
                    manager.startUpdateFlowForResult(
                            info,
                            activity,
                            AppUpdateOptions.newBuilder(type).build(),
                            REQUEST_CODE
                    );
                    call.resolve(result(true, null));
                } catch (Exception e) {
                    Log.e(TAG, "startUpdateFlowForResult failed", e);
                    clearPendingType();
                    call.reject("Failed to start update flow: " + e.getMessage());
                }
            })
            .addOnFailureListener(e -> call.reject("Play update check failed: " + e.getMessage()));
    }

    @Override
    public void handleOnResume() {
        super.handleOnResume();
        if (manager == null) return;

        manager.getAppUpdateInfo().addOnSuccessListener(info -> {
            // Flexible: download completed while we were backgrounded/killed.
            if (info.installStatus() == InstallStatus.DOWNLOADED) {
                JSObject ret = new JSObject();
                ret.put("status", InstallStatus.DOWNLOADED);
                ret.put("statusName", "DOWNLOADED");
                notifyListeners("updateDownloaded", ret);
            }

            // Immediate: user abandoned the blocking flow mid-way. Resume it.
            if (info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS
                    && pendingUpdateType == AppUpdateType.IMMEDIATE
                    && info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE)) {
                Activity activity = getActivity();
                if (activity == null) return;
                try {
                    manager.startUpdateFlowForResult(
                            info,
                            activity,
                            AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build(),
                            REQUEST_CODE
                    );
                } catch (Exception e) {
                    Log.e(TAG, "Failed to resume immediate update", e);
                }
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (manager != null && installListener != null) {
            manager.unregisterListener(installListener);
        }
        super.handleOnDestroy();
    }

    private JSObject toJs(AppUpdateInfo info) {
        JSObject ret = new JSObject();
        ret.put("updateAvailable", info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE);
        ret.put("updateInProgress",
                info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS);
        ret.put("updatePriority", info.updatePriority());
        ret.put("flexibleAllowed", info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE));
        ret.put("immediateAllowed", info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE));
        ret.put("installStatus", info.installStatus());
        ret.put("installStatusName", statusName(info.installStatus()));
        return ret;
    }

    private JSObject result(boolean started, String reason) {
        JSObject ret = new JSObject();
        ret.put("started", started);
        if (reason != null) ret.put("reason", reason);
        return ret;
    }

    private void setPendingType(int type) {
        pendingUpdateType = type;
        getContext().getSharedPreferences(PREFS, 0)
                .edit().putInt(KEY_PENDING_TYPE, type).apply();
    }

    private void clearPendingType() {
        pendingUpdateType = -1;
        getContext().getSharedPreferences(PREFS, 0)
                .edit().remove(KEY_PENDING_TYPE).apply();
    }

    private static String statusName(int status) {
        switch (status) {
            case InstallStatus.PENDING:     return "PENDING";
            case InstallStatus.DOWNLOADING: return "DOWNLOADING";
            case InstallStatus.INSTALLING:  return "INSTALLING";
            case InstallStatus.INSTALLED:   return "INSTALLED";
            case InstallStatus.FAILED:      return "FAILED";
            case InstallStatus.CANCELED:    return "CANCELED";
            case InstallStatus.DOWNLOADED:  return "DOWNLOADED";
            default:                        return "UNKNOWN";
        }
    }
}