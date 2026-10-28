import { parseBlob } from "music-metadata"

export interface ExtractedMeta {
  title?: string
  artist?: string
  album?: string
  coverImage?: string // data URL
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ""
  const len = bytes.length
  // process in chunks to avoid call stack limits on large images
  const chunk = 0x8000
  for (let i = 0; i < len; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[]
    )
  }
  return btoa(binary)
}

// Extract embedded cover art + basic tags (title/artist/album) from an audio file.
// Fails gracefully — returns {} on any error so playback is never blocked.
export async function extractAudioMeta(file: File): Promise<ExtractedMeta> {
  try {
    const metadata = await parseBlob(file)
    const common = metadata.common
    const picture = common.picture?.[0]
    let coverImage: string | undefined
    if (picture && picture.data) {
      const base64 = uint8ToBase64(picture.data)
      coverImage = `data:${picture.format || "image/jpeg"};base64,${base64}`
    }
    return {
      title: common.title?.trim() || undefined,
      artist: common.artist?.trim() || undefined,
      album: common.album?.trim() || undefined,
      coverImage,
    }
  } catch {
    return {}
  }
}
