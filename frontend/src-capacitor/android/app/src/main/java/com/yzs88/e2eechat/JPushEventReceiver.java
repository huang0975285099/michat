package com.yzs88.e2eechat;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

import cn.jpush.android.api.NotificationMessage;
import cn.jpush.android.service.JPushMessageReceiver;

public class JPushEventReceiver extends JPushMessageReceiver {

    private static final String TAG = "JPushEventReceiver";

    /** JPush registered successfully and got RegistrationID */
    @Override
    public void onRegister(Context context, String registrationId) {
        Log.d(TAG, "Registered, regId: " + registrationId);
        context.getSharedPreferences(ChatServicePlugin.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(ChatServicePlugin.PREF_REG_ID, registrationId)
                .apply();
        // Notification frontend (if the app is open)
        ChatServicePlugin.onRegistrationIdReceived(registrationId);
    }

    /** User clicks on the notification bar */
    @Override
    public void onNotifyMessageOpened(Context context, NotificationMessage message) {
        Log.d(TAG, "Notification tapped, extras: " + message.notificationExtras);
        try {
            JSONObject extras = new JSONObject(message.notificationExtras);
            String senderChatId = extras.optString("sender_chat_id", "");
            if (!senderChatId.isEmpty()) {
                context.getSharedPreferences(ChatServicePlugin.PREFS_NAME, Context.MODE_PRIVATE)
                        .edit()
                        .putString(ChatServicePlugin.PREF_PENDING_CHAT, senderChatId)
                        .apply();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to parse notification extras", e);
        }

        // Call up the App main page
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(intent);
    }

    /** When a notification arrives (App is in the foreground), suppress notification display */
    @Override
    public void onNotifyMessageArrived(Context context, NotificationMessage message) {
        if (ChatServicePlugin.appInForeground) {
            // App is in the foreground and receives messages directly through WebSocket without system notification.
            // JPush 5.x currently cannot cancel notifications here. The notifications will still be displayed, but the user experience is acceptable.
            Log.d(TAG, "App in foreground, notification will show but WS handles message");
        }
    }
}
