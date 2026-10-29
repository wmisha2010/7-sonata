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

// Non-ASCII characters in the project path are a known source of silent
// failures on Windows (Turbopack / standalone output). Warn early.
if (/[^\x20-\x7E]/.test(root)) {
  console.log("ВНИМАНИЕ: путь к проекту содержит русские буквы или спецсимволы:")
  console.log(`         ${root}`)
  console.log("На Windows это может ломать сборку. Надёжный вариант — распаковать")
  console.log("проект в путь без русских букв, например:  C:\\7-sonata")
  console.log("(продолжаю попытку сборки — если упадёт, перенеси папку и запусти снова)\n")
}

// Builds Next.js and returns true when the standalone server was produced.
function buildNext(extraArgs = "") {
  run(`npx next build${extraArgs}`, root)
  return existsSync(path.join(root, ".next", "standalone", "server.js"))
}

console.log("1/4  next build (production, standalone)")
let built = buildNext()

if (!built) {
  console.log("\n  Standalone-сервер не создан. Так бывает на Windows: Turbopack не любит")
  console.log("  русские буквы в пути, а файловая система без symlink-поддержки (exFAT/FAT32)")
  console.log("  ломает standalone-копирование. Пробую ещё раз через webpack...\n")
  rmSync(path.join(root, ".next"), { recursive: true, force: true })
  built = buildNext(" --webpack")
}

if (!built) {
  console.error("\nERROR: .next/standalone/server.js так и не создан после двух попыток.")
  console.error("Что проверить:")
  console.error("  1) Путь к проекту БЕЗ русских букв?  Например:  C:\\7-sonata")
  console.error("  2) Диск NTFS? (exFAT/FAT32 не поддерживают symlinks — standalone не соберётся)")
  console.error("  3) Свободное место на диске (нужно ~3 ГБ).")
  process.exit(1)
}

console.log("2/4  copying static assets into the standalone bundle")
const standalone = path.join(root, ".next", "standalone")
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
try {
  run("npm run dist:win", desktopDir)
} catch (e) {
  const msg = String(e?.message || e)
  if (msg.includes("symbolic link") || msg.includes("Символическая ссылка") || msg.includes("не обладает требуемыми правами")) {
    console.error("\nERROR: electron-builder не смог распаковать инструменты сборки —")
    console.error("Windows не разрешает создавать символические ссылки без особых прав.")
    console.error("\nРешение (одно из двух):")
    console.error("  1) Запусти командную строку ОТ ИМЕНИ АДМИНИСТРАТОРА (Пуск → набери cmd →")
    console.error("     правой кнопкой → «Запуск от имени администратора») и выполни:")
    console.error("       cd " + desktopDir)
    console.error("       npm run dist:win")
    console.error("     (веб-часть уже собрана — это займёт пару минут)")
    console.error("  2) Либо один раз включи «Режим разработчика»: Параметры → Обновление и")
    console.error("     безопасность → Для разработчиков → Режим разработчика. После этого")
    console.error("     админ не нужен, можно собирать обычной командой npm run desktop:win.")
    process.exit(1)
  }
  throw e
}

console.log("\n==========================================")
console.log("Готово! Файлы лежат в: desktop/release/")
console.log("  - 7-Sonata-<версия>-Setup.exe     (установщик)")
console.log("  - 7-Sonata-<версия>-portable.exe  (портативная, без установки)")
console.log("==========================================")
