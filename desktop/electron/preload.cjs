// Preload runs in an isolated context with limited Node access.
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("sonata", {
  isDesktop: true,
  platform: process.platform,
  searchMp3mn: (query) => ipcRenderer.invoke("mp3mn:search", query),
  saveArtifact: (kind) => ipcRenderer.invoke("sonata:save-artifact", kind),
})
