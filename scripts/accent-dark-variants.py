#!/usr/bin/env python3
"""Add dark: emerald variants to violet accents in music-player.tsx.
Light theme = violet, dark theme = green (original look)."""
import sys

F = "/home/z/my-project/src/components/music-player/music-player.tsx"

# (old, new, expected_count)
PAIRS = [
    # drag-over ring
    ('isDragOver && "ring-2 ring-inset ring-violet-400"',
     'isDragOver && "ring-2 ring-inset ring-violet-400 dark:ring-emerald-400"', 1),
    # big Disc3 spinner (drag overlay)
    ('<Disc3 className="h-12 w-12 animate-spin-slow text-violet-500" />',
     '<Disc3 className="h-12 w-12 animate-spin-slow text-violet-500 dark:text-emerald-400" />', 1),
    # drag overlay bg + border
    ('justify-center bg-violet-500/10 backdrop-blur-sm',
     'justify-center bg-violet-500/10 dark:bg-emerald-500/10 backdrop-blur-sm', 1),
    ('border-dashed border-violet-400 bg-background/80',
     'border-dashed border-violet-400 dark:border-emerald-400 bg-background/80', 1),
    # upload icon + text
    ('<Upload className="mx-auto mb-2 h-8 w-8 text-violet-500" />',
     '<Upload className="mx-auto mb-2 h-8 w-8 text-violet-500 dark:text-emerald-400" />', 1),
    ('<p className="text-sm font-medium text-violet-500">',
     '<p className="text-sm font-medium text-violet-500 dark:text-emerald-500">', 1),
    # resize handle
    ('hover:bg-violet-400/60 focus:bg-violet-400 focus:outline-none',
     'hover:bg-violet-400/60 dark:hover:bg-emerald-400/60 focus:bg-violet-400 dark:focus:bg-emerald-400 focus:outline-none', 1),
    ('group-hover/handle:bg-violet-300',
     'group-hover/handle:bg-violet-300 dark:group-hover/handle:bg-emerald-300', 1),
    # now-playing ping dot on cover
    ('animate-ping rounded-full bg-violet-400 opacity-75',
     'animate-ping rounded-full bg-violet-400 opacity-75 dark:bg-emerald-400', 1),
    ('relative inline-flex h-4 w-4 rounded-full bg-violet-500',
     'relative inline-flex h-4 w-4 rounded-full bg-violet-500 dark:bg-emerald-500', 1),
    # status text (Сейчас играет / Пауза)
    ('uppercase tracking-widest text-violet-500 drop-shadow',
     'uppercase tracking-widest text-violet-500 dark:text-emerald-400 drop-shadow', 1),
    # shuffle / repeat active (original dark shades: 400 + hover 300)
    ('shuffle && "text-violet-500 hover:text-violet-400"',
     'shuffle && "text-violet-500 hover:text-violet-400 dark:text-emerald-400 dark:hover:text-emerald-300"', 1),
    ('repeatMode !== "off" && "text-violet-500 hover:text-violet-400"',
     'repeatMode !== "off" && "text-violet-500 hover:text-violet-400 dark:text-emerald-400 dark:hover:text-emerald-300"', 1),
    # play button glow
    ('shadow-xl shadow-violet-500/10',
     'shadow-xl shadow-violet-500/10 dark:shadow-emerald-500/10', 1),
    # playlist header icon
    ('<ListMusic className="h-4 w-4 text-violet-500" />',
     '<ListMusic className="h-4 w-4 text-violet-500 dark:text-emerald-400" />', 1),
    # sort select + filter input focus borders
    ('px-2 text-[11px] font-medium text-foreground/80 focus:border-violet-400 focus:outline-none',
     'px-2 text-[11px] font-medium text-foreground/80 focus:border-violet-400 dark:focus:border-emerald-400 focus:outline-none', 1),
    ('text-xs text-foreground placeholder:text-muted-foreground focus:border-violet-400 focus:outline-none',
     'text-xs text-foreground placeholder:text-muted-foreground focus:border-violet-400 dark:focus:border-emerald-400 focus:outline-none', 1),
    # "Найти" button
    ('className="shrink-0 rounded-md bg-violet-500 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-violet-600 disabled:opacity-40"',
     'className="shrink-0 rounded-md bg-violet-500 dark:bg-emerald-500 px-2.5 py-1.5 text-xs font-medium text-white transition hover:bg-violet-600 dark:hover:bg-emerald-600 disabled:opacity-40"', 1),
    # current row bg
    ('isCurrentTrack && "bg-violet-500/10"',
     'isCurrentTrack && "bg-violet-500/10 dark:bg-emerald-500/10"', 1),
    # current track title
    ('isCurrentTrack ? "text-violet-500" : "text-foreground"',
     'isCurrentTrack ? "text-violet-500 dark:text-emerald-500" : "text-foreground"', 1),
    # time badge of current track
    ('<span className="shrink-0 rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-500">',
     '<span className="shrink-0 rounded-full bg-violet-500/10 dark:bg-emerald-500/10 px-2 py-0.5 text-[10px] text-violet-500 dark:text-emerald-500">', 1),
    # "В плейлисте" badge
    ('? "bg-violet-500/10 text-violet-500"',
     '? "bg-violet-500/10 dark:bg-emerald-500/10 text-violet-500 dark:text-emerald-500"', 1),
    # "+ Добавить" hover
    (': "bg-secondary text-muted-foreground hover:bg-violet-500/10 hover:text-violet-500"',
     ': "bg-secondary text-muted-foreground hover:bg-violet-500/10 dark:hover:bg-emerald-500/10 hover:text-violet-500 dark:hover:text-emerald-400"', 1),
    # "Добавить все" button
    ('className="w-full rounded-md bg-violet-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-violet-600"',
     'className="w-full rounded-md bg-violet-500 dark:bg-emerald-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-violet-600 dark:hover:bg-emerald-600"', 1),
    # context/sort menu: active bg + active text
    ('active ? "bg-violet-500/10" : "hover:bg-secondary"',
     'active ? "bg-violet-500/10 dark:bg-emerald-500/10" : "hover:bg-secondary"', 1),
    ('active ? "text-violet-500" : "text-foreground"',
     'active ? "text-violet-500 dark:text-emerald-500" : "text-foreground"', 1),
    # volume popup bar
    ('w-full rounded-full bg-violet-500 transition-[height]',
     'w-full rounded-full bg-violet-500 dark:bg-emerald-500 transition-[height]', 1),
    # footer Disc3
    ('<Disc3 className="h-3.5 w-3.5 shrink-0 text-violet-500" />',
     '<Disc3 className="h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-emerald-400" />', 1),
    # download menu icons (x2)
    ('<Icon className="h-4 w-4 text-violet-500" />',
     '<Icon className="h-4 w-4 text-violet-500 dark:text-emerald-500" />', 2),
]

# Theme-aware fallback cover gradient: dark = original green→sky, light = violet→fuchsia
FALLBACKS = [
    ('const coverRef = useRef(currentTrack?.cover ?? { from: "#8b5cf6", to: "#d946ef" })',
     'const coverRef = useRef(currentTrack?.cover ?? { from: "#10b981", to: "#0ea5e9" })', 1),
    ('coverRef.current = currentTrack?.cover ?? { from: "#8b5cf6", to: "#d946ef" }',
     'coverRef.current = currentTrack?.cover ?? (theme === "dark" ? { from: "#10b981", to: "#0ea5e9" } : { from: "#8b5cf6", to: "#d946ef" })', 1),
    # effect must re-run on theme change so the fallback follows the theme
    ('}, [currentTrack])\n\n  // ---- Retro VFD spectrum analyzer',
     '}, [currentTrack, theme])\n\n  // ---- Retro VFD spectrum analyzer', 1),
]

src = open(F, encoding="utf-8").read()
errors = []
for old, new, n in PAIRS + FALLBACKS:
    c = src.count(old)
    if c != n:
        errors.append(f"count mismatch ({c} != {n}): {old[:70]}")
        continue
    src = src.replace(old, new)

if errors:
    print("ABORT, no changes written:")
    for e in errors:
        print(" -", e)
    sys.exit(1)

open(F, "w", encoding="utf-8").write(src)

# invariant: every line with violet must also carry a dark: emerald twin
missed = [i for i, l in enumerate(src.splitlines(), 1)
          if "violet" in l and "emerald" not in l]
print("OK — all replacements applied")
print("lines with violet but no dark twin:", missed if missed else "none")
