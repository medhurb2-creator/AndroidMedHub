# =========================================================================
# MedVix — R8 / ProGuard rules
# android/app/proguard-rules.pro
# =========================================================================

# --- MedVix App Core & Custom Plugins ---
# Protects all custom application classes, activities, and plugins from
# shrinking. Covers MainActivity, MedVixStorage, ReviewManagerHelper,
# MedvixReviewPlugin, MedvixAppPlugin, FileOpenPlugin, AppUpdatePlugin,
# MedvixDevicePlugin, MedvixOrientationPlugin, MedvixStatusBarPlugin,
# MedvixKeepAwakePlugin, MedvixSharePlugin, MedvixHapticsPlugin — every
# plugin registered in MainActivity.onCreate() lives in this package.
-keep class com.medhurb.app.** { *; }

# --- Capacitor core ---
# Capacitor discovers plugins, bridge classes, and PluginCall results by
# reflection. Keeping the framework wholesale is the safest option and is
# what the Capacitor docs themselves recommend.
-keep class com.getcapacitor.** { *; }

# --- Capacitor plugin discovery ---
# Any class annotated @CapacitorPlugin may be instantiated reflectively by
# the bridge. Its @PluginMethod-annotated methods are the ones invoked
# from JavaScript — R8 will rename them away unless explicitly kept, which
# produces a plugin that exists on the Java side but is silently absent in
# the WebView (window.Capacitor.Plugins.<Name> is undefined, or every call
# rejects with "not implemented").
#
# The @Permission, @PermissionCallback and @ActivityCallback annotations
# mark methods the bridge invokes as callbacks — same reasoning.
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.PluginMethod public <methods>;
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.annotation.Permission <methods>;
}

# Keep PluginMethod itself so the annotation metadata survives R8. Without
# this, some R8 configurations strip the annotation and the reflection
# match above returns nothing.
-keep @interface com.getcapacitor.PluginMethod

# --- Cordova plugins bridged through Capacitor ---
-keep class org.apache.cordova.** { *; }

# --- Third-party Capacitor plugins ---
# Plugins that live outside com.medhurb.app and com.getcapacitor are not
# covered by the generic @CapacitorPlugin rule above for their internal
# classes. The social-login plugin is the only one currently in the graph
# that matters here — if its package changes on a future @capgo/capacitor-
# social-login update, update this rule to match.
-keep class ee.forgr.capacitor.social.login.** { *; }
-keep interface ee.forgr.capacitor.social.login.** { *; }

# --- WebView JS bridge (custom Java plugins & MedVixStorage) ---
# Any method called from JavaScript via @JavascriptInterface must be kept.
# The class-scoped rule below is redundant with the com.medhurb.app.**
# keep above, but kept for documentation value; the wildcard rule is the
# one that actually matters for any future JavascriptInterface host.
-keepclassmembers class com.medhurb.app.MedVixStorage {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# --- Firebase / google-services ---
# Only applied when google-services.json is present (see build.gradle).
# Firebase loads several entry points by reflection from its manifest-
# declared components, so the wholesale keep is intentional.
-keep class com.google.firebase.** { *; }

# --- Google Play Services ---
# Broad keep. Covers Play Core internals used by play:review and
# play:app-update (both reflectively load their own service implementations
# at runtime), plus gms:play-services-tasks — which is where Task and
# OnCompleteListener now live after the Play Core split. ReviewManagerHelper
# imports com.google.android.gms.tasks.* directly, so if this rule were
# removed those imports would still resolve at compile time but the
# callback classes would be stripped at runtime, causing the review flow
# to hang on requestReviewFlow() with no completion callback.
-keep class com.google.android.gms.** { *; }

# --- Google Play libraries (In-App Updates + In-App Review) ---
# Covers the review and update SDKs, which still live under
# com.google.android.play.core.*. The Tasks classes they return are no
# longer in this package — see the gms rule above.
-keep class com.google.android.play.core.** { *; }

# --- Play Install Referrer ---
-keep class com.android.installreferrer.** { *; }

# --- Reflection-based serialisation (Gson / Moshi / kotlinx) ---
# These attributes must survive R8 for JSON serialisation to work at runtime.
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes InnerClasses
-keepattributes EnclosingMethod

# --- Crash-report readability ---
# Keeps source file and line numbers in stack traces so mapping.txt is useful.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile