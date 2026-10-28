// One-shot screenshot runner: opens the app, waits for render, captures the window.
const { app, BrowserWindow } = require("electron")
const path = require("node:path")

const SHOT_PATH = process.env.SONATA_SHOT_PATH || "/tmp/sonata-shot.png"
const WAIT_MS = Number(process.env.SONATA_WAIT_MS || 4000)

app.commandLine.appendSwitch("no-sandbox")

let win = null

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    show: false,
    backgroundColor: "#09090b",
    webPreferences: {
      offscreen: false,
    },
  })

  // Production build -> load the static file directly (no dev server needed).
  await win.loadFile(path.join(__dirname, "..", "dist", "index.html"))

  // Give the app time to synth the demo tracks and render the visualizer.
  await new Promise((r) => setTimeout(r, WAIT_MS))

  try {
    const image = await win.webContents.capturePage()
    require("node:fs").writeFileSync(SHOT_PATH, image.toPNG())
    console.log("SCREENSHOT_SAVED:" + SHOT_PATH)
  } catch (e) {
    console.error("capture failed", e)
  }

  app.quit()
})

app.on("window-all-closed", () => app.quit())
