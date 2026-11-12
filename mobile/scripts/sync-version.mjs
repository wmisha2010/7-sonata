// Propagates src/lib/version.ts (the single source of truth) into
// mobile/package.json and the Android project.
//
// Runs as `npm run version:sync`, and `build:web` calls it first so a release
// build can never ship mismatched version strings.
//
// versionCode is derived from the version (major*10000 + minor*100 + patch),
// so it always grows with the version and a new APK installs over the old one.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const mobileRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const versionFile = path.join(mobileRoot, "src", "lib", "version.ts")

let source
try {
  source = fs.readFileSync(versionFile, "utf8")
} catch {
  console.error(`[version:sync] не найден ${versionFile}`)
  process.exit(1)
}

const match = source.match(/APP_VERSION\s*=\s*"(\d+)\.(\d+)\.(\d+)"/)
if (!match) {
  console.error(`[version:sync] не удалось прочитать APP_VERSION в ${versionFile}`)
  process.exit(1)
}

const [, major, minor, patch] = match
const version = `${major}.${minor}.${patch}`
const versionCode = Number(major) * 10000 + Number(minor) * 100 + Number(patch)
const changed = []

function syncText(file, rules) {
  const full = path.join(mobileRoot, file)
  let text
  try {
    text = fs.readFileSync(full, "utf8")
  } catch {
    console.error(`[version:sync] не найден ${full}`)
    process.exit(1)
  }
  let next = text
  for (const [pattern, replacement] of rules) next = next.replace(pattern, replacement)
  if (next !== text) {
    fs.writeFileSync(full, next)
    changed.push(file)
  }
}

syncText("package.json", [[/"version":\s*"[^"]*"/, `"version": "${version}"`]])
syncText("android/app/build.gradle", [
  [/versionName\s+"[^"]*"/, `versionName "${version}"`],
  [/versionCode\s+\d+/, `versionCode ${versionCode}`],
])

if (changed.length === 0) {
  console.log(`[version:sync] ${version} (versionCode ${versionCode}) — всё уже совпадает`)
} else {
  console.log(`[version:sync] ${version} (versionCode ${versionCode}) → обновлено: ${changed.join(", ")}`)
}
