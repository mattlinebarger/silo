const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  notify: (title, options) => ipcRenderer.send("notify", { title, options }),
  unreadCount: (count) => ipcRenderer.send("unread-count", count)
});