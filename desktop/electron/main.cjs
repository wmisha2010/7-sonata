// 7-Sonata — Electron main process.
//
// Architecture: the packaged app carries the FULL Next.js production server
// (output: "standalone") inside resources/server. On startup we spawn it on a
// free 127.0.0.1 port (running Electron's own binary in Node mode via
// ELECTRON_RUN_AS_NODE) and open it in a native window. This way every app
// feature — MP3mn search, Rutube video proxy, quality selector, downloads —
// works locally with no hosted backend.
const { app, BrowserWindow, shell, dialog, ipcMain, Tray, Menu, nativeImage } = require("electron")
const { spawn } = require("node:child_process")
const path = require("node:path")
const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")

// Optional dev helper: point the window at a running `next dev` instead of
// spawning the production server. Usage: SONATA_DEV_URL=http://localhost:3000 electron .
const DEV_SERVER_URL = process.env.SONATA_DEV_URL || ""
const BASE_PORT = 37654

// Media app: keep the renderer alive when the window is minimized.
// On Windows Chromium marks a minimized window as "occluded" -> the page
// flips to hidden, the video pipeline stalls and Picture-in-Picture freezes
// until the window is restored. Disabling the occlusion tracker keeps the
// page "visible" while minimized, so playback (and PiP) just continues.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")

let serverProc = null
let mainWindow = null
let quitting = false
let loadFailed = false

// ---- logging (goes to console + userData/sonata-server.log) ----
function logFilePath() {
  try {
    const dir = app.getPath("userData")
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, "sonata-server.log")
  } catch {
    return null
  }
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { console.log(line) } catch {}
  const f = logFilePath()
  if (f) { try { fs.appendFileSync(f, line + "\n") } catch {} }
}

function truncateLog() {
  try {
    const f = logFilePath()
    if (f && fs.existsSync(f) && fs.statSync(f).size > 1000000) fs.writeFileSync(f, "")
  } catch {}
}

// ---- GPU black-screen fallback ---------------------------------------------
// Some Windows GPU drivers show the Electron window as pure black even when
// the page has fully loaded (known Chromium/Electron issue on older drivers).
// Recovery ladder:
//   1. `7-Sonata.exe --disable-gpu` forces software rendering manually.
//   2. GPU process crashed 3 times  -> relaunch with --disable-gpu.
//   3. Page loaded but the visible frame is still black -> same relaunch.
const launchedArgs = process.argv.slice(1)
const gpuDisabled = launchedArgs.includes("--disable-gpu")
let relaunchedForGpu = false
let gpuCrashes = 0

if (gpuDisabled) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch("disable-gpu")
}

function relaunchWithoutGpu(reason) {
  if (relaunchedForGpu || gpuDisabled) return
  relaunchedForGpu = true
  log(`GPU problem (${reason}) — relaunching with --disable-gpu`)
  app.relaunch({
    args: [...launchedArgs.filter((a) => a !== "--disable-gpu"), "--disable-gpu"],
  })
  app.exit(0)
}

app.on("child-process-gone", (_event, details) => {
  log(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
  if (details.type === "GPU") {
    gpuCrashes += 1
    if (gpuCrashes >= 3) relaunchWithoutGpu("GPU process crashed 3 times")
  }
})

// ---- free port discovery (so we never clash with anything on the PC) ----
function getFreePort(start) {
  return new Promise((resolve) => {
    const probe = (p) => {
      const s = net.createServer()
      s.once("error", () => probe(p + 1))
      s.once("listening", () => s.close(() => resolve(p)))
      s.listen(p, "127.0.0.1")
    }
    probe(start)
  })
}

// ---- embedded Next.js standalone server ----
function serverDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, "server")
  // In dev (electron . from desktop/) the standalone build lives in the repo root.
  return path.join(__dirname, "..", "..", ".next", "standalone")
}

function startServer(port) {
  const dir = serverDir()
  const serverJs = path.join(dir, "server.js")
  if (!fs.existsSync(serverJs)) {
    log(`ERROR: embedded server not found at ${serverJs}`)
    log("Run `npm run build` in the repo root, then `npm run stage` in desktop/.")
    return false
  }
  log(`starting embedded server: ${serverJs} (port ${port})`)
  serverProc = spawn(process.execPath, [serverJs], {
    cwd: dir,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // run the Electron binary as plain Node
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1", // loopback only — no Windows Firewall prompt
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  serverProc.stdout.on("data", (d) => log(`[server] ${d.toString().trim()}`))
  serverProc.stderr.on("data", (d) => log(`[server:err] ${d.toString().trim()}`))
  serverProc.on("exit", (code) => {
    log(`embedded server exited (code=${code})`)
    serverProc = null
  })
  return true
}

function killServer() {
  if (serverProc) {
    try { serverProc.kill() } catch {}
    serverProc = null
  }
}

function waitForServer(port, timeoutMs = 45000) {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const ping = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => {
        res.resume()
        resolve(true)
      })
      const retry = () => {
        if (Date.now() - startedAt > timeoutMs) resolve(false)
        else setTimeout(ping, 350)
      }
      req.on("error", retry)
      req.on("timeout", () => { req.destroy(); retry() })
    }
    ping()
  })
}

// ---- black-window detection -------------------------------------------------
// The app UI is dark, but it always renders readable text. A frame that is
// 100% near-black pixels means the compositor never drew anything (broken
// GPU acceleration), not that the UI is merely dark-themed.
function isMostlyBlack(image) {
  try {
    const size = image.getSize()
    if (!size.width || !size.height) return true
    const bmp = image.toBitmap() // BGRA
    const stride = 4 * 97 // sample every 97th pixel — plenty, and cheap
    let sampled = 0
    for (let i = 0; i + 3 < bmp.length; i += stride) {
      const r = bmp[i + 2]
      const g = bmp[i + 1]
      const b = bmp[i]
      sampled += 1
      if (r > 16 || g > 16 || b > 16) return false
    }
    return sampled > 0
  } catch {
    return false
  }
}

// ---- compact ("windowshade") mode ----
// The renderer draws a single bar and asks for a small window. Previous bounds
// are remembered, so leaving the mode restores exactly what the user had.
// The mode itself is remembered too (userData/window-state.json): quitting in
// the shade brings the app back as a small window, with no full player first.
const MINI_WIDTH = 452
const MINI_MIN_WIDTH = 360
const MINI_HEIGHT = 172
const MINI_MIN_HEIGHT = 150
const FULL_MIN_WIDTH = 1000
const FULL_MIN_HEIGHT = 640

let savedFullBounds = null // window rect to come back to
let miniMode = false

function windowStatePath() {
  try {
    return path.join(app.getPath("userData"), "window-state.json")
  } catch {
    return null
  }
}

function readWindowState() {
  try {
    const file = windowStatePath()
    if (!file || !fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

function writeWindowState(next) {
  try {
    const file = windowStatePath()
    if (!file) return
    fs.writeFileSync(file, JSON.stringify(next, null, 2))
  } catch {
    /* unreadable userData — state simply won't persist */
  }
}

function persistWindowState() {
  try {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    if (!miniMode && win && !win.isMaximized() && !win.isFullScreen()) {
      savedFullBounds = win.getBounds()
    }
    // Only the mode and the full-size rect are remembered. The shade always
    // reopens at its base height: the playlist drawer is runtime state, and
    // restoring it made the window start tall and then shrink.
    writeWindowState({ mini: miniMode, fullBounds: savedFullBounds })
  } catch {
    /* ignore */
  }
}

// A shade window is a fixed-size always-on-top bar: the user cannot drag its
// edges (the renderer asks for the height it needs when the drawer opens).
function applyMiniWindow(win, on) {
  if (on) {
    if (win.isMaximized()) win.unmaximize()
    if (win.isFullScreen()) win.setFullScreen(false)
    savedFullBounds = win.getBounds()
    win.setResizable(false)
    win.setMaximizable(false)
    win.setMinimumSize(MINI_MIN_WIDTH, MINI_MIN_HEIGHT)
    win.setAlwaysOnTop(true, "floating")
    win.setBounds({ x: savedFullBounds.x, y: savedFullBounds.y, width: MINI_WIDTH, height: MINI_HEIGHT })
    win.setMaximumSize(MINI_WIDTH, 900)
  } else {
    win.setMaximumSize(16384, 16384)
    win.setMinimumSize(FULL_MIN_WIDTH, FULL_MIN_HEIGHT)
    win.setResizable(true)
    win.setMaximizable(true)
    win.setAlwaysOnTop(false)
    const b = savedFullBounds
    if (b) win.setBounds(b)
    savedFullBounds = null
  }
}

ipcMain.handle("sonata:window", (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return false
  if (action === "minimize") win.minimize()
  else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize()
  else if (action === "tray") hideToTray()
  else if (action === "close") win.close()
  return true
})

// The compact bar grows when its playlist drawer opens — the renderer asks for
// the height it needs and the width stays fixed.
ipcMain.handle("sonata:mini-size", (event, height) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed() || !miniMode) return false
  const h = Math.max(MINI_MIN_HEIGHT, Math.min(900, Math.round(Number(height) || 0)))
  const b = win.getBounds()
  if (b.width !== MINI_WIDTH || b.height !== h) {
    log(`mini-size: ${b.width}x${b.height} -> ${MINI_WIDTH}x${h}${h > MINI_HEIGHT ? " (playlist open)" : ""}`)
    win.setBounds({ x: b.x, y: b.y, width: MINI_WIDTH, height: h })
  }
  return true
})

// The renderer asks which mode the window is already in — that decides
// whether it paints the full player or the shade.
ipcMain.handle("sonata:mini-state", () => miniMode)

ipcMain.handle("sonata:mini-mode", (event, on) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || win.isDestroyed()) return false
  const next = !!on
  // Idempotent: on launch the renderer re-sends the mode the window is
  // already in, and that must not reset the saved bounds.
  if (next === miniMode) return true
  miniMode = next
  log(`mini-mode: ${next ? "on" : "off"}`)
  applyMiniWindow(win, next)
  persistWindowState()
  return true
})

// ---- tray ---------------------------------------------------------------
// "Свернуть в трей": the window hides, the embedded server and playback keep
// running, and the tray icon (click or menu) brings the player back.
let tray = null
// Set while the user keeps the player in the tray — the launch safety net must
// not pop the window back up during the first seconds after a start.
let hiddenToTray = false

async function trayIconImage() {
  // Packaged: the exe carries the app icon — Electron can extract it.
  try {
    const icon = await app.getFileIcon(process.execPath, { size: "small" })
    if (icon && !icon.isEmpty()) return icon
  } catch {
    /* fall through */
  }
  // Dev (`electron .`): the build icon sits next to the electron folder.
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, "..", "build", "icon.png"))
    if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
  } catch {
    /* no icon */
  }
  return null
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  hiddenToTray = false
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  hiddenToTray = true
  log("tray: window hidden")
  mainWindow.hide()
}

async function createTray() {
  if (tray) return
  const icon = await trayIconImage()
  if (!icon) {
    log("tray: no icon available, skipping tray icon")
    return
  }
  try {
    tray = new Tray(icon)
    tray.setToolTip("7-Sonata")
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Показать 7-Sonata", click: showMainWindow },
        { label: "Скрыть в трей", click: hideToTray },
        { type: "separator" },
        { label: "Выход", click: () => { quitting = true; killServer(); app.quit() } },
      ]),
    )
    tray.on("click", showMainWindow)
    tray.on("double-click", showMainWindow)
    log("tray: icon ready")
  } catch (e) {
    log(`tray: failed to create — ${e?.message || e}`)
  }
}

// ---- window ----
async function createWindow() {
  let url
  if (DEV_SERVER_URL) {
    log(`dev mode: attaching to ${DEV_SERVER_URL}`)
    url = DEV_SERVER_URL
  } else {
    const port = await getFreePort(BASE_PORT)
    if (!startServer(port)) {
      dialog.showErrorBox(
        "7-Sonata: встроенный сервер не найден",
        `Не найден файл:\n${path.join(serverDir(), "server.js")}\n\n` +
          "Похоже, сборка повреждена. Соберите заново (npm run desktop:win)\n" +
          `или скачайте архив с релиза.\n\nЛог: ${logFilePath() || "?"}`,
      )
      app.quit()
      return
    }
    const ok = await waitForServer(port)
    if (!ok) {
      log("WARNING: embedded server did not answer in time, opening window anyway")
      dialog.showErrorBox(
        "7-Sonata: сервер не отвечает",
        "Встроенный сервер не ответил за 45 секунд.\n\n" +
          "Точная причина — в логе, строки с пометкой [server:err]:\n" +
          `${logFilePath() || "(лог недоступен)"}\n\n` +
          "Частые причины: антивирус заблокировал запуск вложенного процесса\n" +
          "(добавьте 7-Sonata в исключения) либо сборка оказалась неполной.",
      )
    }
    url = `http://127.0.0.1:${port}/`
  }

  // Restored window state: start directly in the mode the app was closed in.
  const savedState = readWindowState()
  miniMode = savedState.mini === true
  savedFullBounds = savedState.fullBounds && typeof savedState.fullBounds === "object" ? savedState.fullBounds : null

  mainWindow = new BrowserWindow({
    width: miniMode ? MINI_WIDTH : savedFullBounds?.width || 1280,
    height: miniMode ? MINI_HEIGHT : savedFullBounds?.height || 832,
    ...(miniMode || !savedFullBounds ? {} : { x: savedFullBounds.x, y: savedFullBounds.y }),
    minWidth: miniMode ? MINI_MIN_WIDTH : FULL_MIN_WIDTH,
    minHeight: miniMode ? MINI_MIN_HEIGHT : FULL_MIN_HEIGHT,
    // A shade launch is a small, fixed, always-on-top bar from the first frame.
    resizable: !miniMode,
    maximizable: !miniMode,
    alwaysOnTop: miniMode,
    show: false,
    // No OS title bar: the player draws its own (src/.../music-player.tsx).
    // This is what lets the compact bar be a bare little panel.
    frame: false,
    autoHideMenuBar: true,
    title: "7-Sonata",
    // Per-pixel alpha: the shade panel is semi-transparent with rounded
    // corners, so the desktop shows through the corners and the surface.
    transparent: true,
    backgroundColor: "#00000000",
    icon: app.isPackaged ? undefined : path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The only bridge to the renderer: the compact "windowshade" mode.
      preload: path.join(__dirname, "preload.cjs"),
      // No timer/rAF throttling when the window is hidden or minimized —
      // progress bars, HLS and PiP video must keep running in the background.
      backgroundThrottling: false,
      // The player starts tracks programmatically (autoplay next, prefetched
      // search previews) — do not let Chromium block playback.
      autoplayPolicy: "no-user-gesture-required",
    },
  })

  mainWindow.once("ready-to-show", () => {
    if (miniMode) mainWindow.setAlwaysOnTop(true, "floating")
    const b = mainWindow.getBounds()
    log(`window ready: ${miniMode ? "shade" : "full"} ${b.width}x${b.height}`)
    mainWindow.show()
  })

  // Diagnostics: anything that could leave the window dark gets logged.
  mainWindow.webContents.on("did-finish-load", () => log("page did-finish-load"))
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, u, isMain) => {
    if (!isMain) return
    loadFailed = true
    log(`did-fail-load: code=${code} desc=${desc} url=${u}`)
    dialog.showErrorBox(
      "7-Sonata: не удалось загрузить интерфейс",
      `Код ${code} — ${desc}\n\nЛог: ${logFilePath() || "?"}`,
    )
  })
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    log(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })

  // External links (e.g. "Открыть на Rutube") go to the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target)
    return { action: "deny" }
  })

  // Remember where/what the window was, so the next launch opens the same way.
  mainWindow.on("close", () => persistWindowState())
  mainWindow.on("closed", () => { mainWindow = null })

  log(`loading ${url}`)
  try { await mainWindow.loadURL(url) } catch (e) { log(`loadURL failed: ${e?.message || e}`) }

  // Safety net: never leave the user with an invisible window.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !hiddenToTray) {
      log("window still hidden 10 s after load — showing anyway")
      mainWindow.show()
    }
  }, 10000)

  // Black-window auto-heal: page reports loaded, but the visible frame is
  // still pure black a few seconds later -> restart once in software mode.
  if (!DEV_SERVER_URL && !gpuDisabled) {
    setTimeout(async () => {
      try {
        if (!mainWindow || mainWindow.isDestroyed() || loadFailed) return
        const image = await mainWindow.webContents.capturePage()
        if (isMostlyBlack(image)) relaunchWithoutGpu("screen stayed black after load")
        else log("black-screen check passed: content rendered")
      } catch (e) {
        log(`black-screen check skipped: ${e?.message || e}`)
      }
    }, 7000)
  }
}

// ---- lifecycle ----
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  // Launching the exe again while the player sits in the tray brings it back.
  app.on("second-instance", () => {
    showMainWindow()
  })
  app.whenReady().then(async () => {
    truncateLog()
    log(`--- 7-Sonata start: v${app.getVersion()} packaged=${app.isPackaged}`)
    log(`execPath=${process.execPath}`)
    log(`resourcesPath=${process.resourcesPath}`)
    log(`userData=${app.getPath("userData")}`)
    if (gpuDisabled) log("GPU disabled: safe mode (--disable-gpu)")
    try { log(`gpu status: ${JSON.stringify(app.getGPUFeatureStatus())}`) } catch {}
    await createWindow()
    await createTray()
  }).catch((e) => log(`fatal: ${e?.stack || e}`))
}

app.on("window-all-closed", () => {
  quitting = true
  killServer()
  app.quit()
})

app.on("before-quit", () => {
  quitting = true
  killServer()
  if (tray) { try { tray.destroy() } catch {} tray = null }
})

process.on("exit", killServer)
process.on("uncaughtException", (e) => log(`uncaughtException: ${e?.stack || e}`))
