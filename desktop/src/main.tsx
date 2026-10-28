import React from "react"
import { createRoot } from "react-dom/client"
import "./globals.css"
import { MusicPlayer } from "@/components/music-player/music-player"

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MusicPlayer />
  </React.StrictMode>
)
