import { describe, expect, it } from 'vitest'
import { assignDocLabels } from './labels'

describe('assignDocLabels', () => {
  it('assigns 1-based labels in first-appearance order', () => {
    const labels = assignDocLabels([{ documentId: 'a' }, { documentId: 'b' }, { documentId: 'c' }])
    expect(labels).toEqual([
      { label: 1, documentId: 'a' },
      { label: 2, documentId: 'b' },
      { label: 3, documentId: 'c' },
    ])
  })

  it('gives repeated chunks of one document a single shared label', () => {
    // Chunks arrive rank-ordered and interleaved across two documents.
    const labels = assignDocLabels(['a', 'b', 'a', 'b', 'a'].map((documentId) => ({ documentId })))
    expect(labels).toEqual([
      { label: 1, documentId: 'a' },
      { label: 2, documentId: 'b' },
    ])
  })

  it('labels a single document as Doc 1', () => {
    expect(assignDocLabels([{ documentId: 'only' }, { documentId: 'only' }])).toEqual([
      { label: 1, documentId: 'only' },
    ])
  })

  it('returns an empty array for no chunks', () => {
    expect(assignDocLabels([])).toEqual([])
  })
})
