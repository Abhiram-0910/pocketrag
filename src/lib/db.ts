import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface DocumentRecord {
  id: string
  fileName: string
  uploadedAt: number
  chunkCount: number
  // Milestone 9: 'document' (local-only PDF pipeline) or 'note' (OCR'd via the Notes
  // tab's explicit per-file consent flow). IndexedDB is schemaless, so a record saved
  // before this field existed simply won't have it — App.tsx's restore path defaults
  // a missing value to 'document', never assume it's present.
  source: 'document' | 'note'
}

export interface ChunkRecord {
  id: string
  documentId: string
  index: number
  text: string
  tokenCount: number
  page: number
  embedding: number[]
  // Whether this chunk's page paints a raster image (Milestone 10's structural
  // diagram-likely signal — see diagramHeuristic.ts). IndexedDB stores are
  // schemaless, so a chunk saved before this field existed simply won't have it —
  // callers must treat a missing value as `false`, never assume it's present.
  hasImage: boolean
}

interface PocketRagDB extends DBSchema {
  documents: { key: string; value: DocumentRecord }
  chunks: { key: string; value: ChunkRecord; indexes: { documentId: string } }
}

const DB_NAME = 'pocketrag'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<PocketRagDB>> | null = null

function getDB(): Promise<IDBPDatabase<PocketRagDB>> {
  dbPromise ??= openDB<PocketRagDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore('documents', { keyPath: 'id' })
      db.createObjectStore('chunks', { keyPath: 'id' }).createIndex('documentId', 'documentId')
    },
  }).catch((err: unknown) => {
    // Don't cache a failed open (e.g. a VersionError, or storage blocked): the next call
    // retries instead of every DB call failing for the rest of the session.
    dbPromise = null
    throw err
  })
  return dbPromise
}

let persistRequested = false

/**
 * Ask the browser to exempt this origin from storage eviction — once per session, on the
 * first successful save (of a document here, or of a chat turn in historyDb.ts). Best-effort: guarded and fire-and-forget so it never throws or
 * blocks a save (and stays inert in the Node test env, where navigator.storage is absent).
 * See ARCHITECTURE.md for why (Safari's 7-day proactive eviction, not raw quota).
 */
export function requestPersistOnce(): void {
  if (persistRequested) return
  persistRequested = true
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
    void navigator.storage.persist().catch(() => {})
  }
}

export async function saveDocument(document: DocumentRecord, chunks: ChunkRecord[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['documents', 'chunks'], 'readwrite')
  await Promise.all([
    tx.objectStore('documents').put(document),
    ...chunks.map((chunk) => tx.objectStore('chunks').put(chunk)),
  ])
  await tx.done
  requestPersistOnce()
}

export function getChunksForDocument(documentId: string): Promise<ChunkRecord[]> {
  return getDB().then((db) => db.getAllFromIndex('chunks', 'documentId', documentId))
}

/** All chunks across every stored document — the pool for "all documents" retrieval scope. */
export function getAllChunks(): Promise<ChunkRecord[]> {
  return getDB().then((db) => db.getAll('chunks'))
}

/** All stored document records — used to restore the document list on reload. */
export function getAllDocuments(): Promise<DocumentRecord[]> {
  return getDB().then((db) => db.getAll('documents'))
}

/** Deletes a document and every one of its chunks in a single atomic transaction. */
export async function deleteDocument(documentId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['documents', 'chunks'], 'readwrite')
  const chunkKeys = await tx.objectStore('chunks').index('documentId').getAllKeys(documentId)
  await Promise.all([
    tx.objectStore('documents').delete(documentId),
    ...chunkKeys.map((key) => tx.objectStore('chunks').delete(key)),
  ])
  await tx.done
}
