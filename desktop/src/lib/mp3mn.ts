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
    let tracks = await searchOnce(query)
    // mp3mn returns an EMPTY stub page for multi-word queries. Fall back to
    // the longest words of the query (the distinctive terms).
    if (!tracks.length) {
      const words = query.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length)
      for (const w of words.slice(0, 3)) {
        if (words.length === 1) break
        tracks = await searchOnce(w)
        if (tracks.length) break
      }
    }
    return tracks
  } catch {
    return []
  }
}

async function searchOnce(query: string): Promise<Mp3mnTrack[]> {
  const apiUrl = `https://mp3mn.net/api/search?query=${encodeURIComponent(query)}`
  const apiRes = await fetch(apiUrl, {
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
  })
  if (!apiRes.ok) throw new Error("api failed")
  const apiJson = await apiRes.json()
  const redirectPath = apiJson.url
  if (!redirectPath) throw new Error("no redirect")
  const pageUrl = `https://mp3mn.net${redirectPath}`
  const pageRes = await fetch(pageUrl, {
    headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
  })
  if (!pageRes.ok) throw new Error("page failed")
  const pageJson = await pageRes.json()
  const html = pageJson.xx1_content || pageJson.xx2_content || ""
  const coverMatch = html.match(/src="(\/public\/album\/[^"]+)"/)
  const coverUrl = coverMatch ? `https://mp3mn.net${coverMatch[1]}` : undefined
  return parseHtml(html, coverUrl)
}

function parseHtml(html: string, coverUrl?: string): Mp3mnTrack[] {
  const tracks: Mp3mnTrack[] = []
  const seenFilenames = new Set<string>()
  const seenTitles = new Set<string>()
  const items = html.split(/<li[^>]*>/)
  for (let i = 1; i < items.length; i++) {
    const block = items[i]
    const urlMatch = block.match(/data-url="([^"]+)"/)
    if (!urlMatch) continue
    const streamUrl = urlMatch[1]
    const filename = streamUrl.split("/").pop() || streamUrl
    if (seenFilenames.has(filename)) continue
    const artistMatch = block.match(/class="playlist-name-artist"[^>]*><a[^>]*>([^<]+)/)
    const artist = artistMatch ? artistMatch[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'") : "Unknown"
    const titleMatch = block.match(/class="playlist-name-title"[^>]*>.*?<em>([^<]+)/)
    const title = titleMatch ? titleMatch[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'") : "Unknown"
    const titleKey = `${artist.trim().toLowerCase()}|${title.trim().toLowerCase()}`
    if (seenTitles.has(titleKey)) continue
    const durMatch = block.match(/class="playlist-duration">([^<]+)/)
    const duration = durMatch ? parseDuration(durMatch[1]) : 0
    seenFilenames.add(filename)
    seenTitles.add(titleKey)
    tracks.push({ id: `mn-${i}-${Date.now().toString(36)}`, title, artist, artworkUrl: coverUrl, streamUrl, duration })
  }
  return tracks.slice(0, 25)
}

export function mp3mnToTrack(a: Mp3mnTrack): Track {
  return {
    id: a.id,
    title: a.title,
    artist: a.artist,
    album: "MP3mn",
    duration: a.duration,
    url: a.streamUrl,
    coverImage: a.artworkUrl,
    cover: { from: "#f59e0b", to: "#ef4444" },
    isStream: true,
  }
}
