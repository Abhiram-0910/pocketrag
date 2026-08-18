import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { getAllChunks, getAllDocuments, saveDocument, type ChunkRecord, type DocumentRecord } from './db'

// Isolated file so exact-count assertions hold: `fake-indexeddb/auto` gives each test
// *file* its own fresh IndexedDB, whereas db.test.ts accumulates docs across its tests in
// one shared DB (db.ts's connection is a module-level singleton, so there's no per-test
// reset). db.ts creates the connection lazily on first call, so the empty-DB test must run
// before any save — vitest runs a file's tests in source order, so it's defined first.

function makeChunk(documentId: string, index: number, overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    id: `${documentId}:${index}`,
    documentId,
    index,
    text: `chunk ${index}`,
    tokenCount: 5,
    page: 1,
    embedding: [0.1, 0.2, 0.3],
    hasImage: false,
    ...overrides,
  }
}

describe('getAllDocuments / getAllChunks (isolated, exact counts)', () => {
  it('returns [] from an empty database', async () => {
    expect(await getAllDocuments()).toEqual([])
    expect(await getAllChunks()).toEqual([])
  })

  it('returns exactly the saved documents and all their chunks, intact', async () => {
    const bio: DocumentRecord = { id: 'bio', fileName: 'biology.pdf', uploadedAt: 1, chunkCount: 2, source: 'document' }
    const cook: DocumentRecord = { id: 'cook', fileName: 'cooking.pdf', uploadedAt: 2, chunkCount: 1, source: 'document' }
    await saveDocument(bio, [
      makeChunk('bio', 0, { page: 1, embedding: [0.9, 0.1, 0] }),
      makeChunk('bio', 1, { page: 2, embedding: [0.2, 0.8, 0] }),
    ])
    await saveDocument(cook, [makeChunk('cook', 0, { page: 3, embedding: [0, 0, 1] })])

    const docs = await getAllDocuments()
    expect(docs).toHaveLength(2)
    expect(docs.map((d) => d.id).sort()).toEqual(['bio', 'cook'])
    // DocumentRecords round-trip exactly through IndexedDB.
    expect(docs.find((d) => d.id === 'bio')).toEqual(bio)
    expect(docs.find((d) => d.id === 'cook')).toEqual(cook)

    const chunks = await getAllChunks()
    expect(chunks).toHaveLength(3)
    // Embeddings and pages survive the round-trip.
    const bioPage2 = chunks.find((c) => c.id === 'bio:1')
    expect(bioPage2?.page).toBe(2)
    expect(bioPage2?.embedding).toEqual([0.2, 0.8, 0])
    const cookChunk = chunks.find((c) => c.id === 'cook:0')
    expect(cookChunk?.page).toBe(3)
    expect(cookChunk?.embedding).toEqual([0, 0, 1])
  })
})
