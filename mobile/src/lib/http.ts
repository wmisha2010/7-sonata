// Native-aware HTTP helpers for the Capacitor (mobile) build.
//
// WHY: the Capacitor WebView is a regular browser context (origin
// https://localhost) — plain fetch() is subject to CORS, and most of our
// targets (mp3mn.net: no ACAO at all; rutube.ru/api/search: 403 for the
// localhost Origin via WAF) reject or block it. Electron (desktop) is fine
// because its renderer runs with webSecurity:false.
//
// FIX: on a native platform we route requests through CapacitorHttp —
// the request is executed by the NATIVE HTTP stack (OkHttp), which has no
// CORS concept, sends no Origin header, and allows custom User-Agent.
// On web/desktop we fall back to plain fetch (unchanged behavior).
//
// IMPORTANT: do NOT enable the global `CapacitorHttp: { enabled: true }`
// interceptor in capacitor.config.ts — it would transparently patch
// window.fetch and hijack hls.js segment/media requests (Range headers,
// streaming) as well. These helpers keep native HTTP opt-in per call.

import { Capacitor, CapacitorHttp } from "@capacitor/core"

export function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

const DEFAULT_TIMEOUT = 15000

type Headers = Record<string, string>

async function nativeGet(
  url: string,
  headers: Headers | undefined,
  timeout: number,
  responseType: "json" | "text" | "arraybuffer"
) {
  const res = await CapacitorHttp.get({
    url,
    headers: headers ?? {},
    connectTimeout: timeout,
    readTimeout: timeout,
    responseType,
  })
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`)
  return res
}

// JSON → parsed object. On native, CapacitorHttp already parses JSON
// responses into an object; a plain string means non-JSON content-type.
export async function httpJson(url: string, headers?: Headers, timeout = DEFAULT_TIMEOUT): Promise<any> {
  if (isNativePlatform()) {
    const res = await nativeGet(url, headers, timeout, "json")
    if (typeof res.data === "string") {
      try {
        return JSON.parse(res.data)
      } catch {
        throw new Error("invalid JSON body")
      }
    }
    return res.data
  }
  const r = await fetch(url, { headers, cache: "no-store" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// Plain text (m3u8 playlists etc.).
export async function httpText(url: string, headers?: Headers, timeout = DEFAULT_TIMEOUT): Promise<string> {
  if (isNativePlatform()) {
    const res = await nativeGet(url, headers, timeout, "text")
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data)
  }
  const r = await fetch(url, { headers, cache: "no-store" })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text()
}

// Binary (images) → data: URL, safe for <img> + canvas getImageData
// (bypasses CORS/canvas-tainting entirely).
export async function httpBlobAsDataUrl(url: string, timeout = DEFAULT_TIMEOUT): Promise<string> {
  if (isNativePlatform()) {
    const res = await nativeGet(url, undefined, timeout, "arraybuffer")
    // CapacitorHttp returns binary payload as base64 string for arraybuffer.
    const b64 = typeof res.data === "string" ? res.data : ""
    if (!b64) throw new Error("empty body")
    const mime = (res.headers?.["Content-Type"] || res.headers?.["content-type"] || "application/octet-stream") as string
    return `data:${mime.split(";")[0]};base64,${b64}`
  }
  const res = await fetch(url, { cache: "no-store" })
  if (!res.ok) throw new Error("HTTP " + res.status)
  const blob = await res.blob()
  if (!blob.size) throw new Error("empty body")
  return await new Promise<string>((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(new Error("fileReader fail"))
    fr.readAsDataURL(blob)
  })
}
