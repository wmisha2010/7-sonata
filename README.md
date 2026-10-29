# 7-Sonata — музыкальный веб-плеер

Кроссплатформенный музыкальный плеер: поиск и стриминг музыки, видеотреки, живой аудиовизуализатор, умные обложки и адаптивные темы.

## Возможности

- **Поиск музыки (mp3mn.net)** — агрегация результатов по словам запроса, без жёсткого лимита в 20 результатов (до 200), дедупликация и ранжирование по релевантности.
- **Видеотреки (Rutube)** — поиск видео, нативное воспроизведение HLS через собственный прокси `/api/video-stream` (hls.js + same-origin MSE), с автоматическим fallback на iframe-embed при фатальных ошибках.
- **Работающий визуализатор** — Web Audio AnalyserNode получает реальный спектр как для музыки, так и для видео (благодаря проксированию медиа на same-origin).
- **Обогащение обложек** — автоподбор обложек альбомов через iTunes Search API (6 параллельных воркеров), извлечение доминирующих цветов обложки для динамического акцента интерфейса.
- **Адаптивные темы** — фиолетовый акцент на светлой теме, зелёный на тёмной; динамическая палитра от обложки трека.
- **Media Session API** — управление с наушников / системного плеера, метаданные трека, обложка в системном UI.
- **Плейлист** — сортировка, next/prev по видимому порядку списка, автопереход по окончании трека.

## Стек

| Слой | Технологии |
|------|-----------|
| Веб | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4, shadcn/ui |
| Аудио/видео | hls.js 1.7, Web Audio API, Media Session API |
| БД | Prisma + SQLite (настраивается через `.env`) |
| Десктоп | Electron + Vite (`desktop/`) |
| Мобильные | Capacitor 8 + Android (`mobile/`) |

## Структура репозитория

```
├── src/                    # Веб-приложение (Next.js 16)
│   ├── app/api/            # API-роуты
│   │   ├── mp3mn-search/   #   поиск музыки (mp3mn.net, агрегация по словам)
│   │   ├── video-search/   #   поиск видео (Rutube)
│   │   ├── video-stream/   #   HLS-прокси Rutube (манифесты + сегменты, Range)
│   │   ├── audio-proxy/    #   same-origin прокси аудио (для Web Audio)
│   │   ├── image-proxy/    #   прокси обложек
│   │   └── download/       #   скачивание трека
│   ├── components/music-player/  # главный компонент плеера
│   └── lib/                # mp3mn.ts, rutube.ts, metadata, storage, color-extract...
├── desktop/                # Electron-обёртка (Vite, автономная сборка)
├── mobile/                 # Capacitor 8 + Android-проект
├── prisma/                 # схема БД
└── public/                 # обложки, логотип
```

## Запуск веб-версии

```bash
bun install            # или npm install / pnpm install
cp .env.example .env   # DATABASE_URL="file:./db/custom.db"
bunx prisma db push    # создать/обновить схему БД
bun run dev            # dev-сервер на http://localhost:3000
```

Продакшен-сборка:

```bash
bun run build
bun run start
```

## Десктоп (Electron)

Подробности — в [`desktop/README-RU.md`](desktop/README-RU.md).

```bash
cd desktop && bun install && bun run dev
```

## Android (Capacitor)

Подробности — в [`mobile/README.md`](mobile/README.md).

```bash
cd mobile && bun install && npx cap sync android && npx cap open android
```

## Как это работает

**Поиск музыки.** Запрос отправляется на mp3mn.net пословно (`xx1_content`), результаты агрегируются, дедуплицируются и ранжируются; обложки подтягиваются из iTunes Search API. Медиа отдаётся клиенту через `/api/audio-proxy` — same-origin позволяет Web Audio анализировать поток.

**Видео.** Поиск через публичный API Rutube. Для воспроизведения `/api/video-stream` запрашивает play/options с подписанным balancer-URL, переписывает URI во всех манифестах (`?u=` для вложенных плейлистов, `?seg=` для сегментов с поддержкой Range) и стримит их же-origin. Клиент играет через hls.js → MSE → `<video>`, поэтому `createMediaElementSource` доступен и визуализатор показывает реальный спектр. При фатальной ошибке HLS плеер автоматически переключается на iframe-embed.
