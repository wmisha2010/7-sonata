import { NextResponse } from "next/server"
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url); const t = searchParams.get("url")
  if (!t) return new NextResponse("missing url", { status: 400 })
  if (!/^https?:\/\//i.test(t)) return new NextResponse("invalid url", { status: 400 })
  try {
    const u = await fetch(t, { headers: { "User-Agent": "Mozilla/5.0", Referer: new URL(t).origin }, redirect: "follow" })
    if (!u.ok) return new NextResponse(`upstream ${u.status}`, { status: 502 })
    const ct = u.headers.get("content-type") || "image/jpeg"; if (!ct.startsWith("image/")) return new NextResponse(`not image: ${ct}`, { status: 415 })
    const buf = Buffer.from(await u.arrayBuffer())
    return new NextResponse(buf, { status: 200, headers: { "Content-Type": ct, "Cache-Control": "public, max-age=86400, immutable", "Access-Control-Allow-Origin": "*" } })
  } catch (e) { return new NextResponse(e instanceof Error ? e.message : "proxy error", { status: 502 }) }
}
export const dynamic = "force-dynamic"
