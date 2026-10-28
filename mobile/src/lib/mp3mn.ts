// MP3mn.net music search — full-length tracks, no API key needed.
// Desktop (Electron) / Mobile (Capacitor) build: the fetch runs directly
// from the renderer — cross-origin restrictions are lifted on those
// platforms (Electron webSecurity:false, Capacitor native HTTP interceptor).
// The aggregation logic mirrors the web app's /api/mp3mn-search route:
// mp3mn caps ONE query at ~20-23 tracks and has no pagination, so we fire
// the full query AND one search per significant word, in parallel, then
// merge + dedupe (up to 200 results).

import type { Track } from "./tracks"

export interface Mp3mnTrack {
  id: string
  title: string
  artist: string
  artworkUrl?: string
  streamUrl: string
  duration: number
}

function parseDuration(text: string): number {
  const parts = text.trim().split(":")
  if (parts.length === 2) {
    return parseInt(parts[0]) * 60 + parseInt(parts[1])
  }
  return 0
}

function parseHtml(html: string, coverUrl: string | undefined, tag: number): Mp3mnTrack[] {
  const tracks: Mp3mnTrack[] = []
  const items = html.split(/<li[^>]*>/)
  for (let i = 1; i < items.length; i++) {
    const b = items[i]
    const um = b.match(/data-url="([^"]+)"/)
    if (!um) continue
    const su = um[1]
    const am = b.match(/class="playlist-name-artist"[^>]*><a[^>]*>([^<]+)/)
    const ar = am ? am[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'") : "Unknown"
    const tm = b.match(/class="playlist-name-title"[^>]*>.*?<em>([^<]+)/)
    const ti = tm ? tm[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'") : "Unknown"
    const dm = b.match(/class="playlist-duration">([^<]+)/)
    const du = dm ? parseDuration(dm[1]) : 0
    tracks.push({
      id: `mn-${tag}-${i}-${Date.now().toString(36)}`,
      title: ti,
      artist: ar,
      artworkUrl: coverUrl,
      streamUrl: su,
      duration: du,
    })
  }
  return tracks
}

// One search round-trip: mp3mn /api/search → track page → parse.
async function searchOnce(q: string, tag: number): Promise<Mp3mnTrack[]> {
  const headers = { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
  const aR = await fetch(`https://mp3mn.net/api/search?query=${encodeURIComponent(q)}`, { headers })
  if (!aR.ok) return []
  const aJ = await aR.json()
  const rp = aJ.url
  if (!rp) return []
  const pR = await fetch(`https://mp3mn.net${rp}`, { headers })
  if (!pR.ok) return []
  const pJ = await pR.json()
  const html = pJ.xx1_content || pJ.xx2_content || ""
  const cm = html.match(/src="(\/public\/album\/[^"]+)"/)
  const cu = cm ? `https://mp3mn.net${cm[1]}` : undefined
  return parseHtml(html, cu, tag)
}

// Distinctive words of the query for extra probes: drop 1-2 char filler
// ("и", "of"), longest (most distinctive) first, max 4 probes.
function probeWords(q: string): string[] {
  const words = q.split(/\s+/).filter(Boolean)
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const k = w.toLowerCase()
    if (k.length < 3 || seen.has(k)) continue
    seen.add(k)
    out.push(w)
    if (out.length >= 4) break
  }
  return out
}

export async function searchMp3mn(query: string): Promise<Mp3mnTrack[]> {
  if (!query.trim()) return []
  try {
    // Full query + one probe per significant word, all in parallel so the
    // wall time stays close to a single query even for multi-word input.
    const probes = probeWords(query).filter((w) => w.toLowerCase() !== query.toLowerCase())
    const queries = [query, ...probes]
    const batches = await Promise.all(queries.map((s, i) => searchOnce(s, i).catch(() => [])))
    // Merge: full-query hits first, then word probes. Dedupe across queries
    // by stream filename and artist+title (mp3mn re-serves the same songs).
    const merged: Mp3mnTrack[] = []
    const sf = new Set<string>()
    const st = new Set<string>()
    for (const batch of batches) {
      for (const t of batch) {
        const fn = t.streamUrl.split("/").pop() || t.streamUrl
        const tk = `${t.artist.trim().toLowerCase()}|${t.title.trim().toLowerCase()}`
        if (sf.has(fn) || st.has(tk)) continue
        sf.add(fn)
        st.add(tk)
        merged.push(t)
      }
    }
    return merged.slice(0, 200)
  } catch {
    return []
  }
}

// Convert an mp3mn search result into the app's Track shape. The stream URL
// stays direct — on desktop/mobile there is no local proxy server, and the
// platforms allow cross-origin media (playback works; the Web Audio graph
// detaches for remote streams exactly like in the web build).
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
