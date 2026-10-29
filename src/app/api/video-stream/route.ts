import { NextResponse } from "next/server"

// HLS proxy for Rutube videos — makes video playback SAME-ORIGIN.
//
// WHY: the audio of a video played inside the official Rutube iframe embed
// is physically untappable by the Web Audio API (cross-origin document —
// createMediaElementSource only works on media elements of our own document).
// That's why the spectrum visualizer showed only its fake animated wave for
// video tracks. This route resolves the signed HLS manifest server-side
// (rutube.ru/api/play/options/{id}) and re-serves every nested manifest and
// segment through our own origin. hls.js then feeds a native <video> element
// via MSE (blob:) — same-origin, safe to capture with the analyser → the
// visualizer gets REAL audio data for videos, exactly like music tracks.
//
// Modes:
//   ?id={rutube video id} → resolve + fetch the master manifest, rewrite URIs
//   ?u={m3u8 url}         → nested (variant) manifest, rewrite URIs
//   ?seg={segment url}    → byte-stream passthrough (Range kept → seeking works)

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

function isAllowedHost(hostname: string): boolean {
  return (
    hostname === "rutube.ru" ||
    hostname.endsWith(".rutube.ru") ||
    hostname.endsWith(".rtbcdn.ru")
  )
}

function upstreamHeaders(range?: string | null): HeadersInit {
  return {
    "User-Agent": UA,
    Accept: "*/*",
    Referer: "https://rutube.ru/",
    ...(range ? { Range: range } : {}),
  }
}

// Rewrite every resource URI in an m3u8 playlist into a same-origin proxy
// URL. Non-comment lines are variant manifests (→ ?u=) or media segments
// (→ ?seg=); #EXT-X-KEY / #EXT-X-MAP carry their URI in an attribute.
function proxifyManifest(raw: string, baseUrl: string): string {
  const out: string[] = []
  for (const line0 of raw.split(/\r?\n/)) {
    const line = line0.trim()
    if (!line) {
      out.push("")
      continue
    }
    if (line.startsWith("#")) {
      if (/^#EXT-X-(KEY|MAP):/i.test(line)) {
        out.push(
          line.replace(/URI="([^"]+)"/g, (orig, uri: string) => {
            try {
              const abs = new URL(uri, baseUrl).toString()
              return `URI="/api/video-stream?seg=${encodeURIComponent(abs)}"`
            } catch {
              return orig
            }
          })
        )
      } else {
        out.push(line)
      }
      continue
    }
    try {
      const abs = new URL(line, baseUrl)
      if (!isAllowedHost(abs.hostname)) {
        out.push(line)
        continue
      }
      const isManifest = /\.m3u8(\?|$)/i.test(abs.pathname + abs.search)
      const key = isManifest ? "u" : "seg"
      out.push(`/api/video-stream?${key}=${encodeURIComponent(abs.toString())}`)
    } catch {
      out.push(line)
    }
  }
  return out.join("\n")
}

function manifestResponse(text: string) {
  return new NextResponse(text, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-store",
    },
  })
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  const u = searchParams.get("u")
  const seg = searchParams.get("seg")

  // 1) Resolve the signed master manifest for a video id.
  if (id) {
    if (!/^[0-9a-f]{32}$/i.test(id))
      return new NextResponse("invalid id", { status: 400 })
    try {
      const r = await fetch(`https://rutube.ru/api/play/options/${id}/?i=1`, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json",
          Referer: "https://rutube.ru/",
        },
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      })
      if (!r.ok) return new NextResponse(`rutube api ${r.status}`, { status: 502 })
      const j = (await r.json()) as { video_balancer?: { m3u8?: string } | null }
      const master = j?.video_balancer?.m3u8
      if (typeof master !== "string" || !master)
        return new NextResponse("no stream available", { status: 404 })
      const mu = new URL(master)
      if (!isAllowedHost(mu.hostname))
        return new NextResponse("host not allowed", { status: 403 })
      const mr = await fetch(mu.toString(), {
        headers: upstreamHeaders(),
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      })
      if (!mr.ok) return new NextResponse(`manifest ${mr.status}`, { status: 502 })
      return manifestResponse(proxifyManifest(await mr.text(), mu.toString()))
    } catch (e) {
      return new NextResponse(e instanceof Error ? e.message : "proxy error", {
        status: 502,
      })
    }
  }

  // 2) Nested (variant) manifest.
  if (u) {
    try {
      const mu = new URL(u)
      if (!isAllowedHost(mu.hostname))
        return new NextResponse("host not allowed", { status: 403 })
      const mr = await fetch(mu.toString(), {
        headers: upstreamHeaders(),
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      })
      if (!mr.ok) return new NextResponse(`manifest ${mr.status}`, { status: 502 })
      return manifestResponse(proxifyManifest(await mr.text(), mu.toString()))
    } catch (e) {
      return new NextResponse(e instanceof Error ? e.message : "proxy error", {
        status: 502,
      })
    }
  }

  // 3) Segment passthrough — Range header goes upstream, 206/Content-Range
  // come back, body streams without buffering the whole chunk.
  if (seg) {
    try {
      const su = new URL(seg)
      if (!isAllowedHost(su.hostname))
        return new NextResponse("host not allowed", { status: 403 })
      const range = request.headers.get("range")
      const sr = await fetch(su.toString(), {
        headers: upstreamHeaders(range),
        redirect: "follow",
      })
      if (!sr.ok && sr.status !== 206)
        return new NextResponse(`segment ${sr.status}`, { status: 502 })
      const headers = new Headers()
      const ct = sr.headers.get("content-type")
      if (ct) headers.set("Content-Type", ct)
      const cl = sr.headers.get("content-length")
      if (cl) headers.set("Content-Length", cl)
      const cr = sr.headers.get("content-range")
      if (cr) headers.set("Content-Range", cr)
      headers.set("Accept-Ranges", sr.headers.get("accept-ranges") || "bytes")
      headers.set("Cache-Control", "no-store")
      return new Response(sr.body, { status: sr.status, headers })
    } catch (e) {
      return new NextResponse(e instanceof Error ? e.message : "proxy error", {
        status: 502,
      })
    }
  }

  return new NextResponse("missing id/u/seg", { status: 400 })
}

export const dynamic = "force-dynamic"
