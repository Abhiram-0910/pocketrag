import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

export interface DocumentRecord {
  id: string
  fileName: string
  uploadedAt: number
  chunkCount: number
}

export interface ChunkRecord {
  id: string
  documentId: string
  index: number
  text: string
  tokenCount: number
  page: number
  embedding: number[]
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
  })
  return dbPromise
}

export async function saveDocument(document: DocumentRecord, chunks: ChunkRecord[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['documents', 'chunks'], 'readwrite')
  await Promise.all([
    tx.objectStore('documents').put(document),
    ...chunks.map((chunk) => tx.objectStore('chunks').put(chunk)),
  ])
  await tx.done
}

export function getChunksForDocument(documentId: string): Promise<ChunkRecord[]> {
  return getDB().then((db) => db.getAllFromIndex('chunks', 'documentId', documentId))
}
