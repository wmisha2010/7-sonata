#!/usr/bin/env node
// Copies the built Next.js standalone server (repo root .next/standalone)
// into desktop/staged/server, ready to be packed by electron-builder as
// extraResources. Run AFTER `npm run build` in the repo root.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

const desktopDir = process.cwd()
const src = path.resolve(desktopDir, "..", ".next", "standalone")
const stagedDir = path.join(desktopDir, "staged")
const dest = path.join(stagedDir, "server")

if (!existsSync(path.join(src, "server.js"))) {
  console.error(`ERROR: ${src} not found.`)
  console.error("First run in the repo root:  npm run build")
  process.exit(1)
}

console.log(`staging: ${src} -> ${dest}`)
rmSync(stagedDir, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })

// Verify the staged server is complete — electron-builder and NSIS rely on it.
const required = [
  "server.js",
  ["node_modules", "next", "package.json"],
  [".next", "BUILD_ID"],
  [".next", "static"],
]
for (const rel of required) {
  const p = path.join(dest, ...[].concat(rel))
  if (!existsSync(p)) {
    console.error(`ERROR: в staged/server нет ${path.relative(dest, p)}`)
    console.error("Standalone-сборка неполная. Удали .next и запусти заново: npm run desktop:win")
    process.exit(1)
  }
}
console.log("verified: server.js + node_modules/next + BUILD_ID + static")
console.log("done.")
