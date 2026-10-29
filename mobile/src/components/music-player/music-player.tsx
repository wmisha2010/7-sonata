"use client"

import * as React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  Volume1,
  Upload,
  Music2,
  ListMusic,
  Trash2,
  Disc3,
  Sun,
  Moon,
  FolderOpen,
  Film,
  Search,
  Loader2,
  Plus,
  Check,
  X,
  PanelLeft,
  PanelLeftOpen,
  Download,
  Smartphone,
  Monitor,
  FileArchive,
  FolderArchive,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { formatTime } from "@/lib/format"
import { type Track } from "@/lib/tracks"
import { extractAudioMeta } from "@/lib/metadata"
import { enrichFromITunes, getDurationFromAudio } from "@/lib/metadata-enrichment"
import { extractCoverColors } from "@/lib/color-extract"
import { searchMp3mn, mp3mnToTrack } from "@/lib/mp3mn"
import { searchRutube, rutubeToTrack, isRutubeUrl, rutubeId, resolveRutubeMasterUrl } from "@/lib/rutube"
import Hls from "hls.js"
import {
  loadLibrary,
  saveLibrary,
  putAudioBytes,
  getAudioUrl,
  deleteAudio,
  type StoredTrack,
} from "@/lib/storage"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
// Media Session API wrapper — MOBILE BUILD.
// v1.7.2: STATIC import of @jofr/capacitor-media-session. The previous
// dynamic import() lived in a separate Vite chunk; if that chunk failed on
// a device, the error was swallowed by catch(() => {}) and the player
// silently fell back to navigator.mediaSession — the WebView's own media
// card has NO buttons, which looked like "the shade is broken". A static
// import puts the plugin proxy into the main chunk so it is ALWAYS there.
// Every native failure is now RECORDED and surfaced in the footer as a
// MS:ERR marker, so one screenshot pinpoints the failing layer.
interface MediaSessionPluginShape {
  setMetadata(opts: { title: string; artist: string; album: string; artwork: any[] }): Promise<void>
  setPlaybackState(opts: { playbackState: string }): Promise<void>
  setActionHandler(opts: { action: string }, handler: ((d: any) => void) | null): Promise<void>
  setPositionState(opts: { duration: number; position: number; playbackRate: number }): Promise<void>
}
import { MediaSession as NativeMediaSessionPlugin } from "@jofr/capacitor-media-session"

export type MediaSessionMode = "native" | "web" | "err"
let msMode: MediaSessionMode = "web"
let msErr = ""
let msStatusListener: ((mode: MediaSessionMode, err: string) => void) | null = null
export function onMediaSessionStatus(cb: (mode: MediaSessionMode, err: string) => void) { msStatusListener = cb; cb(msMode, msErr) }
function reportMsStatus() { try { msStatusListener?.(msMode, msErr) } catch {} }
function markMs(mode: MediaSessionMode, err = "") { if (msMode === mode && msErr === err) return; msMode = mode; msErr = err; reportMsStatus() }
function msErrMsg(e: any): string { try { if (typeof e === "string") return e.slice(0, 48); const m = e?.message || (e ? String(e) : "unknown"); return String(m).slice(0, 48) } catch { return "unknown" } }
const msIsNative = () => typeof window !== "undefined" && !!(window as any)?.Capacitor?.isNativePlatform?.()
function nativeMs(): MediaSessionPluginShape | null {
  if (!msIsNative()) return null
  return NativeMediaSessionPlugin as unknown as MediaSessionPluginShape
}
// WebView fallback (also used when a native call rejects, so at least the
// in-app controls keep receiving system events).
const msFallback = {
  metadata(o: { title: string; artist: string; album: string; artwork: any[] }) { if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return; try { navigator.mediaSession.metadata = new MediaMetadata({ title: o.title, artist: o.artist, album: o.album, artwork: o.artwork as any }) } catch {} },
  playbackState(s: "playing" | "paused" | "none") { if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return; try { navigator.mediaSession.playbackState = s as MediaSessionPlaybackState } catch {} },
  actionHandler(a: string, h: ((d: any) => void) | null) { if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return; try { navigator.mediaSession.setActionHandler(a as MediaSessionAction, h as MediaSessionActionHandler | null) } catch {} },
  positionState(o: { duration: number; position: number; playbackRate: number }) { if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return; try { navigator.mediaSession.setPositionState(o as any) } catch {} },
}
const mediaSessionApi = {
  setMetadata(o: { title: string; artist: string; album: string; artwork: any[] }) {
    const n = nativeMs()
    if (!n) { markMs("web"); msFallback.metadata(o); return }
    // v1.7.3: call sites pre-resolve remote covers to base64 data URLs via
    // CapacitorHttp (see resolveArtworkSrc below), so the plugin only ever
    // decodes data: artwork and never touches the network itself. The http
    // strip below stays as a safety net: remote http(s) URLs would make the
    // plugin's own HttpURLConnection fetch stall/throw on the single
    // Capacitor plugin thread, rejecting the whole call (title/artist never
    // reach the session card). Local blob:/data: artwork passes through.
    const safeArt = (o.artwork || []).filter((a: any) => a && typeof a.src === "string" && !a.src.startsWith("http"))
    n.setMetadata({ ...o, artwork: safeArt }).then(() => markMs("native")).catch((e) => { markMs("err", msErrMsg(e)); msFallback.metadata(o) })
  },
  setPlaybackState(s: "playing" | "paused" | "none") {
    const n = nativeMs()
    if (!n) { markMs("web"); msFallback.playbackState(s); return }
    n.setPlaybackState({ playbackState: s }).then(() => markMs("native")).catch((e) => { markMs("err", msErrMsg(e)); msFallback.playbackState(s) })
  },
  setActionHandler(a: string, h: ((d: any) => void) | null) {
    const n = nativeMs()
    if (!n) { markMs("web"); msFallback.actionHandler(a, h); return }
    n.setActionHandler({ action: a }, h).then(() => markMs("native")).catch((e) => { markMs("err", msErrMsg(e)); msFallback.actionHandler(a, h) })
  },
  setPositionState(o: { duration: number; position: number; playbackRate: number }) {
    const n = nativeMs()
    if (!n) { markMs("web"); msFallback.positionState(o); return }
    n.setPositionState(o).then(() => markMs("native")).catch((e) => { markMs("err", msErrMsg(e)); msFallback.positionState(o) })
  },
}


type RepeatMode = "off" | "all" | "one"
type Theme = "dark" | "light"

export function MusicPlayer() {
  // Start empty — users add their own music.
  const [tracks, setTracks] = useState<Track[]>([])
  const [currentIndex, setCurrentIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.8)
  const [muted, setMuted] = useState(false)
  const [shuffle, setShuffle] = useState(false)
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("off")
  const [isLoading, setIsLoading] = useState(false)
  const [tracksReady, setTracksReady] = useState(false)
  const [theme, setTheme] = useState<Theme>("dark")
  const [isDragOver, setIsDragOver] = useState(false)
  // ---- Search ----
  // Three modes: filter the local library, search MP3mn online for audio
  // tracks, or search Rutube for video clips — both online modes add
  // streaming tracks to the playlist.
  const [searchMode, setSearchMode] = useState<"library" | "online" | "video">("library")
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Track[]>([])
  const [isSearching, setIsSearching] = useState(false)
  // Preview playback for search results: play a track without adding it to
  // the playlist, so the user can audition before committing.
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(false)
  const [previewProgress, setPreviewProgress] = useState(0)
  const [previewDuration, setPreviewDuration] = useState(0)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  // Rutube embed player (iframe) — playback is driven via the postMessage
  // protocol: commands are JSON strings {type:"player:play"|"player:pause"},
  // events come back as JSON strings {type:"player:...",data:{...}}.
  const rtFrameRef = useRef<HTMLIFrameElement | null>(null)
  // Set once the embed proves itself alive (any postMessage event received).
  // If no event ever arrives (player host blocked/unavailable), we show a
  // fallback hint instead of a silent black box.
  const rtGotEventRef = useRef(false)
  const [rtUnavailable, setRtUnavailable] = useState(false)
  // Verified against the live embed: play/pause work; seek is NOT supported
  // by the embed (its own controls handle it); volume is sent best-effort.
  const rtCommand = useCallback((method: "play" | "pause" | "volume", value?: number | boolean) => {
    const win = rtFrameRef.current?.contentWindow
    if (!win) return
    let payload: string | null = null
    if (method === "play") payload = JSON.stringify({ type: "player:play" })
    else if (method === "pause") payload = JSON.stringify({ type: "player:pause" })
    else if (method === "volume" && typeof value === "number") payload = JSON.stringify({ type: "player:volume", data: { volume: value } })
    if (!payload) return
    try { win.postMessage(payload, "*") } catch {}
  }, [])
  // Collapse the playlist panel (especially useful on mobile / narrow screens
  // so the player gets the full width).
  const [playlistCollapsed, setPlaylistCollapsed] = useState(false)
  // Download menu — offered only in a regular browser (not inside the
  // Capacitor app / Electron build, where downloading the app makes no sense).
  const [canDownload, setCanDownload] = useState(false)
  // Electron IPC bridge for the footer "Скачать" menu (saves artifacts to ~/Downloads)
  const [desktopSave, setDesktopSave] = useState<((kind: string) => Promise<{ ok: boolean; path?: string; error?: string }>) | null>(null)
  const [downloadNote, setDownloadNote] = useState<string | null>(null)
  // Playlist sort mode — user can sort by title, artist, duration, date added.
  const [sortMode, setSortMode] = useState<"default" | "title" | "artist" | "duration" | "date">("default")
  const [sortAsc, setSortAsc] = useState(true)
  // User-adjustable video width (px). Draggable from the bottom-right corner.
  const [videoWidth, setVideoWidth] = useState<number | null>(null)
  const videoResizeStateRef = useRef<{
    startX: number
    startW: number
  } | null>(null)

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const progressRef = useRef(0)
  const shuffleHistory = useRef<number[]>([])
  const blobUrlsRef = useRef<Set<string>>(new Set())

  // Connect the Web Audio analyser to whichever media element is currently
  // active. createMediaElementSource can only be called once per *element*,
  // but the <video> element is unmounted/remounted when switching tracks —
  // so we track the element we created the source for and rebuild it when
  // the element changes. This is what keeps the visualizer working across
  // repeated audio↔video switches.
  const audioSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const videoSourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const videoSourceElRef = useRef<HTMLVideoElement | null>(null)
  const audioSourceElRef = useRef<HTMLAudioElement | null>(null)
  // Normalizer (compressor) — evens out loudness between tracks so one
  // isn't much quieter/louder than another.
  const normalizerRef = useRef<DynamicsCompressorNode | null>(null)
  // hls.js instance for native Rutube HLS playback (see rtUseEmbed below).
  const hlsRef = useRef<Hls | null>(null)
  // v1.7.4: background continuation for video tracks. Android WebView
  // force-pauses <video> when the app leaves the foreground (audio elements
  // keep playing — that's why music tracks survive backgrounding). When the
  // app hides while a video is playing we hand playback to a hidden <audio>
  // element fed by the SAME hls.js stream, and on return we sync the
  // position back onto the video. Chromium happily plays muxed video+audio
  // HLS through an <audio> element (verified: BUFFER_CREATED tracks=video,audio).
  const bgAudioRef = useRef<HTMLAudioElement | null>(null)
  const bgHlsRef = useRef<Hls | null>(null)
  const bgFallbackRef = useRef(false)
  const bgResumePosRef = useRef(0)
  // Resolved master manifest of the CURRENT Rutube track (for the bg audio).
  const rtMasterUrlRef = useRef<string>("")

  const ensureAudioGraph = useCallback(
    (forVideo: boolean) => {
      const el = forVideo ? videoRef.current : audioRef.current
      if (!el) return
      // Lazily create the AudioContext + analyser + normalizer once.
      if (!audioCtxRef.current) {
        try {
          const Ctx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext: typeof AudioContext })
              .webkitAudioContext
          if (!Ctx) {
            useFakeRef.current = true
            return
          }
          const ctx = new Ctx()
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          analyser.smoothingTimeConstant = 0.82
          // Compressor/normalizer — gently compresses dynamic range so
          // quiet tracks are louder and loud tracks are tamer.
          const compressor = ctx.createDynamicsCompressor()
          compressor.threshold.value = -18
          compressor.knee.value = 12
          compressor.ratio.value = 4
          compressor.attack.value = 0.01
          compressor.release.value = 0.25
          // Chain: source → compressor → analyser → destination
          analyser.connect(compressor)
          compressor.connect(ctx.destination)
          audioCtxRef.current = ctx
          analyserRef.current = analyser
          normalizerRef.current = compressor
        } catch {
          useFakeRef.current = true
          return
        }
      }
      const analyser = analyserRef.current!

      const sourceRef = forVideo ? videoSourceRef : audioSourceRef
      const elRef = forVideo ? videoSourceElRef : audioSourceElRef
      const otherSourceRef = forVideo ? audioSourceRef : videoSourceRef

      // If the underlying element changed (e.g. the <video> was remounted),
      // tear down the stale source and rebuild it for the new element.
      if (sourceRef.current && elRef.current !== el) {
        try {
          sourceRef.current.disconnect()
        } catch {
          /* ignore */
        }
        sourceRef.current = null
      }
      if (!sourceRef.current) {
        try {
          sourceRef.current = audioCtxRef.current.createMediaElementSource(el)
          elRef.current = el
        } catch {
          useFakeRef.current = true
          return
        }
      }
      const active = sourceRef.current
      const inactive = otherSourceRef.current
      // Disconnect the inactive source so only the active one feeds the
      // analyser — otherwise paused media can leave stale data in the buffer.
      if (inactive) {
        try {
          inactive.disconnect()
        } catch {
          /* already disconnected */
        }
      }
      // (Re)connect the active source to the analyser.
      try {
        active.connect(analyser)
      } catch {
        /* already connected */
      }
      // Real analyser data is available again (e.g. switching back from a
      // remote/CORS-silenced track to a local one) — re-enable the graph.
      useFakeRef.current = false
    },
    []
  )

  // Detach the audio element from the Web Audio graph. Used for remote
  // (cross-origin) streams — see isRemoteMediaUrl below.
  const teardownAudioSource = useCallback(() => {
    const src = audioSourceRef.current
    if (src) {
      try {
        src.disconnect()
      } catch {
        /* ignore */
      }
    }
    audioSourceRef.current = null
    audioSourceElRef.current = null
  }, [])

  // Track currently playing from search results (NOT in the playlist).
  // When set, it overrides the playlist's currentTrack for the main player
  // display and playback. Cleared when the user clicks a playlist track.
  const [previewTrack, setPreviewTrack] = useState<Track | null>(null)

  const currentTrack = previewTrack || tracks[currentIndex]
  // True when the current track is a Rutube video.
  const isRtTrack = !!currentTrack?.isVideo && isRutubeUrl(currentTrack.url)
  // Video playback mode for Rutube tracks. Default is native HLS: hls.js
  // feeds the <video> element via MSE (blob:) with the signed balancer
  // manifest resolved directly (see lib/rutube.ts), so Web Audio can capture
  // the element and the spectrum visualizer gets REAL data — exactly like
  // music tracks. If HLS fails for a given video (DRM, ACL, region…) we
  // fall back to the official iframe embed, whose audio is untappable
  // (visualizer runs its animated wave there).
  const [rtUseEmbed, setRtUseEmbed] = useState(false)
  const isRtEmbed = isRtTrack && rtUseEmbed
  const isRtHls = isRtTrack && !rtUseEmbed
  // Reset the fallback when switching to another video — every track gets
  // a fresh HLS attempt.
  useEffect(() => {
    setRtUseEmbed(false)
  }, [currentTrack?.id])

  // ---- Theme handling ----
  useEffect(() => {
    const root = document.documentElement
    if (theme === "dark") {
      root.classList.add("dark")
    } else {
      root.classList.remove("dark")
    }
  }, [theme])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"))
  }, [])

  // ---- Platform detection for the download menu ----
  // - Capacitor (Android): the app IS the APK — the menu stays hidden.
  // - Electron desktop: the menu saves artifacts to the system Downloads
  //   folder via the window.sonata IPC bridge.
  // - Regular browser: direct links to /api/download on the web server.
  useEffect(() => {
    try {
      const w = window as any
      const isNative = !!w.Capacitor
      setCanDownload(!isNative)
      const canSave = !isNative && !!w.sonata?.isDesktop && typeof w.sonata?.saveArtifact === "function"
      setDesktopSave(canSave ? (kind: string) => w.sonata.saveArtifact(kind) : null)
    } catch {
      setCanDownload(false)
      setDesktopSave(null)
    }
  }, [])

  const handleSaveArtifact = useCallback(async (kind: string) => {
    if (!desktopSave) return
    setDownloadNote("Сохранение…")
    try {
      const res = await desktopSave(kind)
      if (res?.ok && res.path) setDownloadNote(`Сохранено в «Загрузки»: ${res.path}`)
      else setDownloadNote(res?.error ? `Не удалось сохранить: ${res.error}` : "Не удалось сохранить файл")
    } catch (e) {
      setDownloadNote(`Не удалось сохранить: ${String(e)}`)
    } finally {
      window.setTimeout(() => setDownloadNote(null), 7000)
    }
  }, [desktopSave])

  // ---- Restore the user's saved library on mount ----
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const saved = await loadLibrary()
      if (cancelled) return
      // Drop stale Dailymotion embed tracks — that integration was replaced
      // with Rutube, and the old dailymotion:* URLs can no longer play.
      const usable = saved.filter((s) => !s.url?.startsWith("dailymotion:"))
      if (usable.length > 0) {
        const restored: Track[] = []
        for (const s of usable) {
          if (s.isStream) {
            // Streaming tracks (MP3mn): keep their permanent remote URL.
            restored.push({ ...s, hasAudioBlob: undefined } as Track)
          } else {
            // Local uploaded tracks: rebuild the blob URL from stored bytes.
            const url = await getAudioUrl(s.id)
            if (url) {
              blobUrlsRef.current.add(url)
              restored.push({ ...s, url, hasAudioBlob: undefined } as Track)
            }
          }
        }
        if (restored.length > 0 && !cancelled) {
          setTracks(restored)
        }
      }
      setTracksReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ---- Audio setup ----
  // NOTE: audioKey dep — the <audio> element remounts when switching between
  // local (blob:) and remote sources (see the key prop below), so the event
  // listeners must be re-attached to the fresh element.
  const audioKey = isRemoteMediaUrl(currentTrack?.url) ? "remote" : "local"
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onLoadedMeta = () => {
      setDuration(audio.duration || 0)
      setIsLoading(false)
    }
    const onTimeUpdate = () => setProgress(audio.currentTime)
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onWaiting = () => setIsLoading(true)
    const onCanPlay = () => setIsLoading(false)
    const onError = () => {
      setIsLoading(false)
      setIsPlaying(false)
      // Auto-skip to next track if the current one fails to load/play
      // (e.g. expired URL on MP3mn). This way the user doesn't get stuck
      // on a dead track.
      setTimeout(() => {
        if (tracks.length > 1) {
          shouldAutoPlayRef.current = true
          setPreviewTrack(null)
          setCurrentIndex((i) => (i + 1) % tracks.length)
        }
      }, 500)
    }

    audio.addEventListener("loadedmetadata", onLoadedMeta)
    audio.addEventListener("timeupdate", onTimeUpdate)
    audio.addEventListener("play", onPlay)
    audio.addEventListener("pause", onPause)
    audio.addEventListener("waiting", onWaiting)
    audio.addEventListener("canplay", onCanPlay)
    audio.addEventListener("error", onError)

    return () => {
      audio.removeEventListener("loadedmetadata", onLoadedMeta)
      audio.removeEventListener("timeupdate", onTimeUpdate)
      audio.removeEventListener("play", onPlay)
      audio.removeEventListener("pause", onPause)
      audio.removeEventListener("waiting", onWaiting)
      audio.removeEventListener("canplay", onCanPlay)
      audio.removeEventListener("error", onError)
    }
  }, [audioKey])

  // Sync volume to BOTH the audio and the video element (whichever is
  // active). The Rutube embed receives it as a best-effort postMessage.
  useEffect(() => {
    const v = muted ? 0 : volume
    if (isRtEmbed) {
      rtCommand("volume", v)
      return
    }
    if (audioRef.current) audioRef.current.volume = v
    if (videoRef.current) videoRef.current.volume = v
  }, [volume, muted, audioKey, isRtEmbed, rtCommand])

  // Reset playback state + switch to a track (called from event handlers, not effects)
  const selectTrack = useCallback(
    (index: number) => {
      if (index < 0 || index >= tracks.length) return
      const nextTrack = tracks[index]
      setCurrentIndex(index)
      setProgress(0)
      setIsPlaying(false)
      setIsLoading(true)
      setDuration(nextTrack.duration || 0)
      // Reset the video player to its default size whenever the user switches
      // tracks (audio→video, video→audio, or video→video). This way the size
      // the user set for one clip doesn't leak into the next one.
      setVideoWidth(null)
    },
    [tracks]
  )

  // Flag to force-play the next track change. Set when the user explicitly
  // clicks a track in the playlist or from search — NOT on initial load.
  const shouldAutoPlayRef = useRef(false)

  // ---- Search ----
  // Library mode: filter the existing playlist by the query string.
  const filteredTracks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (searchMode !== "library" || !q) return tracks
    return tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        (t.album || "").toLowerCase().includes(q)
    )
  }, [tracks, searchQuery, searchMode])

  // Sorted tracks for display — applies the user-selected sort mode.
  // NOTE: declared BEFORE playNext/playPrev/handleEnded — their deps arrays
  // reference sortedTracks, so it must exist by that point in the render.
  const sortedTracks = useMemo(() => {
    const base = searchMode === "library" && searchQuery.trim() ? filteredTracks : tracks
    if (sortMode === "default") return base
    const sorted = [...base]
    const dir = sortAsc ? 1 : -1
    switch (sortMode) {
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title, "ru") * dir)
        break
      case "artist":
        sorted.sort((a, b) => a.artist.localeCompare(b.artist, "ru") * dir)
        break
      case "duration":
        sorted.sort((a, b) => (a.duration - b.duration) * dir)
        break
      case "date":
        // Date added = index in original tracks array (higher = newer)
        sorted.sort((a, b) => {
          const ia = tracks.indexOf(a)
          const ib = tracks.indexOf(b)
          return (ia - ib) * dir
        })
        break
    }
    return sorted
  }, [tracks, filteredTracks, sortMode, sortAsc, searchMode, searchQuery])

  // When the playing track changes, stop the OTHER media element so audio
  // and video never play simultaneously, then LOAD the active one.
  // Auto-plays ONLY if shouldAutoPlayRef was set (user clicked a track).
  useEffect(() => {
    if (!currentTrack || !currentTrack.url) return
    // Stop any active preview playback — the playlist track takes priority.
    if (previewAudioRef.current && !previewAudioRef.current.paused) {
      previewAudioRef.current.pause()
    }
    setPreviewId(null)
    setIsPreviewPlaying(false)
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.currentTime = 0
    }
    if (currentTrack.isVideo) {
      // Native Rutube HLS mode: the dedicated hls.js effect below owns the
      // element (graph attach, autoplay, error fallback) — don't fight it here.
      if (isRtHls) return
      const video = videoRef.current
      if (video) {
        video.volume = muted ? 0 : volume
        const isMobileViewport = window.innerWidth < 640
        if (!isMobileViewport) {
          // Only route the video through the Web Audio graph when it is a
          // local file — remote video would be CORS-silenced by the graph.
          if (!isRemoteMediaUrl(currentTrack.url)) ensureAudioGraph(true)
          if (audioCtxRef.current?.state === "suspended") {
            audioCtxRef.current.resume().catch(() => {})
          }
        }
        video.currentTime = 0
        if (shouldAutoPlayRef.current) {
          shouldAutoPlayRef.current = false
          const p = video.play()
          if (p) p.then(() => setIsPlaying(true)).catch(() => {})
        }
      }
      return
    }
    if (!audio) return
    if (isRemoteMediaUrl(currentTrack.url)) {
      // Remote streams (mp3mn etc.) send no CORS headers. Routing them
      // through the Web Audio graph outputs SILENCE (and once an element is
      // captured by createMediaElementSource it can never play directly
      // again) — so detach the graph and let the element play straight to
      // the speakers. The visualizer falls back to its animated wave.
      teardownAudioSource()
    } else {
      ensureAudioGraph(false)
    }
    if (audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {})
    }
    audio.load()
    audio.currentTime = 0
    if (shouldAutoPlayRef.current) {
      shouldAutoPlayRef.current = false
      const p = audio.play()
      if (p) p.then(() => setIsPlaying(true)).catch(() => {})
    }
  }, [currentIndex, currentTrack?.url, currentTrack?.isVideo, isRtHls])

  // Native Rutube HLS playback — the heart of the "visualizer for video"
  // fix. hls.js feeds the <video> via MSE (blob:). The blob stays
  // same-origin regardless of where the segments come from, so
  // ensureAudioGraph(true) gives the analyser REAL samples and the VFD
  // spectrum dances to the video like it does for music. Any fatal error →
  // fall back to the official iframe embed (its audio is untappable — the
  // visualizer runs its animated wave there).
  useEffect(() => {
    if (!isRtHls || !currentTrack?.url) return
    const video = videoRef.current
    if (!video) return
    const vid = rutubeId(currentTrack.url)
    if (!vid) return
    let cancelled = false
    let cleanup: (() => void) | null = null

    const startPlay = () => {
      if (cancelled) return
      // Attach the Web Audio graph (desktop only — mobile skips it to save
      // CPU, same trade-off as local videos; the visualizer is hidden there).
      if (typeof window === "undefined" || window.innerWidth >= 640) {
        ensureAudioGraph(true)
      }
      if (audioCtxRef.current?.state === "suspended") {
        audioCtxRef.current.resume().catch(() => {})
      }
      if (shouldAutoPlayRef.current) {
        shouldAutoPlayRef.current = false
        const p = video.play()
        if (p) p.then(() => setIsPlaying(true)).catch(() => {})
      }
    }

    ;(async () => {
      // There is no local proxy server in the desktop/mobile builds —
      // resolve Rutube's signed master manifest directly. Cross-origin
      // loading is allowed there (Electron webSecurity:false / Capacitor
      // native HTTP interceptor), and the MSE blob: stays same-origin, so
      // the visualizer keeps getting real audio data.
      const src = await resolveRutubeMasterUrl(vid)
      if (cancelled) return
      if (!src) {
        setRtUseEmbed(true)
        return
      }
      rtMasterUrlRef.current = src // v1.7.4: reusable by the bg-audio fallback

      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, maxBufferLength: 30 })
        hlsRef.current = hls
        hls.loadSource(src)
        hls.attachMedia(video)
        hls.on(Hls.Events.MANIFEST_PARSED, () => startPlay())
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (cancelled || !data.fatal) return
          // Manifest/segment/network failure — the official embed usually
          // still plays such videos (it handles DRM/ACL itself).
          setRtUseEmbed(true)
        })
        cleanup = () => {
          hls.destroy()
          if (hlsRef.current === hls) hlsRef.current = null
        }
        return
      }

      // Native HLS (iOS Safari / some WebViews): give the element the
      // master manifest directly.
      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src
        const onMeta = () => startPlay()
        const onErr = () => setRtUseEmbed(true)
        video.addEventListener("loadedmetadata", onMeta)
        video.addEventListener("error", onErr)
        cleanup = () => {
          video.removeEventListener("loadedmetadata", onMeta)
          video.removeEventListener("error", onErr)
          video.removeAttribute("src")
        }
        return
      }

      // No MSE and no native HLS → straight to the official embed.
      setRtUseEmbed(true)
    })()

    return () => {
      cancelled = true
      cleanup?.()
      rtMasterUrlRef.current = "" // v1.7.4: never reuse a stale master across tracks
    }
  }, [isRtHls, currentTrack?.id, currentTrack?.url, ensureAudioGraph])

  const playIndex = useCallback(
    (index: number) => {
      // Clear any search preview track — we're switching to a playlist track
      setPreviewTrack(null)
      // If clicking the currently playing track → toggle pause/resume
      if (index === currentIndex && !previewTrack) {
        const media = currentTrack?.isVideo
          ? videoRef.current
          : audioRef.current
        if (media) {
          if (media.paused) {
            media.play().catch(() => {})
          } else {
            media.pause()
          }
        }
        return
      }
      // Different track — auto-play it
      shouldAutoPlayRef.current = true
      selectTrack(index)
    },
    [selectTrack, currentIndex, currentTrack?.isVideo, previewTrack]
  )

  const playNext = useCallback(() => {
    if (tracks.length === 0) return
    // A stuck search-preview track overrides currentTrack (see its useMemo),
    // so switching the index underneath would change nothing — clear it on
    // ANY explicit next/prev request (same as playIndex does).
    setPreviewTrack(null)
    if (shuffle) {
      if (tracks.length === 1) {
        selectTrack(0)
        return
      }
      let next = currentIndex
      while (next === currentIndex) {
        next = Math.floor(Math.random() * tracks.length)
      }
      shuffleHistory.current.push(currentIndex)
      shouldAutoPlayRef.current = true
      selectTrack(next)
      return
    }
    // Advance in the DISPLAYED (sorted/filtered) order — with sorting active
    // the storage order of `tracks` differs from what the user sees, so
    // storage index+1 would jump to a seemingly random row.
    const order = sortedTracks
    if (order.length === 0) return
    const curId = tracks[currentIndex]?.id
    const pos = curId ? order.findIndex((t) => t.id === curId) : -1
    const nextPos = (pos === -1 ? 0 : pos + 1) % order.length
    const realIdx = tracks.findIndex((t) => t.id === order[nextPos].id)
    if (realIdx === -1) return
    shouldAutoPlayRef.current = true
    selectTrack(realIdx)
  }, [shuffle, currentIndex, tracks, sortedTracks, selectTrack])

  const playPrev = useCallback(() => {
    if (tracks.length === 0) return
    // Same previewTrack reasoning as playNext above.
    setPreviewTrack(null)
    if (shuffle && shuffleHistory.current.length > 0) {
      const prev = shuffleHistory.current.pop()!
      shouldAutoPlayRef.current = true
      selectTrack(prev)
      return
    }
    // Same as playNext — follow the displayed (sorted/filtered) order.
    const order = sortedTracks
    if (order.length === 0) return
    const curId = tracks[currentIndex]?.id
    const pos = curId ? order.findIndex((t) => t.id === curId) : -1
    const prevPos = (pos === -1 ? 0 : pos - 1 + order.length) % order.length
    const realIdx = tracks.findIndex((t) => t.id === order[prevPos].id)
    if (realIdx === -1) return
    shouldAutoPlayRef.current = true
    selectTrack(realIdx)
  }, [shuffle, currentIndex, tracks, sortedTracks, selectTrack])

  const togglePlay = useCallback(() => {
    // Rutube embeds are controlled via postMessage commands; native HLS
    // falls through to the regular <video> element below.
    if (isRtEmbed) {
      rtCommand(isPlaying ? "pause" : "play")
      return
    }
    // Video tracks use their own visible <video> element (with controls).
    // v1.7.4: while the bg-audio fallback is active (app hidden), toggle the
    // hidden audio element instead of the <video> Chromium refuses to run.
    if (currentTrack?.isVideo) {
      if (bgFallbackRef.current && bgAudioRef.current) {
        const bg = bgAudioRef.current
        if (bg.paused) bg.play().catch(() => {})
        else bg.pause()
        return
      }
      const video = videoRef.current
      if (!video) return
      if (video.paused) {
        video.play().catch(() => {})
      } else {
        video.pause()
      }
      return
    }
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }, [currentTrack?.isVideo, isRtEmbed, isPlaying, rtCommand])

  const handleEnded = useCallback(() => {
    if (repeatMode === "one") {
      if (currentTrack?.isVideo) {
        // Rutube embeds restart via the play command (no media element);
        // native HLS restarts the <video> like any other video.
        if (isRtEmbed) {
          rtCommand("play")
          return
        }
        const video = videoRef.current
        if (video) {
          video.currentTime = 0
          video.play().catch(() => {})
        }
      } else {
        const audio = audioRef.current
        if (audio) {
          audio.currentTime = 0
          audio.play().catch(() => {})
        }
      }
      return
    }
    // Stop only when the current track is the LAST one in the DISPLAYED
    // (sorted/filtered) order — not in storage order.
    const order = sortedTracks
    const curId = currentTrack?.id
    const isLastInView =
      order.length === 0 ||
      (curId !== undefined && order.findIndex((t) => t.id === curId) === order.length - 1)
    if (!shuffle && repeatMode === "off" && isLastInView) {
      setIsPlaying(false)
      if (currentTrack?.isVideo) {
        const video = videoRef.current
        if (video) {
          video.pause()
          video.currentTime = 0
        }
      } else {
        const audio = audioRef.current
        if (audio) {
          audio.pause()
          audio.currentTime = 0
        }
      }
      return
    }
    playNext()
  }, [repeatMode, shuffle, currentIndex, tracks, sortedTracks, playNext, currentTrack?.id, currentTrack?.isVideo, isRtEmbed, rtCommand])

  // Rutube iframe events: the embed posts JSON STRINGS {type,data} with
  // origin https://rutube.ru (verified against the live player). The source
  // check guarantees the message comes from OUR embed, not any other one.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== "https://rutube.ru") return
      let msg: { type?: string; data?: Record<string, unknown> } | null = null
      try { msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data } catch { return }
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return
      if (!rtFrameRef.current || e.source !== rtFrameRef.current.contentWindow) return
      const d = (msg.data ?? {}) as {
        currentTime?: number
        time?: number
        duration?: number
        state?: string
        isPlaying?: boolean
        playOptions?: { acl_access?: { allowed?: boolean } }
      }
      switch (msg.type) {
        case "player:init":
        case "player:ready":
          rtGotEventRef.current = true
          setRtUnavailable(false)
          setIsLoading(false)
          break
        case "player:playStart":
          rtGotEventRef.current = true
          setRtUnavailable(false)
          setIsPlaying(true)
          setIsLoading(false)
          break
        case "player:changeState":
          rtGotEventRef.current = true
          if (d.state === "complete") { handleEnded(); break }
          if (d.isPlaying === true) { setIsPlaying(true); setIsLoading(false) }
          else if (d.state === "pause" || d.state === "stop") setIsPlaying(false)
          // "seeking"/"seeked"/"buffering" don't change our play state
          break
        case "player:canPlay":
          rtGotEventRef.current = true
          // Fallback for autoplay=1 being blocked: as soon as the embed is
          // ready, request playback if the user actually clicked a track.
          if (shouldAutoPlayRef.current) {
            shouldAutoPlayRef.current = false
            rtCommand("play")
          }
          break
        case "player:currentTime": {
          rtGotEventRef.current = true
          const t = typeof d.currentTime === "number" ? d.currentTime : d.time
          if (typeof t === "number" && Math.abs(t - progressRef.current) > 0.25) {
            progressRef.current = t
            setProgress(t)
          }
          if (d.duration && d.duration > 0) setDuration(d.duration)
          break
        }
        case "player:durationChange":
          if (d.duration && d.duration > 0) setDuration(d.duration)
          break
        case "player:playOptionsLoaded":
          rtGotEventRef.current = true
          if (d.playOptions?.acl_access?.allowed === false) setRtUnavailable(true)
          break
        case "player:error":
          rtGotEventRef.current = true
          setRtUnavailable(true)
          break
      }
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [handleEnded, rtCommand])

  // If the embed never proves itself alive (no events within 8s), assume the
  // player host is unavailable (region/network block) and surface a helpful
  // hint instead of a silent black rectangle.
  useEffect(() => {
    if (!isRtEmbed) { setRtUnavailable(false); return }
    rtGotEventRef.current = false
    const t = setTimeout(() => {
      if (!rtGotEventRef.current) setRtUnavailable(true)
    }, 8000)
    return () => clearTimeout(t)
  }, [isRtEmbed, currentTrack?.url])

  const seek = useCallback(
    (value: number) => {
      // The Rutube embed doesn't accept seek commands (verified against the
      // live player) — its own controls handle seeking; our slider just
      // reflects the position. Native HLS seeks the <video> like normal.
      if (isRtEmbed) {
        setProgress(value)
        return
      }
      // v1.7.4: while the bg-audio fallback is active, seek the hidden audio.
      if (bgFallbackRef.current && bgAudioRef.current) {
        try { bgAudioRef.current.currentTime = value } catch {}
        setProgress(value)
        return
      }
      const media = currentTrack?.isVideo ? videoRef.current : audioRef.current
      if (!media || !Number.isFinite(media.duration)) return
      media.currentTime = value
      setProgress(value)
    },
    [currentTrack?.isVideo, isRtEmbed]
  )


  // ---- Media Session API + Wheel volume ----
  const latestRef = useRef({ currentTrack, isPlaying, playPrev, playNext, seek, audioRef, videoRef, previewAudioRef, repeatMode, rtUseEmbed, handleEnded })
  useEffect(() => { latestRef.current = { currentTrack, isPlaying, playPrev, playNext, seek, audioRef, videoRef, previewAudioRef, repeatMode, rtUseEmbed, handleEnded } })
  const getActiveMedia = useCallback(() => { const { currentTrack, audioRef, videoRef } = latestRef.current; if (currentTrack?.isVideo) return videoRef.current; return audioRef.current }, [])
  // v1.7.3: hand the cover to the media-session plugin as a base64 data URL.
  // The plugin's own HttpURLConnection fetch has no browser headers and no
  // timeout, and it runs on the single Capacitor plugin thread — if it
  // stalls, every media-session call queued behind it stalls too (playback
  // state, position, handlers). CapacitorHttp is proven to reach both the
  // mp3mn and rutube CDNs on-device, so we fetch the bytes there and let the
  // plugin just decode base64.
  const artworkCacheRef = useRef(new Map<string, string>())
  const msTrackTokenRef = useRef("")
  const resolveArtworkSrc = useCallback(async (src?: string): Promise<string> => {
    if (!src) return ""
    if (src.startsWith("data:")) return src
    const cached = artworkCacheRef.current.get(src)
    if (cached) return cached
    try {
      if (msIsNative()) {
        const { CapacitorHttp } = await import("@capacitor/core")
        const res = await CapacitorHttp.get({
          url: src,
          responseType: "arraybuffer",
          connectTimeout: 10000,
          readTimeout: 10000,
          headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36" },
        })
        const b64 = typeof res.data === "string" ? res.data : ""
        if (b64.length > 100) {
          const mime = String(res.headers?.["content-type"] || "image/jpeg").split(";")[0].trim() || "image/jpeg"
          const dataUrl = `data:${mime};base64,${b64}`
          artworkCacheRef.current.set(src, dataUrl)
          return dataUrl
        }
      }
    } catch {}
    return "" // native fetch of raw http URLs is stripped by safeArt anyway
  }, [])
  const sendMediaMetadata = useCallback(async (t: typeof currentTrack) => {
    if (!t) { msTrackTokenRef.current = ""; mediaSessionApi.setMetadata({ title: "", artist: "", album: "", artwork: [] }); return }
    msTrackTokenRef.current = t.url
    const art = await resolveArtworkSrc(t.coverImage)
    if (msTrackTokenRef.current !== t.url) return
    mediaSessionApi.setMetadata({ title: t.title, artist: t.artist, album: t.album || "7-Sonata", artwork: art ? [{ src: art, sizes: "512x512", type: "image/jpeg" }] : [] })
  }, [resolveArtworkSrc])
  const updateMediaSession = useCallback(() => { void sendMediaMetadata(currentTrack) }, [sendMediaMetadata, currentTrack])
  // Register MediaSession action handlers — kept intentionally simple: the
  // original (unpatched) @jofr/capacitor-media-session plugin handled the
  // shade/lock-screen card correctly in v1.6.0. The "hardening" added later
  // (playpause action, visibilitychange retry, 3s late retry) actually broke
  // the shade on real devices, so we reverted to the working v1.6.0 wiring.
  useEffect(() => {
    const actions = ["play", "pause", "previoustrack", "nexttrack", "seekbackward", "seekforward", "seekto"] as const
    const h: Record<string, (d: any) => void> = {
      play: () => {
        // v1.7.4: while the bg-audio fallback is active (app hidden), the
        // shade controls the hidden audio element — resuming the <video>
        // would be blocked by Chromium while the app is not visible.
        if (bgFallbackRef.current && bgAudioRef.current) {
          bgAudioRef.current.play().then(() => mediaSessionApi.setPlaybackState("playing")).catch(() => {})
          return
        }
        const t = latestRef.current.currentTrack
        if (t?.isVideo && isRutubeUrl(t.url) && rtUseEmbed) {
          rtCommand("play")
          mediaSessionApi.setPlaybackState("playing")
          return
        }
        const el = getActiveMedia()
        if (el) {
          el.play().then(() => mediaSessionApi.setPlaybackState("playing")).catch(() => mediaSessionApi.setPlaybackState("paused"))
        } else mediaSessionApi.setPlaybackState("playing")
      },
      pause: () => {
        if (bgFallbackRef.current && bgAudioRef.current) {
          bgAudioRef.current.pause()
          mediaSessionApi.setPlaybackState("paused")
          return
        }
        const t = latestRef.current.currentTrack
        if (t?.isVideo && isRutubeUrl(t.url) && rtUseEmbed) {
          rtCommand("pause")
          mediaSessionApi.setPlaybackState("paused")
          return
        }
        const el = getActiveMedia()
        if (el) {
          el.pause()
          setTimeout(() => mediaSessionApi.setPlaybackState("paused"), 50)
        } else mediaSessionApi.setPlaybackState("paused")
      },
      previoustrack: () => latestRef.current.playPrev(),
      nexttrack: () => latestRef.current.playNext(),
      seekbackward: () => latestRef.current.playPrev(),
      seekforward: () => latestRef.current.playNext(),
      seekto: (d: any) => { if (d?.seekTime != null) latestRef.current.seek(d.seekTime) },
    }
    for (const a of actions) mediaSessionApi.setActionHandler(a, h[a])
  }, [getActiveMedia, rtUseEmbed])
  useEffect(() => { updateMediaSession() }, [updateMediaSession])
  // Footer diagnostic for the native MediaSession bridge: if the shade card
  // has no buttons, the marker next to the version tells us which layer
  // failed (native plugin rejected a call → MS:ERR:<msg>).
  const [msDiag, setMsDiag] = useState<{ mode: MediaSessionMode; err: string }>({ mode: "web", err: "" })
  useEffect(() => { onMediaSessionStatus((mode, err) => setMsDiag({ mode, err })) }, [])
  useEffect(() => { mediaSessionApi.setPlaybackState(isPlaying ? "playing" : "paused") }, [isPlaying, currentTrack?.url])
  useEffect(() => { if (!currentTrack?.url) return; void sendMediaMetadata(currentTrack); if (isPlaying) mediaSessionApi.setPlaybackState("playing") }, [currentTrack?.url, sendMediaMetadata])
  useEffect(() => { const m = bgFallbackRef.current ? bgAudioRef.current : currentTrack?.isVideo ? videoRef.current : audioRef.current; if (!m || !Number.isFinite(m.duration)) return; try { mediaSessionApi.setPositionState({ duration: m.duration, position: m.currentTime, playbackRate: 1 }) } catch {} }, [progress, currentTrack?.isVideo])
  // Wheel volume
  const [volumePopup, setVolumePopup] = useState<{ visible: boolean; value: number }>({ visible: false, value: 0 })
  const volumePopupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showVolumePopup = useCallback((v: number) => { setVolumePopup({ visible: true, value: v }); if (volumePopupTimerRef.current) clearTimeout(volumePopupTimerRef.current); volumePopupTimerRef.current = setTimeout(() => setVolumePopup((p) => ({ ...p, visible: false })), 800) }, [])
  const volumeRef = useRef(volume); useEffect(() => { volumeRef.current = volume }, [volume])
  const mutedRef = useRef(muted); useEffect(() => { mutedRef.current = muted }, [muted])
  const playerCardRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { const el = playerCardRef.current; if (!el) return; const onWheel = (e: WheelEvent) => { if (e.deltaY === 0) return; const t = e.target as HTMLElement; if (t.closest("[data-no-wheel-volume]")) return; e.preventDefault(); const d = e.deltaY < 0 ? 0.05 : -0.05; const n = Math.max(0, Math.min(1, volumeRef.current + d)); if (n > 0) setMuted(false); setVolume(n); showVolumePopup(n) }; el.addEventListener("wheel", onWheel, { passive: false }); return () => el.removeEventListener("wheel", onWheel) }, [showVolumePopup])

  const cycleRepeat = useCallback(() => {
    setRepeatMode((m) => (m === "off" ? "all" : m === "all" ? "one" : "off"))
  }, [])

  // ---- v1.7.4: background continuation for video tracks ----
  // Android WebView pauses <video> the moment the app leaves the foreground,
  // while <audio> keeps playing (music tracks already survive backgrounding).
  // enterBgFallback() hands a playing video to a hidden <audio> element fed by
  // the same HLS master manifest (or the same file, for local videos);
  // exitBgFallback() syncs the position back onto the <video> on return.
  const stopBgAudio = useCallback(() => {
    const bg = bgAudioRef.current
    if (bg) {
      bg.onplay = null
      bg.onpause = null
      bg.ontimeupdate = null
      bg.onended = null
      bg.onloadedmetadata = null
      bg.onerror = null
      try { bg.pause() } catch {}
      try { bg.removeAttribute("src"); bg.load() } catch {}
    }
    if (bgHlsRef.current) {
      try { bgHlsRef.current.destroy() } catch {}
      bgHlsRef.current = null
    }
    bgFallbackRef.current = false
  }, [])

  const enterBgFallback = useCallback(() => {
    if (bgFallbackRef.current) return
    if (typeof document !== "undefined" && !document.hidden) return // only when actually hidden
    const L = latestRef.current
    const t = L.currentTrack
    if (!t?.isVideo || !L.isPlaying) return
    // Rutube iframe embed: its audio lives in a cross-origin document — not
    // capturable. Nothing we can do there (same behavior as before).
    if (t && isRutubeUrl(t.url) && L.rtUseEmbed) return
    const video = videoRef.current
    if (!video) return
    const pos = video.currentTime || progressRef.current || 0
    bgFallbackRef.current = true // set BEFORE pausing — JSX onPause guard reads it
    bgResumePosRef.current = pos
    try { video.pause() } catch {}
    let bg = bgAudioRef.current
    if (!bg) {
      bg = document.createElement("audio")
      bg.preload = "auto"
      bgAudioRef.current = bg
    }
    const el = bg
    el.volume = mutedRef.current ? 0 : volumeRef.current
    el.onplay = () => setIsPlaying(true)
    el.onpause = () => setIsPlaying(false)
    el.ontimeupdate = () => {
      const v = el.currentTime
      if (Math.abs(v - progressRef.current) > 0.25) {
        progressRef.current = v
        setProgress(v)
      }
    }
    el.onended = () => {
      const LL = latestRef.current
      // Repeat-one: loop the background audio itself (playing the <video>
      // from the shade while hidden would be blocked by Chromium).
      if (bgFallbackRef.current && LL.repeatMode === "one" && bgAudioRef.current) {
        bgAudioRef.current.currentTime = 0
        bgAudioRef.current.play().catch(() => {})
        return
      }
      LL.handleEnded()
    }
    el.onerror = () => stopBgAudio()
    const startAt = () => {
      const seekAndPlay = () => {
        try { el.currentTime = bgResumePosRef.current } catch {}
        el.play().catch(() => {})
      }
      if (el.readyState >= 1) seekAndPlay()
      else el.addEventListener("loadedmetadata", seekAndPlay, { once: true })
    }
    const wantUrl = t.url
    if (isRutubeUrl(t.url)) {
      ;(async () => {
        let master: string = rtMasterUrlRef.current
        if (!master) {
          const vid = rutubeId(t.url)
          master = vid ? ((await resolveRutubeMasterUrl(vid)) ?? "") : ""
          // The fallback may have been stopped (or the track changed) while resolving.
          if (!bgFallbackRef.current || latestRef.current.currentTrack?.url !== wantUrl) return
        }
        if (!master) { stopBgAudio(); return }
        if (Hls.isSupported()) {
          const h = new Hls({ enableWorker: true, maxBufferLength: 30 })
          bgHlsRef.current = h
          h.loadSource(master)
          h.attachMedia(el)
          h.on(Hls.Events.MANIFEST_PARSED, () => { if (bgFallbackRef.current) startAt() })
          h.on(Hls.Events.ERROR, (_evt, data) => { if (data.fatal && bgFallbackRef.current) stopBgAudio() })
        } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
          el.src = master
          startAt()
        } else {
          stopBgAudio()
        }
      })()
    } else {
      // Local (uploaded) video: an <audio> element decodes the container's
      // audio track from the very same blob/file URL.
      const src = video.currentSrc || video.src || t.url
      if (!src) { stopBgAudio(); return }
      el.src = src
      startAt()
    }
    // Watchdog: if the stream never produces audio (dead manifest, blocked
    // decode…), drop the fallback instead of leaving a silent app.
    setTimeout(() => {
      if (bgFallbackRef.current && el.currentTime < 0.5 && el.readyState === 0) stopBgAudio()
    }, 12000)
  }, [stopBgAudio])

  const exitBgFallback = useCallback(() => {
    if (!bgFallbackRef.current) return
    const bg = bgAudioRef.current
    const pos = bg && bg.currentTime > 1 ? bg.currentTime : bgResumePosRef.current
    const wasPlaying = !!latestRef.current.isPlaying
    stopBgAudio()
    const t = latestRef.current.currentTrack
    const video = videoRef.current
    if (!video || !t?.isVideo) return
    try { video.currentTime = pos } catch {}
    if (wasPlaying) {
      video.play().then(() => setIsPlaying(true)).catch(() => setIsPlaying(false))
    }
  }, [stopBgAudio])

  // visibilitychange covers regular browsers; the Capacitor App plugin
  // (appStateChange) is the reliable native signal on Android.
  useEffect(() => {
    let lateRecheck: ReturnType<typeof setTimeout> | null = null
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        enterBgFallback()
        // Chromium pauses <video> around the same moment as the visibility
        // flip; a late re-check covers the race where the pause landed first.
        if (lateRecheck) clearTimeout(lateRecheck)
        lateRecheck = setTimeout(() => {
          if (document.hidden) enterBgFallback()
        }, 500)
      } else {
        if (lateRecheck) { clearTimeout(lateRecheck); lateRecheck = null }
        exitBgFallback()
      }
    }
    document.addEventListener("visibilitychange", onVis)
    let nativeSub: { remove: () => void } | null = null
    let cancelled = false
    if (msIsNative()) {
      import("@capacitor/app")
        .then(({ App }) =>
          App.addListener("appStateChange", (s) => (s.isActive ? exitBgFallback() : enterBgFallback()))
        )
        .then((sub) => {
          if (cancelled) (sub as unknown as { remove: () => void })?.remove?.()
          else nativeSub = sub as unknown as { remove: () => void }
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
      if (lateRecheck) clearTimeout(lateRecheck)
      document.removeEventListener("visibilitychange", onVis)
      nativeSub?.remove?.()
      stopBgAudio()
    }
  }, [enterBgFallback, exitBgFallback, stopBgAudio])

  // Track switched while hidden (shade next/prev): tear down the old bg audio
  // and, if the new track is a video, re-engage the fallback once its HLS
  // effect had a moment to resolve the new master manifest.
  useEffect(() => {
    if (bgFallbackRef.current) stopBgAudio()
    if (typeof document !== "undefined" && document.hidden) {
      const t = setTimeout(() => {
        if (document.hidden) enterBgFallback()
      }, 1500)
      return () => clearTimeout(t)
    }
  }, [currentTrack?.id, stopBgAudio, enterBgFallback])

  // ---- Upload ----
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  // Persist the current uploaded tracks (excluding demos) to IndexedDB.
  const persistLibrary = useCallback((allTracks: Track[]) => {
    // Persist both local uploaded tracks AND streaming tracks (MP3mn).
    //   - Local (up-*, not stream): audio bytes are stored separately in
    //     IndexedDB, so we blank the URL here and rebuild it on load.
    //   - Streaming (isStream): the URL is a permanent remote stream URL, so
    //     we keep it as-is — no blob to store.
    const stored: StoredTrack[] = allTracks
      .filter((t) => t.id.startsWith("up-") || t.isStream)
      .map((t) => ({
        ...t,
        url: t.isStream ? t.url : "", // blank only local blob URLs
        hasAudioBlob: !t.isStream,
      }))
    void saveLibrary(stored)
  }, [])

  const handleFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || (files as FileList).length === 0) return
      const palettes = [
        { from: "#8b5cf6", to: "#d946ef" },
        { from: "#f43f5e", to: "#f59e0b" },
        { from: "#8b5cf6", to: "#ec4899" },
        { from: "#14b8a6", to: "#84cc16" },
        { from: "#f97316", to: "#eab308" },
        { from: "#06b6d4", to: "#3b82f6" },
      ]
      // Keep only audio/video files (so dropping a whole folder with
      // cover.jpg, .txt, etc. doesn't pollute the playlist).
      const isMedia = (f: File) =>
        f.type.startsWith("audio/") ||
        f.type.startsWith("video/") ||
        /\.(mp3|flac|m4a|aac|ogg|opus|wav|mp4|mkv|webm|mov|avi|m4v)$/i.test(
          f.name
        )
      const fileArr = Array.from(files as ArrayLike<File>).filter(isMedia)
      if (fileArr.length === 0) return

      // Insert placeholder tracks immediately (so the list feels responsive),
      // then enrich them in-place with extracted title/artist/album/cover.
      const baseTime = Date.now()
      const placeholders: Track[] = fileArr.map((file, i) => {
        const id = `up-${baseTime}-${i}`
        const palette = palettes[Math.floor(Math.random() * palettes.length)]
        const url = URL.createObjectURL(file)
        blobUrlsRef.current.add(url)
        const isVideo = file.type.startsWith("video/")
        return {
          id,
          title: file.name.replace(/\.[^.]+$/, ""),
          artist: "Локальный файл",
          album: "Моя библиотека",
          duration: 0,
          url,
          cover: palette,
          isVideo,
        }
      })
      const startIdx = tracks.length
      const withPlaceholders = [...tracks, ...placeholders]
      setTracks(withPlaceholders)
      // Only auto-select the first new track if nothing is currently playing.
      if (tracks.length === 0) {
        setCurrentIndex(0)
        setProgress(0)
        setIsLoading(true)
        setDuration(0)
      }

      // Persist audio/video bytes + metadata so uploads survive reloads.
      // (Run extraction and storage in parallel per file.)
      await Promise.all(
        fileArr.map(async (file, i) => {
          void putAudioBytes(placeholders[i].id, file)

          const meta = await extractAudioMeta(file)
          let coverImage = meta.coverImage
          let title = meta.title
          let artist = meta.artist
          let album = meta.album

          // If no cover from ID3, try iTunes
          if (!coverImage) {
            const enriched = await enrichFromITunes(file.name)
            if (enriched) {
              title = title || enriched.title
              artist = artist || enriched.artist
              album = album || enriched.album
              coverImage = enriched.coverImage
            }
          }

          // Extract dominant colors from cover
          let coverColors = placeholders[i].cover
          if (coverImage) {
            const extracted = await extractCoverColors(coverImage, coverColors)
            if (extracted) coverColors = extracted
          }

          if (!title && !coverImage && coverColors === placeholders[i].cover) return

          setTracks((prev) => {
            const idx = prev.findIndex((t) => t.id === placeholders[i].id)
            if (idx === -1) return prev
            const next = [...prev]
            next[idx] = {
              ...next[idx],
              title: title || next[idx].title,
              artist: artist || next[idx].artist,
              album: album || next[idx].album,
              coverImage: coverImage || next[idx].coverImage,
              cover: coverColors,
            }
            persistLibrary(next)
            return next
          })
        })
      )
      // Final persist in case metadata extraction found nothing for some files.
      persistLibrary(withPlaceholders)
    },
    [tracks, persistLibrary]
  )

  const removeTrack = useCallback(
    (id: string) => {
      const idx = tracks.findIndex((t) => t.id === id)
      if (idx === -1) return
      const removing = tracks[idx]
      if (removing.url.startsWith("blob:")) {
        URL.revokeObjectURL(removing.url)
        blobUrlsRef.current.delete(removing.url)
      }
      const next = tracks.filter((t) => t.id !== id)
      setTracks(next)

      // Drop the audio bytes + library entry from persistent storage.
      // Streaming tracks have no stored blob, so skip deleteAudio for them.
      if (!removing.isStream) {
        void deleteAudio(id)
      }
      persistLibrary(next)

      if (next.length === 0) {
        setIsPlaying(false)
        setCurrentIndex(0)
        setProgress(0)
        return
      }
      if (idx === currentIndex) {
        // play the track now sitting at this slot
        const newIdx = Math.min(idx, next.length - 1)
        setCurrentIndex(newIdx)
        setProgress(0)
        setIsLoading(true)
        setDuration(next[newIdx].duration || 0)
      } else if (idx < currentIndex) {
        setCurrentIndex((c) => c - 1)
      }
    },
    [tracks, currentIndex, persistLibrary]
  )

  // Self-heal: ensure every playlist track that HAS a cover image also has
  // real cover colors. Catches tracks added via "Add all" (before extraction
  // ran), entries restored from IndexedDB by older versions without the
  // flag, and any other path that skipped extraction. Terminates because
  // every attempt (success or failure) sets coverColorsExtracted.
  useEffect(() => {
    const pending = tracks.filter((t) => t.coverImage && !t.coverColorsExtracted)
    if (pending.length === 0) return
    let cancelled = false
    void (async () => {
      for (const t of pending) {
        if (cancelled) return
        const colors = await extractCoverColors(t.coverImage!, t.cover)
        if (cancelled) return
        setTracks((prev) => {
          const idx = prev.findIndex((x) => x.id === t.id)
          if (idx === -1) return prev
          const next = [...prev]
          next[idx] = { ...next[idx], cover: colors, coverColorsExtracted: true }
          persistLibrary(next)
          return next
        })
        // Mirror into search results / preview if the same track is shown there
        setSearchResults((prev) => prev.map((x) => (x.url === t.url ? { ...x, cover: colors, coverColorsExtracted: true } : x)))
        setPreviewTrack((prev) => (prev && prev.url === t.url ? { ...prev, cover: colors, coverColorsExtracted: true } : prev))
      }
    })()
    return () => { cancelled = true }
  }, [tracks, persistLibrary])

  // Online mode: query MP3mn when the user submits the search.
  const runOnlineSearch = useCallback(async () => {
    const q = searchQuery.trim()
    if (!q) { setSearchResults([]); return }
    setIsSearching(true)
    try {
      const mnResults = await searchMp3mn(q)
      if (mnResults.length > 0) {
        const converted = mnResults.map(mp3mnToTrack)
        setSearchResults(converted)
        // Enrich covers from iTunes with a small worker pool — an aggregated
        // search can return 40-90 tracks and blasting that many parallel
        // requests at iTunes would trip its rate limiting.
        const queue = converted.filter((t) => !t.coverImage)
        let qi = 0
        const enrichWorker = async () => {
          while (qi < queue.length) {
            const t = queue[qi++]
            const enriched = await enrichFromITunes(`${t.artist} ${t.title}`.trim())
            if (enriched?.coverImage) {
              setSearchResults((prev) => prev.map((x) => x.id === t.id ? { ...x, coverImage: enriched.coverImage } : x))
              // Also update playlist copies that were added before enrichment
              // finished (e.g. user pressed "Add all" immediately). The
              // self-heal effect will then extract colors for them.
              setTracks((prev) => {
                if (!prev.some((x) => x.url === t.url && !x.coverImage)) return prev
                const next = prev.map((x) => x.url === t.url && !x.coverImage ? { ...x, coverImage: enriched.coverImage! } : x)
                persistLibrary(next)
                return next
              })
            }
          }
        }
        void Promise.all(Array.from({ length: Math.min(6, queue.length) }, enrichWorker))
        return
      }
      setSearchResults([])
    } catch { setSearchResults([]) } finally { setIsSearching(false) }
  }, [searchQuery, persistLibrary])

  // Video mode: query Rutube for clips. Covers come from the search
  // response itself — no iTunes enrichment needed.
  const runVideoSearch = useCallback(async () => {
    const q = searchQuery.trim()
    if (!q) { setSearchResults([]); return }
    setIsSearching(true)
    try {
      const vids = await searchRutube(q)
      setSearchResults(vids.map(rutubeToTrack))
    } catch { setSearchResults([]) } finally { setIsSearching(false) }
  }, [searchQuery])

  // Play a track from search results WITHOUT adding it to the playlist.
  // Sets it as the previewTrack so the main player displays it and the
  // visualizer reacts. Plays through the main audioRef.
  const addAndPlayTrack = useCallback(
    (track: Track) => {
      // If same track is already the previewTrack → toggle play/pause
      if (previewTrack && previewTrack.url === track.url) {
        // Rutube embed toggles via postMessage; native HLS via the element.
        if (track.isVideo && isRutubeUrl(track.url) && rtUseEmbed) {
          rtCommand(isPlaying ? "pause" : "play")
          return
        }
        if (track.isVideo) {
          const video = videoRef.current
          if (video) {
            if (video.paused) video.play().catch(() => {})
            else video.pause()
          }
          return
        }
        const audio = audioRef.current
        if (audio) {
          if (audio.paused) audio.play().catch(() => {})
          else audio.pause()
        }
        return
      }
      // Set as previewTrack — main player will display it
      setPreviewTrack(track)
      // The effect on [currentTrack?.url] will load + play it
      shouldAutoPlayRef.current = true

      // Async: extract dominant colors from cover for glassmorphism tinting
      if (track.coverImage && !track.coverColorsExtracted) {
        void extractCoverColors(track.coverImage, track.cover).then((colors) => {
          setPreviewTrack((prev) =>
            prev && prev.url === track.url
              ? { ...prev, cover: colors, coverColorsExtracted: true }
              : prev
          )
          setSearchResults((prev) =>
            prev.map((t) =>
              t.url === track.url ? { ...t, cover: colors, coverColorsExtracted: true } : t
            )
          )
        })
      }
    },
    [previewTrack, isPlaying, rtCommand, rtUseEmbed]
  )

  // Helper: check if a track is already in the playlist by title+artist
  // (case-insensitive, trimmed). This catches duplicates even when ids differ
  // (e.g. same song found via different search sources).
  const trackExists = useCallback(
    (track: Track, list: Track[]): boolean => {
      const normTitle = track.title.trim().toLowerCase()
      const normArtist = track.artist.trim().toLowerCase()
      return list.some(
        (t) =>
          t.title.trim().toLowerCase() === normTitle &&
          t.artist.trim().toLowerCase() === normArtist
      )
    },
    []
  )

  // Add all online search results to the playlist. Keeps search results
  // visible (no reset). De-dupes by title+artist — both against the
  // existing playlist AND within the search results themselves (so if
  // the search returns the same song twice, only one copy is added).
  const addAllSearchResults = useCallback(() => {
    if (searchResults.length === 0) return
    setTracks((prev) => {
      const toAdd: Track[] = []
      for (const candidate of searchResults) {
        // Skip if already in playlist
        if (trackExists(candidate, prev)) continue
        // Skip if already in toAdd (duplicate within search results)
        if (trackExists(candidate, toAdd)) continue
        toAdd.push(candidate)
      }
      if (toAdd.length === 0) return prev
      const next = [...prev, ...toAdd]
      persistLibrary(next)
      return next
    })
    // Don't reset search — keep results visible
  }, [searchResults, persistLibrary, trackExists])

  // Toggle preview playback of a search result without adding it to the
  // playlist. If the same track is already previewing, pause/resume it.
  const togglePreview = useCallback(
    (track: Track) => {
      const audio = previewAudioRef.current
      if (!audio) return
      // Always pause the main player (audio + video) before previewing —
      // they must never play simultaneously.
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause()
      }
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause()
      }
      if (previewId === track.id) {
        // same track → toggle play/pause
        if (audio.paused) {
          void audio.play().catch(() => {})
        } else {
          audio.pause()
        }
      } else {
        // new track → load + play
        audio.src = track.url
        audio.volume = muted ? 0 : volume
        setPreviewProgress(0)
        setPreviewDuration(0)
        void audio.play().catch(() => {})
        setPreviewId(track.id)
      }
    },
    [previewId, muted, volume]
  )

  // Seek the preview audio to a specific time (seconds).
  const seekPreview = useCallback((value: number) => {
    const audio = previewAudioRef.current
    if (!audio || !Number.isFinite(audio.duration)) return
    audio.currentTime = value
    setPreviewProgress(value)
  }, [])

  // Keep preview audio volume in sync with the main volume controls.
  useEffect(() => {
    if (previewAudioRef.current) {
      previewAudioRef.current.volume = muted ? 0 : volume
    }
  }, [volume, muted])

  // Stop the preview when leaving online search mode.
  useEffect(() => {
    if (searchMode !== "online" && previewAudioRef.current) {
      previewAudioRef.current.pause()
      previewAudioRef.current.src = ""
      setPreviewId(null)
      setIsPreviewPlaying(false)
    }
  }, [searchMode])

  // ---- Visualizer (Web Audio API, with graceful fallback) ----
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const useFakeRef = useRef(false)
  const isPlayingRef = useRef(isPlaying)
  const coverRef = useRef(currentTrack?.cover ?? { from: "#10b981", to: "#0ea5e9" })

  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  useEffect(() => {
    coverRef.current = currentTrack?.cover ?? (theme === "dark" ? { from: "#10b981", to: "#0ea5e9" } : { from: "#8b5cf6", to: "#d946ef" })
  }, [currentTrack, theme])

  // ---- Retro VFD spectrum analyzer (Technics/Pioneer style) ----
  //   - 16 segmented bars (cubes), symmetric around the center: bass in the
  //     middle, highs on the edges, left↔right mirrored.
  //   - each bar is built from individual horizontal segments with black gaps
  //   - peak-hold markers: freeze ~500ms at the top, then fall
  //   - VFD color scheme: green (low) → orange (mid) → red (clip/0dB)
  const BAR_COUNT = 16
  const SEGMENTS = 12
  const peaksRef = useRef<Float32Array>(new Float32Array(BAR_COUNT))
  const peakHoldRef = useRef<Float32Array>(new Float32Array(BAR_COUNT))
  const peakTimeRef = useRef<Float32Array>(new Float32Array(BAR_COUNT))

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current
      const analyser = analyserRef.current
      if (!canvas) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }
      const ctx = canvas.getContext("2d")
      if (!ctx) {
        rafRef.current = requestAnimationFrame(draw)
        return
      }
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)

      // Layout: 16 bars, generous gap so they look like chunky EQ sliders.
      const gap = Math.max(4, w * 0.012)
      const barWidth = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT
      // Segments stacked from the bottom, each with a thin black gap.
      const segGap = 1
      const segH = Math.max(2, (h - segGap * (SEGMENTS - 1)) / SEGMENTS)

      // Read frequency data.
      let data: Uint8Array | null = null
      if (analyser && !useFakeRef.current) {
        const buf = new Uint8Array(analyser.frequencyBinCount)
        try {
          analyser.getByteFrequencyData(buf)
          // CORS-silenced streams (e.g. mp3mn — no CORS headers on their CDN)
          // feed all-zero samples into the analyser. Detect that while playing
          // and fall back to the animated wave, so the visualizer still moves.
          let sum = 0
          for (let i = 0; i < buf.length; i++) sum += buf[i]
          data = sum === 0 ? null : buf
        } catch {
          useFakeRef.current = true
        }
      }

      const playing = isPlayingRef.current
      const now = performance.now()
      const t = now / 1000
      const peaks = peaksRef.current
      const peakHold = peakHoldRef.current
      const peakTime = peakTimeRef.current

      // Map each bar to a frequency bin. The center two bars (7, 8) are the
      // lowest freqs (bass), bars going outward climb to higher freqs. Left
      // and right halves are mirror images of each other.
      const halfBars = BAR_COUNT / 2
      const freqBins = data ? data.length : 64

      // Compute per-bar values with lerp smoothing.
      // Scale keeps full dynamic range (quiet→loud clearly visible) while
      // spreading bars vertically via per-bin frequency weighting, so the
      // bass (center) reads louder than the highs (edges) — like real music.
      for (let i = 0; i < BAR_COUNT; i++) {
        const distFromCenter = Math.abs(i - (halfBars - 0.5))
        const norm = distFromCenter / halfBars // 0 (center) → 1 (edge)
        let target: number
        if (data && playing) {
          const idx = Math.min(
            freqBins - 1,
            1 + Math.floor(norm * (freqBins * 0.7))
          )
          // Full-range scale: 0..255 → 0..1 with a gentle sqrt curve that
          // keeps quiet passages low and lets peaks reach near the top —
          // this is what gives visible dynamics instead of a flat band.
          const raw = data[idx] / 255
          const shaped = Math.sqrt(raw) // sqrt: 0.25→0.5, 0.5→0.7, 1.0→1.0
          // Per-bar weighting: bass (center) is naturally louder, highs
          // (edges) quieter. A gentle falloff keeps bars from matching.
          const weight = 1 - norm * 0.3 // center → 1.0, edges → 0.7
          target = Math.min(1, shaped * weight)
        } else {
          const active = playing ? 0.5 : 0.06
          const centerBoost = 1 - norm * 0.5
          const wave =
            0.5 + 0.5 * Math.sin(t * 3 + i * 0.5) * Math.sin(t * 1.7 + i * 0.22)
          target = active * centerBoost * (0.2 + 0.8 * Math.max(0, wave))
        }
        // Snappier dynamics: near-instant attack, medium release so bars
        // jump on transients (kick/snare) and ease down on sustain.
        const prev = peaks[i]
        const eased =
          target > prev
            ? prev + (target - prev) * 0.7 // fast attack
            : prev + (target - prev) * 0.25 // medium release
        peaks[i] = Math.max(0, Math.min(1, eased))

        // Peak-hold: latch the max for ~500ms, then let it fall.
        if (peaks[i] >= peakHold[i]) {
          peakHold[i] = peaks[i]
          peakTime[i] = now
        } else if (now - peakTime[i] > 500) {
          peakHold[i] = Math.max(peaks[i], peakHold[i] - 0.018)
        }
      }

      // Color scheme adapts to the track's cover colors (matches the player
      // accent). Bottom segments use the cover's "to" color, mid segments
      // blend to the brighter "from" color, top segments (clip zone) glow
      // near-white so they read as the overload/0dB zone.
      const cover = coverRef.current
      const segColor = (segIndex: number) => {
        const ratio = segIndex / (SEGMENTS - 1) // 0 (bottom) → 1 (top)
        if (ratio < 0.75) return cover.to
        if (ratio < 0.9) return cover.from
        return "#fef9c3" // near-white yellow = clip / 0dB
      }

      // Draw each bar: lit segments from the bottom up to the value, plus a
      // peak-hold marker segment at the peak position.
      for (let i = 0; i < BAR_COUNT; i++) {
        const x = i * (barWidth + gap)
        const v = peaks[i]
        const litCount = Math.round(v * SEGMENTS)
        // peak marker position in segments
        const peakSeg = Math.round(peakHold[i] * SEGMENTS)

        for (let s = 0; s < SEGMENTS; s++) {
          // segments drawn bottom-up: s=0 is bottom.
          const y = h - (s + 1) * (segH + segGap) + segGap
          if (s < litCount) {
            // lit segment — bright VFD color
            ctx.fillStyle = segColor(s)
            ctx.fillRect(x, y, barWidth, segH)
          } else if (s === peakSeg && peakHold[i] > 0.02) {
            // peak-hold marker — bright white-red segment floating above
            ctx.fillStyle = "#fef2f2"
            ctx.fillRect(x, y, barWidth, segH)
          }
          // unlit segments are simply not drawn (black background)
        }
      }

      // Subtle glow pass for the retro VFD feel — redraw lit tops with blur.
      ctx.save()
      ctx.globalCompositeOperation = "lighter"
      ctx.shadowBlur = 6
      for (let i = 0; i < BAR_COUNT; i++) {
        const x = i * (barWidth + gap)
        const v = peaks[i]
        const litCount = Math.round(v * SEGMENTS)
        if (litCount <= 0) continue
        const topSeg = litCount - 1
        const y = h - (topSeg + 1) * (segH + segGap) + segGap
        ctx.shadowColor = segColor(topSeg)
        ctx.fillStyle = "rgba(0,0,0,0.01)" // invisible, just for the shadow
        ctx.fillRect(x, y, barWidth, segH)
      }
      ctx.restore()

      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    if (isPlaying && audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {})
    }
  }, [isPlaying])

  const onPlayClick = useCallback(() => {
    // Skip the Web Audio graph for remote streams — CORS-silenced (see
    // isRemoteMediaUrl). Otherwise pause/resume would mute online tracks.
    if (!isRemoteMediaUrl(currentTrack?.url)) {
      ensureAudioGraph(!!currentTrack?.isVideo)
    }
    if (audioCtxRef.current?.state === "suspended") {
      audioCtxRef.current.resume().catch(() => {})
    }
    togglePlay()
  }, [ensureAudioGraph, teardownAudioSource, togglePlay, currentTrack?.isVideo, currentTrack?.url])

  // ---- Video resize (drag the vertical handle to the right of the video) ----
  // Max width is computed from the real available space: window width minus the
  // playlist's minimum width (200px) minus padding/gaps. This way the video can
  // grow large (the playlist shrinks to its minimum) but never overflows under
  // the playlist.
  const getVideoMaxWidth = useCallback(() => {
    if (typeof window === "undefined") return 800
    const main = document.querySelector("main")
    const mainW = main?.getBoundingClientRect().width ?? window.innerWidth - 64
    // The playlist (aside) can shrink down to 200px. Leave room for the gap
    // (gap-6 = 24px) between section and aside.
    const playlistMin = 200
    const gap = 24
    return Math.max(320, Math.floor(mainW - playlistMin - gap))
  }, [])

  const startVideoResize = useCallback(
    (clientX: number, currentWidth: number) => {
      videoResizeStateRef.current = { startX: clientX, startW: currentWidth }
      const onMove = (e: MouseEvent) => {
        const s = videoResizeStateRef.current
        if (!s) return
        // Dragging right grows, left shrinks.
        const delta = e.clientX - s.startX
        const next = Math.max(280, Math.min(getVideoMaxWidth(), s.startW + delta))
        setVideoWidth(next)
      }
      const onUp = () => {
        videoResizeStateRef.current = null
        window.removeEventListener("mousemove", onMove)
        window.removeEventListener("mouseup", onUp)
      }
      window.addEventListener("mousemove", onMove)
      window.addEventListener("mouseup", onUp)
    },
    [getVideoMaxWidth]
  )

  const startVideoResizeTouch = useCallback(
    (clientX: number, currentWidth: number) => {
      videoResizeStateRef.current = { startX: clientX, startW: currentWidth }
      const onMove = (e: TouchEvent) => {
        const s = videoResizeStateRef.current
        if (!s || !e.touches[0]) return
        const delta = e.touches[0].clientX - s.startX
        const next = Math.max(280, Math.min(getVideoMaxWidth(), s.startW + delta))
        setVideoWidth(next)
      }
      const onUp = () => {
        videoResizeStateRef.current = null
        window.removeEventListener("touchmove", onMove)
        window.removeEventListener("touchend", onUp)
      }
      window.addEventListener("touchmove", onMove)
      window.addEventListener("touchend", onUp)
    },
    [getVideoMaxWidth]
  )

  const resetVideoSize = useCallback(() => setVideoWidth(null), [])

  // cleanup all blob URLs on unmount
  useEffect(() => {
    return () => {
      blobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u))
      blobUrlsRef.current.clear()
    }
  }, [])

  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2

  const repeatLabel =
    repeatMode === "off"
      ? "Повтор выключен"
      : repeatMode === "all"
      ? "Повтор всего списка"
      : "Повтор одной"

  const coverStyle = useMemo(() => {
    if (!currentTrack) return undefined
    return {
      backgroundImage: `linear-gradient(135deg, ${currentTrack.cover.from}, ${currentTrack.cover.to})`,
    }
  }, [currentTrack])

  return (
    <div
      className={cn(
        "relative flex min-h-screen flex-col overflow-x-hidden bg-background text-foreground transition-colors duration-700",
        isDragOver && "ring-2 ring-inset ring-violet-400 dark:ring-emerald-400"
      )}
      onDragOver={(e) => {
        e.preventDefault()
        if (!isDragOver) setIsDragOver(true)
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the window, not when moving between children
        if (e.relatedTarget === null) setIsDragOver(false)
      }}
      onDrop={async (e) => {
        e.preventDefault()
        setIsDragOver(false)
        const dt = e.dataTransfer
        if (!dt) return

        // Prefer the items API so we can recurse into dropped folders.
        const items = dt.items
        if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === "function") {
          const collected: File[] = []
          const traverseEntry = (entry: FileSystemEntry): Promise<void> =>
            new Promise((resolve) => {
              if (entry.isFile) {
                ;(entry as FileSystemFileEntry).file(
                  (f) => {
                    collected.push(f)
                    resolve()
                  },
                  () => resolve()
                )
              } else if (entry.isDirectory) {
                const reader = (entry as FileSystemDirectoryEntry).createReader()
                const readBatch = () => {
                  reader.readEntries(
                    async (batch) => {
                      if (batch.length === 0) {
                        resolve()
                        return
                      }
                      await Promise.all(batch.map(traverseEntry))
                      readBatch() // keep reading until empty
                    },
                    () => resolve()
                  )
                }
                readBatch()
              } else {
                resolve()
              }
            })

          const entries: FileSystemEntry[] = []
          for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry()
            if (entry) entries.push(entry)
          }
          await Promise.all(entries.map(traverseEntry))
          if (collected.length > 0) {
            void handleFiles(collected)
          }
          return
        }

        // Fallback: plain file list (no folder traversal).
        const files = dt.files
        if (files && files.length > 0) {
          void handleFiles(files)
        }
      }}
    >
      {/* Hidden audio element for audio tracks.
          Video tracks use the visible <video> rendered in the now-playing section. */}
      <audio
        ref={audioRef}
        // Remount the element when switching between local (blob:) and remote
        // sources. An element that was once captured by
        // createMediaElementSource can NEVER play directly again — a fresh
        // element is required so remote tracks can output sound.
        key={audioKey}
        src={!currentTrack?.isVideo ? currentTrack?.url || undefined : undefined}
        // NOTE: no crossOrigin here — mp3mn stream servers send no CORS
        // headers, and crossorigin="anonymous" would make the browser refuse
        // to load them at all. The visualizer falls back to its animated
        // wave when a stream can't be tapped by the AnalyserNode.
        preload="metadata"
        onEnded={handleEnded}
      />
      {/* Hidden audio element for previewing search results without adding
          them to the playlist. */}
      <audio
        ref={previewAudioRef}
        // no crossOrigin — see the main <audio> above
        preload="metadata"
        onPlay={() => setIsPreviewPlaying(true)}
        onPause={() => setIsPreviewPlaying(false)}
        onTimeUpdate={() =>
          setPreviewProgress(previewAudioRef.current?.currentTime ?? 0)
        }
        onLoadedMetadata={() => {
          setPreviewDuration(previewAudioRef.current?.duration ?? 0)
        }}
        onEnded={() => {
          setIsPreviewPlaying(false)
          setPreviewId(null)
          setPreviewProgress(0)
        }}
      />


      {/* Ambient blurred cover image */}
      {currentTrack?.coverImage && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden" style={{ backgroundImage: `url(${currentTrack.coverImage})`, backgroundSize: "cover", backgroundPosition: "center", filter: "blur(90px) saturate(1.6) brightness(1.1)", transform: "scale(1.4)", opacity: theme === "dark" ? 0.5 : 0.3, transition: "background-image 600ms ease, opacity 400ms ease" }} />
      )}
      {currentTrack && (
        <div aria-hidden className="pointer-events-none fixed inset-0 z-0" style={{ background: `linear-gradient(180deg, transparent 0%, ${currentTrack.cover.from}${theme === "dark" ? "22" : "15"} 100%), radial-gradient(circle at 50% 50%, transparent 30%, ${theme === "dark" ? "#00000066" : "#ffffff33"} 100%)`, transition: "background 600ms ease" }} />
      )}

      {/* Loading splash while restoring the saved library */}
      {!tracksReady && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background">
          <Disc3 className="h-12 w-12 animate-spin-slow text-violet-500 dark:text-emerald-400" />
          <p className="text-xs text-muted-foreground">Загрузка библиотеки…</p>
        </div>
      )}

      {/* Drag overlay hint */}
      {isDragOver && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-violet-500/10 dark:bg-emerald-500/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-violet-400 dark:border-emerald-400 bg-background/80 px-10 py-8 text-center shadow-2xl">
            <Upload className="mx-auto mb-2 h-8 w-8 text-violet-500 dark:text-emerald-400" />
            <p className="text-sm font-medium text-violet-500 dark:text-emerald-500">
              Отпустите файлы или папку, чтобы добавить
            </p>
          </div>
        </div>
      )}

      {/* Hidden file input for individual audio/video files. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/*"
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ""
        }}
      />
      {/* Hidden file input with webkitdirectory — lets the user pick a whole folder.
          Non-media files inside the folder are filtered out in handleFiles. */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        // @ts-expect-error — webkitdirectory is a non-standard but widely supported attribute
        webkitdirectory=""
        directory=""
        onChange={(e) => {
          handleFiles(e.target.files)
          e.target.value = ""
        }}
      />

      {/* Main — no top header, fills the full height */}
      <main className={cn(
        "relative z-10 mx-auto flex w-full max-w-[1600px] min-w-0 flex-1 flex-col gap-6 px-4 pt-4 pb-2 sm:px-6 lg:flex-row lg:px-8",
        // On mobile + video mode, remove horizontal padding so the video
        // spans the full screen width (edge-to-edge).
        currentTrack?.isVideo ? "px-0 sm:px-6" : "px-4"
      )}>
        {/* Now playing */}
        <section
          className={cn(
            "flex min-w-0 flex-col",
            // Mobile: full width. Desktop (sm+): user-set width via the
            // --video-width CSS variable (default 50%).
            currentTrack?.isVideo
              ? "w-full sm:w-[var(--video-width,50%)]"
              : "flex-1"
          )}
          style={
            currentTrack?.isVideo
              ? ({
                  flex: "0 0 auto",
                  ["--video-width" as string]: videoWidth
                    ? `${videoWidth}px`
                    : "50%",
                } as React.CSSProperties)
              : { flex: "1 1 0%" }
          }
        >
          <div ref={playerCardRef}
               className={cn(
            "relative overflow-hidden bg-card/60 shadow-2xl backdrop-blur-2xl",
            currentTrack?.isVideo
              ? "rounded-none border-0 p-0 sm:rounded-3xl sm:border sm:border-border sm:p-8"
              : "rounded-3xl border border-border/50 p-5 sm:p-8"
          )}
          style={{
            backgroundColor: currentTrack ? `${currentTrack.cover.to}${theme === "dark" ? "66" : "4d"}` : undefined,
          }}
          >
            {currentTrack && (
              <div
                className="pointer-events-none absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full opacity-30 blur-3xl"
                style={{
                  background: `radial-gradient(circle, ${currentTrack.cover.from}, transparent 70%)`,
                }}
              />
            )}

            <div
              className={cn(
                "relative flex items-stretch gap-6",
                // Audio: cover + info side by side. Video: stack info below the
                // video so long titles never overflow onto the video area.
                currentTrack?.isVideo ? "flex-col" : "flex-col sm:flex-row sm:items-start"
              )}
            >
              {currentTrack?.isVideo ? (
                /* Video track — the parent <section> is sized via videoWidth,
                   so the video fills the section width. The vertical handle
                   on the right resizes the section (and the playlist shrinks). */
                <div className="flex w-full shrink-0 items-stretch">
                  <div className="relative min-w-0 flex-1 overflow-hidden bg-black shadow-2xl sm:rounded-2xl sm:shadow-2xl">
                    {isRtEmbed ? (
                      /* Rutube embed — official player iframe, driven via the
                         postMessage protocol. Only used as the fallback when
                         native HLS (and its working visualizer) can't play
                         this video; audio here is untappable by Web Audio. */
                      <div
                        className="relative mx-auto w-full max-w-full"
                        style={{ aspectRatio: "16 / 9", maxHeight: "60vh" }}
                      >
                        <iframe
                          ref={rtFrameRef}
                          key={currentTrack.id}
                          src={`https://rutube.ru/play/embed/${rutubeId(currentTrack.url)}/?autoplay=1`}
                          allow="autoplay; fullscreen; picture-in-picture; encrypted-media"
                          allowFullScreen
                          className="absolute inset-0 h-full w-full border-0"
                          title={currentTrack.title}
                          onLoad={() => {
                            setIsLoading(false)
                            rtCommand("volume", muted ? 0 : volume)
                          }}
                        />
                        {rtUnavailable && (
                          <div className="absolute inset-0 z-10 grid place-items-center bg-black/85 p-4 text-center">
                            <div className="max-w-xs">
                              <p className="text-sm font-medium text-white">Плеер Rutube не загрузился</p>
                              <p className="mt-1 text-xs text-white/70">Возможно, видео недоступно или сервис временно не отвечает.</p>
                              <a
                                href={`https://rutube.ru/video/${rutubeId(currentTrack.url)}/`}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-3 inline-block rounded-md bg-violet-500 dark:bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-violet-600 dark:hover:bg-emerald-600"
                              >
                                Открыть на Rutube ↗
                              </a>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                    <video
                      ref={videoRef}
                      src={isRtTrack ? undefined : currentTrack.url}
                      preload="auto"
                      // Mobile: fixed-height horizontal container (35vh).
                      // object-contain keeps the video's aspect ratio — vertical
                      // videos get pillarboxed (black bars on the sides),
                      // landscape fills the frame. Desktop: fill container.
                      className="mx-auto block h-[40vh] max-h-[60vh] w-full max-w-full object-contain"
                      controls
                      playsInline
                      onTimeUpdate={() => {
                        // Throttle progress updates to ~4/sec to avoid
                        // re-rendering the whole component too often on
                        // mobile, which causes video stutter.
                        const v = videoRef.current
                        if (!v) return
                        const t = v.currentTime
                        if (Math.abs(t - progressRef.current) > 0.25) {
                          progressRef.current = t
                          setProgress(t)
                        }
                      }}
                      onLoadedMetadata={() => {
                        setDuration(videoRef.current?.duration ?? 0)
                        setIsLoading(false)
                      }}
                      // v1.7.4: ignore play/pause events that Chromium fires on the
                      // <video> during app backgrounding — the isPlaying state must
                      // keep reflecting the logical playback (the bg-audio fallback).
                      onPlay={() => { if (!bgFallbackRef.current && !document.hidden) setIsPlaying(true) }}
                      onPause={() => { if (!bgFallbackRef.current && !document.hidden) setIsPlaying(false) }}
                      onEnded={handleEnded}
                    />
                    )}
                  </div>
                  {/* Vertical resize handle — hidden on mobile (no room),
                      shown on sm+ so desktop users can drag to resize. */}
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    aria-label="Изменить размер видео"
                    tabIndex={0}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      const el = (e.currentTarget as HTMLElement).parentElement
                      const w = el?.getBoundingClientRect().width ?? 560
                      startVideoResize(e.clientX, w)
                    }}
                    onTouchStart={(e) => {
                      const el = (e.currentTarget as HTMLElement).parentElement
                      const w = el?.getBoundingClientRect().width ?? 560
                      startVideoResizeTouch(e.touches[0].clientX, w)
                    }}
                    onDoubleClick={resetVideoSize}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowRight") {
                        e.preventDefault()
                        setVideoWidth((w) => Math.min(getVideoMaxWidth(), (w ?? 560) + 40))
                      } else if (e.key === "ArrowLeft") {
                        e.preventDefault()
                        setVideoWidth((w) => Math.max(280, (w ?? 560) - 40))
                      } else if (e.key === "Enter") {
                        e.preventDefault()
                        resetVideoSize()
                      }
                    }}
                    className="hidden group/handle w-2 cursor-col-resize touch-none items-center justify-center rounded-full bg-border/40 transition hover:bg-violet-400/60 dark:hover:bg-emerald-400/60 focus:bg-violet-400 dark:focus:bg-emerald-400 focus:outline-none sm:flex"
                    title="Тяните, чтобы изменить размер. Двойной клик — сбросить"
                  >
                    <div className="h-10 w-1 rounded-full bg-muted-foreground/40 transition group-hover/handle:bg-violet-300 dark:group-hover/handle:bg-emerald-300" />
                  </div>
                </div>
              ) : (
                <div className="relative shrink-0">
                  <div
                    className="grid aspect-square w-44 place-items-center overflow-hidden rounded-2xl shadow-2xl sm:w-52"
                    style={coverStyle}
                  >
                    {currentTrack?.coverImage ? (
                      <img
                        src={currentTrack.coverImage}
                        alt={`Обложка: ${currentTrack.title}`}
                        className="h-full w-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <Disc3
                        className={cn(
                          "h-20 w-20 text-white/90 drop-shadow-lg",
                          isPlaying && "animate-spin-slow"
                        )}
                      />
                    )}
                  </div>
                  {isPlaying && (
                    <span className="absolute -right-1 -top-1 flex h-4 w-4">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-400 opacity-75 dark:bg-emerald-400" />
                      <span className="relative inline-flex h-4 w-4 rounded-full bg-violet-500 dark:bg-emerald-500" />
                    </span>
                  )}
                </div>
              )}

              <div className={cn(
                "flex min-w-0 flex-1 flex-col",
                // On mobile, the video sits edge-to-edge (no padding) so it
                // fills the full width. The info block below gets padding so
                // the title/controls don't touch the screen edge.
                currentTrack?.isVideo ? "p-4 sm:p-0" : ""
              )}>
                <p className="text-xs font-medium uppercase tracking-widest text-violet-500 dark:text-emerald-400 drop-shadow">
                  {isLoading ? "Загрузка…" : isPlaying ? "Сейчас играет" : "Пауза"}
                </p>
                <h2 className="mt-1 truncate text-2xl font-bold tracking-tight drop-shadow-sm sm:text-3xl">
                  {currentTrack?.title ?? "Нет трека"}
                </h2>
                <p className="mt-1 truncate text-sm font-medium text-foreground/90 drop-shadow-sm">
                  {currentTrack?.artist}{" "}
                  {currentTrack?.album ? (
                    <span className="text-foreground/60">· {currentTrack.album}</span>
                  ) : null}
                </p>

                {/* Retro VFD spectrum analyzer — identical for audio and video.
                    On mobile + video mode we hide it entirely to save CPU
                    (the requestAnimationFrame loop can cause video stutter
                    in mobile WebView). */}
                {!(currentTrack?.isVideo && typeof window !== "undefined" && window.innerWidth < 640) && (
                <div className="mt-4 h-24 w-full overflow-hidden rounded-xl">
                  <canvas ref={canvasRef} className="h-full w-full" />
                </div>
                )}

                <div className="mt-5 flex items-center gap-3">
                  <span className="w-10 shrink-0 text-right text-xs font-medium tabular-nums text-foreground/80">
                    {formatTime(progress)}
                  </span>
                  <Slider
                    value={[progress]}
                    max={duration > 0 ? duration : 100}
                    step={0.1}
                    onValueChange={(v) => seek(v[0])}
                    className="flex-1"
                  />
                  <span className="w-10 shrink-0 text-xs font-medium tabular-nums text-foreground/80">
                    {formatTime(duration)}
                  </span>
                </div>
              </div>
            </div>

            <div className="relative mt-6 flex flex-col items-center gap-4 border-t border-border pt-5 sm:flex-row sm:justify-between">
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShuffle((s) => !s)}
                  className={cn(
                    "h-9 w-9 text-foreground/80 hover:text-foreground",
                    shuffle && "text-violet-500 hover:text-violet-400 dark:text-emerald-400 dark:hover:text-emerald-300"
                  )}
                  aria-pressed={shuffle}
                  title="Перемешать"
                >
                  <Shuffle className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={cycleRepeat}
                  className={cn(
                    "h-9 w-9 text-foreground/80 hover:text-foreground",
                    repeatMode !== "off" && "text-violet-500 hover:text-violet-400 dark:text-emerald-400 dark:hover:text-emerald-300"
                  )}
                  title={repeatLabel}
                  aria-label={repeatLabel}
                >
                  {repeatMode === "one" ? (
                    <Repeat1 className="h-4 w-4" />
                  ) : (
                    <Repeat className="h-4 w-4" />
                  )}
                </Button>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={playPrev}
                  disabled={!tracksReady || tracks.length === 0}
                  className="h-10 w-10 text-foreground hover:text-foreground"
                  aria-label="Предыдущий"
                >
                  <SkipBack className="h-5 w-5" />
                </Button>
                <Button
                  onClick={onPlayClick}
                  disabled={!tracksReady || !currentTrack?.url}
                  size="icon"
                  className="h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-xl shadow-violet-500/10 dark:shadow-emerald-500/10 transition hover:scale-105 hover:bg-primary disabled:opacity-40 disabled:hover:scale-100"
                  aria-label={isPlaying ? "Пауза" : "Играть"}
                >
                  {isPlaying ? (
                    <Pause className="h-6 w-6" />
                  ) : (
                    <Play className="ml-0.5 h-6 w-6" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={playNext}
                  disabled={!tracksReady || tracks.length === 0}
                  className="h-10 w-10 text-foreground hover:text-foreground"
                  aria-label="Следующий"
                >
                  <SkipForward className="h-5 w-5" />
                </Button>
              </div>

              <div className="flex w-full items-center gap-2 sm:w-36 sm:justify-end">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setMuted((m) => !m)}
                  className="h-9 w-9 shrink-0 text-foreground/80 hover:text-foreground"
                  aria-label={muted ? "Включить звук" : "Выключить звук"}
                >
                  <VolumeIcon className="h-4 w-4" />
                </Button>
                <Slider
                  value={[muted ? 0 : volume * 100]}
                  max={100}
                  step={1}
                  onValueChange={(v) => {
                    setVolume(v[0] / 100)
                    setMuted(v[0] === 0)
                  }}
                  className="w-full max-w-[120px]"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Playlist — takes the remaining space after the video section.
            Can be collapsed via the header toggle (useful on mobile / narrow
            screens so the player gets the full width). */}
        {!playlistCollapsed && (
        <aside className="flex w-full min-w-0 flex-col overflow-hidden lg:min-w-[200px] lg:max-w-[400px]" style={{ flex: "1 1 0%" }}>
          <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-border/50 bg-card/60 backdrop-blur-2xl"
               style={{
                 backgroundColor: currentTrack
                   ? `${currentTrack.cover.from}${theme === "dark" ? "5c" : "45"}`
                   : undefined,
               }}
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <ListMusic className="h-4 w-4 text-violet-500 dark:text-emerald-400" />
                <h3 className="text-sm font-semibold">Плейлист</h3>
              </div>
              <div className="flex items-center gap-2">
                {/* Sort dropdown */}
                <div className="relative">
                  <select
                    value={sortMode}
                    onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                    className="h-7 rounded-md border border-border/50 bg-secondary/80 px-2 text-[11px] font-medium text-foreground/80 focus:border-violet-400 dark:focus:border-emerald-400 focus:outline-none"
                    title="Сортировка"
                  >
                    <option value="default">По умолчанию</option>
                    <option value="title">По названию</option>
                    <option value="artist">По исполнителю</option>
                    <option value="duration">По длительности</option>
                    <option value="date">По дате добавления</option>
                  </select>
                </div>
                {/* Sort direction toggle */}
                <button
                  onClick={() => setSortAsc((a) => !a)}
                  className="h-7 w-7 shrink-0 rounded-md text-foreground/80 hover:text-foreground"
                  title={sortAsc ? "По возрастанию" : "По убыванию"}
                  aria-label="Направление сортировки"
                >
                  {sortAsc ? "↑" : "↓"}
                </button>
                <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] text-muted-foreground">
                  {tracks.length} треков
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setPlaylistCollapsed(true)}
                  className="h-7 w-7 text-foreground/80 hover:text-foreground"
                  aria-label="Скрыть плейлист"
                  title="Скрыть плейлист"
                >
                  <PanelLeft className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            {/* Search bar — two modes: filter the local library, or search
                MP3mn online and add streaming tracks to the playlist. */}
            <div className="border-b border-border p-3">
              <div className="mb-2 flex gap-1 rounded-lg bg-secondary p-0.5">
                <button
                  onClick={() => {
                    setSearchMode("library")
                  }}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                    searchMode === "library"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Моя библиотека
                </button>
                <button
                  onClick={() => setSearchMode("online")}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                    searchMode === "online"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Онлайн (MP3mn)
                </button>
                <button
                  onClick={() => setSearchMode("video")}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors",
                    searchMode === "video"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  Видео
                </button>
              </div>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && searchMode === "online") {
                        e.preventDefault()
                        void runOnlineSearch()
                      } else if (e.key === "Enter" && searchMode === "video") {
                        e.preventDefault()
                        void runVideoSearch()
                      }
                    }}
                    placeholder={
                      searchMode === "library"
                        ? "Фильтр по названию…"
                        : searchMode === "video"
                          ? "Введите название клипа и Enter…"
                          : "Введите песню/исполнителя и Enter…"
                    }
                    className="w-full rounded-md border border-border bg-background py-1.5 pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:border-violet-400 dark:focus:border-emerald-400 focus:outline-none"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => {
                        setSearchQuery("")
                        setSearchResults([])
                      }}
                      className="absolute right-1.5 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full bg-muted-foreground/30 text-foreground transition hover:bg-muted-foreground/60"
                      aria-label="Очистить поиск"
                      title="Очистить"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  )}
                </div>
                {searchMode !== "library" && (
                  <button
                    onClick={() => void (searchMode === "video" ? runVideoSearch() : runOnlineSearch())}
                    disabled={isSearching || !searchQuery.trim()}
                    className="shrink-0 rounded-md bg-violet-500 dark:bg-emerald-500 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-violet-600 dark:hover:bg-emerald-600 disabled:opacity-40"
                  >
                    {isSearching ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Найти"
                    )}
                  </button>
                )}
              </div>
            </div>
            <div className="custom-scroll flex-1 overflow-y-auto overflow-x-hidden" style={{maxHeight: "calc(100vh - 360px)"}}>
              {searchMode !== "library" ? (
                <ul className="divide-y divide-border">
                  {searchResults.map((track) => {
                    const isInPlaylist = trackExists(track, tracks)
                    // Check if this track is the currently playing preview track
                    const isCurrentTrack = previewTrack?.url === track.url
                    return (
                    <li
                      key={track.id}
                      className={cn(
                        "group flex w-full min-w-0 flex-col text-left transition-colors hover:bg-secondary",
                        isCurrentTrack && "bg-violet-500/10 dark:bg-emerald-500/10"
                      )}
                    >
                      <div className="flex w-full min-w-0 items-center gap-3 px-3 py-2.5">
                      {/* Click cover → play/pause preview (no playlist add) */}
                      <button
                        onClick={() => addAndPlayTrack(track)}
                        className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg"
                        style={{
                          backgroundImage: `linear-gradient(135deg, ${track.cover.from}, ${track.cover.to})`,
                        }}
                        aria-label={isCurrentTrack && isPreviewPlaying ? "Пауза" : "Слушать"}
                        title={isCurrentTrack && isPreviewPlaying ? "Пауза" : "Воспроизвести"}
                      >
                        {track.coverImage ? (
                          <img
                            src={track.coverImage}
                            alt=""
                            className="absolute inset-0 h-full w-full object-cover"
                            draggable={false}
                          />
                        ) : null}
                        <span className={cn(
                          "absolute inset-0 bg-black/30 transition group-hover:bg-black/10",
                          isCurrentTrack && "bg-black/40"
                        )} />
                        {isCurrentTrack && isPlaying ? (
                          <Pause className="relative h-4 w-4 text-white drop-shadow" />
                        ) : (
                          <Play className="relative ml-0.5 h-4 w-4 text-white drop-shadow" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className={cn(
                          "truncate text-sm font-medium",
                          isCurrentTrack ? "text-violet-500 dark:text-emerald-500" : "text-foreground"
                        )}>
                          {track.title}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {track.artist}
                        </p>
                      </div>
                      {isCurrentTrack && (
                        <span className="shrink-0 rounded-full bg-violet-500/10 dark:bg-emerald-500/10 px-2 py-0.5 text-[10px] text-violet-500 dark:text-emerald-500">
                          {formatTime(progress)} / {formatTime(duration)}
                        </span>
                      )}
                      {/* Add button — text label so users understand */}
                      <button
                        onClick={() => {
                          setTracks((prev) => {
                            if (trackExists(track, prev)) return prev
                            const next = [...prev, track]
                            persistLibrary(next)
                            return next
                          })
                        }}
                        disabled={isInPlaylist}
                        className={cn(
                          "shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition",
                          isInPlaylist
                            ? "bg-violet-500/10 dark:bg-emerald-500/10 text-violet-500 dark:text-emerald-500"
                            : "bg-secondary text-muted-foreground hover:bg-violet-500/10 dark:hover:bg-emerald-500/10 hover:text-violet-500 dark:hover:text-emerald-400"
                        )}
                      >
                        {isInPlaylist ? "✓ В плейлисте" : "+ Добавить"}
                      </button>
                      </div>
                    </li>
                    )
                  })}
                  {searchResults.length === 0 && !isSearching && (
                    <li className="px-4 py-10 text-center text-xs text-muted-foreground">
                      {searchQuery.trim()
                        ? "Ничего не найдено. Попробуйте другое слово."
                        : "Введите запрос и нажмите «Найти»"}
                    </li>
                  )}
                  {searchResults.length > 0 && (
                    <li className="border-t border-border p-3">
                      <button
                        onClick={addAllSearchResults}
                        className="w-full rounded-md bg-violet-500 dark:bg-emerald-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-violet-600 dark:hover:bg-emerald-600"
                      >
                        Добавить все ({searchResults.length})
                      </button>
                    </li>
                  )}
                </ul>
              ) : (
                <ul className="divide-y divide-border">
                {sortedTracks.map((track) => {
                  const realIdx = tracks.findIndex((t) => t.id === track.id)
                  const active = realIdx === currentIndex
                  return (
                    <li key={track.id} className="min-w-0 overflow-hidden">
                      <button
                        onClick={() => playIndex(realIdx)}
                        className={cn(
                          "group flex w-full min-w-0 items-center gap-3 px-3 py-2.5 text-left transition-colors",
                          active ? "bg-violet-500/10 dark:bg-emerald-500/10" : "hover:bg-secondary"
                        )}
                      >
                        <div
                          className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg"
                          style={{
                            backgroundImage: `linear-gradient(135deg, ${track.cover.from}, ${track.cover.to})`,
                          }}
                        >
                          {track.coverImage ? (
                            <img
                              src={track.coverImage}
                              alt=""
                              className="absolute inset-0 h-full w-full object-cover"
                              draggable={false}
                            />
                          ) : null}
                          {active && isPlaying ? (
                            <EqualizerIcon />
                          ) : active ? (
                            <Pause className="relative h-4 w-4 text-white" />
                          ) : (
                            !track.coverImage && (
                              track.isVideo ? (
                                <Film className="relative h-4 w-4 text-white/90" />
                              ) : (
                                <Music2 className="relative h-4 w-4 text-white/80" />
                              )
                            )
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              "truncate text-sm font-medium",
                              active ? "text-violet-500 dark:text-emerald-500" : "text-foreground"
                            )}
                            title={track.title}
                          >
                            {track.title}
                          </p>
                          <p
                            className="truncate text-xs text-muted-foreground"
                            title={track.artist}
                          >
                            {track.artist}
                          </p>
                        </div>
                        <span
                          className="shrink-0 cursor-pointer rounded-md p-1 text-muted-foreground transition hover:bg-secondary hover:text-rose-400"
                          role="button"
                          tabIndex={0}
                          onClick={(e) => {
                            e.stopPropagation()
                            removeTrack(track.id)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault()
                              e.stopPropagation()
                              removeTrack(track.id)
                            }
                          }}
                          aria-label="Удалить трек"
                          title="Удалить трек"
                        >
                          <Trash2 className="h-4 w-4" />
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {formatTime(track.duration)}
                        </span>
                      </button>
                    </li>
                  )
                })}
                {tracks.length === 0 && searchResults.length === 0 && (
                  <li className="flex flex-col items-center gap-3 px-4 py-12 text-center">
                    <div className="grid h-12 w-12 place-items-center rounded-full bg-secondary text-muted-foreground">
                      <Music2 className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        Плейлист пуст
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Перетащите файлы или папку, либо нажмите «Файлы»/«Папку» ниже
                      </p>
                    </div>
                  </li>
                )}
              </ul>
              )}
            </div>
            <div className="border-t border-border px-4 py-3">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  className="justify-center border-border bg-secondary/50 text-foreground hover:bg-secondary"
                >
                  <Upload className="mr-1.5 h-4 w-4" />
                  Файлы
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => folderInputRef.current?.click()}
                  className="justify-center border-border bg-secondary/50 text-foreground hover:bg-secondary"
                >
                  <FolderOpen className="mr-1.5 h-4 w-4" />
                  Папку
                </Button>
              </div>
              <p className="mt-2 text-center text-[10px] leading-tight text-muted-foreground/60">
                Перетащите файлы сюда или нажмите кнопку выше
              </p>
            </div>
          </div>
        </aside>
        )}
      </main>


      {/* Volume popup */}
      <div aria-hidden className={cn("pointer-events-none fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border/50 bg-background/80 px-5 py-4 shadow-2xl backdrop-blur-md transition-opacity duration-200", volumePopup.visible ? "opacity-100" : "opacity-0")}>
        <div className="flex flex-col items-center gap-2">
          <VolumeIcon className="h-6 w-6 text-foreground" />
          <div className="flex h-24 w-2 flex-col justify-end overflow-hidden rounded-full bg-secondary"><div className="w-full rounded-full bg-violet-500 dark:bg-emerald-500 transition-[height] duration-75" style={{ height: `${Math.round(volumePopup.value * 100)}%` }} /></div>
          <span className="text-xs font-medium tabular-nums text-foreground">{Math.round(volumePopup.value * 100)}%</span>
        </div>
      </div>

      {/* Download status toast (desktop "Скачать" menu) */}
      {downloadNote && (
        <div role="status" className="fixed bottom-14 right-4 z-[60] max-w-[320px] rounded-xl border border-border/60 bg-background/95 px-3.5 py-2.5 text-xs leading-snug text-foreground shadow-2xl backdrop-blur-md">
          {downloadNote}
        </div>
      )}

      {/* Footer — app name, version, current track, and "show playlist" button */}
      <footer className="relative z-10 mt-auto border-t border-border/60 backdrop-blur-xl" style={{ backgroundColor: currentTrack ? (theme === "dark" ? `${currentTrack.cover.to}66` : `${currentTrack.cover.to}55`) : undefined }}>
        <div className="relative z-10 mx-auto flex w-full max-w-[1600px] items-center justify-between px-4 py-2.5 text-xs text-foreground/80 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2 truncate">
            <Disc3 className="h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-emerald-400" />
            <span className="shrink-0 font-semibold text-foreground">7-Sonata</span>
            <span className="shrink-0 text-foreground/50">v1.7.4</span>
            {msDiag.mode === "err" && (
              <span className="shrink-0 text-amber-500 dark:text-amber-400" title={`MediaSession: ${msDiag.err}`}>
                MS:ERR ({msDiag.err})
              </span>
            )}
            <span className="truncate">
              {currentTrack
                ? `· ${currentTrack.title} — ${currentTrack.artist}`
                : ""}
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <span className="hidden sm:inline font-medium text-foreground">
              Перемешивание {shuffle ? "вкл" : "выкл"} ·{" "}
              {repeatLabel.toLowerCase()}
            </span>
            {canDownload && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-[11px] text-foreground/80 hover:text-foreground"
                    aria-label="Скачать приложение"
                    title="Скачать приложение"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Скачать</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">
                    Скачать 7-Sonata
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {([
                    { kind: "apk", file: "sonata-mobile.apk", title: "Android — APK", Icon: Smartphone },
                    { kind: "appimage", file: "sonata-desktop.AppImage", title: "Linux — AppImage", Icon: Monitor },
                    { kind: "zip", file: "sonata-desktop.zip", title: "Исходники десктопа — ZIP", Icon: FileArchive },
                    { kind: "source", file: "sonata-source.zip", title: "Полный исходный код — ZIP", Icon: FolderArchive },
                  ] as const).map(({ kind, file, title, Icon }) => (
                    <DropdownMenuItem
                      key={kind}
                      onSelect={desktopSave ? () => void handleSaveArtifact(kind) : undefined}
                      asChild={!desktopSave}
                    >
                      {desktopSave ? (
                        <span className="flex w-full cursor-pointer items-center gap-2">
                          <Icon className="h-4 w-4 text-violet-500 dark:text-emerald-500" />
                          <span className="flex flex-col">
                            <span className="text-sm font-medium">{title}</span>
                            <span className="text-[11px] text-muted-foreground">{file}</span>
                          </span>
                        </span>
                      ) : (
                        <a href={`/api/download?file=${file}`} download={file} className="flex cursor-pointer items-center gap-2">
                          <Icon className="h-4 w-4 text-violet-500 dark:text-emerald-500" />
                          <span className="flex flex-col">
                            <span className="text-sm font-medium">{title}</span>
                            <span className="text-[11px] text-muted-foreground">{file}</span>
                          </span>
                        </a>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="h-7 w-7 text-foreground/80 hover:text-foreground"
              aria-label={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
              title={theme === "dark" ? "Светлая тема" : "Тёмная тема"}
            >
              {theme === "dark" ? (
                <Sun className="h-3.5 w-3.5" />
              ) : (
                <Moon className="h-3.5 w-3.5" />
              )}
            </Button>
            {playlistCollapsed && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPlaylistCollapsed(false)}
                className="h-7 gap-1.5 px-2 text-[11px] text-foreground/80 hover:text-foreground"
                aria-label="Показать плейлист"
                title="Показать плейлист"
              >
                <PanelLeftOpen className="h-3.5 w-3.5" />
                Плейлист
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  )
}

// Remote (cross-origin) media — e.g. mp3mn streams — must NOT be routed
// through the Web Audio graph: those servers send no CORS headers, so the
// graph outputs silence (and the element can never be "uncaptured" again).
// Local files are blob:/data: URLs — same-origin, safe for the graph.
function isRemoteMediaUrl(url?: string | null): boolean {
  if (!url) return false
  if (url.startsWith("blob:") || url.startsWith("data:")) return false
  try {
    return new URL(url, window.location.href).origin !== window.location.origin
  } catch {
    return true
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function EqualizerIcon() {
  return (
    <div className="flex h-4 items-end gap-[2px]" aria-hidden>
      <span className="w-[2px] animate-eq1 rounded-full bg-white" style={{ height: "60%" }} />
      <span className="w-[2px] animate-eq2 rounded-full bg-white" style={{ height: "90%" }} />
      <span className="w-[2px] animate-eq3 rounded-full bg-white" style={{ height: "40%" }} />
      <span className="w-[2px] animate-eq2 rounded-full bg-white" style={{ height: "75%" }} />
    </div>
  )
}
