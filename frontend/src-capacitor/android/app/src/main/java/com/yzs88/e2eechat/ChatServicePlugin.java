package com.yzs88.e2eechat;

import android.content.Context;
import android.os.Build;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import cn.jpush.android.api.JPushInterface;

@CapacitorPlugin(name = "ChatService")
public class ChatServicePlugin extends Plugin {

    /** Whether the App is in the foreground is jointly maintained by JPushEventReceiver and front-end visibilitychange */
    public static volatile boolean appInForeground = true;

    private static ChatServicePlugin instance;

    static final String PREFS_NAME = "ChatServicePrefs";
    static final String PREF_PENDING_CHAT = "pending_chat_id";
    static final String PREF_REG_ID = "jpush_reg_id";

    @Override
    public void load() {
        instance = this;
    }

    /** For JPushEventReceiver to call back after successful registration to notify the front end of the new RegistrationID */
    static void onRegistrationIdReceived(String regId) {
        if (instance == null) return;
        JSObject data = new JSObject();
        data.put("registrationId", regId);
        instance.notifyListeners("registrationId", data);
    }

    /** Get JPush Registration ID (device unique push ID) */
    @PluginMethod
    public void getRegistrationId(PluginCall call) {
        String regId = JPushInterface.getRegistrationID(getContext());
        if (regId == null || regId.isEmpty()) {
            regId = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(PREF_REG_ID, "");
        }
        JSObject result = new JSObject();
        result.put("registrationId", regId != null ? regId : "");
        call.resolve(result);
    }

    /** Driven by the front-end visibilitychange event, controls whether notifications are displayed */
    @PluginMethod
    public void setForeground(PluginCall call) {
        appInForeground = Boolean.TRUE.equals(call.getBoolean("active", false));
        call.resolve();
    }

    /** Obtain and clear the session ID to be redirected caused by notification clicks */
    @PluginMethod
    public void getPendingNotification(PluginCall call) {
        String chatId = getContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(PREF_PENDING_CHAT, null);

        JSObject result = new JSObject();
        if (chatId != null && !chatId.isEmpty()) {
            getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().remove(PREF_PENDING_CHAT).apply();
            result.put("senderChatId", chatId);
        }
        call.resolve(result);
    }

    /** Request Android 13+ notification permission */
    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            String perm = android.Manifest.permission.POST_NOTIFICATIONS;
            if (ContextCompat.checkSelfPermission(getContext(), perm)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(getActivity(), new String[]{perm}, 1001);
            }
        }
        JSObject result = new JSObject();
        result.put("granted", true);
        call.resolve(result);
    }
}
