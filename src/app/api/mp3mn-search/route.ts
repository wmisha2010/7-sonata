import { NextResponse } from "next/server"
interface Mp3mnTrack { id: string; title: string; artist: string; artworkUrl?: string; streamUrl: string; duration: number }
function parseDuration(t: string): number { const p = t.trim().split(":"); if (p.length === 2) { const m = parseInt(p[0], 10), s = parseInt(p[1], 10); if (!isNaN(m) && !isNaN(s)) return m * 60 + s } return 0 }
function parseHtml(html: string, coverUrl?: string): Mp3mnTrack[] {
  const tracks: Mp3mnTrack[] = []; const sf = new Set<string>(); const st = new Set<string>()
  const items = html.split(/<li[^>]*>/)
  for (let i = 1; i < items.length; i++) {
    const b = items[i]; const um = b.match(/data-url="([^"]+)"/); if (!um) continue
    const su = um[1]; const fn = su.split("/").pop() || su; if (sf.has(fn)) continue
    const am = b.match(/class="playlist-name-artist"[^>]*><a[^>]*>([^<]+)/); const ar = am ? am[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'") : "Unknown"
    const tm = b.match(/class="playlist-name-title"[^>]*>.*?<em>([^<]+)/); const ti = tm ? tm[1].replace(/&amp;/g, "&").replace(/&#0?3[09];/g, "'") : "Unknown"
    const tk = `${ar.trim().toLowerCase()}|${ti.trim().toLowerCase()}`; if (st.has(tk)) continue
    const dm = b.match(/class="playlist-duration">([^<]+)/); const du = dm ? parseDuration(dm[1]) : 0
    sf.add(fn); st.add(tk); tracks.push({ id: `mn-${i}-${Date.now().toString(36)}`, title: ti, artist: ar, artworkUrl: coverUrl, streamUrl: su, duration: du })
  }
  return tracks.slice(0, 25)
}

// One search round-trip: mp3mn /api/search → track page → parse.
async function searchOnce(q: string): Promise<Mp3mnTrack[]> {
  const aR = await fetch(`https://mp3mn.net/api/search?query=${encodeURIComponent(q)}`, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0" } })
  if (!aR.ok) return []
  const aJ = await aR.json(); const rp = aJ.url; if (!rp) return []
  const pR = await fetch(`https://mp3mn.net${rp}`, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "User-Agent": "Mozilla/5.0" } })
  if (!pR.ok) return []
  const pJ = await pR.json(); const html = pJ.xx1_content || pJ.xx2_content || ""
  const cm = html.match(/src="(\/public\/album\/[^"]+)"/); const cu = cm ? `https://mp3mn.net${cm[1]}` : undefined
  return parseHtml(html, cu)
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url); const q = searchParams.get("query")?.trim(); if (!q) return NextResponse.json({ tracks: [] })
  try {
    let tracks = await searchOnce(q)
    // mp3mn returns an EMPTY stub page for multi-word queries. Fall back to
    // the longest words of the query (the distinctive terms), which reliably
    // return results.
    if (!tracks.length) {
      const words = q.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length)
      for (const w of words.slice(0, 3)) {
        if (words.length === 1) break
        tracks = await searchOnce(w)
        if (tracks.length) break
      }
    }
    return NextResponse.json({ tracks })
  } catch { return NextResponse.json({ tracks: [] }) }
}
