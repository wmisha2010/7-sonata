import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Keep the standalone bundle lean: file tracing pulls in project folders
  // that some API routes touch at runtime (download/, desktop/, etc.). The
  // embedded desktop server must not carry them — they added ~140 MB and
  // recursive copies to the packaged exe.
  outputFileTracingExcludes: {
    "*": [
      "./desktop/**",
      "./download/**",
      "./android-sdk/**",
      "./scripts/**",
      "./src/**",
      "./prisma/**",
    ],
  },
};

export default nextConfig;
