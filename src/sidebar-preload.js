const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  switch: (view) => ipcRenderer.send("sidebar-switch", view),
  onActiveChange: (callback) =>
    ipcRenderer.on("sidebar-set-active", (event, view) => callback(view))
});