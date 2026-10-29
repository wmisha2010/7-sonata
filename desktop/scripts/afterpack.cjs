#!/usr/bin/env node
// electron-builder's built-in extraResources copy silently SKIPS node_modules
// (its filter exists to avoid accidentally packing huge dependency folders).
// Our embedded Next.js standalone server NEEDS its node_modules (next, react,
// sharp, ...), so we copy staged/server -> resources/server ourselves and
// verify the result. If anything is missing the build fails loudly instead of
// producing an exe that shows an empty window.
const { rmSync, cpSync, existsSync } = require("node:fs")
const path = require("node:path")

exports.default = async function afterPack(context) {
  const staged = path.join(__dirname, "..", "staged", "server")
  const dest = path.join(context.appOutDir, "resources", "server")

  if (!existsSync(path.join(staged, "server.js"))) {
    throw new Error(
      "afterPack: staged/server пуст. Сначала выполни в корне проекта:  npm run desktop:win",
    )
  }

  console.log(`  • afterPack: копирую встроенный сервер -> ${dest}`)
  rmSync(dest, { recursive: true, force: true })
  cpSync(staged, dest, { recursive: true })

  // Hard verification — the packaged server must be complete and runnable.
  const required = [
    "server.js",
    path.join("node_modules", "next", "package.json"),
    path.join(".next", "BUILD_ID"),
    path.join(".next", "static"),
  ]
  for (const rel of required) {
    if (!existsSync(path.join(dest, rel))) {
      throw new Error(`afterPack: в упакованном сервере нет ${rel} — сборка прервана`)
    }
  }
  console.log("  • afterPack: сервер упакован и проверён (server.js, node_modules/next, BUILD_ID, static)")
}
