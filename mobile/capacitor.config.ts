import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "com.zai.sonata",
  appName: "7-Sonata",
  webDir: "dist",
  android: {
    backgroundColor: "#09090b",
    allowMixedContent: true,
  },
}

export default config
