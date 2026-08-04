import { app, BrowserWindow, Menu, session, ipcMain, Notification } from "electron";
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

// Rendering process requests flashing taskbar
ipcMain.on("flash-window", () => {
    if (mainWindow && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
        mainWindow.once("focus", () => mainWindow.flashFrame(false));
    }
});

// Rendering process requests focus window (when notification is clicked)
ipcMain.on("focus-window", () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// The rendering process requests to pop up the system Toast notification (only pops up when the window is not focused)
ipcMain.on("notify-message", (_event, body) => {
    if (!Notification.isSupported()) return;
    if (mainWindow && mainWindow.isFocused()) return;
    const n = new Notification({
        title: "Yunmi",
        body: body || "new message received",
        icon: path.resolve(currentDir, "icons/icon.png"),
    });
    n.on("click", () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
    n.show();
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
