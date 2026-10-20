# =========================================================================
# MedVix — R8 / ProGuard rules
# android/app/proguard-rules.pro
# =========================================================================

# --- MedVix App Core & Custom Plugins ---
# Protects all custom application classes, activities, and plugins from shrinking
-keep class com.medhurb.app.** { *; }

# --- Capacitor core ---
# Capacitor discovers plugins and bridge classes by reflection[cite: 6].
-keep class com.getcapacitor.** { *; }
-keep @com.getcapacitor.annotation.CapacitorPlugin public class * {
    @com.getcapacitor.annotation.PermissionCallback <methods>;
    @com.getcapacitor.annotation.ActivityCallback <methods>;
    @com.getcapacitor.annotation.Permission <methods>;
}

# --- Cordova plugins bridged through Capacitor[cite: 6] ---
-keep class org.apache.cordova.** { *; }

# --- WebView JS bridge (custom Java plugins & MedVixStorage) ---
# Any method called from JavaScript via @JavascriptInterface must be kept[cite: 6].
-keepclassmembers class com.medhurb.app.MedVixStorage {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# --- Firebase / google-services[cite: 6] ---
# Only needed because google-services is applied in your build.gradle[cite: 6].
-keep class com.google.firebase.** { *; }
-keep class com.google.android.gms.** { *; }

# --- Google Play libraries (In-App Updates + In-App Review + Install Referrer) ---
# Covers Google Play Core, In-App Review, In-App Updates, and Install Referrer SDKs
-keep class com.google.android.play.core.** { *; }
-keep class com.android.installreferrer.** { *; }

# --- Reflection-based serialisation (Gson / Moshi / kotlinx)[cite: 6] ---
# These attributes must survive R8 for JSON serialisation to work at runtime[cite: 6].
-keepattributes Signature
-keepattributes *Annotation*
-keepattributes InnerClasses
-keepattributes EnclosingMethod

# --- Crash-report readability[cite: 6] ---
# Keeps source file and line numbers in stack traces so mapping.txt is useful[cite: 6].
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile