const { contextBridge, ipcRenderer } = require("electron");

// Preload script for sidebar BrowserView
// Exposes IPC for view switching and syncing active state
contextBridge.exposeInMainWorld("electronAPI", {
  // Send view switch request to main process
  switch: (view) => ipcRenderer.send("sidebar-switch", view),
  // Receive active view updates from main process (keyboard shortcuts, menu clicks)
  onActiveChange: (callback) =>
    ipcRenderer.on("sidebar-set-active", (event, view) => callback(view))
});