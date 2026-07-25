import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { getChunksForDocument, saveDocument, type ChunkRecord, type DocumentRecord } from './db'

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
})
