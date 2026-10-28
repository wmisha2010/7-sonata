// Dailymotion video search client.
// Search runs server-side via /api/video-search (Dailymotion's public REST
// API needs no key). Playback uses Dailymotion's OFFICIAL embedded player:
// their CDN blocks non-browser clients (bot protection), so direct stream
// URLs are not an option — the iframe player is the supported path. We
// drive it through the documented postMessage API (api=1): play/pause,
// seek, volume and timeupdate / video_end events.

import type { Track } from "./tracks"

export interface DailymotionVideo {
  id: string
  title: string
  artist: string
  duration: number
  thumbnail?: string
}

export async function searchDailymotion(query: string): Promise<DailymotionVideo[]> {
  if (!query.trim()) return []
  try {
    const res = await fetch(`/api/video-search?query=${encodeURIComponent(query)}`)
    if (!res.ok) return []
    const json = await res.json()
    return (json.videos ?? []) as DailymotionVideo[]
  } catch { return [] }
}

// Marker URL scheme for Dailymotion embeds — the player code recognizes
// `dailymotion:` URLs and renders the official iframe player for them.
export function dailymotionUrl(videoId: string): string {
  return `dailymotion:${videoId}`
}

export function isDailymotionUrl(url: string): boolean {
  return url.startsWith("dailymotion:")
}

export function dailymotionId(url: string): string {
  return url.slice("dailymotion:".length)
}

// Convert a search result into the app's Track shape. isStream: true —
// same persistence rules as mp3mn streams (permanent remote URL, no blob).
export function dailymotionToTrack(v: DailymotionVideo): Track {
  return {
    id: `dm-${v.id}`,
    title: v.title,
    artist: v.artist,
    album: "Dailymotion",
    duration: v.duration,
    url: dailymotionUrl(v.id),
    coverImage: v.thumbnail,
    cover: { from: "#0ea5e9", to: "#6366f1" },
    isStream: true,
    isVideo: true,
  }
}
