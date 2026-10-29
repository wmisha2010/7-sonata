// 7-Sonata — Electron main process.
//
// Architecture: the packaged app carries the FULL Next.js production server
// (output: "standalone") inside resources/server. On startup we spawn it on a
// free 127.0.0.1 port (running Electron's own binary in Node mode via
// ELECTRON_RUN_AS_NODE) and open it in a native window. This way every app
// feature — MP3mn search, Rutube video proxy, quality selector, downloads —
// works locally with no hosted backend.
const { app, BrowserWindow, shell } = require("electron")
const { spawn } = require("node:child_process")
const path = require("node:path")
const fs = require("node:fs")
const http = require("node:http")
const net = require("node:net")

// Optional dev helper: point the window at a running `next dev` instead of
// spawning the production server. Usage: SONATA_DEV_URL=http://localhost:3000 electron .
const DEV_SERVER_URL = process.env.SONATA_DEV_URL || ""
const BASE_PORT = 37654

let serverProc = null
let mainWindow = null
let quitting = false

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
    return
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
}

function killServer() {
  if (serverProc) {
    try { serverProc.kill() } catch {}
    serverProc = null
  }
}

function waitForServer(port, timeoutMs = 30000) {
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

// ---- window ----
async function createWindow() {
  let url
  if (DEV_SERVER_URL) {
    log(`dev mode: attaching to ${DEV_SERVER_URL}`)
    url = DEV_SERVER_URL
  } else {
    const port = await getFreePort(BASE_PORT)
    startServer(port)
    const ok = await waitForServer(port)
    if (!ok) log("WARNING: embedded server did not answer in time, opening window anyway")
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
      // The player starts tracks programmatically (autoplay next, prefetched
      // search previews) — do not let Chromium block playback.
      autoplayPolicy: "no-user-gesture-required",
    },
  })

  mainWindow.once("ready-to-show", () => mainWindow.show())

  // External links (e.g. "Открыть на Rutube") go to the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target)
    return { action: "deny" }
  })

  mainWindow.on("closed", () => { mainWindow = null })
  log(`loading ${url}`)
  try { await mainWindow.loadURL(url) } catch (e) { log(`loadURL failed: ${e?.message || e}`) }
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
  app.whenReady().then(createWindow).catch((e) => log(`fatal: ${e?.stack || e}`))
}

app.on("window-all-closed", () => {
  quitting = true
  killServer()
  app.quit()
})

app.on("before-quit", () => { quitting = true; killServer() })

process.on("exit", killServer)
