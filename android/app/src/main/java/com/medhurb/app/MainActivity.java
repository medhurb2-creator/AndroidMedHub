package com.medhurb.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins BEFORE super.onCreate()
        registerPlugin(AppUpdatePlugin.class);

        super.onCreate(savedInstanceState);
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