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
//
// v1.7.5 ANTI-BUFFERING LAYER:
// The proxy chain is client → this server → Rutube CDN, so every segment
// used to pay the full CDN round-trip latency on EVERY request (no cache at
// all). Since Rutube videos are VOD — every media segment is immutable once
// published — we now:
//   1. Keep an in-process LRU cache of fully downloaded segments; ABR level
//      switches, hls.js retries and seeks re-serve from RAM instantly.
//   2. Speculatively prefetch the NEXT segments of the variant playlist
//      being played, so they are already in RAM by the time hls.js asks —
//      the CDN latency is hidden behind the playback of the current segment.
//   3. Cache rewritten manifests for a short TTL (hls.js reloads variant
//      playlists on switches/stalls).
//   4. Allow the browser HTTP cache to keep segments (immutable content).
// The same benefits apply to the mobile app's background-audio fallback,
// which streams through this route too.

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

// ---------------- segment cache (LRU by recency, byte-capped) ----------------

type SegEntry = { data: Uint8Array; ct: string; status: number }

const SEG_MAX_BYTES = 128 * 1024 * 1024 // RAM cap for cached segments
const SEG_MAX_ENTRIES = 400
const segCache = new Map<string, SegEntry>() // Map preserves insertion order → LRU
let segBytes = 0
// De-duplicates concurrent downloads of the same segment (client request vs
// prefetch) — both await the same promise.
const segInflight = new Map<string, Promise<SegEntry | null>>()

function cacheGet(key: string): SegEntry | undefined {
  const e = segCache.get(key)
  if (e) {
    // touch → most recently used
    segCache.delete(key)
    segCache.set(key, e)
  }
  return e
}

function cachePut(key: string, e: SegEntry) {
  const prev = segCache.get(key)
  if (prev) {
    segBytes -= prev.data.byteLength
    segCache.delete(key)
  }
  // Never cache an oversized segment — it would evict half the cache.
  if (e.data.byteLength > SEG_MAX_BYTES / 2) return
  segCache.set(key, e)
  segBytes += e.data.byteLength
  while (segBytes > SEG_MAX_BYTES || segCache.size > SEG_MAX_ENTRIES) {
    const oldest = segCache.keys().next().value as string | undefined
    if (oldest === undefined) break
    const o = segCache.get(oldest)!
    segBytes -= o.data.byteLength
    segCache.delete(oldest)
  }
}

// Download (or join an in-flight download of) a full segment.
async function loadSegment(url: string, timeoutMs?: number): Promise<SegEntry | null> {
  const cached = cacheGet(url)
  if (cached) return cached
  const infl = segInflight.get(url)
  if (infl) return infl
  const p = (async (): Promise<SegEntry | null> => {
    try {
      const r = await fetch(url, {
        headers: upstreamHeaders(),
        redirect: "follow",
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      })
      if (!r.ok && r.status !== 206) return null
      const data = new Uint8Array(await r.arrayBuffer())
      const e: SegEntry = {
        data,
        ct: r.headers.get("content-type") || "video/mp2t",
        status: r.status,
      }
      cachePut(url, e)
      return e
    } catch {
      return null
    } finally {
      segInflight.delete(url)
    }
  })()
  segInflight.set(url, p)
  return p
}

// ---------------- playlist order tracking (for prefetch) ----------------

// Variant playlist URL → ordered absolute segment URLs.
const PLAYLIST_TTL_MS = 10 * 60_000
const playlistOrder = new Map<string, { segs: string[]; t: number }>()
// Absolute segment URL → position within its playlist (reverse index).
const segPos = new Map<string, { pl: string; idx: number }>()

// Register the segment order of a MEDIA playlist (skip master manifests —
// they list variant playlists, not segments; the #EXTINF check filters them).
function rememberPlaylist(playlistUrl: string, raw: string) {
  if (!/#EXTINF/i.test(raw)) return
  const segs: string[] = []
  for (const line0 of raw.split(/\r?\n/)) {
    const line = line0.trim()
    if (!line || line.startsWith("#")) continue
    try {
      segs.push(new URL(line, playlistUrl).toString())
    } catch {
      /* skip malformed line */
    }
  }
  if (!segs.length) return
  playlistOrder.set(playlistUrl, { segs, t: Date.now() })
  segs.forEach((s, i) => segPos.set(s, { pl: playlistUrl, idx: i }))
  if (playlistOrder.size > 16) {
    let oldestKey = ""
    let oldestT = Infinity
    for (const [k, v] of playlistOrder) {
      if (v.t < oldestT) {
        oldestT = v.t
        oldestKey = k
      }
    }
    if (oldestKey) {
      for (const s of playlistOrder.get(oldestKey)!.segs) {
        const p = segPos.get(s)
        if (p && p.pl === oldestKey) segPos.delete(s)
      }
      playlistOrder.delete(oldestKey)
    }
  }
}

// Speculatively download the next segments of the variant currently being
// played. Fire-and-forget: they land in the LRU before hls.js needs them.
const PREFETCH_AHEAD = 2
function prefetchAfter(segUrl: string) {
  const pos = segPos.get(segUrl)
  if (!pos) return
  const info = playlistOrder.get(pos.pl)
  if (!info || Date.now() - info.t > PLAYLIST_TTL_MS) return
  for (let n = 1; n <= PREFETCH_AHEAD; n++) {
    const next = info.segs[pos.idx + n]
    if (!next) break
    if (segCache.has(next) || segInflight.has(next)) continue
    // Cap concurrent downloads so rapid seeking doesn't stampede the CDN.
    if (segInflight.size >= 4) break
    void loadSegment(next, 30_000)
  }
}

// ---------------- manifest cache (short TTL) ----------------

const MANIFEST_TTL_MS = 120_000
const manifestCache = new Map<string, { text: string; t: number }>()

function manifestCacheGet(key: string): string | null {
  const m = manifestCache.get(key)
  if (!m) return null
  if (Date.now() - m.t > MANIFEST_TTL_MS) {
    manifestCache.delete(key)
    return null
  }
  return m.text
}

function manifestCachePut(key: string, text: string) {
  manifestCache.set(key, { text, t: Date.now() })
  if (manifestCache.size > 64) {
    const first = manifestCache.keys().next().value as string | undefined
    if (first) manifestCache.delete(first)
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

// Serve a cached full segment, honouring Range requests (206) so seeking
// clients keep working without ever touching the CDN.
function segResponseFromCache(e: SegEntry, range: string | null, hit: boolean): Response {
  const headers = new Headers()
  headers.set("Content-Type", e.ct)
  headers.set("Accept-Ranges", "bytes")
  // Rutube VOD segments are immutable → let the browser HTTP cache keep
  // them across replays/retries (hls.js re-requests on some seeks).
  headers.set("Cache-Control", "public, max-age=86400")
  headers.set("X-Cache", hit ? "HIT" : "MISS")
  const len = e.data.byteLength
  const m = range ? range.match(/bytes=(\d*)-(\d*)/) : null
  if (m) {
    let start: number
    let end: number
    if (m[1] === "" && m[2] !== "") {
      // suffix range "bytes=-N" → last N bytes
      const n = parseInt(m[2], 10)
      start = Math.max(0, len - n)
      end = len - 1
    } else {
      start = m[1] === "" ? 0 : parseInt(m[1], 10)
      end = m[2] === "" ? len - 1 : parseInt(m[2], 10)
    }
    if (!Number.isFinite(end) || end >= len) end = len - 1
    if (start >= 0 && start <= end && start < len) {
      const chunk = e.data.slice(start, end + 1)
      headers.set("Content-Range", `bytes ${start}-${end}/${len}`)
      headers.set("Content-Length", String(chunk.byteLength))
      return new Response(chunk, { status: 206, headers })
    }
    headers.set("Content-Range", `bytes */${len}`)
    return new Response(null, { status: 416, headers })
  }
  headers.set("Content-Length", String(len))
  return new Response(e.data, { status: 200, headers })
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
    const ck = `id:${id}`
    const cached = manifestCacheGet(ck)
    if (cached) return manifestResponse(cached)
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
      const text = proxifyManifest(await mr.text(), mu.toString())
      manifestCachePut(ck, text)
      return manifestResponse(text)
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
      const ck = mu.toString()
      const cached = manifestCacheGet(ck)
      if (cached) return manifestResponse(cached)
      const mr = await fetch(mu.toString(), {
        headers: upstreamHeaders(),
        cache: "no-store",
        signal: AbortSignal.timeout(12000),
      })
      if (!mr.ok) return new NextResponse(`manifest ${mr.status}`, { status: 502 })
      const raw = await mr.text()
      rememberPlaylist(ck, raw) // register segment order → enables prefetch
      const text = proxifyManifest(raw, ck)
      manifestCachePut(ck, text)
      return manifestResponse(text)
    } catch (e) {
      return new NextResponse(e instanceof Error ? e.message : "proxy error", {
        status: 502,
      })
    }
  }

  // 3) Segments. Full-object requests go through the LRU cache + prefetch;
  // Range requests pass through upstream (hls.js only sends Range for
  // byterange playlists — Rutube TS segments are plain full-object parts).
  if (seg) {
    try {
      const su = new URL(seg)
      if (!isAllowedHost(su.hostname))
        return new NextResponse("host not allowed", { status: 403 })
      const abs = su.toString()
      const range = request.headers.get("range")

      if (!range) {
        const cached = cacheGet(abs)
        if (cached) {
          prefetchAfter(abs)
          return segResponseFromCache(cached, null, true)
        }
        const e = await loadSegment(abs, 60_000)
        if (!e) return new NextResponse("segment fetch failed", { status: 502 })
        prefetchAfter(abs)
        return segResponseFromCache(e, null, false)
      }

      const sr = await fetch(abs, {
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
      headers.set("Cache-Control", "public, max-age=86400")
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
