const { contextBridge, ipcRenderer } = require("electron");

// Preload script for settings view
// Exposes profile management IPC functions
contextBridge.exposeInMainWorld("electronAPI", {
  // Get all profiles and active profile ID
  getProfiles: () => ipcRenderer.invoke("profiles:get-all"),
  
  // Create a new profile
  createProfile: (data) => ipcRenderer.invoke("profiles:create", data),
  
  // Update an existing profile
  updateProfile: (id, updates) => ipcRenderer.invoke("profiles:update", { id, updates }),
  
  // Delete a profile
  deleteProfile: (id) => ipcRenderer.invoke("profiles:delete", id),
  
  // Switch to a different profile (will recreate views)
  switchProfile: (id) => ipcRenderer.invoke("profiles:switch", id),
  
  // Select avatar image file
  selectAvatar: () => ipcRenderer.invoke("profiles:select-avatar"),
});
