export interface EnrichedMeta { title?: string; artist?: string; album?: string; coverImage?: string; duration?: number }
export async function enrichFromITunes(filename: string): Promise<EnrichedMeta | null> {
  const query = filename.replace(/\.[^.]+$/, "").replace(/_/g, " ").replace(/\s+/g, " ").trim()
  if (!query) return null
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=1`
    const res = await fetch(url, { headers: { Accept: "application/json" } })
    if (!res.ok) return null
    const json = await res.json()
    const track = json?.results?.[0]
    if (!track) return null
    return { title: track.trackName || undefined, artist: track.artistName || undefined, album: track.collectionName || undefined, coverImage: track.artworkUrl100 ? track.artworkUrl100.replace("100x100", "300x300") : undefined, duration: track.trackTimeMillis ? Math.round(track.trackTimeMillis / 1000) : undefined }
  } catch { return null }
}
export function getDurationFromAudio(url: string, isVideo = false): Promise<number> {
  return new Promise((resolve) => {
    const el = isVideo ? document.createElement("video") : new Audio()
    el.preload = "metadata"; el.src = url
    el.onloadedmetadata = () => { const d = el.duration; el.src = ""; if (el instanceof HTMLMediaElement) el.load(); resolve(Number.isFinite(d) && d > 0 ? Math.round(d) : 0) }
    el.onerror = () => resolve(0); setTimeout(() => resolve(0), 8000)
  })
}
