// Electron main process — creates the native window that hosts the music player.
const { app, BrowserWindow, shell, ipcMain } = require("electron")
const path = require("node:path")

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production"

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 360,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: "7-Sonata",
    backgroundColor: "#09090b",
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Allow fetching from Audius API (no CORS headers on their search
      // endpoint). The app loads from file:// in production, so cross-origin
      // requests would otherwise be blocked. This is safe for a local app.
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  })

  // Open external links in the user's default browser, not inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url)
      return { action: "deny" }
    }
    return { action: "allow" }
  })

  // Set a permissive CSP so the renderer can fetch from Audius API
  // (their search endpoint has no CORS headers, so we need to allow
  // cross-origin requests from the file:// origin in production).
  mainWindow.webContents.session.webRequest.onHeadersReceived(
    (details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Content-Security-Policy": [
            "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http:; img-src * data: blob:; media-src * https: http: blob:; connect-src * https: http: ws:",
          ],
        },
      })
    }
  )

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show()
  })

  if (isDev) {
    // In dev, load the Vite dev server (hot reload inside the desktop window).
    mainWindow.loadURL("http://localhost:5173")
    // mainWindow.webContents.openDevTools({ mode: "detach" })
  } else {
    // In production, load the built static files.
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"))
  }
}

// ---- MP3mn search via IPC (Node.js — no CORS restrictions) ----
// MP3mn.net has no CORS headers, so fetch from the renderer is blocked in
// the browser. In Electron we fetch via the main process and return results.
async function searchMp3mnNode(query, log) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    // Step 1: /api/search returns a JSON redirect URL (artist or track page)
    const apiUrl = `https://mp3mn.net/api/search?query=${encodeURIComponent(query)}`
    log("Step 1: " + apiUrl.slice(0, 60))
    const apiRes = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    })
    if (!apiRes.ok) throw new Error(`API HTTP ${apiRes.status}`)
    const apiJson = await apiRes.json()
    const redirectPath = apiJson.url
    if (!redirectPath) throw new Error("No redirect URL in API response")
    log("Redirect: " + redirectPath)

    // Step 2: fetch the redirect page (artist or track page) as JSON
    const pageUrl = `https://mp3mn.net${redirectPath}`
    log("Step 2: " + pageUrl.slice(0, 60))
    const pageRes = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      },
    })
    if (!pageRes.ok) throw new Error(`Page HTTP ${pageRes.status}`)
    const pageJson = await pageRes.json()
    const html = pageJson.xx1_content || pageJson.xx2_content || ""
    log("HTML length: " + html.length)

    // Extract the shared album/artist cover image
    const coverMatch = html.match(/src="(\/public\/album\/[^"]+)"/)
    const coverUrl = coverMatch ? `https://mp3mn.net${coverMatch[1]}` : undefined
    if (coverUrl) log("Cover: " + coverUrl.slice(0, 60))

    // Parse HTML: extract data-url, artist, title, duration per track.
    // Deduplicate by filename AND by artist+title — MP3mn returns multiple
    // copies of the same song; keep only the first.
    const tracks = []
    const seenFilenames = new Set()
    const seenTitles = new Set()
    const items = html.split(/<li[^>]*>/)
    for (let i = 1; i < items.length; i++) {
      const block = items[i]
      const urlMatch = block.match(/data-url="([^"]+)"/)
      if (!urlMatch) continue
      const streamUrl = urlMatch[1]

      // Dedupe by filename from URL
      const filename = streamUrl.split("/").pop() || streamUrl
      if (seenFilenames.has(filename)) continue

      const artistMatch = block.match(/class="playlist-name-artist"[^>]*><a[^>]*>([^<]+)/)
      const artist = artistMatch
        ? artistMatch[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'")
        : "Unknown"

      const titleMatch = block.match(/class="playlist-name-title"[^>]*>.*?<em>([^<]+)/)
      const title = titleMatch
        ? titleMatch[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'")
        : "Unknown"

      // Dedupe by artist+title
      const titleKey = `${artist.trim().toLowerCase()}|${title.trim().toLowerCase()}`
      if (seenTitles.has(titleKey)) continue

      const durMatch = block.match(/class="playlist-duration">([^<]+)/)
      const duration = durMatch ? parseDuration(durMatch[1]) : 0

      seenFilenames.add(filename)
      seenTitles.add(titleKey)

      tracks.push({
        id: `mn-${i}-${Date.now().toString(36)}`,
        title,
        artist,
        artworkUrl: coverUrl,
        streamUrl,
        duration,
      })
    }
    return tracks.slice(0, 25)
  } finally {
    clearTimeout(timeout)
  }
}

function parseDuration(text) {
  const parts = text.trim().split(":")
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1])
  return 0
}

ipcMain.handle("mp3mn:search", async (event, query) => {
  if (!query || !query.trim()) return []
  const log = (msg) => {
    console.log("[MP3mn]", msg)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`console.log("[MP3mn] ${msg.replace(/"/g, '\\"')}")`).catch(() => {})
    }
  }
  try {
    log("Searching: " + query)
    const results = await searchMp3mnNode(query, log)
    log("Found: " + results.length + " tracks")
    return results
  } catch (e) {
    log("ERROR: " + e.message)
    return []
  }
})

// ---- Artifact saving (footer "Скачать" menu in the desktop app) ----
// Copies the requested build artifact into the user's Downloads folder.
//  - apk / zip ship inside the AppImage via electron-builder extraResources
//  - the AppImage copies itself (process.env.APPIMAGE points to the .AppImage)
const fs = require("node:fs")

const ARTIFACTS = {
  apk: "sonata-mobile.apk",
  appimage: "sonata-desktop.AppImage",
  zip: "sonata-desktop.zip",
  source: "sonata-source.zip",
}

ipcMain.handle("sonata:save-artifact", (_event, kind) => {
  try {
    const name = ARTIFACTS[kind]
    if (!name) return { ok: false, error: "Неизвестный файл" }

    let src = null
    if (kind === "appimage") {
      if (process.env.APPIMAGE && fs.existsSync(process.env.APPIMAGE)) {
        src = process.env.APPIMAGE
      } else if (!app.isPackaged) {
        return { ok: false, error: "AppImage доступен только в собранной Linux-сборке" }
      } else {
        src = process.execPath // linux-unpacked fallback
      }
    } else {
      const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, name) : null,
        path.join(__dirname, "..", "extra", name),
        path.join(__dirname, "..", "..", "download", name),
      ].filter(Boolean)
      src = candidates.find((p) => fs.existsSync(p))
    }

    if (!src || !fs.existsSync(src)) return { ok: false, error: "Файл не найден" }

    const dest = path.join(app.getPath("downloads"), name)
    fs.copyFileSync(src, dest)
    return { ok: true, path: dest }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
})

app.whenReady().then(() => {
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
