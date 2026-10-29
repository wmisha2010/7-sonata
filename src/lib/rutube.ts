// Rutube video search client.
// Search runs server-side via /api/video-search (Rutube's public REST API
// needs no key). Playback uses Rutube's OFFICIAL embedded player:
// https://rutube.ru/play/embed/{id}/?autoplay=1 — the iframe is the reliable
// path because Rutube no longer exposes direct stream URLs in its public API
// (and the previous Dailymotion integration turned out to be referer-locked:
// geo.dailymotion.com 403s every non-Dailymotion referrer).
// The embed is driven via the verified postMessage protocol:
//   commands (parent → player): JSON strings {type:"player:play"} /
//     {type:"player:pause"} (seek is NOT supported by the embed — its own
//     controls handle it; volume is sent best-effort);
//   events (player → parent): JSON strings {type:"player:...",data:{...}}
//     with origin https://rutube.ru — init/ready, playStart, changeState
//     (state playing/pause/complete), currentTime, durationChange,
//     playOptionsLoaded (acl_access.allowed = доступ к видео), error.

import type { Track } from "./tracks"

export interface RutubeVideo {
  id: string
  title: string
  artist: string
  duration: number
  thumbnail?: string
}

export async function searchRutube(query: string): Promise<RutubeVideo[]> {
  if (!query.trim()) return []
  try {
    const res = await fetch(`/api/video-search?query=${encodeURIComponent(query)}`)
    if (!res.ok) return []
    const json = await res.json()
    return (json.videos ?? []) as RutubeVideo[]
  } catch { return [] }
}

// Marker URL scheme for Rutube embeds — the player code recognizes `rutube:`
// URLs and renders the official iframe player for them.
export function rutubeUrl(videoId: string): string {
  return `rutube:${videoId}`
}

export function isRutubeUrl(url: string): boolean {
  return url.startsWith("rutube:")
}

export function rutubeId(url: string): string {
  return url.slice("rutube:".length)
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
