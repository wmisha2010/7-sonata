import { NextResponse } from "next/server"
// Dailymotion public REST API — read-only video search, no API key needed.
// GET /api/video-search?query=...
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get("query")?.trim()
  if (!q) return NextResponse.json({ videos: [] })
  try {
    const fields = ["id", "title", "duration", "thumbnail_480_url", "owner.screenname"].join(",")
    const u = `https://api.dailymotion.com/videos?search=${encodeURIComponent(q)}&fields=${fields}&limit=30&sort=relevance`
    const r = await fetch(u, { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" } })
    if (!r.ok) return NextResponse.json({ videos: [] })
    const j = await r.json()
    const videos = (j.list ?? []).map((v: { id: string; title: string; duration?: number; thumbnail_480_url?: string; "owner.screenname"?: string }) => ({
      id: v.id,
      title: v.title ?? "Unknown",
      artist: v["owner.screenname"] ?? "Dailymotion",
      duration: v.duration ?? 0,
      thumbnail: v.thumbnail_480_url,
    }))
    return NextResponse.json({ videos })
  } catch { return NextResponse.json({ videos: [] }) }
}
