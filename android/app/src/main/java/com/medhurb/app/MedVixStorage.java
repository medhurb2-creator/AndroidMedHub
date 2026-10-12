package com.medhurb.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Environment;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * MedVixStorage
 * ============================================================================
 *
 * Low-level file I/O bridge, exposed to the WebView as
 * window.MedVixStorage once MainActivity registers it.
 *
 * ─── STORAGE MODEL ──────────────────────────────────────────────────────────
 *
 * Three roots can exist on an Android device. The user picks which one
 * NEW writes go to. Reads check all three, so switching the preference
 * never strands an existing file.
 *
 *   internal — /data/data/com.medhurb.app/files/
 *              Default. Always available. Never visible in Files.
 *              Deleted by "clear app data". Fastest.
 *
 *   external — /storage/emulated/0/Android/data/com.medhurb.app/files/
 *              Android's EMULATED external storage. Lives on the same
 *              physical chip as internal on essentially every modern
 *              phone. Deleted by "clear app data". May appear in Files
 *              on Android 10 and below.
 *
 *   sdcard   — /storage/XXXX-XXXX/Android/data/com.medhurb.app/files/
 *              The REMOVABLE SD card's app-specific directory, obtained
 *              from Context.getExternalFilesDirs(). This is real,
 *              separate physical storage. Only present when a removable
 *              volume is mounted. Not deleted by "clear app data" for
 *              this app; IS deleted if the app is uninstalled while the
 *              card is inserted, or if the card is formatted elsewhere.
 *
 * Note on terminology: on most modern phones, "external" means emulated
 * external storage, which does NOT free up space on the device. Only
 * "sdcard" is a distinct physical volume. The old two-root model has
 * been extended rather than replaced — every existing method keeps its
 * signature and its behaviour for internal and external.
 *
 * ─── SWITCHING ROOTS ────────────────────────────────────────────────────────
 *
 * The switch is a two-phase operation driven from JavaScript:
 *
 *   Phase 1 — warn. JS reads getAvailableRoots() and shows a dialog:
 *             "This will move all downloaded content to the SD card.
 *              Do not eject the card or kill the app during the move."
 *
 *   Phase 2 — migrate. JS calls listFilesInRoot(sourceRoot, 'content'),
 *             then relocateToRoot(rel, 'sdcard') for each path. Progress
 *             is shown per file. If any file fails, JS can stop, roll
 *             back the preference, and report which items were not
 *             moved.
 *
 * The preference is only updated AFTER migration completes. Until then,
 * new writes keep going to the old root. Reads never fail because all
 * three roots are always checked.
 *
 * ─── PATH MODEL ─────────────────────────────────────────────────────────────
 *
 * Every method takes a RELATIVE path:
 *
 *     content/resources/textbooks/robins-pathology/document.pdf
 *     cache/thumbnails/robins-pathology.jpg
 *     system/layout.json
 *
 * The DB never stores an absolute path. The same install works whether
 * the active root is internal, external, or sdcard.
 *
 * ─── READ STRATEGY ──────────────────────────────────────────────────────────
 *
 * Two read paths for binary data, chosen by the caller based on file
 * size. Both return Base64 because the Android WebView bridge
 * (addJavascriptInterface) can only marshal JSON-compatible primitives
 * across the boundary — no byte[], no Blob, no ArrayBuffer.
 *
 *   Small files (< ~30 MB)  →  readBase64(relativePath)
 *     Single call. Returns the whole file as one Base64 string. Cost is
 *     4× the file size at peak: Java byte[] + Base64 string + JS string
 *     + decoded Uint8Array. Above 30 MB this exhausts the WebView
 *     renderer heap on most devices.
 *
 *   Large files (up to ~200 MB)  →  fileSize() + readBase64Range()
 *     The caller loops over [0, fileSize) in fixed-size windows,
 *     decodes each window, and appends to a Blob. Java-side allocation
 *     is bounded to CHUNK_BYTES per call; JS-side peak is one chunk's
 *     worth of working memory plus the accumulating Blob (which
 *     Chromium spills to disk for large inputs). The ceiling here is
 *     the renderer's pre-spill buffer, not the file size.
 *
 * Above ~200 MB the WebView bridge cannot deliver the bytes into JS at
 * all — the renderer OOMs during accumulation. Files that large must be
 * served via a local HTTP range endpoint so PDF.js can stream, which is
 * a separate native component (see project notes on PdfRangeServer).
 *
 * ─── SECURITY ───────────────────────────────────────────────────────────────
 *
 * Every path is canonicalized and refused if it escapes the root.
 * getCanonicalFile() defeats "..", "~", and symlink tricks.
 *
 * App-specific external storage (both emulated "external" and the
 * removable "sdcard" root) is private to the app on Android 11+. On
 * Android 10 and below, other apps with legacy READ_EXTERNAL_STORAGE
 * may be able to read it. Do not store credentials, tokens, or
 * encryption keys in any external root — those belong in internal.
 *
 * ─── ERROR MODEL ────────────────────────────────────────────────────────────
 *
 * Every method returns a primitive sentinel on failure (-1, false, "",
 * "[]", "unavailable"). No exceptions cross the bridge.
 */
public class MedVixStorage {

    private static final String PREFS_NAME    = "medvix_storage";
    private static final String PREF_KEY_ROOT = "preferred_root";

    // Root type identifiers. These strings cross the JS boundary and are
    // stored in SharedPreferences — do not change them without a
    // migration, or existing user preferences will be ignored.
    public static final String ROOT_INTERNAL = "internal";
    public static final String ROOT_EXTERNAL = "external";
    public static final String ROOT_SDCARD   = "sdcard";

    private final Context context;

    public MedVixStorage(Context context) {
        this.context = context.getApplicationContext();
    }

    // =========================================================================
    // Root preference
    // =========================================================================

    /**
     * Which root new writes go to. Reports the ACTUAL root in use, not
     * the stored preference — if the user chose "sdcard" but no card is
     * inserted, this returns "internal" so callers get the truth.
     *
     * Returns "internal" | "external" | "sdcard".
     */
    @JavascriptInterface
    public String getPreferredRoot() {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String pref = prefs.getString(PREF_KEY_ROOT, ROOT_INTERNAL);

            if (ROOT_SDCARD.equals(pref)) {
                if (getSdCardRoot() != null) return ROOT_SDCARD;
                // Chose sdcard, card missing — fall through to internal.
                return ROOT_INTERNAL;
            }
            if (ROOT_EXTERNAL.equals(pref)) {
                if (getExternalRoot() != null) return ROOT_EXTERNAL;
                return ROOT_INTERNAL;
            }
            return ROOT_INTERNAL;
        } catch (Exception e) {
            return ROOT_INTERNAL;
        }
    }

    /**
     * Set the root preference. Called AFTER a successful migration, not
     * before — see the class docstring.
     *
     * Takes effect immediately for new writes. Does not move existing
     * files.
     *
     * Returns false if:
     *   • type is not one of "internal", "external", "sdcard"
     *   • type is "external" but emulated external storage is absent
     *   • type is "sdcard" but no removable volume is mounted
     */
    @JavascriptInterface
    public boolean setPreferredRoot(String type) {
        if (!ROOT_INTERNAL.equals(type)
                && !ROOT_EXTERNAL.equals(type)
                && !ROOT_SDCARD.equals(type)) {
            return false;
        }
        if (ROOT_SDCARD.equals(type) && getSdCardRoot() == null) {
            return false;
        }
        if (ROOT_EXTERNAL.equals(type) && getExternalRoot() == null) {
            return false;
        }
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(PREF_KEY_ROOT, type).apply();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Absolute path of the current write root. "" if unavailable.
     */
    @JavascriptInterface
    public String getRoot() {
        File root = getWriteRoot();
        return root != null ? root.getAbsolutePath() : "";
    }

    /**
     * Type of the current write root.
     * "internal" | "external" | "sdcard" | "unavailable"
     */
    @JavascriptInterface
    public String getRootType() {
        try {
            String actual = getPreferredRoot();
            if (ROOT_SDCARD.equals(actual))   return ROOT_SDCARD;
            if (ROOT_EXTERNAL.equals(actual)) return ROOT_EXTERNAL;
            if (context.getFilesDir() != null) return ROOT_INTERNAL;
            return "unavailable";
        } catch (Exception e) {
            return "unavailable";
        }
    }

    @JavascriptInterface
    public boolean isAvailable() {
        return getWriteRoot() != null;
    }

    /**
     * Every root MedVix can use, with metadata. For the Settings →
     * Storage UI.
     *
     * Returns JSON:
     *   [
     *     {
     *       "type":      "internal" | "external" | "sdcard",
     *       "path":      string,
     *       "available": boolean,
     *       "removable": boolean,
     *       "freeBytes": number,
     *       "isCurrent": boolean,
     *       "volumeId":  string
     *     },
     *     ...
     *   ]
     *
     * "sdcard" only appears when a removable volume is mounted. Devices
     * without an SD card see two entries.
     */
    @JavascriptInterface
    public String getAvailableRoots() {
        JSONArray out = new JSONArray();
        String current = getRootType();

        try {
            File internal = context.getFilesDir();
            JSONObject i = new JSONObject();
            i.put("type",      ROOT_INTERNAL);
            i.put("path",      internal != null ? internal.getAbsolutePath() : "");
            i.put("available", internal != null);
            i.put("removable", false);
            i.put("freeBytes", internal != null ? internal.getFreeSpace() : 0L);
            i.put("isCurrent", ROOT_INTERNAL.equals(current));
            i.put("volumeId",  ROOT_INTERNAL);
            out.put(i);
        } catch (Exception ignored) {}

        try {
            File external = context.getExternalFilesDir(null);
            JSONObject e = new JSONObject();
            e.put("type",      ROOT_EXTERNAL);
            e.put("path",      external != null ? external.getAbsolutePath() : "");
            e.put("available", external != null);
            e.put("removable", false);
            e.put("freeBytes", external != null ? external.getFreeSpace() : 0L);
            e.put("isCurrent", ROOT_EXTERNAL.equals(current));
            e.put("volumeId",  external != null ? stableVolumeId(external, false) : "");
            out.put(e);
        } catch (Exception ignored) {}

        try {
            File sd = getSdCardRoot();
            if (sd != null) {
                JSONObject s = new JSONObject();
                s.put("type",      ROOT_SDCARD);
                s.put("path",      sd.getAbsolutePath());
                s.put("available", true);
                s.put("removable", true);
                s.put("freeBytes", sd.getFreeSpace());
                s.put("isCurrent", ROOT_SDCARD.equals(current));
                s.put("volumeId",  stableVolumeId(sd, true));
                out.put(s);
            }
        } catch (Exception ignored) {}

        return out.toString();
    }

    // =========================================================================
    // Directories
    // =========================================================================

    @JavascriptInterface
    public boolean createDirectory(String relativePath) {
        File f = resolveWrite(relativePath);
        if (f == null) return false;
        return f.exists() || f.mkdirs() || f.exists();
    }

    @JavascriptInterface
    public boolean exists(String relativePath) {
        File f = resolveRead(relativePath);
        return f != null && f.exists();
    }

    @JavascriptInterface
    public boolean isDirectory(String relativePath) {
        File f = resolveRead(relativePath);
        return f != null && f.isDirectory();
    }

    @JavascriptInterface
    public boolean isFile(String relativePath) {
        File f = resolveRead(relativePath);
        return f != null && f.isFile();
    }

    /**
     * Immediate children of a directory in the WRITE root.
     *
     * Returns JSON: [{"name":"...","isDirectory":true,"size":0,"lastModified":0}]
     * "[]" on failure.
     */
    @JavascriptInterface
    public String listDirectory(String relativePath) {
        File dir = resolveWrite(relativePath);
        if (dir == null || !dir.isDirectory()) return "[]";

        File[] children = dir.listFiles();
        if (children == null) return "[]";

        JSONArray out = new JSONArray();
        for (File child : children) {
            try {
                JSONObject entry = new JSONObject();
                entry.put("name",         child.getName());
                entry.put("isDirectory",  child.isDirectory());
                entry.put("size",         child.isFile() ? child.length() : 0L);
                entry.put("lastModified", child.lastModified());
                out.put(entry);
            } catch (Exception ignored) {}
        }
        return out.toString();
    }

    /**
     * Recursively list every FILE under `subpath` in the given root.
     *
     * Used for migration. Returns relative paths (relative to that
     * root's base), one per file, so the JS side can iterate and call
     * relocateToRoot() per item.
     *
     * Accepts "internal", "external", or "sdcard". Returns "[]" if the
     * root is unavailable, the subpath does not exist, or an I/O error
     * occurs.
     *
     * Returns JSON: ["content/resources/textbooks/robins/document.pdf", ...]
     */
    @JavascriptInterface
    public String listFilesInRoot(String rootType, String subpath) {
        File root = getRootByType(rootType);
        if (root == null) return "[]";

        String trimmed = (subpath == null || subpath.trim().isEmpty()) ? "" : subpath.trim();
        File start = resolveAgainst(root, trimmed.isEmpty() ? "." : trimmed);
        if (start == null || !start.exists()) return "[]";

        JSONArray out = new JSONArray();
        collectFilesRecursive(root, start, out);
        return out.toString();
    }

    /**
     * Recursive size of a directory in the WRITE root.
     * -1 if the path does not exist.
     */
    @JavascriptInterface
    public long getDirectorySize(String relativePath) {
        File f = resolveWrite(relativePath);
        if (f == null || !f.exists()) return -1L;
        if (f.isFile()) return f.length();
        return directorySizeRecursive(f);
    }

    /**
     * Recursive size of a directory in the given root.
     * -1 if the path does not exist or the root is unavailable.
     */
    @JavascriptInterface
    public long getDirectorySizeInRoot(String rootType, String subpath) {
        File root = getRootByType(rootType);
        if (root == null) return -1L;
        File target = resolveAgainst(root, subpath);
        if (target == null || !target.exists()) return -1L;
        if (target.isFile()) return target.length();
        return directorySizeRecursive(target);
    }

    // =========================================================================
    // File inspection
    // =========================================================================

    @JavascriptInterface
    public long size(String relativePath) {
        File f = resolveRead(relativePath);
        if (f == null || !f.isFile()) return -1L;
        return f.length();
    }

    @JavascriptInterface
    public long lastModified(String relativePath) {
        File f = resolveRead(relativePath);
        if (f == null || !f.exists()) return -1L;
        return f.lastModified();
    }

    // =========================================================================
    // Delete
    // =========================================================================

    @JavascriptInterface
    public boolean deleteFile(String relativePath) {
        File f = resolveRead(relativePath);
        return f != null && f.isFile() && f.delete();
    }

    @JavascriptInterface
    public boolean deleteDirectory(String relativePath) {
        File f = resolveRead(relativePath);
        if (f == null || !f.isDirectory()) return false;
        return deleteRecursive(f);
    }

    // =========================================================================
    // Move
    // =========================================================================

    /**
     * Rename or move within the WRITE root. Refuses to overwrite.
     */
    @JavascriptInterface
    public boolean move(String fromRelative, String toRelative) {
        File from = resolveWrite(fromRelative);
        File to   = resolveWrite(toRelative);
        if (from == null || to == null || !from.exists()) return false;

        try {
            File parent = to.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
                return false;
            }
            if (to.exists()) return false;
            return moveFile(from, to);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Move a single file from whichever root currently has it to the
     * OTHER root. Retained for backwards compatibility with the pre-
     * sdcard migration UI; its semantics are now "internal ↔ external"
     * only.
     *
     * New code should prefer relocateToRoot(rel, "sdcard") or
     * relocateToRoot(rel, "internal"), which accept the target root
     * explicitly.
     *
     * The file's relative path is preserved. Empty parent directories
     * under the old root are not cleaned up automatically — JS can do
     * that with deleteDirectory() after migration completes if desired.
     *
     * Returns true on success. Returns false if the path does not exist
     * in either root, or if the destination already exists, or on I/O
     * failure.
     */
    @JavascriptInterface
    public boolean relocateToOtherRoot(String relativePath) {
        if (relativePath == null) return false;
        String trimmed = relativePath.trim();
        if (trimmed.isEmpty()) return false;

        File internalRoot = getInternalRoot();
        File externalRoot = getExternalRoot();
        if (internalRoot == null || externalRoot == null) return false;

        // Find the file in one of the two roots.
        File source = resolveAgainst(internalRoot, trimmed);
        File destRoot = externalRoot;
        if (source == null || !source.exists()) {
            source = resolveAgainst(externalRoot, trimmed);
            destRoot = internalRoot;
            if (source == null || !source.exists()) return false;
        }

        File dest = resolveAgainst(destRoot, trimmed);
        if (dest == null) return false;

        try {
            File parent = dest.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
                return false;
            }
            if (dest.exists()) return false;
            return moveFile(source, dest);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Move a single file from whichever root currently holds it to the
     * specified target root. The relative path is preserved.
     *
     * Target must be "internal", "external", or "sdcard". Returns false
     * if:
     *   • the file is not found in any root other than the target,
     *   • the target root is unavailable (e.g. "sdcard" with no card),
     *   • the destination already exists (no overwrite),
     *   • or the underlying move fails.
     *
     * Cross-mount moves fall back to copy + size-verify + delete. A
     * partial copy never survives — the destination is deleted if
     * verification fails.
     *
     * Intended to be called once per file during a root migration.
     */
    @JavascriptInterface
    public boolean relocateToRoot(String relativePath, String targetRootType) {
        if (relativePath == null || targetRootType == null) return false;
        String trimmed = relativePath.trim();
        if (trimmed.isEmpty()) return false;

        File destRoot = getRootByType(targetRootType);
        if (destRoot == null) return false;

        // Find the file in any non-target root.
        File source = null;
        for (File root : getAllRootsOrdered()) {
            if (root == null) continue;
            if (root.equals(destRoot)) continue;
            File candidate = resolveAgainst(root, trimmed);
            if (candidate != null && candidate.exists()) {
                source = candidate;
                break;
            }
        }
        if (source == null) return false;

        File dest = resolveAgainst(destRoot, trimmed);
        if (dest == null) return false;

        try {
            File parent = dest.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
                return false;
            }
            if (dest.exists()) return false;
            return moveFile(source, dest);
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * True if the file at relativePath currently lives in targetRootType.
     *
     * Used by migration to skip files already in the destination — cheap
     * idempotency check that lets a migration be resumed after a crash
     * without re-doing completed work.
     *
     * Returns false if the root is unavailable, the path is invalid, or
     * the file is not present there.
     */
    @JavascriptInterface
    public boolean fileInRoot(String relativePath, String targetRootType) {
        if (relativePath == null || targetRootType == null) return false;
        String trimmed = relativePath.trim();
        if (trimmed.isEmpty()) return false;

        File root = getRootByType(targetRootType);
        if (root == null) return false;
        File f = resolveAgainst(root, trimmed);
        return f != null && f.exists();
    }

    // =========================================================================
    // Binary write / read
    // =========================================================================

    @JavascriptInterface
    public boolean writeBase64(String relativePath, String base64, boolean append) {
        File f = resolveWrite(relativePath);
        if (f == null) return false;

        try {
            File parent = f.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
                return false;
            }
            byte[] data = Base64.getDecoder().decode(base64);
            try (FileOutputStream out = new FileOutputStream(f, append)) {
                out.write(data);
                out.flush();
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Read a whole file as Base64.
     *
     * Safe up to roughly 30 MB on typical Android WebView renderers —
     * peak cost is 4× file size (Java byte[] + Base64 string + JS string
     * + decoded Uint8Array). For anything larger, use the chunked pair
     * fileSize() + readBase64Range().
     *
     * Returns "" on failure or if the file exceeds Integer.MAX_VALUE bytes.
     */
    @JavascriptInterface
    public String readBase64(String relativePath) {
        File f = resolveRead(relativePath);
        if (f == null || !f.isFile()) return "";

        try {
            long len = f.length();
            if (len <= 0 || len > Integer.MAX_VALUE) return "";

            byte[] buf = new byte[(int) len];
            try (FileInputStream in = new FileInputStream(f)) {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n < 0) break;
                    off += n;
                }
                if (off < buf.length) {
                    byte[] trimmed = new byte[off];
                    System.arraycopy(buf, 0, trimmed, 0, off);
                    buf = trimmed;
                }
            }
            return Base64.getEncoder().encodeToString(buf);
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * Size of a file in bytes.
     *
     * Returns -1 if the path does not resolve to a regular file. Pairs
     * with readBase64Range() as the entry point for chunked reads.
     */
    @JavascriptInterface
    public long fileSize(String relativePath) {
        File f = resolveRead(relativePath);
        if (f == null || !f.isFile()) return -1L;
        return f.length();
    }

    /**
     * Read a byte range from a file and return it as Base64.
     *
     * Chunked reads let the WebView open files larger than the single-
     * shot readBase64() ceiling (~30 MB) without exhausting the renderer
     * heap. The caller loops over [0, fileSize) in fixed-size windows,
     * decodes each window, and appends to a Blob. Java-side allocation
     * is bounded to `length` bytes per call; JS-side working memory is
     * one chunk + the accumulating Blob.
     *
     * Range semantics:
     *   relativePath null or resolves to non-file  → ""
     *   offset < 0 or length <= 0                  → ""
     *   offset >= fileSize                         → "" (empty range)
     *   offset + length > fileSize                 → clamp to fileSize
     *   length > Integer.MAX_VALUE                 → clamp to Int max
     *
     * Uses RandomAccessFile so a single call reads only the requested
     * window — the file is not materialized in memory. Short reads
     * (file truncated between fileSize() and readBase64Range()) are
     * trimmed to actual bytes so callers never receive zero padding.
     *
     * Returns Base64.NO_WRAP-style output (java.util.Base64 encoder
     * default has no line breaks) or "" on failure. Never throws.
     */
    @JavascriptInterface
    public String readBase64Range(String relativePath, long offset, long length) {
        if (relativePath == null) return "";

        File file = resolveRead(relativePath);
        if (file == null || !file.isFile()) return "";
        if (offset < 0 || length <= 0) return "";

        long fileLen = file.length();
        if (offset >= fileLen) return "";

        long effective = Math.min(length, fileLen - offset);
        int toRead = (int) Math.min(effective, Integer.MAX_VALUE);
        if (toRead <= 0) return "";

        try (RandomAccessFile raf = new RandomAccessFile(file, "r")) {
            raf.seek(offset);
            byte[] buf = new byte[toRead];
            int read = 0;
            while (read < toRead) {
                int n = raf.read(buf, read, toRead - read);
                if (n < 0) break;
                read += n;
            }
            if (read < toRead) {
                // File shrank under us between fileSize() and this call.
                // Trim to actual bytes so the caller never sees zero padding.
                byte[] trimmed = new byte[read];
                System.arraycopy(buf, 0, trimmed, 0, read);
                buf = trimmed;
            }
            return Base64.getEncoder().encodeToString(buf);
        } catch (Exception e) {
            return "";
        }
    }

    // =========================================================================
    // Text write / read
    // =========================================================================

    @JavascriptInterface
    public boolean writeText(String relativePath, String text) {
        File f = resolveWrite(relativePath);
        if (f == null) return false;

        try {
            File parent = f.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
                return false;
            }
            try (FileOutputStream out = new FileOutputStream(f, false)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public String readText(String relativePath) {
        File f = resolveRead(relativePath);
        if (f == null || !f.isFile()) return "";

        try {
            long len = f.length();
            if (len <= 0 || len > Integer.MAX_VALUE) return "";

            byte[] buf = new byte[(int) len];
            try (FileInputStream in = new FileInputStream(f)) {
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n < 0) break;
                    off += n;
                }
                if (off < buf.length) {
                    byte[] trimmed = new byte[off];
                    System.arraycopy(buf, 0, trimmed, 0, off);
                    buf = trimmed;
                }
            }
            return new String(buf, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    // =========================================================================
    // Root resolution
    // =========================================================================

    private File getInternalRoot() {
        try { return context.getFilesDir(); } catch (Exception e) { return null; }
    }

    private File getExternalRoot() {
        try { return context.getExternalFilesDir(null); } catch (Exception e) { return null; }
    }

    /**
     * The removable SD card's app-specific files directory, or null if
     * no removable volume is mounted.
     *
     * Uses getExternalFilesDirs(), which returns every app-specific
     * external dir the platform exposes. Index 0 is always the primary
     * shared storage. Any further non-null entry corresponds to a
     * secondary volume — on consumer devices that is the SD card, or
     * occasionally an OTG drive.
     *
     * Removability is determined per entry, not by index, so a device
     * that exposes three volumes (e.g. two SIM storage partitions plus
     * an SD card) still resolves the SD card correctly. Devices with no
     * SD card simply have no removable entry.
     *
     * Cached per call rather than across calls: an SD card can be
     * ejected and re-inserted between two bridge invocations, and a
     * stale cached File would silently point at an unmounted path.
     */
    private File getSdCardRoot() {
        File[] dirs;
        try {
            dirs = context.getExternalFilesDirs(null);
        } catch (Exception e) {
            return null;
        }
        if (dirs == null) return null;

        for (File dir : dirs) {
            if (dir == null) continue;
            if (!dir.exists() && !dir.mkdirs() && !dir.exists()) continue;
            if (isRemovableVolume(dir)) return dir;
        }
        return null;
    }

    /**
     * All roots in the order used by resolveRead(): internal first, then
     * external, then sdcard. Null entries for unavailable roots are
     * still present so callers do not need to filter — every consumer
     * null-checks before use.
     */
    private List<File> getAllRootsOrdered() {
        List<File> out = new ArrayList<>(3);
        out.add(getInternalRoot());
        out.add(getExternalRoot());
        out.add(getSdCardRoot());
        return out;
    }

    /**
     * Resolve a root type string to its File, or null if unavailable.
     */
    private File getRootByType(String type) {
        if (ROOT_INTERNAL.equals(type)) return getInternalRoot();
        if (ROOT_EXTERNAL.equals(type)) return getExternalRoot();
        if (ROOT_SDCARD.equals(type))   return getSdCardRoot();
        return null;
    }

    /**
     * The root that NEW writes go to. Prefers the user's choice if it
     * is currently available; otherwise falls back to internal, which
     * is always available.
     */
    private File getWriteRoot() {
        String pref = getPreferredRoot();
        if (ROOT_SDCARD.equals(pref)) {
            File sd = getSdCardRoot();
            if (sd != null) return sd;
        } else if (ROOT_EXTERNAL.equals(pref)) {
            File ext = getExternalRoot();
            if (ext != null) return ext;
        }
        return getInternalRoot();
    }

    /**
     * For writes. Resolves against the write root only.
     */
    private File resolveWrite(String relativePath) {
        return resolveAgainst(getWriteRoot(), relativePath);
    }

    /**
     * For reads and deletes. Tries the write root first, then every
     * other available root.
     *
     * This is what makes preference changes non-destructive: a file
     * downloaded to internal remains readable after the user switches
     * to sdcard, and vice versa. A file left on the SD card after the
     * user switches to internal remains readable until the card is
     * ejected.
     */
    private File resolveRead(String relativePath) {
        if (relativePath == null) return null;
        String trimmed = relativePath.trim();
        if (trimmed.isEmpty()) return null;

        File writeRoot = getWriteRoot();
        File found = resolveAgainst(writeRoot, trimmed);
        if (found != null && found.exists()) return found;

        for (File root : getAllRootsOrdered()) {
            if (root == null) continue;
            if (writeRoot != null && root.equals(writeRoot)) continue;
            File candidate = resolveAgainst(root, trimmed);
            if (candidate != null && candidate.exists()) return candidate;
        }

        // Nothing on disk yet — return the write-root path so callers
        // that create on demand get the right location.
        return found;
    }

    // =========================================================================
    // Removable volume detection
    // =========================================================================

    /**
     * Decide whether the storage volume containing appDir is removable.
     *
     * API 30+ : match against StorageManager.getStorageVolumes() by
     *           directory, then read StorageVolume.isRemovable().
     *           getDirectory() is public on API 30+.
     *
     * API 24-29: StorageVolume has no public getDirectory(). Use
     *           Environment.isExternalStorageRemovable(File), which
     *           takes a File contained in a volume and reports whether
     *           that volume is removable. Deprecated on API 30+ but
     *           accurate on the API range where it is used.
     *
     * API < 24 : only Environment.isExternalStorageRemovable is
     *           available. Same code path as 24-29.
     *
     * Returns false on any failure — a false negative (calling a
     * removable volume non-removable) is far safer than a false
     * positive (treating the primary internal partition as removable
     * and offering to move user data to it).
     */
    private boolean isRemovableVolume(File appDir) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                StorageManager sm = (StorageManager)
                        context.getSystemService(Context.STORAGE_SERVICE);
                if (sm != null) {
                    for (StorageVolume sv : sm.getStorageVolumes()) {
                        File svDir = sv.getDirectory();
                        if (svDir == null) continue;
                        if (pathContains(svDir, appDir)) {
                            return sv.isRemovable();
                        }
                    }
                }
            } catch (Exception ignored) {
                // Fall through to the heuristic below.
            }
        }
        return legacyIsRemovable(appDir);
    }

    @SuppressWarnings("deprecation")
    private boolean legacyIsRemovable(File appDir) {
        try {
            return Environment.isExternalStorageRemovable(appDir);
        } catch (Exception e) {
            // Last resort: if this dir is not the primary external dir,
            // treat it as removable. Only reached if the Environment API
            // itself threw — never on a normal device.
            File primary = getExternalRoot();
            if (primary == null) return false;
            try {
                return !primary.getCanonicalPath().equals(appDir.getCanonicalPath());
            } catch (IOException ignored) {
                return false;
            }
        }
    }

    /**
     * True if `child` is `parent` or lies beneath it, after canonical
     * path resolution. Used to match an app-specific directory to its
     * containing StorageVolume.
     */
    private boolean pathContains(File parent, File child) {
        try {
            String p = parent.getCanonicalPath();
            String c = child.getCanonicalPath();
            return c.equals(p) || c.startsWith(p + File.separator);
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * A stable identifier for the volume containing this file.
     *
     * Uses StorageVolume.getUuid() (API 24+) when a matching volume can
     * be found. Falls back to the volume mount path — stable for the
     * life of the mount, useful for logging and metadata, but not
     * guaranteed across reboot on every OEM.
     *
     * Never used to resolve files. Only reported to JavaScript and
     * stored as resource metadata alongside relativePath.
     */
    private String stableVolumeId(File appDir, boolean removable) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                StorageManager sm = (StorageManager)
                        context.getSystemService(Context.STORAGE_SERVICE);
                if (sm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    for (StorageVolume sv : sm.getStorageVolumes()) {
                        File svDir = sv.getDirectory();
                        if (svDir == null) continue;
                        if (pathContains(svDir, appDir)) {
                            String uuid = sv.getUuid();
                            return uuid != null ? uuid : "path:" + svDir.getAbsolutePath();
                        }
                    }
                }
            } catch (Exception ignored) {}
        }
        try {
            File root = findVolumeRoot(appDir);
            if (root != null) return "path:" + root.getCanonicalPath();
        } catch (IOException ignored) {}
        return removable ? "removable:unknown" : "primary:unknown";
    }

    /**
     * Walk up from an app-specific external directory to the volume
     * root — the parent of the "Android" directory.
     *
     * Example input:  /storage/1234-5678/Android/data/com.medhurb.app/files
     * Example output: /storage/1234-5678
     */
    private File findVolumeRoot(File appDir) {
        File cur = appDir;
        while (cur != null) {
            if ("data".equals(cur.getName())
                    && cur.getParentFile() != null
                    && "Android".equals(cur.getParentFile().getName())) {
                return cur.getParentFile().getParentFile();
            }
            cur = cur.getParentFile();
        }
        return null;
    }

    // =========================================================================
    // Path safety
    // =========================================================================

    /**
     * Canonicalize `relativePath` against `root` and refuse anything
     * that escapes it.
     */
    private File resolveAgainst(File root, String relativePath) {
        if (root == null || relativePath == null) return null;
        String trimmed = relativePath.trim();
        if (trimmed.isEmpty()) return null;

        try {
            File target = new File(root, trimmed).getCanonicalFile();
            String rootPath   = root.getCanonicalFile().getPath();
            String targetPath = target.getPath();

            if (!targetPath.equals(rootPath)
                    && !targetPath.startsWith(rootPath + File.separator)) {
                return null;
            }
            return target;
        } catch (Exception e) {
            return null;
        }
    }

    // =========================================================================
    // File operations
    // =========================================================================

    /**
     * Move a file or directory. Tries renameTo first — works within the
     * same mount point. If that fails (internal, external, and SD card
     * are typically on different mount points), falls back to
     * copy + size-verify + delete. Cleans up partial copies on failure.
     */
    private boolean moveFile(File from, File to) {
        if (from.renameTo(to)) return true;

        // Cross-mount fallback: copy then delete.
        boolean copied = false;
        try {
            if (from.isDirectory()) {
                copyDirectoryRecursive(from, to);
            } else {
                copyFile(from, to);
            }
            copied = true;
        } catch (Exception e) {
            // Clean up whatever partial data landed at dest.
            if (to.exists()) {
                try { deleteRecursive(to); } catch (Exception ignored) {}
            }
            return false;
        }

        if (!copied) return false;

        // Delete the source now that the copy is verified by size.
        long srcSize = from.isDirectory() ? directorySizeRecursive(from) : from.length();
        long dstSize = to.isDirectory()   ? directorySizeRecursive(to)   : to.length();
        if (srcSize != dstSize) {
            try { deleteRecursive(to); } catch (Exception ignored) {}
            return false;
        }

        return deleteRecursive(from);
    }

    private void copyFile(File from, File to) throws IOException {
        File parent = to.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) {
            throw new IOException("Could not create parent dirs");
        }
        try (FileInputStream in = new FileInputStream(from);
             FileOutputStream out = new FileOutputStream(to)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
            out.flush();
        }
    }

    private void copyDirectoryRecursive(File from, File to) throws IOException {
        if (!to.exists() && !to.mkdirs() && !to.exists()) {
            throw new IOException("Could not create dir: " + to.getPath());
        }
        File[] children = from.listFiles();
        if (children == null) return;
        for (File child : children) {
            File target = new File(to, child.getName());
            if (child.isDirectory()) {
                copyDirectoryRecursive(child, target);
            } else {
                copyFile(child, target);
            }
        }
    }

    private boolean deleteRecursive(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    if (!deleteRecursive(child)) return false;
                }
            }
        }
        return file.delete();
    }

    private long directorySizeRecursive(File file) {
        if (file.isFile()) return file.length();
        if (!file.isDirectory()) return 0L;

        long total = 0L;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                total += directorySizeRecursive(child);
            }
        }
        return total;
    }

    /**
     * Recursively collect every file under `current` into `out`, using
     * paths relative to `root`.
     */
    private void collectFilesRecursive(File root, File current, JSONArray out) {
        if (current.isFile()) {
            try {
                String rel = relativize(root, current);
                if (rel != null) out.put(rel);
            } catch (Exception ignored) {}
            return;
        }
        if (!current.isDirectory()) return;

        File[] children = current.listFiles();
        if (children == null) return;
        for (File child : children) {
            collectFilesRecursive(root, child, out);
        }
    }

    private String relativize(File root, File target) {
        try {
            String rootPath   = root.getCanonicalFile().getPath();
            String targetPath = target.getCanonicalFile().getPath();
            if (!targetPath.startsWith(rootPath + File.separator)) return null;
            String rel = targetPath.substring(rootPath.length() + 1);
            // Normalize separators to forward slash for JS.
            return rel.replace(File.separatorChar, '/');
        } catch (Exception e) {
            return null;
        }
    }
}