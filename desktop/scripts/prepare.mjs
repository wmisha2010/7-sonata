#!/usr/bin/env node
// Cross-platform builder for the 7-Sonata desktop app.
// Works on Windows / Linux / macOS with only Node.js installed.
//
// Usage (from the repo root):  npm run desktop:win
//
// Steps:
//   1. next build                      — production build (output: standalone)
//   2. copy static/public into .next/standalone
//   3. npm install in desktop/         — downloads Electron + electron-builder
//   4. electron-builder --win          — 7-Sonata-<version>-Setup.exe + portable
import { execSync } from "node:child_process"
import { cpSync, existsSync, rmSync } from "node:fs"
import path from "node:path"

const root = process.cwd()
const desktopDir = path.join(root, "desktop")
const run = (cmd, cwd) => {
  console.log(`\n> ${cmd}   (cwd: ${path.relative(root, cwd) || "."})`)
  execSync(cmd, { stdio: "inherit", cwd })
}

console.log("1/4  next build (production, standalone)")
run("npx next build", root)

const standalone = path.join(root, ".next", "standalone")
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("ERROR: .next/standalone/server.js not found — build failed?")
  process.exit(1)
}

console.log("2/4  copying static assets into the standalone bundle")
rmSync(path.join(standalone, ".next", "static"), { recursive: true, force: true })
cpSync(path.join(root, ".next", "static"), path.join(standalone, ".next", "static"), { recursive: true })
if (existsSync(path.join(root, "public"))) {
  rmSync(path.join(standalone, "public"), { recursive: true, force: true })
  cpSync(path.join(root, "public"), path.join(standalone, "public"), { recursive: true })
}

console.log("3/4  installing desktop dependencies (first run downloads Electron, be patient)")
run("npm install --no-audit --no-fund", desktopDir)

// Some npm setups block package install scripts — make sure the Electron
// binary actually exists before packaging, otherwise download it directly.
const electronDist = path.join(desktopDir, "node_modules", "electron", "dist", "electron.exe")
if (!existsSync(electronDist)) {
  console.log("     Electron binary missing — running its install script directly")
  run(process.platform === "win32" ? "node node_modules\\electron\\install.js" : "node node_modules/electron/install.js", desktopDir)
}

console.log("4/4  electron-builder --win")
run("npm run dist:win", desktopDir)

console.log("\n==========================================")
console.log("Готово! Файлы лежат в: desktop/release/")
console.log("  - 7-Sonata-<версия>-Setup.exe     (установщик)")
console.log("  - 7-Sonata-<версия>-portable.exe  (портативная, без установки)")
console.log("==========================================")
