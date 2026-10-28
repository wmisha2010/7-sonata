import React from "react"
import { createRoot } from "react-dom/client"
import "./globals.css"
import { MusicPlayer } from "@/components/music-player/music-player"

// Note: NO React.StrictMode here. StrictMode double-invokes effects in dev
// which breaks the @jofr/capacitor-media-session plugin callbacks.
createRoot(document.getElementById("root")!).render(<MusicPlayer />)
