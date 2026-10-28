// MP3mn.net music search — full-length tracks, no API key needed.
// Parses the HTML search results page to extract track info + stream URLs.
//
// In the Electron desktop app, the fetch happens via IPC (main process)
// because MP3mn has no CORS headers — browser fetch is blocked.

import type { Track } from "./tracks"

export interface Mp3mnTrack {
  id: string
  title: string
  artist: string
  artworkUrl?: string
  streamUrl: string
  duration: number
}

interface SonataBridge {
  isDesktop: boolean
  searchMp3mn: (query: string) => Promise<Mp3mnTrack[]>
}

function getBridge(): SonataBridge | null {
  if (typeof window !== "undefined" && (window as any).sonata?.isDesktop) {
    return (window as any).sonata as SonataBridge
  }
  return null
}

function parseDuration(text: string): number {
  const parts = text.trim().split(":")
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseInt(parts[1])
  }
  return 0
}

export async function searchMp3mn(query: string): Promise<Mp3mnTrack[]> {
  if (!query.trim()) return []
  const bridge = getBridge()
  if (bridge) return bridge.searchMp3mn(query)
  try {
    const res = await fetch(`/api/mp3mn-search?query=${encodeURIComponent(query)}`)
    if (!res.ok) return []
    const json = await res.json()
    return (json.tracks ?? []) as Mp3mnTrack[]
  } catch { return [] }
}

function parseHtml(html: string, coverUrl?: string): Mp3mnTrack[] {
  const tracks: Mp3mnTrack[] = []
  const seenFilenames = new Set<string>() // dedupe by URL filename
  const seenTitles = new Set<string>() // dedupe by artist+title
  // Each track is in a <li> block. Split by <li to get individual tracks.
  const items = html.split(/<li[^>]*>/)
  for (let i = 1; i < items.length; i++) {
    const block = items[i]
    const urlMatch = block.match(/data-url="([^"]+)"/)
    if (!urlMatch) continue

    const streamUrl = urlMatch[1]

    // Extract the filename from the URL for deduplication.
    // MP3mn often returns multiple copies of the same song with different
    // encoded paths but the same filename — keep only the first.
    const filename = streamUrl.split("/").pop() || streamUrl
    if (seenFilenames.has(filename)) continue

    const artistMatch = block.match(
      /class="playlist-name-artist"[^>]*><a[^>]*>([^<]+)/
    )
    const artist = artistMatch
      ? artistMatch[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'")
      : "Unknown"

    const titleMatch = block.match(
      /class="playlist-name-title"[^>]*>.*?<em>([^<]+)/
    )
    const title = titleMatch
      ? titleMatch[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'")
      : "Unknown"

    // Also dedupe by artist+title (case-insensitive) — different copies
    // with slightly different filenames but same song.
    const titleKey = `${artist.trim().toLowerCase()}|${title.trim().toLowerCase()}`
    if (seenTitles.has(titleKey)) continue

    const durMatch = block.match(/class="playlist-duration">([^<]+)/)
    const duration = durMatch ? parseDuration(durMatch[1]) : 0

    seenFilenames.add(filename)
    seenTitles.add(titleKey)

    tracks.push({
      id: `mn-${i}-${Date.now().toString(36)}`,
      title,
      artist,
      artworkUrl: coverUrl,
      streamUrl,
      duration,
    })
  }
  return tracks // no cap — the API route merges several mp3mn queries
}

// Route the CDN stream through our own origin (relative same-origin URL).
// Same-origin media can be safely captured by the Web Audio graph — no
// CORS-taint silence — so online tracks get the REAL spectrum visualizer
// and keep their sound. Desktop (Electron) uses its own IPC bridge and has
// no /api routes, so it keeps the direct URL.
function proxiedStreamUrl(streamUrl: string): string {
  if (typeof window !== "undefined" && (window as any).sonata?.isDesktop) return streamUrl
  return `/api/audio-proxy?url=${encodeURIComponent(streamUrl)}`
}

// Convert an mp3mn search result into the app's Track shape.
export function mp3mnToTrack(a: Mp3mnTrack): Track {
  return {
    id: a.id,
    title: a.title,
    artist: a.artist,
    album: "MP3mn",
    duration: a.duration,
    url: proxiedStreamUrl(a.streamUrl),
    coverImage: a.artworkUrl,
    cover: { from: "#f59e0b", to: "#ef4444" },
    isStream: true,
  }
}
