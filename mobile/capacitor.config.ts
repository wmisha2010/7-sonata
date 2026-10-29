import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "com.zai.sonata",
  appName: "7-Sonata",
  webDir: "dist",
  android: {
    backgroundColor: "#09090b",
    allowMixedContent: true,
  },
  plugins: {
    // CRITICAL: without "always" the @jofr/capacitor-media-session plugin
    // never promotes MediaSessionService to a foreground service — result:
    // NO notification shade card, playback dies on backgrounding, and no
    // wired/Bluetooth headset control. Must stay in sync with the
    // capacitor.config.json that `cap sync` writes into android assets.
    MediaSession: {
      foregroundService: "always",
    },
  },
}

export default config
