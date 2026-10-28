export interface CoverColors { from: string; to: string }
const DEFAULT_COLORS: CoverColors = { from: "#8b5cf6", to: "#d946ef" }
function rgbToHex(r: number, g: number, b: number): string { return "#" + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("") }
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b); const l = (max + min) / 2
  let h = 0, s = 0; if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4 } h /= 6 }
  return [h, s, l]
}
function shiftHue(h: number, delta: number): number { let n = h + delta; if (n < 0) n += 1; if (n > 1) n -= 1; return n }
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  let r: number, g: number, b: number
  if (s === 0) { r = g = b = l } else {
    const hue2rgb = (p: number, q: number, t: number) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3)
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const img = new Image(); img.crossOrigin = "anonymous"; img.onload = () => resolve(img); img.onerror = () => reject(new Error("fail")); img.src = src })
}
function boostColor(r: number, g: number, b: number, ts = 0.7, tl = 0.6): [number, number, number] {
  const [h, s, l] = rgbToHsl(r, g, b); if (s < 0.08) return [r, g, b]
  const ns = Math.max(s, Math.min(1, s * 0.3 + ts * 0.7)); const nl = Math.max(tl, Math.min(0.75, l + 0.15))
  return hslToRgb(h, ns, nl)
}
export async function extractCoverColors(imageUrl: string, fallback: CoverColors = DEFAULT_COLORS): Promise<CoverColors> {
  if (!imageUrl) return fallback
  let imgSrc = imageUrl
  if (!imageUrl.startsWith("data:") && !imageUrl.startsWith("blob:") && !imageUrl.startsWith("/")) { imgSrc = `/api/image-proxy?url=${encodeURIComponent(imageUrl)}` }
  try {
    const img = await loadImage(imgSrc); const SIZE = 32; const canvas = document.createElement("canvas")
    canvas.width = SIZE; canvas.height = SIZE; const ctx = canvas.getContext("2d"); if (!ctx) return fallback
    ctx.drawImage(img, 0, 0, SIZE, SIZE)
    let pixels: Uint8ClampedArray; try { pixels = ctx.getImageData(0, 0, SIZE, SIZE).data } catch { return fallback }
    const buckets = new Float32Array(12); const br: Array<[number, number, number, number]> = []; for (let i = 0; i < 12; i++) br.push([0, 0, 0, 0])
    for (let i = 0; i < pixels.length; i += 4) { const a = pixels[i + 3]; if (a < 128) continue; const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2]; const [h, s, l] = rgbToHsl(r, g, b); if (l > 0.9 || l < 0.08) continue; const idx = Math.min(11, Math.floor(h * 12)); const w = s * s; buckets[idx] += w; const e = br[idx]; e[0] += r * w; e[1] += g * w; e[2] += b * w; e[3] += w }
    let ti = 0, si = -1; for (let i = 1; i < 12; i++) { if (buckets[i] > buckets[ti]) { si = ti; ti = i } else if (si < 0 || buckets[i] > buckets[si]) si = i }
    const te = br[ti]; if (te[3] === 0) return fallback
    let r1 = te[0] / te[3], g1 = te[1] / te[3], b1 = te[2] / te[3]
    let r2: number, g2: number, b2: number; const se = br[si]
    if (se[3] > 0) { r2 = se[0] / se[3]; g2 = se[1] / se[3]; b2 = se[2] / se[3] } else { const [h, s, l] = rgbToHsl(r1, g1, b1); [r2, g2, b2] = hslToRgb(shiftHue(h, 0.12), s, l) }
    ;[r1, g1, b1] = boostColor(r1, g1, b1, 0.75, 0.6); [r2, g2, b2] = boostColor(r2, g2, b2, 0.7, 0.65)
    return { from: rgbToHex(r1, g1, b1), to: rgbToHex(r2, g2, b2) }
  } catch { return fallback }
}
