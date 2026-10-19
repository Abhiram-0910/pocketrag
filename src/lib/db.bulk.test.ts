import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { deleteAllDocuments, getAllChunks, getAllDocuments, getChunksByIds, saveDocument, type ChunkRecord } from './db'

// Isolated file: deleteAllDocuments clears the whole (per-file) fake IndexedDB.
const chunk = (documentId: string, index: number): ChunkRecord => ({
  id: `${documentId}:${index}`,
  documentId,
  index,
  text: `${documentId} chunk ${index}`,
  tokenCount: 3,
  page: 1,
  embedding: [1],
  hasImage: false,
})

describe('getChunksByIds / deleteAllDocuments', () => {
  it('returns chunks in the requested order and skips ids no longer stored', async () => {
    await saveDocument({ id: 'a', fileName: 'a.pdf', uploadedAt: 1, chunkCount: 2, source: 'document' }, [chunk('a', 0), chunk('a', 1)])
    await saveDocument({ id: 'b', fileName: 'b.pdf', uploadedAt: 1, chunkCount: 1, source: 'note' }, [chunk('b', 0)])

    const found = await getChunksByIds(['b:0', 'gone:0', 'a:1'])
    expect(found.map((c) => c.id)).toEqual(['b:0', 'a:1'])
  })

  it('deleteAllDocuments clears every document and chunk', async () => {
    await deleteAllDocuments()
    expect(await getAllDocuments()).toEqual([])
    expect(await getAllChunks()).toEqual([])
  })
})
