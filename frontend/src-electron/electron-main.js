import {
    app,
    BrowserWindow,
    Menu,
    ipcMain,
    nativeImage,
    Notification,
    Tray,
} from "electron";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const platform = process.platform || os.platform();
const currentDir = fileURLToPath(new URL(".", import.meta.url));

// Set AppUserModelID on Windows to ensure that Toast displays the correct application name instead of "electron.app.Electron"
if (platform === "win32") {
    app.setAppUserModelId("Yunmi");
}

let mainWindow;
let tray;
let trayFlashTimer;
let isQuitting = false;

const appIconPath = path.resolve(currentDir, "icons/icon.png");

function stopTrayFlashing() {
    if (trayFlashTimer) {
        clearInterval(trayFlashTimer);
        trayFlashTimer = null;
    }
    if (tray) {
        tray.setImage(appIconPath);
        tray.setToolTip("Yunmi");
    }
}

function startTrayFlashing() {
    // The tray only flashes while the user has explicitly hidden the window.
    if (!tray || !mainWindow || mainWindow.isVisible() || trayFlashTimer) return;

    const emptyIcon = nativeImage.createEmpty();
    let showIcon = false;
    tray.setToolTip("Yunmi - 有新消息");
    trayFlashTimer = setInterval(() => {
        if (!tray) return;
        tray.setImage(showIcon ? appIconPath : emptyIcon);
        showIcon = !showIcon;
    }, 500);
}

function showMainWindow() {
    if (!mainWindow) return;
    stopTrayFlashing();
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
}

function createTray() {
    if (tray) return;

    tray = new Tray(appIconPath);
    tray.setToolTip("Yunmi");
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: "打开 Yunmi", click: showMainWindow },
        { type: "separator" },
        {
            label: "退出",
            click: () => {
                isQuitting = true;
                app.quit();
            },
        },
    ]));
    tray.on("click", showMainWindow);
}

async function createWindow() {
    mainWindow = new BrowserWindow({
        icon: appIconPath,
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

    mainWindow.on("close", (event) => {
        if (isQuitting) return;
        event.preventDefault();
        mainWindow.hide();
    });

    mainWindow.on("focus", stopTrayFlashing);

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

// Rendering process requests flashing taskbar
ipcMain.on("flash-window", () => {
    if (mainWindow && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
        mainWindow.once("focus", () => mainWindow.flashFrame(false));
    }
});

// Rendering process requests focus window (when notification is clicked)
ipcMain.on("focus-window", () => {
    showMainWindow();
});

// The rendering process requests to pop up the system Toast notification (only pops up when the window is not focused)
ipcMain.on("notify-message", (_event, body) => {
    if (mainWindow && mainWindow.isFocused()) return;
    startTrayFlashing();

    if (Notification.isSupported()) {
        const n = new Notification({
            title: "Yunmi",
            body: body || "new message received",
            icon: appIconPath,
        });
        n.on("click", showMainWindow);
        n.show();
    }
});

app.whenReady().then(async () => {
    createTray();
    await createWindow();
});

app.on("before-quit", () => {
    isQuitting = true;
    stopTrayFlashing();
});

app.on("window-all-closed", () => {
    if (platform !== "darwin") app.quit();
});

app.on("activate", () => {
    if (mainWindow === null) createWindow();
    else showMainWindow();
});
