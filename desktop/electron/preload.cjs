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
  // First full frame: library restored and the window mode is known. The main
  // process keeps the window hidden until this arrives (no splash flash).
  appReady: (info) => ipcRenderer.send("sonata:renderer-ready", info || null),
  // Window shown/hidden/minimized — lets decorative animation loops park when
  // the player is in the tray or minimized (occlusion tracking is off).
  onVisibility: (cb) => {
    const handler = (_e, visible) => cb(!!visible)
    ipcRenderer.on("sonata:visibility", handler)
    return () => ipcRenderer.removeListener("sonata:visibility", handler)
  },
})
