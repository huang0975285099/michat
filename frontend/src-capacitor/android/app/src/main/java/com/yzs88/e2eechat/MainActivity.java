package com.yzs88.e2eechat;

import android.os.Bundle;
import android.content.pm.ApplicationInfo;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import cn.jpush.android.api.JPushInterface;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChatServicePlugin.class);
        super.onCreate(savedInstanceState);

        // JPush initialization
        JPushInterface.setDebugMode(isDebugBuild());
        JPushInterface.init(this);

        // WebView debugging (debug package only)
        WebView.setWebContentsDebuggingEnabled(isDebugBuild());
    }

    @Override
    public void onResume() {
        super.onResume();
        JPushInterface.onResume(this);
        ChatServicePlugin.appInForeground = true;
    }

    @Override
    public void onPause() {
        super.onPause();
        JPushInterface.onPause(this);
        ChatServicePlugin.appInForeground = false;
    }

    private boolean isDebugBuild() {
        return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }
}
