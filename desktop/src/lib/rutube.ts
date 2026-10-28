// Rutube video search + HLS source resolution for the desktop (Electron)
// and mobile (Capacitor) builds. The web build routes everything through
// its /api/video-search and /api/video-stream server routes; here there is
// no local server, so the renderer talks to Rutube's public REST API
// directly (allowed: Electron webSecurity:false / Capacitor native HTTP
// interceptor).

import type { Track } from "./tracks"

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

export async function searchRutube(query: string): Promise<RutubeVideo[]> {
  if (!query.trim()) return []
  try {
    const r = await fetch(
      `https://rutube.ru/api/search/video/?query=${encodeURIComponent(query)}`,
      { headers: { Accept: "application/json" } }
    )
    if (!r.ok) return []
    const j = await r.json()
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

// Resolve the signed master HLS manifest for a video id. The URL comes from
// rutube.ru/api/play/options (video_balancer.m3u8) — it is pre-signed
// (sign+expire) and works without extra referer/cookies. hls.js loads it
// cross-origin; all nested manifests/segments are absolute URLs on the same
// CDN hosts, so no rewriting is needed outside the web build.
export async function resolveRutubeMasterUrl(videoId: string): Promise<string | null> {
  if (!/^[0-9a-f]{32}$/i.test(videoId)) return null
  try {
    const r = await fetch(`https://rutube.ru/api/play/options/${videoId}/?i=1`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
    if (!r.ok) return null
    const j = (await r.json()) as { video_balancer?: { m3u8?: string } | null }
    const master = j?.video_balancer?.m3u8
    return typeof master === "string" && master ? master : null
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
