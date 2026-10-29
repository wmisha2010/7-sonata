// 7-Sonata — Electron main process.
//
// Architecture: the packaged app carries the FULL Next.js production server
// (output: "standalone") inside resources/server. On startup we spawn it on a
// free 127.0.0.1 port (running Electron's own binary in Node mode via
// ELECTRON_RUN_AS_NODE) and open it in a native window. This way every app
// feature — MP3mn search, Rutube video proxy, quality selector, downloads —
// works locally with no hosted backend.
const { app, BrowserWindow, shell, dialog } = require("electron")
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

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: "7-Sonata",
    backgroundColor: "#09090b",
    icon: app.isPackaged ? undefined : path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // No timer/rAF throttling when the window is hidden or minimized —
      // progress bars, HLS and PiP video must keep running in the background.
      backgroundThrottling: false,
      // The player starts tracks programmatically (autoplay next, prefetched
      // search previews) — do not let Chromium block playback.
      autoplayPolicy: "no-user-gesture-required",
    },
  })

  mainWindow.once("ready-to-show", () => mainWindow.show())

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

  mainWindow.on("closed", () => { mainWindow = null })

  log(`loading ${url}`)
  try { await mainWindow.loadURL(url) } catch (e) { log(`loadURL failed: ${e?.message || e}`) }

  // Safety net: never leave the user with an invisible window.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
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
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
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
  }).catch((e) => log(`fatal: ${e?.stack || e}`))
}

app.on("window-all-closed", () => {
  quitting = true
  killServer()
  app.quit()
})

app.on("before-quit", () => { quitting = true; killServer() })

process.on("exit", killServer)
process.on("uncaughtException", (e) => log(`uncaughtException: ${e?.stack || e}`))
