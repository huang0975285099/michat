package com.yzs88.e2eechat;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.system.ErrnoException;
import android.system.OsConstants;
import android.util.Base64;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.OutputStream;

/** Streams decrypted attachment chunks into a user-selected Android document. */
@CapacitorPlugin(name = "FileSave")
public class FileSavePlugin extends Plugin {
    private OutputStream output;
    private Uri destination;
    private long bytesWritten;

    @PluginMethod
    public synchronized void begin(PluginCall call) {
        if (output != null) {
            call.reject("Another file is already being saved");
            return;
        }
        String filename = call.getString("filename", "download");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType == null || mimeType.isEmpty() ? "application/octet-stream" : mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, safeFilename(filename));
        startActivityForResult(call, intent, "createdDocument");
    }

    @ActivityCallback
    private synchronized void createdDocument(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            JSObject response = new JSObject();
            response.put("canceled", true);
            call.resolve(response);
            return;
        }
        try {
            destination = result.getData().getData();
            output = getContext().getContentResolver().openOutputStream(destination, "wt");
            if (output == null) throw new IllegalStateException("Unable to open the selected document");
            bytesWritten = 0;
            JSObject response = new JSObject();
            response.put("canceled", false);
            response.put("uri", destination.toString());
            call.resolve(response);
        } catch (Exception error) {
            closeAndDelete();
            rejectWriteError(call, "Unable to create the selected document", error);
        }
    }

    @PluginMethod
    public synchronized void append(PluginCall call) {
        if (output == null) {
            call.reject("No file save is active");
            return;
        }
        String encoded = call.getString("data");
        if (encoded == null || encoded.isEmpty()) {
            call.reject("File chunk is empty");
            return;
        }
        try {
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            output.write(bytes);
            bytesWritten += bytes.length;
            JSObject response = new JSObject();
            response.put("bytesWritten", bytesWritten);
            call.resolve(response);
        } catch (Exception error) {
            closeAndDelete();
            rejectWriteError(call, "Unable to write the selected document", error);
        }
    }

    @PluginMethod
    public synchronized void finish(PluginCall call) {
        if (output == null) {
            call.reject("No file save is active");
            return;
        }
        try {
            output.flush();
            output.close();
            output = null;
            JSObject response = new JSObject();
            response.put("uri", destination != null ? destination.toString() : "");
            response.put("bytesWritten", bytesWritten);
            destination = null;
            bytesWritten = 0;
            call.resolve(response);
        } catch (Exception error) {
            closeAndDelete();
            rejectWriteError(call, "Unable to finish the selected document", error);
        }
    }

    @PluginMethod
    public synchronized void abort(PluginCall call) {
        closeAndDelete();
        call.resolve();
    }

    @Override
    protected synchronized void handleOnDestroy() {
        closeOutput();
    }

    private String safeFilename(String value) {
        String cleaned = value == null ? "download" : value.replaceAll("[\\\\/:*?\"<>|\\x00-\\x1F]", "_");
        cleaned = cleaned.replaceAll("[. ]+$", "");
        return cleaned.isEmpty() ? "download" : cleaned;
    }

    private void closeOutput() {
        if (output != null) {
            try { output.close(); } catch (Exception ignored) { }
        }
        output = null;
    }

    private void closeAndDelete() {
        closeOutput();
        if (destination != null) {
            try { getContext().getContentResolver().delete(destination, null, null); } catch (Exception ignored) { }
        }
        destination = null;
        bytesWritten = 0;
    }

    private void rejectWriteError(PluginCall call, String message, Exception error) {
        Throwable cause = error;
        while (cause != null) {
            if (cause instanceof ErrnoException && ((ErrnoException) cause).errno == OsConstants.ENOSPC) {
                call.reject(message, "destination_storage_full", error);
                return;
            }
            cause = cause.getCause();
        }
        call.reject(message, error);
    }
}
