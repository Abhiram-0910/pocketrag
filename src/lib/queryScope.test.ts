import { describe, expect, it } from 'vitest'
import type { DocEntry } from '../store/documentStore'
import { canRunQuery } from './queryScope'

function doc(id: string, status: DocEntry['status']): DocEntry {
  return { id, fileName: `${id}.pdf`, status, error: null, embedProgress: null, chunkCount: 1, source: 'document' }
}

describe('canRunQuery', () => {
  it('is false for both scopes with no documents', () => {
    expect(canRunQuery([], null, 'document')).toBe(false)
    expect(canRunQuery([], null, 'all')).toBe(false)
  })

  it('is true for "all" scope when any document is ready, regardless of selection', () => {
    const documents = [doc('a', 'ready'), doc('b', 'embedding')]
    expect(canRunQuery(documents, null, 'all')).toBe(true)
  })

  it('is false for "document" scope with no selection', () => {
    const documents = [doc('a', 'ready')]
    expect(canRunQuery(documents, null, 'document')).toBe(false)
  })

  it('is false for "document" scope when the selected document is not ready', () => {
    const documents = [doc('a', 'embedding')]
    expect(canRunQuery(documents, 'a', 'document')).toBe(false)
  })

  it('is true for "document" scope when the selected document is ready', () => {
    const documents = [doc('a', 'ready'), doc('b', 'embedding')]
    expect(canRunQuery(documents, 'a', 'document')).toBe(true)
  })
})
