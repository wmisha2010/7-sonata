// Audius music search — free, legal (Creative Commons), full-length tracks.
// API docs: https://docs.audius.org
// No API key required — just an app_name.
//
// Uses regular fetch() everywhere (browser, mobile, desktop). In Electron
// desktop, webSecurity:false + permissive CSP allow cross-origin requests.

import type { Track } from "./tracks"

const AUDIUS_HOST = "https://discoveryprovider.audius.co"
const APP_NAME = "sonata"

export interface AudiusTrack {
  id: string
  title: string
  artist: string
  artworkUrl?: string
  streamUrl: string
  duration: number
}

// Search Audius for tracks matching the query. Returns up to 20 results.
export async function searchAudius(query: string): Promise<AudiusTrack[]> {
  if (!query.trim()) return []

  // Get fresh discovery nodes from Audius, fall back to hardcoded.
  let hosts = [AUDIUS_HOST]
  try {
    const res = await fetch("https://api.audius.co", {
      headers: { Accept: "application/json" },
    })
    const json = await res.json()
    if (Array.isArray(json?.data) && json.data.length > 0) {
      hosts = json.data.slice(0, 6)
    }
  } catch {
    // use fallback
  }

  for (const host of hosts) {
    try {
      const url = `${host}/v1/tracks/search?query=${encodeURIComponent(
        query
      )}&app_name=${APP_NAME}&limit=20`
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { Accept: "application/json" },
      })
      if (!res.ok) continue
      const json = await res.json()
      const data = (json?.data ?? []) as Array<{
        id: string
        title: string
        user?: { name: string }
        artwork?: { "150x150"?: string; "480x480"?: string }
        duration?: number
      }>
      return data
        .filter((t) => t.id && t.title)
        .map((t) => ({
          id: `aud-${t.id}`,
          title: t.title,
          artist: t.user?.name || "Audius",
          artworkUrl: t.artwork?.["480x480"] || t.artwork?.["150x150"],
          streamUrl: `${host}/v1/tracks/${t.id}/stream?app_name=${APP_NAME}`,
          duration: t.duration || 0,
        }))
    } catch {
      // try next host
    }
  }
  return []
}

// Convert an Audius search result into the app's Track shape.
export function audiusToTrack(a: AudiusTrack): Track {
  return {
    id: a.id,
    title: a.title,
    artist: a.artist,
    album: "Audius",
    duration: a.duration,
    url: a.streamUrl,
    cover: { from: "#8b5cf6", to: "#ec4899" },
    coverImage: a.artworkUrl,
    isStream: true,
  }
}
