import { NextResponse } from "next/server"
// Rutube public REST API — read-only video search, no API key needed.
// GET /api/video-search?query=...
// Non-video entries (audio-only, livestreams, deleted/hidden/locked/paid)
// are filtered out so every result is actually playable in the embed.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get("query")?.trim()
  if (!q) return NextResponse.json({ videos: [] })
  try {
    const r = await fetch(
      `https://rutube.ru/api/search/video/?query=${encodeURIComponent(q)}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        },
        cache: "no-store",
      }
    )
    if (!r.ok) return NextResponse.json({ videos: [] })
    const j = await r.json()
    const videos = (j.results ?? [])
      .filter(
        (v: {
          is_audio?: boolean
          is_livestream?: boolean
          is_deleted?: boolean
          is_hidden?: boolean
          is_locked?: boolean
          is_paid?: boolean
          embed_url?: string
        }) =>
          !v.is_audio &&
          !v.is_livestream &&
          !v.is_deleted &&
          !v.is_hidden &&
          !v.is_locked &&
          !v.is_paid &&
          !!v.embed_url
      )
      .map(
        (v: {
          id: string
          title?: string
          duration?: number
          thumbnail_url?: string
          author?: { name?: string }
        }) => ({
          id: v.id,
          title: v.title ?? "Unknown",
          artist: v.author?.name ?? "Rutube",
          duration: Math.round(v.duration ?? 0),
          thumbnail: v.thumbnail_url || undefined,
        })
      )
    return NextResponse.json({ videos })
  } catch {
    return NextResponse.json({ videos: [] })
  }
}
