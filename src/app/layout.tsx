import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

// NOTE: next/font/google (Geist) was removed — the build environment has no
// reliable access to Google Fonts. The CSS variables below are defined in
// globals.css via a system font stack, so the visual style is preserved.

export const metadata: Metadata = {
  title: "7-Sonata — Музыкальный плеер",
  description: "Музыкальный плеер: поиск и стриминг музыки, видеотреки, визуализатор и плейлист.",
  keywords: ["music player", "плеер", "музыка", "music", "Next.js"],
  authors: [{ name: "wmisha2010" }],
  icons: {
    icon: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className="dark" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
