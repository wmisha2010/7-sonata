import { NextRequest, NextResponse } from "next/server"
import fs from "fs"
import path from "path"
import { Readable } from "stream"

export const runtime = "nodejs"

// Whitelist of downloadable build artifacts (kept in <project>/download/).
const ALLOWED: Record<string, string> = {
  "sonata-mobile.apk": "application/vnd.android.package-archive",
  "sonata-desktop.AppImage": "application/x-appimage",
  "sonata-desktop.zip": "application/zip",
  "sonata-source.zip": "application/zip",
}

function resolveArtifact(name: string): string | null {
  // Canonical artifacts live in <project>/download/. The standalone server may
  // run with cwd = .next/standalone, where a build-time COPY of download/ can
  // go stale (artifacts are refreshed after the standalone bundle is produced),
  // so the canonical directory MUST be checked first.
  const dirs = ["/home/z/my-project", process.cwd(), path.join(process.cwd(), "..")]
  for (const dir of dirs) {
    const p = path.join(dir, "download", name)
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
    } catch {
      // ignore and try next candidate
    }
  }
  return null
}

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("file") ?? ""
  const mime = ALLOWED[name]
  if (!mime) {
    return NextResponse.json({ error: "Unknown file" }, { status: 404 })
  }
  const filePath = resolveArtifact(name)
  if (!filePath) {
    return NextResponse.json({ error: "File not found" }, { status: 404 })
  }
  const size = fs.statSync(filePath).size
  const nodeStream = fs.createReadStream(filePath)
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream
  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    },
  })
}
