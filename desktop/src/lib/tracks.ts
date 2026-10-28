export interface Track {
  id: string
  title: string
  artist: string
  album: string
  duration: number // in seconds (approx, for display before metadata loads)
  url: string // object URL for uploaded files, stream URL for online tracks
  cover: {
    from: string
    to: string
  }
  coverImage?: string // optional cover art (data URL extracted from file tags)
  coverColorsExtracted?: boolean // true once dominant colors were extracted from coverImage
  isVideo?: boolean // true for video files — rendered in a video player
  isStream?: boolean // true for online (streaming) tracks — not persisted to IndexedDB
}

// No demo tracks — the player starts with an empty playlist.
// Users add their own music/videos via the "Add files" button or drag-and-drop.
