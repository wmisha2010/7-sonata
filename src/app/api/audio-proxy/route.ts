import { NextResponse } from "next/server"

// Audio stream proxy — makes mp3mn (sunproxy.net) streams SAME-ORIGIN.
//
// WHY: those CDNs send no CORS headers. By spec, a cross-origin media
// element captured by the Web Audio graph outputs SILENCE — so online
// tracks had to bypass the graph, and the spectrum visualizer got no
// analyser data (fake animated wave only). Proxied through our own origin
// the stream is safe to capture: sound stays audible AND the analyser
// receives real samples → the real spectrum bars work for search tracks.
//
// Range passthrough (request header + 206/Content-Range response) keeps
// seeking working as if the element were loading the CDN directly.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const t = searchParams.get("url")
  if (!t) return new NextResponse("missing url", { status: 400 })
  let u: URL
  try {
    u = new URL(t)
  } catch {
    return new NextResponse("invalid url", { status: 400 })
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return new NextResponse("invalid protocol", { status: 400 })
  // Whitelist — only the mp3mn stream CDN, no open proxy.
  const h = u.hostname
  const allowed =
    h === "mp3mn.net" || h.endsWith(".mp3mn.net") || h.endsWith(".sunproxy.net")
  if (!allowed) return new NextResponse("host not allowed", { status: 403 })

  const range = request.headers.get("range")
  try {
    const up = await fetch(u.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "*/*",
        ...(range ? { Range: range } : {}),
      },
      redirect: "follow",
    })
    if (!up.ok) return new NextResponse(`upstream ${up.status}`, { status: 502 })

    const headers = new Headers()
    const ct = up.headers.get("content-type")
    if (ct) headers.set("Content-Type", ct)
    const cl = up.headers.get("content-length")
    if (cl) headers.set("Content-Length", cl)
    const cr = up.headers.get("content-range")
    if (cr) headers.set("Content-Range", cr)
    headers.set("Accept-Ranges", up.headers.get("accept-ranges") || "bytes")
    headers.set("Cache-Control", "no-store")
    // Stream the body through without buffering the whole file.
    return new Response(up.body, { status: up.status, headers })
  } catch (e) {
    return new NextResponse(e instanceof Error ? e.message : "proxy error", { status: 502 })
  }
}

export const dynamic = "force-dynamic"
