import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAllDocuments, getChunksForDocument, saveDocument, type ChunkRecord, type DocumentRecord } from './db'
import { EMBEDDING_MODEL_KEY } from './searchModels'
import { useDocumentStore } from '../store/documentStore'
import type { EmbedTextsHandlers } from './embeddingClient'

const embedTexts = vi.fn<(texts: string[], handlers: EmbedTextsHandlers) => void>()
vi.mock('./embeddingClient', () => ({ embedTexts: (texts: string[], handlers: EmbedTextsHandlers) => embedTexts(texts, handlers) }))
const { isCurrentModel, reindexDocument, reindexOutdated } = await import('./reindex')

function staleDoc(id: string): DocumentRecord {
  return { id, fileName: `${id}.pdf`, uploadedAt: 1, chunkCount: 2, source: 'document' }
}
function chunk(documentId: string, index: number): ChunkRecord {
  return { id: `${documentId}:${index}`, documentId, index, text: `passage ${index}`, tokenCount: 2, page: 1, embedding: [0, 0], hasImage: false }
}
async function storeStale(id: string) {
  const doc = staleDoc(id)
  await saveDocument(doc, [chunk(id, 0), chunk(id, 1)])
  useDocumentStore.getState().restoreDocuments([
    { id, fileName: doc.fileName, status: 'reindexing', error: null, embedProgress: null, chunkCount: 2, source: 'document' },
  ])
  return doc
}
const succeed = (texts: string[], h: EmbedTextsHandlers) => {
  h.onEmbedProgress({ type: 'embed-progress', done: texts.length, total: texts.length })
  h.onResult({ type: 'texts-result', embeddings: texts.map((_, i) => [1, i]) })
}
const entry = (id: string) => useDocumentStore.getState().documents.find((d) => d.id === id)

beforeEach(() => {
  embedTexts.mockReset()
})

describe('reindex', () => {
  it('re-embeds an outdated document from its stored text, stamps the model, and marks it ready', async () => {
    const doc = await storeStale('a')
    embedTexts.mockImplementation(succeed)
    await reindexDocument(doc)

    expect(embedTexts.mock.calls[0][0]).toEqual(['passage 0', 'passage 1'])
    expect((await getAllDocuments()).find((d) => d.id === 'a')?.embeddingModel).toBe(EMBEDDING_MODEL_KEY)
    expect((await getChunksForDocument('a')).map((c) => c.embedding)).toEqual([[1, 0], [1, 1]])
    expect(entry('a')?.status).toBe('ready')
  })

  it("doesn't write a document back that was deleted while it re-embedded", async () => {
    const doc = await storeStale('b')
    embedTexts.mockImplementation((texts, h) => {
      useDocumentStore.getState().removeDocument('b')
      succeed(texts, h)
    })
    await reindexDocument(doc)
    expect((await getAllDocuments()).find((d) => d.id === 'b')?.embeddingModel).toBeUndefined()
    expect((await getChunksForDocument('b'))[0].embedding).toEqual([0, 0])
  })

  it('leaves a Try again on a failed model download, which finishes the job', async () => {
    const doc = await storeStale('c')
    embedTexts.mockImplementationOnce((_, h) => h.onError({ type: 'error', message: 'offline', modelDownload: true }))
    await reindexDocument(doc)
    expect(entry('c')?.status).toBe('error')
    expect(entry('c')?.retry).toBeTypeOf('function')

    embedTexts.mockImplementation(succeed)
    entry('c')?.retry?.()
    await vi.waitFor(() => expect(entry('c')?.status).toBe('ready'))
  })

  it('skips documents already on the current model', async () => {
    const current = { ...staleDoc('d'), embeddingModel: EMBEDDING_MODEL_KEY }
    expect(isCurrentModel(current)).toBe(true)
    expect(isCurrentModel(staleDoc('d'))).toBe(false)
    await reindexOutdated([current])
    expect(embedTexts).not.toHaveBeenCalled()
  })
})
