package com.yzs88.e2eechat;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

import cn.jpush.android.api.NotificationMessage;
import cn.jpush.android.service.JPushMessageReceiver;

public class JPushEventReceiver extends JPushMessageReceiver {

    private static final String TAG = "JPushEventReceiver";

    /** JPush 注册成功，拿到 RegistrationID */
    @Override
    public void onRegister(Context context, String registrationId) {
        Log.d(TAG, "Registered, regId: " + registrationId);
        context.getSharedPreferences(ChatServicePlugin.PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(ChatServicePlugin.PREF_REG_ID, registrationId)
                .apply();
        // 通知前端（若 App 已打开）
        ChatServicePlugin.onRegistrationIdReceived(registrationId);
    }

    /** 用户点击通知栏 */
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

        // 唤起 App 主页面
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        context.startActivity(intent);
    }

    /** 通知到达时（App 在前台），抑制通知显示 */
    @Override
    public void onNotifyMessageArrived(Context context, NotificationMessage message) {
        if (ChatServicePlugin.appInForeground) {
            // App 在前台，通过 WebSocket 直接收消息，不需要系统通知
            // JPush 5.x 暂无法在此处取消通知，通知仍会显示，但用户体验可接受
            Log.d(TAG, "App in foreground, notification will show but WS handles message");
        }
    }
}
