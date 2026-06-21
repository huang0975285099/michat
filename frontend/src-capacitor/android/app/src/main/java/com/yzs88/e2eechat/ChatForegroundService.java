package com.yzs88.e2eechat;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;

/** Stub — replaced by JPush push notification implementation. */
public class ChatForegroundService extends Service {
    public static final String ACTION_STOP = "STOP";
    public static final String EXTRA_TOKEN = "session_token";

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
