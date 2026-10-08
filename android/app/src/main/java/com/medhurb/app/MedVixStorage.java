package com.medhurb.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

/**
 * MedVixStorage
 * ============================================================================
 *
 * Low-level file I/O bridge, exposed to the WebView as
 * window.MedVixStorage once MainActivity registers it.
 *
 * ─── STORAGE MODEL ──────────────────────────────────────────────────────────
 *
 * Two roots exist on every Android device. The user picks which one NEW
 * writes go to. Reads check both, so switching the preference never
 * strands an existing file.
 *
 *   internal — /data/data/com.medhurb.app/files/
 *              Default. Always available. Never visible in Files.
 *              Survives "clear app data". Fastest.
 *
 *   external — /storage/emulated/0/Android/data/com.medhurb.app/files/
 *              Chosen when the user wants to move data off internal
 *              storage. Deleted by "clear app data". May appear in
 *              Files on Android 10 and below.
 *
 * Note on terminology: on most modern phones, "external" here means
 * Android's emulated external storage, which lives on the same physical
 * chip as internal. It is not a removable SD card. If the user later
 * wants true SD-card storage, that's a third root and a separate change.
 * The methods here are agnostic — they operate on whichever two roots
 * the platform exposes.
 *
 * ─── SWITCHING ROOTS ────────────────────────────────────────────────────────
 *
 * The switch is a two-phase operation driven from JavaScript:
 *
 *   Phase 1 — warn. JS reads getAvailableRoots() and shows a dialog:
 *             "This will move all downloaded content to external storage.
 *              Do not eject the card or kill the app during the move."
 *
 *   Phase 2 — migrate. JS calls listFilesInRoot(sourceRoot, 'content'),
 *             then relocateToOtherRoot(rel) for each path. Progress is
 *             shown per file. If any file fails, JS can stop, roll back
 *             the preference, and report which items were not moved.
 *
 * The preference is only updated AFTER migration completes. Until then,
 * new writes keep going to the old root. Reads never fail because both
 * roots are always checked.
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
 * the active root is internal or external.
 *
 * ─── SECURITY ───────────────────────────────────────────────────────────────
 *
 * Every path is canonicalized and refused if it escapes the root.
 * getCanonicalFile() defeats "..", "~", and symlink tricks.
 *
 * ─── ERROR MODEL ────────────────────────────────────────────────────────────
 *
 * Every method returns a primitive sentinel on failure (-1, false, "",
 * "[]", "unavailable"). No exceptions cross the bridge.
 */
public class MedVixStorage {

    private static final String PREFS_NAME    = "medvix_storage";
    private static final String PREF_KEY_ROOT = "preferred_root";
    private static final String ROOT_INTERNAL = "internal";
    private static final String ROOT_EXTERNAL = "external";

    private final Context context;

    public MedVixStorage(Context context) {
        this.context = context.getApplicationContext();
    }

    // =========================================================================
    // Root preference
    // =========================================================================

    /**
     * Which root new writes go to.
     * Returns "internal" or "external".
     */
    @JavascriptInterface
    public String getPreferredRoot() {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String pref = prefs.getString(PREF_KEY_ROOT, ROOT_INTERNAL);
            if (ROOT_EXTERNAL.equals(pref)) {
                // Report internal if external is currently unavailable —
                // this matches what getWriteRoot() actually does.
                if (context.getExternalFilesDir(null) == null) return ROOT_INTERNAL;
                return ROOT_EXTERNAL;
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
     */
    @JavascriptInterface
    public boolean setPreferredRoot(String type) {
        if (!ROOT_INTERNAL.equals(type) && !ROOT_EXTERNAL.equals(type)) {
            return false;
        }
        if (ROOT_EXTERNAL.equals(type) && context.getExternalFilesDir(null) == null) {
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
     * "internal" | "external" | "unavailable"
     */
    @JavascriptInterface
    public String getRootType() {
        try {
            String pref = getPreferredRoot();
            if (ROOT_EXTERNAL.equals(pref) && context.getExternalFilesDir(null) != null) {
                return ROOT_EXTERNAL;
            }
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
     * Both roots and their free space. For the Settings → Storage UI.
     *
     * Returns JSON:
     *   [
     *     { "type": "internal", "path": "...", "available": true, "freeBytes": 12345678, "isCurrent": true  },
     *     { "type": "external", "path": "...", "available": true, "freeBytes": 98765432, "isCurrent": false }
     *   ]
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
            i.put("freeBytes", internal != null ? internal.getFreeSpace() : 0L);
            i.put("isCurrent", ROOT_INTERNAL.equals(current));
            out.put(i);
        } catch (Exception ignored) {}

        try {
            File external = context.getExternalFilesDir(null);
            JSONObject e = new JSONObject();
            e.put("type",      ROOT_EXTERNAL);
            e.put("path",      external != null ? external.getAbsolutePath() : "");
            e.put("available", external != null);
            e.put("freeBytes", external != null ? external.getFreeSpace() : 0L);
            e.put("isCurrent", ROOT_EXTERNAL.equals(current));
            out.put(e);
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
     * relocateToOtherRoot() per item.
     *
     * Returns JSON: ["content/resources/textbooks/robins/document.pdf", ...]
     * "[]" on failure.
     */
    @JavascriptInterface
    public String listFilesInRoot(String rootType, String subpath) {
        File root;
        if (ROOT_EXTERNAL.equals(rootType)) {
            root = getExternalRoot();
        } else {
            root = getInternalRoot();
        }
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
     * -1 if the path does not exist.
     */
    @JavascriptInterface
    public long getDirectorySizeInRoot(String rootType, String subpath) {
        File root = ROOT_EXTERNAL.equals(rootType) ? getExternalRoot() : getInternalRoot();
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
     * OTHER root. Used per-item during a root migration.
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
    // Internals
    // =========================================================================

    private File getInternalRoot() {
        try { return context.getFilesDir(); } catch (Exception e) { return null; }
    }

    private File getExternalRoot() {
        try { return context.getExternalFilesDir(null); } catch (Exception e) { return null; }
    }

    /**
     * The root that NEW writes go to. Prefers external only when the
     * user chose it AND external is currently mounted. Otherwise internal.
     */
    private File getWriteRoot() {
        String pref = getPreferredRoot();
        if (ROOT_EXTERNAL.equals(pref)) {
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
     * For reads and deletes. Tries the write root first, then the other.
     */
    private File resolveRead(String relativePath) {
        if (relativePath == null) return null;
        String trimmed = relativePath.trim();
        if (trimmed.isEmpty()) return null;

        File writeRoot = getWriteRoot();
        File found = resolveAgainst(writeRoot, trimmed);
        if (found != null && found.exists()) return found;

        File otherRoot;
        if (writeRoot == null) {
            otherRoot = getExternalRoot();
        } else {
            File internal = getInternalRoot();
            otherRoot = (writeRoot.equals(internal)) ? getExternalRoot() : internal;
        }
        if (otherRoot != null) {
            File other = resolveAgainst(otherRoot, trimmed);
            if (other != null && other.exists()) return other;
        }

        // Nothing on disk yet — return the write-root path so callers
        // that create on demand get the right location.
        return found;
    }

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

    /**
     * Move a file or directory. Tries renameTo first — works within the
     * same mount point. If that fails (internal and external can be on
     * different mount points on some devices), falls back to copy+delete.
     * Cleans up partial copies on failure.
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