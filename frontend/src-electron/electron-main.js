import { app, BrowserWindow, Menu, session, ipcMain } from "electron";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const platform = process.platform || os.platform();
const currentDir = fileURLToPath(new URL(".", import.meta.url));

let mainWindow;

async function createWindow() {
    mainWindow = new BrowserWindow({
        icon: path.resolve(currentDir, "icons/icon.png"),
        width: 375,
        height: 667,
        useContentSize: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.resolve(
                currentDir,
                path.join(
                    process.env.QUASAR_ELECTRON_PRELOAD_FOLDER,
                    "electron-preload" +
                        process.env.QUASAR_ELECTRON_PRELOAD_EXTENSION,
                ),
            ),
        },
    });

    if (process.env.DEV) {
        await mainWindow.loadURL(process.env.APP_URL);
    } else {
        await mainWindow.loadFile("index.html");
    }

    if (process.env.DEBUGGING) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

// 渲染进程请求闪烁任务栏
ipcMain.on("flash-window", () => {
    if (mainWindow && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
        mainWindow.once("focus", () => mainWindow.flashFrame(false));
    }
});

// 渲染进程请求聚焦窗口（点击通知时）
ipcMain.on("focus-window", () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.whenReady().then(async () => {
    await createWindow();
});

app.on("window-all-closed", () => {
    if (platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (mainWindow === null) createWindow();
});
