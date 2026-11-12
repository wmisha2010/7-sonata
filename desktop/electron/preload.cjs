// 7-Sonata — Electron preload.
//
// The renderer gets exactly what it needs for the frameless shell: the compact
// "windowshade" mode, its dynamic height, and the window buttons the OS frame
// no longer provides.
//
// NOTE: do not expose `isDesktop` here. The player treats that flag as "an IPC
// bridge for desktop search/downloads exists" (see src/lib/mp3mn.ts) and would
// call methods this preload does not provide.
const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("sonata", {
  framelessShell: true,
  setMiniMode: (on) => ipcRenderer.invoke("sonata:mini-mode", !!on),
  setMiniSize: (height) => ipcRenderer.invoke("sonata:mini-size", Number(height) || 0),
  getMiniMode: () => ipcRenderer.invoke("sonata:mini-state"),
  windowAction: (action) => ipcRenderer.invoke("sonata:window", String(action)),
  startDrag: (offsetX, offsetY) => ipcRenderer.invoke("sonata:drag-start", Number(offsetX) || 0, Number(offsetY) || 0),
  endDrag: () => ipcRenderer.invoke("sonata:drag-end"),
})
