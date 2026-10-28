import { NextResponse } from "next/server"
interface Mp3mnTrack { id: string; title: string; artist: string; artworkUrl?: string; streamUrl: string; duration: number }
function parseDuration(t: string): number { const p = t.trim().split(":"); if (p.length === 2) { const m = parseInt(p[0], 10), s = parseInt(p[1], 10); if (!isNaN(m) && !isNaN(s)) return m * 60 + s } return 0 }

// mp3mn caps ONE query at ~20-23 tracks and has no pagination at all
// (the site's own "load more" is disabled on search pages — data-urlnext
// is always "false"). To give the user more than that we fire the full
// query AND one search per significant word, in parallel, then merge.
function parseHtml(html: string, coverUrl: string | undefined, tag: number): Mp3mnTrack[] {
  const tracks: Mp3mnTrack[] = []
  const items = html.split(/<li[^>]*>/)
  for (let i = 1; i < items.length; i++) {
    const b = items[i]; const um = b.match(/data-url="([^"]+)"/); if (!um) continue
    const su = um[1]
    const am = b.match(/class="playlist-name-artist"[^>]*><a[^>]*>([^<]+)/); const ar = am ? am[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'") : "Unknown"
    const tm = b.match(/class="playlist-name-title"[^>]*>.*?<em>([^<]+)/); const ti = tm ? tm[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'") : "Unknown"
    const dm = b.match(/class="playlist-duration">([^<]+)/); const du = dm ? parseDuration(dm[1]) : 0
    tracks.push({ id: `mn-${tag}-${i}-${Date.now().toString(36)}`, title: ti, artist: ar, artworkUrl: coverUrl, streamUrl: su, duration: du })
  }
  return tracks
}

// One search round-trip: mp3mn /api/search → track page → parse.
async function searchOnce(q: string, tag: number): Promise<Mp3mnTrack[]> {
  const aR = await fetch(`https://mp3mn.net/api/search?query=${encodeURIComponent(q)}`, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0" } })
  if (!aR.ok) return []
  const aJ = await aR.json(); const rp = aJ.url; if (!rp) return []
  const pR = await fetch(`https://mp3mn.net${rp}`, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0" } })
  if (!pR.ok) return []
  const pJ = await pR.json(); const html = pJ.xx1_content || pJ.xx2_content || ""
  const cm = html.match(/src="(\/public\/album\/[^"]+)"/); const cu = cm ? `https://mp3mn.net${cm[1]}` : undefined
  return parseHtml(html, cu, tag)
}

// Distinctive words of the query for extra probes: drop 1-2 char filler
// ("и", "of"), longest (most distinctive) first, max 4 probes.
function probeWords(q: string): string[] {
  const words = q.split(/\s+/).filter(Boolean)
  const seen = new Set<string>(); const out: string[] = []
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const k = w.toLowerCase()
    if (k.length < 3 || seen.has(k)) continue
    seen.add(k); out.push(w)
    if (out.length >= 4) break
  }
  return out
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url); const q = searchParams.get("query")?.trim(); if (!q) return NextResponse.json({ tracks: [] })
  try {
    // Full query + one probe per significant word, all in parallel so the
    // wall time stays close to a single query even for multi-word input.
    const probes = probeWords(q).filter((w) => w.toLowerCase() !== q.toLowerCase())
    const queries = [q, ...probes]
    const batches = await Promise.all(queries.map((s, i) => searchOnce(s, i)))
    // Merge: full-query hits first, then word probes. Dedupe across queries
    // by stream filename and artist+title (mp3mn re-serves the same songs).
    const merged: Mp3mnTrack[] = []; const sf = new Set<string>(); const st = new Set<string>()
    for (const batch of batches) {
      for (const t of batch) {
        const fn = t.streamUrl.split("/").pop() || t.streamUrl
        const tk = `${t.artist.trim().toLowerCase()}|${t.title.trim().toLowerCase()}`
        if (sf.has(fn) || st.has(tk)) continue
        sf.add(fn); st.add(tk); merged.push(t)
      }
    }
    return NextResponse.json({ tracks: merged.slice(0, 200) })
  } catch { return NextResponse.json({ tracks: [] }) }
}
