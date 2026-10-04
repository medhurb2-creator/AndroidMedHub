package com.medhurb.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Capacitor plugin for receiving files the OS hands to the app via an
 * ACTION_VIEW intent (the "Open with" chooser).
 *
 * ============================================================================
 * HOW IT WORKS
 * ============================================================================
 *
 *   1. The user taps a PDF (or image, or text file) in Files, Gmail, Chrome,
 *      Drive, or any other app and picks MedVix from the chooser.
 *
 *   2. Android launches MainActivity with an ACTION_VIEW intent carrying a
 *      content:// URI. The manifest's <intent-filter> blocks (application/pdf,
 *      image/*, text/plain) match the file's MIME type, which is what tells
 *      Android that MedVix is a candidate.
 *
 *   3. MainActivity.onCreate (cold start) or onNewIntent (warm start) calls
 *      FileOpenPlugin.deliverIntent(intent).
 *
 *   4. deliverIntent extracts every content:// URI from the intent and either:
 *        • dispatches it immediately via notifyListeners, if the plugin is
 *          loaded (warm start, or any launch after the first), or
 *        • stashes it in a static list for getPendingFile() to drain, if the
 *          plugin is not yet loaded (cold start, WebView not yet parsed).
 *
 *   5. JavaScript (viewer.js → _wireNativeFileOpen) either receives the
 *      'fileOpen' event listener (warm start) or calls plugin.getPendingFile()
 *      once on load (cold start). Either path yields the same payload shape:
 *
 *        { path: string, name: string, mimeType: string|null, size: number }
 *
 *   6. viewer.js converts the absolute path into a WebView-fetchable URL via
 *      Capacitor.convertFileSrc, fetches it as a Blob, and passes it to
 *      core.loadDocument. From that point it is indistinguishable from an
 *      in-app file selection.
 *
 * ============================================================================
 * WHY COPY TO CACHE INSTEAD OF PASSING THE URI TO JS
 * ============================================================================
 *
 *   • The content:// URI belongs to the source app's process. Handing it to
 *     the WebView would require a file URI grant, which Android 10+ blocks
 *     with FileUriExposedException.
 *
 *   • A local cache path is stable and readable by the WebView's file
 *     resolver without any runtime permission.
 *
 *   • The cache directory is inside the app sandbox. No external storage
 *     permission is required, which keeps the app off the Play Store's
 *     sensitive-permission review path.
 *
 *   • The stream is copied in 8 KB chunks — a 50 MB PDF never materialises
 *     as a single byte array in Java heap.
 *
 * ============================================================================
 * COLD START vs WARM START
 * ============================================================================
 *
 *   COLD START — the app was not running.
 *     onCreate fires before the WebView has parsed. The plugin's load()
 *     method has not run yet, so sInstance is null. The URI is appended to
 *     sPendingUris. When viewer.js finishes loading and calls
 *     getPendingFile(), the URI is drained and materialised. The user sees
 *     the document open a fraction of a second after the app becomes
 *     visible.
 *
 *   WARM START — the app is already running.
 *     The plugin is loaded, so sInstance is non-null and the URI is
 *     materialised and dispatched immediately. viewer.js's persistent
 *     'fileOpen' listener picks it up and loads the new document, replacing
 *     whatever was already on screen.
 *
 * ============================================================================
 * CACHE LIFECYCLE
 * ============================================================================
 *
 *   Files are written to getContext().getCacheDir() with names like
 *   "incoming-<timestamp>.<ext>". The Android framework may reclaim the
 *   entire cache directory under memory pressure, and it is normal for
 *   files to disappear between sessions.
 *
 *   To keep the cache bounded during long sessions, load() calls
 *   pruneOldCacheFiles(24h) which deletes any incoming-* file older than
 *   one day. Files opened in the current session are never touched — the
 *   age threshold is measured against System.currentTimeMillis() at load
 *   time, and files older than 24 hours predate the current process by
 *   definition.
 *
 *   If a file is deleted out from under a running viewer (extremely rare —
 *   the OS would have to evict it mid-read), the fetch inside viewer.js
 *   fails with a network error and the user sees a toast. No crash.
 *
 * ============================================================================
 * WHAT THIS PLUGIN DOES NOT DO
 * ============================================================================
 *
 *   • It does not parse or render files. That is PDF.js's job, driven by
 *     viewer.js.
 *
 *   • It does not enforce the subscription policy. That is the job of the
 *     getDownloadUrl action in Convex and the Open handler in
 *     resource-browser.js. External files (this path) are deliberately
 *     excluded from the preview-mode policy — the user chose the file
 *     themselves, so there is no catalogue resource to upsell.
 *
 *   • It does not run on iOS. iOS uses a completely different mechanism
 *     (UTImportedTypeDeclarations + Share Extension) that is out of scope
 *     for this plugin. On iOS, window.Capacitor.Plugins.FileOpen is
 *     undefined, viewer.js's _wireNativeFileOpen returns at the first null
 *     check, and the feature is simply inert.
 */
@CapacitorPlugin(name = "FileOpen")
public class FileOpenPlugin extends Plugin {

    /**
     * Event name JS subscribes to via plugin.addListener('fileOpen', ...).
     * viewer.js's _wireNativeFileOpen registers a handler under this name.
     *
     * Kept as a public constant so both sides reference the same literal —
     * a typo in either place would silently break warm-start delivery with
     * no error message on either side.
     */
    public static final String EVENT_OPEN = "fileOpen";

    /**
     * Static reference to the currently loaded plugin instance. Set in
     * load(), cleared in handleOnDestroy().
     *
     * MainActivity.deliverIntent uses this to decide between the two paths:
     *   • sInstance != null  → dispatch immediately (plugin is alive)
     *   • sInstance == null  → stash for later (cold start)
     *
     * There is exactly one instance per process because the Android process
     * model gives one WebView per app, and Capacitor builds one plugin
     * registry per bridge.
     */
    private static FileOpenPlugin sInstance = null;

    /**
     * URIs that arrived before the plugin was loaded (cold start). Drained
     * one-by-one by getPendingFile(). Bounded in practice by the OS — an
     * app is launched with one intent at a time, and re-launches while
     * running go through onNewIntent (warm path), not this list.
     *
     * Not synchronized because every access is on the main thread:
     * deliverIntent is called from MainActivity lifecycle methods, and
     * getPendingFile runs on the WebView's JS thread which Capacitor
     * marshals to the main thread before invoking @PluginMethod.
     */
    private static final List<Uri> sPendingUris = new ArrayList<>();

    @Override
    public void load() {
        sInstance = this;

        // Best-effort cleanup. Runs once per process start. Keeps the cache
        // bounded across long sessions without touching files that belong to
        // the current session (see pruneOldCacheFiles docstring).
        pruneOldCacheFiles(24L * 60 * 60 * 1000);
    }

    @Override
    protected void handleOnDestroy() {
        if (sInstance == this) sInstance = null;
        super.handleOnDestroy();
    }

    // ========================================================================
    // Called by MainActivity
    // ========================================================================

    /**
     * Entry point used by MainActivity from both onCreate() (cold start) and
     * onNewIntent() (warm start).
     *
     * Must be called on the main thread. Both lifecycle hooks satisfy this.
     *
     * @param intent the ACTION_VIEW intent that launched or re-launched the
     *               activity. May be null (defensive — Android never passes
     *               null to lifecycle methods, but a future caller might).
     */
    public static void deliverIntent(Intent intent) {
        List<Uri> uris = extractUris(intent);
        if (uris.isEmpty()) return;

        if (sInstance != null) {
            // Warm path — plugin is loaded, JS listener is attached.
            for (Uri uri : uris) sInstance.dispatch(uri);
        } else {
            // Cold path — plugin not yet loaded. Stash for getPendingFile.
            sPendingUris.addAll(uris);
        }
    }

    // ========================================================================
    // JS-callable methods
    // ========================================================================

    /**
     * JS-initiated: pop one cold-start URI and return it as a file payload.
     *
     * Called exactly once by viewer.js's _wireNativeFileOpen during the
     * initial plugin handshake. If nothing is pending (the common case for
     * a normal launcher tap), resolves with no payload.
     *
     * Resolves with:
     *   { path: string, name: string, mimeType: string|null, size: number }
     *
     * Rejects with:
     *   "Failed to read the launched file." — the URI is present but the
     *   stream could not be opened or copied. Usually means the source app
     *   has revoked read permission (rare) or the file was deleted between
     *   the intent being raised and this call being processed.
     */
    @PluginMethod
    public void getPendingFile(PluginCall call) {
        if (sPendingUris.isEmpty()) {
            call.resolve();
            return;
        }

        Uri uri = sPendingUris.remove(0);
        JSObject payload = materialise(uri);
        if (payload == null) {
            call.reject("Failed to read the launched file.");
            return;
        }
        call.resolve(payload);
    }

    // ========================================================================
    // Internals
    // ========================================================================

    /**
     * Pull every content:// URI out of an ACTION_VIEW intent.
     *
     * Two forms exist:
     *   • Single URI — the common case. Files, Gmail, and Chrome all use
     *     intent.setData(uri).
     *
     *   • Batched URIs — the user long-pressed multiple files and chose
     *     "Open with". The OS packages them into a ClipData. We accept all
     *     of them and let viewer.js show the first; supporting multi-file
     *     open is a future feature, not a current requirement.
     *
     * The action check is the guard that makes `deliverIntent(getIntent())`
     * safe to call unconditionally in MainActivity.onCreate. A normal
     * launcher tap produces an intent with action MAIN, which fails this
     * check and produces an empty URI list.
     */
    private static List<Uri> extractUris(Intent intent) {
        List<Uri> out = new ArrayList<>();
        if (intent == null) return out;
        if (!Intent.ACTION_VIEW.equals(intent.getAction())) return out;

        Uri single = intent.getData();
        if (single != null) out.add(single);

        if (intent.getClipData() != null) {
            int count = intent.getClipData().getItemCount();
            for (int i = 0; i < count; i++) {
                Uri u = intent.getClipData().getItemAt(i).getUri();
                if (u != null && !out.contains(u)) out.add(u);
            }
        }
        return out;
    }

    /**
     * Warm-start path: materialise the URI and emit it to JS immediately.
     * viewer.js's persistent 'fileOpen' listener handles delivery.
     *
     * Failures are silent — the plugin has no UI to show errors on, and the
     * user will simply see the app open without a document. If that becomes
     * a support burden, log to Logcat here.
     */
    private void dispatch(Uri uri) {
        JSObject payload = materialise(uri);
        if (payload != null) notifyListeners(EVENT_OPEN, payload);
    }

    /**
     * Copy the content:// stream into the app cache directory and return a
     * payload with an absolute local path.
     *
     * Streaming copy — reads 8 KB at a time from the source, writes 8 KB at
     * a time to the destination. Memory usage is constant regardless of file
     * size.
     *
     * Returns null on any failure. Callers treat null as "nothing to deliver"
     * and do not surface an error.
     */
    private JSObject materialise(Uri uri) {
        InputStream in = null;
        FileOutputStream out = null;
        try {
            in = getContext().getContentResolver().openInputStream(uri);
            if (in == null) return null;

            // Preserve the original extension so the viewer's MIME detection
            // (which falls back to filename extension when the Content-Type
            // header is absent) still works after the copy.
            String displayName = queryDisplayName(uri);
            String ext = "";
            int dot = displayName.lastIndexOf('.');
            if (dot >= 0) ext = displayName.substring(dot);

            File cacheDir = getContext().getCacheDir();
            File target = new File(cacheDir, "incoming-" + System.currentTimeMillis() + ext);
            out = new FileOutputStream(target);

            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);

            JSObject payload = new JSObject();
            payload.put("path", target.getAbsolutePath());
            payload.put("name", displayName);
            payload.put("mimeType", getContext().getContentResolver().getType(uri));
            payload.put("size", target.length());
            return payload;
        } catch (Exception e) {
            // Any failure — permission revoked mid-read, disk full, target
            // cache path unwritable, malformed URI — collapses to null.
            // Callers handle null by skipping delivery.
            return null;
        } finally {
            try { if (in != null) in.close(); } catch (Exception ignored) {}
            try { if (out != null) out.close(); } catch (Exception ignored) {}
        }
    }

    /**
     * Ask the ContentResolver for the original file's display name so the
     * payload carries the same filename the user saw in Files.
     *
     * Content URIs do not encode the filename in the URI itself; the name
     * lives in the provider's cursor, under OpenableColumns.DISPLAY_NAME.
     *
     * Falls back to "document" when the resolver cannot provide a name —
     * some providers (especially network-backed ones) do not expose it.
     * The file still loads; the viewer just shows a generic title.
     */
    private String queryDisplayName(Uri uri) {
        Cursor cursor = null;
        try {
            cursor = getContext().getContentResolver()
                .query(uri, null, null, null, null);
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String name = cursor.getString(idx);
                    if (name != null && !name.isEmpty()) return name;
                }
            }
        } catch (Exception ignored) {
            // fall through to the default
        } finally {
            try { if (cursor != null) cursor.close(); } catch (Exception ignored) {}
        }
        return "document";
    }

    /**
     * Delete any incoming-* files older than the given age from the cache
     * directory. Called on plugin load so it runs once per process start.
     *
     * Files opened in the current session are never deleted by this method
     * because they were just written — their lastModified timestamp is
     * within seconds of System.currentTimeMillis(), far below any age
     * threshold worth using.
     *
     * The prefix filter ("incoming-") is deliberate: it distinguishes our
     * files from anything else the WebView or a library may have cached
     * in the same directory.
     *
     * Best-effort. A failure to prune must not affect app startup, so every
     * exception is swallowed.
     *
     * @param maxAgeMs maximum file age in milliseconds (e.g. 24 * 60 * 60 * 1000)
     */
    private void pruneOldCacheFiles(long maxAgeMs) {
        try {
            File cacheDir = getContext().getCacheDir();
            File[] files = cacheDir.listFiles();
            if (files == null) return;

            long cutoff = System.currentTimeMillis() - maxAgeMs;
            for (File f : files) {
                if (f.getName().startsWith("incoming-") && f.lastModified() < cutoff) {
                    //noinspection ResultOfMethodCallIgnored
                    f.delete();
                }
            }
        } catch (Exception ignored) {
            // Best-effort. A failure to prune must not affect the launch.
        }
    }
}