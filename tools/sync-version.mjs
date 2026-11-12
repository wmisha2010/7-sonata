// Propagates src/lib/version.ts (the single source of truth for the desktop
// app version) into the root package.json and desktop/package.json.
//
// Runs as `npm run version:sync`, and `npm run build` calls it first so a
// packaged build can never ship a version that disagrees with the footer.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const versionFile = path.join(root, "src", "lib", "version.ts")

let source
try {
  source = fs.readFileSync(versionFile, "utf8")
} catch {
  console.error(`[version:sync] не найден ${versionFile}`)
  process.exit(1)
}

const match = source.match(/APP_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/)
if (!match) {
  console.error(`[version:sync] не удалось прочитать APP_VERSION в ${versionFile}`)
  process.exit(1)
}
const version = match[1]

// Files that must follow version.ts (both are Electron/Next manifests).
const targets = ["package.json", "desktop/package.json"]
const changed = []

for (const file of targets) {
  const full = path.join(root, file)
  let text
  try {
    text = fs.readFileSync(full, "utf8")
  } catch {
    console.error(`[version:sync] не найден ${full}`)
    process.exit(1)
  }
  const next = text.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`)
  if (!/"version":\s*"[^"]*"/.test(text)) {
    console.error(`[version:sync] в ${file} нет поля "version"`)
    process.exit(1)
  }
  if (next !== text) {
    fs.writeFileSync(full, next)
    changed.push(file)
  }
}

if (changed.length === 0) {
  console.log(`[version:sync] ${version} — всё уже совпадает`)
} else {
  console.log(`[version:sync] ${version} → обновлено: ${changed.join(", ")}`)
}
