package com.medhurb.app;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;

/**
 * MedvixShare
 *
 * System share sheet for text, links, and files. Replaces
 * @capacitor/share.
 *
 * Text sharing uses Intent.ACTION_SEND with text/plain.
 *
 * File sharing writes the payload (base64 from JS) to a "shared"
 * subfolder of the app cache, exposes it via the app's FileProvider,
 * and fires Intent.ACTION_SEND with the content:// URI and the correct
 * MIME type. The receiving app gets read permission via the
 * FLAG_GRANT_READ_URI_PERMISSION flag.
 *
 * No permissions required. The provider is already declared in
 * AndroidManifest.xml as ${applicationId}.fileprovider.
 */
@CapacitorPlugin(name = "MedvixShare")
public class MedvixSharePlugin extends Plugin {

    /**
     * Share plain text or a link.
     *
     * call.data:
     *   { title?: string, text?: string, url?: string, dialogTitle?: string }
     */
    @PluginMethod
    public void share(PluginCall call) {
        final String title       = call.getString("title", "");
        final String text        = call.getString("text", "");
        final String url         = call.getString("url", "");
        final String dialogTitle = call.getString("dialogTitle", "Share");

        // Compose the body. URL takes precedence over text if both exist,
        // matching the Web Share API's behaviour.
        final String body = (url != null && !url.isEmpty()) ? url : text;

        if (getActivity() == null) { call.resolve(); return; }

        getActivity().runOnUiThread(() -> {
            try {
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType("text/plain");
                if (title != null && !title.isEmpty()) {
                    send.putExtra(Intent.EXTRA_SUBJECT, title);
                }
                if (body != null && !body.isEmpty()) {
                    send.putExtra(Intent.EXTRA_TEXT, body);
                }
                Intent chooser = Intent.createChooser(send, dialogTitle);
                chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(chooser);
            } catch (Exception ignored) {}
        });

        call.resolve();
    }

    /**
     * Share a file.
     *
     * call.data:
     *   {
     *     base64:    string,   // payload only, no data: prefix
     *     filename:  string,
     *     mimeType?: string,
     *     title?:    string,
     *     text?:     string,
     *     dialogTitle?: string,
     *   }
     *
     * Resolves with { shared: boolean }. Resolves false when the file
     * could not be written or the chooser could not be launched.
     */
    @PluginMethod
    public void shareFile(PluginCall call) {
        final String base64    = call.getString("base64", "");
        final String filename  = call.getString("filename", "document");
        final String mimeType  = call.getString("mimeType", "application/octet-stream");
        final String title     = call.getString("title", "");
        final String text      = call.getString("text", "");
        final String dialogTitle = call.getString("dialogTitle", "Share");
        final PluginCall _call = call;

        if (base64 == null || base64.isEmpty() || getActivity() == null) {
            JSObject ret = new JSObject();
            ret.put("shared", false);
            call.resolve(ret);
            return;
        }

        // File I/O must not run on the UI thread.
        new Thread(() -> {
            try {
                // Write to cache/shared/<filename>. The FileProvider
                // resolves this path via the <cache-path> entry in
                // file_paths.xml.
                File sharedDir = new File(getContext().getCacheDir(), "shared");
                if (!sharedDir.exists()) sharedDir.mkdirs();

                File out = new File(sharedDir, filename);
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    fos.write(bytes);
                }

                Uri uri = FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    out);

                getActivity().runOnUiThread(() -> {
                    try {
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType(mimeType);
                        send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        if (title != null && !title.isEmpty()) {
                            send.putExtra(Intent.EXTRA_SUBJECT, title);
                        }
                        if (text != null && !text.isEmpty()) {
                            send.putExtra(Intent.EXTRA_TEXT, text);
                        }
                        Intent chooser = Intent.createChooser(send, dialogTitle);
                        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        getContext().startActivity(chooser);
                    } catch (Exception ignored) {}
                });

                JSObject ret = new JSObject();
                ret.put("shared", true);
                _call.resolve(ret);
            } catch (Exception e) {
                JSObject ret = new JSObject();
                ret.put("shared", false);
                _call.resolve(ret);
            }
        }).start();
    }
}