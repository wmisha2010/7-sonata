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
console.log("done.")
