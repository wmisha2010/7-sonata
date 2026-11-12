import { NextResponse } from "next/server"

// Cover-image proxy — exists only so the canvas can read cover pixels for the
// dynamic accent colors (those CDNs send no CORS headers, so a direct
// crossOrigin load would fail and every track would keep the fallback palette).
//
// It is NOT a general-purpose proxy: only hosts that can actually serve a
// cover are allowed, otherwise this endpoint would let anyone relay arbitrary
// URLs through the app's server (open-proxy / SSRF surface).
const ALLOWED_IMAGE_HOSTS = [
  "mzstatic.com", // iTunes Search API artwork (metadata enrichment)
  "mp3mn.net", // mp3mn album covers
  "sunproxy.net", // mp3mn stream/cover CDN
  "rutube.ru", // Rutube video thumbnails
  "rtbcdn.ru", // Rutube CDN thumbnails
]

function isAllowedImageHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return ALLOWED_IMAGE_HOSTS.some((allowed) => h === allowed || h.endsWith(`.${allowed}`))
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const t = searchParams.get("url")
  if (!t) return new NextResponse("missing url", { status: 400 })
  let target: URL
  try {
    target = new URL(t)
  } catch {
    return new NextResponse("invalid url", { status: 400 })
  }
  if (target.protocol !== "https:" && target.protocol !== "http:")
    return new NextResponse("invalid protocol", { status: 400 })
  if (!isAllowedImageHost(target.hostname))
    return new NextResponse("host not allowed", { status: 403 })
  try {
    const u = await fetch(target.toString(), {
      headers: { "User-Agent": "Mozilla/5.0", Referer: target.origin },
      redirect: "follow",
    })
    if (!u.ok) return new NextResponse(`upstream ${u.status}`, { status: 502 })
    const ct = u.headers.get("content-type") || "image/jpeg"
    if (!ct.startsWith("image/")) return new NextResponse(`not image: ${ct}`, { status: 415 })
    const buf = Buffer.from(await u.arrayBuffer())
    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Cache-Control": "public, max-age=86400, immutable",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : "proxy error", { status: 502 })
  }
}
export const dynamic = "force-dynamic"
