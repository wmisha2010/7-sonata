// Rutube video search + HLS source resolution for the desktop (Electron)
// and mobile (Capacitor) builds. The web build routes everything through
// its /api/video-search and /api/video-stream server routes; here there is
// no local server, so the renderer talks to Rutube's public REST API via
// lib/http.ts:
//   • Electron — plain fetch (webSecurity:false, no CORS).
//   • Capacitor — CapacitorHttp native stack (the WebView enforces CORS and
//     rutube.ru WAF answers 403 to the https://localhost Origin; native
//     requests carry no Origin header and succeed).
//
// Master manifest note: bl.rutube.ru (the video_balancer.m3u8 host) does
// NOT send Access-Control-Allow-Origin, so hls.js in the WebView cannot
// load it. The per-variant playlists on river-*.rtbcdn.ru / river-*.rutube.ru
// DO echo any Origin. Therefore on native we fetch the master manifest
// ourselves (httpText) and return the BEST variant playlist URL (max
// height ≤ 720p) directly — hls.js then loads only CORS-friendly hosts.

import type { Track } from "./tracks"
import { httpJson, httpText, isNativePlatform } from "./http"

export interface RutubeVideo {
  id: string
  title: string
  artist: string
  duration: number
  thumbnail?: string
}

interface RawRutubeResult {
  is_audio?: boolean
  is_livestream?: boolean
  is_deleted?: boolean
  is_hidden?: boolean
  is_locked?: boolean
  is_paid?: boolean
  embed_url?: string
  id: string
  title?: string
  duration?: number
  thumbnail_url?: string
  author?: { name?: string }
}

// Same UA the web build's /api/video-search route uses.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
const BASE_HEADERS = { Accept: "application/json", "User-Agent": UA, Referer: "https://rutube.ru/" }

export async function searchRutube(query: string): Promise<RutubeVideo[]> {
  if (!query.trim()) return []
  try {
    const j = await httpJson(
      `https://rutube.ru/api/search/video/?query=${encodeURIComponent(query)}`,
      BASE_HEADERS
    )
    // Non-video entries (audio-only, livestreams, deleted/hidden/locked/paid)
    // are filtered out so every result is actually playable.
    const videos = (j.results ?? [])
      .filter(
        (v: RawRutubeResult) =>
          !v.is_audio &&
          !v.is_livestream &&
          !v.is_deleted &&
          !v.is_hidden &&
          !v.is_locked &&
          !v.is_paid &&
          !!v.embed_url
      )
      .map((v: RawRutubeResult) => ({
        id: v.id,
        title: v.title ?? "Unknown",
        artist: v.author?.name ?? "Rutube",
        duration: Math.round(v.duration ?? 0),
        thumbnail: v.thumbnail_url || undefined,
      }))
    return videos
  } catch {
    return []
  }
}

// Marker URL scheme for Rutube tracks — the player code recognizes
// `rutube:` URLs and renders the HLS player (or the iframe fallback).
export function rutubeUrl(videoId: string): string {
  return `rutube:${videoId}`
}

export function isRutubeUrl(url: string): boolean {
  return url.startsWith("rutube:")
}

export function rutubeId(url: string): string {
  return url.slice("rutube:".length)
}

// Pick the best variant from a master m3u8 playlist for phones: highest
// resolution with height ≤ 720 (falls back to the smallest available).
// Returns the absolute variant playlist URL, or null if nothing parsed.
function pickVariant(masterText: string): string | null {
  const lines = masterText.split("\n")
  type Variant = { url: string; height: number; bandwidth: number }
  const variants: Variant[] = []
  for (let i = 0; i < lines.length - 1; i++) {
    const m = lines[i].match(/^#EXT-X-STREAM-INF:(.*)$/)
    if (!m) continue
    const attrs = m[1]
    const res = attrs.match(/RESOLUTION=(\d+)x(\d+)/)
    const bw = attrs.match(/BANDWIDTH=(\d+)/)
    let url = ""
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j].trim()
      if (line && !line.startsWith("#")) {
        url = line
        break
      }
    }
    if (!url) continue
    variants.push({
      url,
      height: res ? parseInt(res[2]) : 0,
      bandwidth: bw ? parseInt(bw[1]) : 0,
    })
  }
  if (!variants.length) return null
  const capped = variants.filter((v) => v.height > 0 && v.height <= 720)
  const best =
    capped.length > 0
      ? capped.reduce((a, b) => (b.height > a.height || (b.height === a.height && b.bandwidth > a.bandwidth) ? b : a))
      : variants.reduce((a, b) => (b.height > 0 && (a.height === 0 || b.height < a.height) ? b : a))
  try {
    return new URL(best.url).toString()
  } catch {
    return best.url
  }
}

// Resolve a CORS-safe HLS URL for a video id. The URL comes from
// rutube.ru/api/play/options (video_balancer.m3u8) — it is pre-signed
// (sign+expire) and works without extra referer/cookies.
//  • Web/desktop: return the master manifest as-is (hls.js handles it —
//    Electron has no CORS).
//  • Native/mobile: fetch the master via the native stack and return a
//    single variant playlist (rtbcdn echoes any Origin → hls.js works,
//    Web Audio stays tap-able → visualizer gets real samples).
export async function resolveRutubeMasterUrl(videoId: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/i.test(videoId)) return null
  try {
    const j = (await httpJson(`https://rutube.ru/api/play/options/${videoId}/?i=1`, {
      ...BASE_HEADERS,
      "X-Requested-With": "XMLHttpRequest",
    })) as { video_balancer?: { m3u8?: string } | null }
    const master = j?.video_balancer?.m3u8
    if (typeof master !== "string" || !master) return null
    if (!isNativePlatform()) return master
    try {
      const masterText = await httpText(master, { "User-Agent": UA })
      const variant = pickVariant(masterText)
      if (variant) return variant
    } catch {
      // Fall through to the master URL — the player will try and, if CORS
      // blocks it, switch to the iframe embed.
    }
    return master
  } catch {
    return null
  }
}

// v1.8.0: FULL master manifest as a local blob: URL — enables the manual
// quality selector. The signed master is fetched via the native stack (no
// CORS), every nested URI is rewritten to absolute https, and the result is
// served to hls.js as a blob:. hls.js then loads the per-variant playlists
// itself — river-*.rtbcdn.ru / river-*.rutube.ru echo any Origin, so ALL
// quality tiers load fine in the WebView (the bl.rutube.ru master host
// itself is the only one without CORS, and the native stack fetched it).
// Returns null on any failure — the caller falls back to the single
// ≤720p variant from resolveRutubeMasterUrl.
export async function resolveRutubeSourceObjectUrl(videoId: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/i.test(videoId)) return null
  if (!isNativePlatform()) return null // web/desktop use the /api/video-stream proxy master
  try {
    const j = (await httpJson(`https://rutube.ru/api/play/options/${videoId}/?i=1`, {
      ...BASE_HEADERS,
      "X-Requested-With": "XMLHttpRequest",
    })) as { video_balancer?: { m3u8?: string } | null }
    const master = j?.video_balancer?.m3u8
    if (typeof master !== "string" || !master) return null
    const text = await httpText(master, { "User-Agent": UA })
    // Absolutize: plain variant lines AND URI="…" attributes inside tag
    // lines (#EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF) — relative URIs
    // cannot resolve against a blob: base.
    const abs = text
      .split(/\r?\n/)
      .map((line0) => {
        const line = line0.trim()
        if (!line) return line
        if (line.startsWith("#")) {
          return line.replace(/URI="([^"]+)"/g, (orig, uri: string) => {
            try {
              return `URI="${new URL(uri, master).toString()}"`
            } catch {
              return orig
            }
          })
        }
        try {
          return new URL(line, master).toString()
        } catch {
          return line
        }
      })
      .join("\n")
    return URL.createObjectURL(new Blob([abs], { type: "application/vnd.apple.mpegurl" }))
  } catch {
    return null
  }
}

// Convert a search result into the app's Track shape. isStream: true —
// same persistence rules as mp3mn streams (permanent remote identity, no blob).
export function rutubeToTrack(v: RutubeVideo): Track {
  return {
    id: `rt-${v.id}`,
    title: v.title,
    artist: v.artist,
    album: "Rutube",
    duration: v.duration,
    url: rutubeUrl(v.id),
    coverImage: v.thumbnail,
    cover: { from: "#ef4444", to: "#f97316" },
    isStream: true,
    isVideo: true,
  }
}
