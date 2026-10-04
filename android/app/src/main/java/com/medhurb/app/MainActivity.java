package com.medhurb.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins BEFORE super.onCreate().
        //
        // Capacitor's BridgeActivity builds its plugin registry inside
        // super.onCreate(). Calling registerPlugin() after that point leaves
        // the plugin invisible to JavaScript — the native class exists, but
        // window.Capacitor.Plugins.<Name> is undefined on the WebView side.
        //
        // Two plugins are registered here:
        //   • AppUpdatePlugin  — in-app update checks.
        //   • FileOpenPlugin   — receives files the OS hands to the app via
        //                        the "Open with" chooser (ACTION_VIEW with
        //                        content:// URIs matching the MIME filters
        //                        declared in AndroidManifest.xml).
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(FileOpenPlugin.class);

        super.onCreate(savedInstanceState);

        // ── Cold-start file open ────────────────────────────────────────
        //
        // If the app was launched by a file-open intent (the user tapped a
        // PDF in Files and chose MedVix), the intent arrives here before the
        // WebView has parsed. At this point FileOpenPlugin is loaded, but
        // viewer.js has not run yet, so no JS listener is attached.
        //
        // FileOpenPlugin.deliverIntent detects that no listener is ready and
        // stashes the URI in its static pending list. viewer.js drains that
        // list via getPendingFile() once it loads. The user sees the file
        // open a fraction of a second after the app becomes visible.
        //
        // Safe to call unconditionally:
        //   • On a normal launcher tap, getIntent().getAction() is MAIN, not
        //     VIEW, so extractUris() returns an empty list and nothing is
        //     stashed.
        //   • On a deep-link or OAuth redirect, the intent's data URI is an
        //     https:// or medvix:// URI that Android delivers to Capacitor's
        //     App plugin, not to us. The static check on intent.getAction()
        //     inside deliverIntent filters those out.
        FileOpenPlugin.deliverIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);

        // Update the activity's current intent so getIntent() reflects the
        // most recent launch. Without this, a subsequent Activity recreation
        // (rotation, process death) would re-deliver the FIRST intent, which
        // is stale by then.
        setIntent(intent);

        // ── Warm-start file open ────────────────────────────────────────
        //
        // The app is already running. The WebView, viewer.js, and the
        // FileOpen plugin listener registered by _wireNativeFileOpen are all
        // alive. deliverIntent dispatches the payload immediately via
        // notifyListeners, and viewer.js's 'fileOpen' handler loads it into
        // the running instance — replacing any document already on screen.
        FileOpenPlugin.deliverIntent(intent);
    }

    /**
     * Required by @capgo/capacitor-social-login.
     *
     * The plugin checks at runtime that MainActivity implements
     * ModifiedMainActivityForSocialLoginPlugin before allowing Google Sign-In.
     * The method body is intentionally empty — the Credential Manager API
     * handles its own activity results internally.
     */
    @Override
    public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {
        // Intentionally empty — the method exists only as a marker.
    }
}