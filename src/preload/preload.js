const { contextBridge, ipcRenderer } = require("electron");

// Preload script for content views (Google apps)
// Exposes limited IPC functions to web content via contextBridge
// Used by Gmail to update unread count badge and trigger notifications
contextBridge.exposeInMainWorld("electronAPI", {
  notify: (title, options) => ipcRenderer.send("notify", { title, options }),
  unreadCount: (count) => ipcRenderer.send("unread-count", count)
});