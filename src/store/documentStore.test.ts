import { beforeEach, describe, expect, it } from 'vitest'
import { useDocumentStore, type DocEntry } from './documentStore'

function entry(id: string): DocEntry {
  return { id, fileName: `${id}.pdf`, status: 'ready', error: null, embedProgress: null, chunkCount: 1, source: 'document' }
}

describe('restoreDocuments', () => {
  beforeEach(() => {
    useDocumentStore.setState({ documents: [], selectedId: null })
  })

  it('adds restored documents to an empty list', () => {
    useDocumentStore.getState().restoreDocuments([entry('a'), entry('b')])
    expect(useDocumentStore.getState().documents.map((d) => d.id)).toEqual(['a', 'b'])
  })

  it('appends only ids not already present (idempotent under StrictMode double-invoke)', () => {
    useDocumentStore.getState().restoreDocuments([entry('a'), entry('b')])
    useDocumentStore.getState().restoreDocuments([entry('a'), entry('b'), entry('c')])
    expect(useDocumentStore.getState().documents.map((d) => d.id)).toEqual(['a', 'b', 'c'])
  })

  it('keeps a live in-memory document over a restored one with the same id', () => {
    useDocumentStore.getState().addDocument('a', 'a.pdf', 'document') // live, status 'queued'
    useDocumentStore.getState().restoreDocuments([entry('a')]) // restored, status 'ready'
    // The live document must not be clobbered by the restore.
    expect(useDocumentStore.getState().documents.find((d) => d.id === 'a')?.status).toBe('queued')
  })
})

describe('removeDocument', () => {
  beforeEach(() => {
    useDocumentStore.setState({ documents: [], selectedId: null })
  })

  it('clears selectedId when the removed document was selected', () => {
    useDocumentStore.getState().restoreDocuments([entry('a'), entry('b')])
    useDocumentStore.getState().selectDocument('a')

    useDocumentStore.getState().removeDocument('a')

    expect(useDocumentStore.getState().documents.map((d) => d.id)).toEqual(['b'])
    expect(useDocumentStore.getState().selectedId).toBeNull()
  })

  it('leaves selectedId untouched when a different document is removed', () => {
    useDocumentStore.getState().restoreDocuments([entry('a'), entry('b')])
    useDocumentStore.getState().selectDocument('a')

    useDocumentStore.getState().removeDocument('b')

    expect(useDocumentStore.getState().documents.map((d) => d.id)).toEqual(['a'])
    expect(useDocumentStore.getState().selectedId).toBe('a')
  })
})
