package com.medhurb.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;
import ee.forgr.capacitor.social.login.GoogleProvider;

public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins BEFORE super.onCreate()
        registerPlugin(AppUpdatePlugin.class);

        super.onCreate(savedInstanceState);
    }

    @Override
    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        // Forward Google Sign-In results back to the SocialLogin plugin.
        // Without this, @capgo/capacitor-social-login silently does nothing
        // when the user picks an account in the native Google dialog.
        if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN
            && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
            GoogleProvider.handleOnActivityResult(this, requestCode, resultCode, data);
        }
    }
}