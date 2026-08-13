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

  it('preserves an existing label for a document even when it does not appear in the new chunks', () => {
    const existing = [{ label: 1, documentId: 'a' }]
    // This turn's chunks are all from a different document — 'a' isn't retrieved again.
    const labels = assignDocLabels([{ documentId: 'b' }], existing)
    expect(labels).toEqual([
      { label: 1, documentId: 'a' },
      { label: 2, documentId: 'b' },
    ])
  })

  it('never reassigns an existing documentId to a different label', () => {
    const existing = [
      { label: 1, documentId: 'a' },
      { label: 2, documentId: 'b' },
    ]
    // 'b' appears first this time, but its frozen label must stay 2, not become 1.
    const labels = assignDocLabels([{ documentId: 'b' }, { documentId: 'a' }], existing)
    expect(labels).toEqual(existing)
  })

  it('continues numbering from the existing map max, never reusing a gap', () => {
    const existing = [
      { label: 1, documentId: 'a' },
      { label: 3, documentId: 'b' },
    ]
    const labels = assignDocLabels([{ documentId: 'c' }], existing)
    expect(labels).toEqual([...existing, { label: 4, documentId: 'c' }])
  })

  it('defaults existing to an empty array, matching the prior stateless behavior', () => {
    expect(assignDocLabels([{ documentId: 'a' }])).toEqual(assignDocLabels([{ documentId: 'a' }], []))
  })
})
