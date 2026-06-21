import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("myAPI", {
    flashWindow: () => ipcRenderer.send("flash-window"),
    focusWindow: () => ipcRenderer.send("focus-window"),
    notify: (body) => ipcRenderer.send("notify-message", body),
    isElectron: true,
});