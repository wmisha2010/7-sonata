// Persistent storage for uploaded tracks using IndexedDB.
// Stores the actual audio file bytes + cover art so the library survives reloads.
// Works in both the browser (Next.js) and Electron's renderer (Chromium).

import type { Track } from "./tracks"

const DB_NAME = "sonata-db"
const DB_VERSION = 1
const STORE_FILES = "audioFiles" // key: track.id -> Blob (audio)
const STORE_META = "library" // key: "tracks" -> Track[] (metadata only, no file bytes)

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES)
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const s = t.objectStore(store)
        const req = fn(s)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
  )
}

export interface StoredTrack extends Track {
  hasAudioBlob: boolean // true if audio bytes are persisted in STORE_FILES
}

// Load the saved library (metadata only). Returns [] if nothing stored yet.
export async function loadLibrary(): Promise<StoredTrack[]> {
  try {
    const data = await tx<unknown>(STORE_META, "readonly", (s) => s.get("tracks"))
    if (!data) return []
    return data as StoredTrack[]
  } catch {
    return []
  }
}

// Save the whole library metadata list.
export async function saveLibrary(tracks: StoredTrack[]): Promise<void> {
  try {
    await tx(STORE_META, "readwrite", (s) => s.put(tracks, "tracks"))
  } catch {
    // ignore — non-fatal
  }
}

// Persist an audio file's bytes, keyed by track id.
export async function putAudioBytes(id: string, blob: Blob): Promise<void> {
  try {
    await tx(STORE_FILES, "readwrite", (s) => s.put(blob, id))
  } catch {
    // ignore
  }
}

// Read a stored audio blob back as an object URL.
export async function getAudioUrl(id: string): Promise<string | null> {
  try {
    const blob = await tx<Blob | undefined>(STORE_FILES, "readonly", (s) =>
      s.get(id)
    )
    if (!blob) return null
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

export async function deleteAudio(id: string): Promise<void> {
  try {
    await tx(STORE_FILES, "readwrite", (s) => s.delete(id))
  } catch {
    // ignore
  }
}

// Drop everything (used by a "reset library" action if ever needed).
export async function clearLibrary(): Promise<void> {
  try {
    await tx(STORE_FILES, "readwrite", (s) => s.clear())
    await tx(STORE_META, "readwrite", (s) => s.clear())
  } catch {
    // ignore
  }
}
