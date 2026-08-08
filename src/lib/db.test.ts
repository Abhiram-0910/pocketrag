import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import {
  deleteDocument,
  getAllChunks,
  getAllDocuments,
  getChunksForDocument,
  saveDocument,
  type ChunkRecord,
  type DocumentRecord,
} from './db'
import { rankChunks } from './retrieval'

function makeChunk(documentId: string, index: number, overrides: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    id: `${documentId}:${index}`,
    documentId,
    index,
    text: `chunk ${index}`,
    tokenCount: 5,
    page: 1,
    embedding: [0.1, 0.2, 0.3],
    ...overrides,
  }
}

describe('db', () => {
  it('saves and retrieves chunks for a document', async () => {
    const documentId = 'doc-a'
    const document: DocumentRecord = { id: documentId, fileName: 'a.pdf', uploadedAt: Date.now(), chunkCount: 2 }
    const chunks = [makeChunk(documentId, 0), makeChunk(documentId, 1)]

    await saveDocument(document, chunks)
    const retrieved = await getChunksForDocument(documentId)

    expect(retrieved).toHaveLength(2)
    expect(retrieved.map((c) => c.text).sort()).toEqual(['chunk 0', 'chunk 1'])
  })

  it('scopes retrieval to the requested document only', async () => {
    const docA = 'doc-b'
    const docB = 'doc-c'
    await saveDocument({ id: docA, fileName: 'b.pdf', uploadedAt: Date.now(), chunkCount: 1 }, [makeChunk(docA, 0)])
    await saveDocument({ id: docB, fileName: 'c.pdf', uploadedAt: Date.now(), chunkCount: 1 }, [makeChunk(docB, 0)])

    const chunksA = await getChunksForDocument(docA)
    const chunksB = await getChunksForDocument(docB)

    expect(chunksA).toHaveLength(1)
    expect(chunksB).toHaveLength(1)
    expect(chunksA[0].documentId).toBe(docA)
    expect(chunksB[0].documentId).toBe(docB)
  })

  it('preserves embedding vectors and page numbers exactly', async () => {
    const documentId = 'doc-d'
    const chunk = makeChunk(documentId, 0, { page: 3, embedding: [0.987654321, -0.123456789, 0] })
    await saveDocument({ id: documentId, fileName: 'd.pdf', uploadedAt: Date.now(), chunkCount: 1 }, [chunk])

    const [retrieved] = await getChunksForDocument(documentId)
    expect(retrieved.page).toBe(3)
    expect(retrieved.embedding).toEqual([0.987654321, -0.123456789, 0])
  })

  it('returns an empty array for a document with no stored chunks', async () => {
    const result = await getChunksForDocument('never-saved')
    expect(result).toEqual([])
  })

  it('pools chunks across every document for the "all documents" scope', async () => {
    const bio = 'pool-bio'
    const cook = 'pool-cook'
    await saveDocument({ id: bio, fileName: 'biology.pdf', uploadedAt: Date.now(), chunkCount: 2 }, [
      makeChunk(bio, 0),
      makeChunk(bio, 1),
    ])
    await saveDocument({ id: cook, fileName: 'cooking.pdf', uploadedAt: Date.now(), chunkCount: 1 }, [
      makeChunk(cook, 0),
    ])

    // getAllChunks() also holds earlier tests' docs in this shared DB, so assert exact
    // per-document counts rather than a global total — a duplicate or leaked chunk for
    // either doc would fail this, where a `toContain` on the documentId set would not.
    const all = await getAllChunks()
    expect(all.filter((c) => c.documentId === bio)).toHaveLength(2)
    expect(all.filter((c) => c.documentId === cook)).toHaveLength(1)
  })

  it('document-scoped retrieval never leaks another document\'s chunk, even a closer one', async () => {
    const query = [1, 0, 0]
    const bio = 'leak-bio'
    const cook = 'leak-cook'
    // cook's chunk is the globally closest to the query; bio's best match is farther.
    await saveDocument({ id: bio, fileName: 'biology.pdf', uploadedAt: Date.now(), chunkCount: 1 }, [
      makeChunk(bio, 0, { embedding: [0.6, 0.8, 0] }),
    ])
    await saveDocument({ id: cook, fileName: 'cooking.pdf', uploadedAt: Date.now(), chunkCount: 1 }, [
      makeChunk(cook, 0, { embedding: [1, 0, 0] }),
    ])

    // "all documents" scope: the globally closest chunk (cook) wins.
    const allRanked = rankChunks(query, await getAllChunks())
    expect(allRanked[0].chunk.documentId).toBe(cook)

    // "this document" scope on bio: cook's closer chunk must not appear at all.
    const bioRanked = rankChunks(query, await getChunksForDocument(bio))
    expect(bioRanked.every((r) => r.chunk.documentId === bio)).toBe(true)
  })

  it('deleteDocument removes the document record and only its own chunks', async () => {
    const keep = 'delete-keep'
    const gone = 'delete-gone'
    await saveDocument({ id: keep, fileName: 'keep.pdf', uploadedAt: Date.now(), chunkCount: 1 }, [
      makeChunk(keep, 0),
    ])
    await saveDocument({ id: gone, fileName: 'gone.pdf', uploadedAt: Date.now(), chunkCount: 2 }, [
      makeChunk(gone, 0),
      makeChunk(gone, 1),
    ])

    await deleteDocument(gone)

    const allDocs = await getAllDocuments()
    expect(allDocs.some((d) => d.id === gone)).toBe(false)
    expect(allDocs.some((d) => d.id === keep)).toBe(true)

    expect(await getChunksForDocument(gone)).toEqual([])
    const keptChunks = await getChunksForDocument(keep)
    expect(keptChunks).toHaveLength(1)
    expect(keptChunks[0].documentId).toBe(keep)
  })
})
