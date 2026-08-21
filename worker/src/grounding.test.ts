import { describe, expect, it } from 'vitest'
import { checkGrounding } from './grounding'
import { assignDocLabels } from './labels'

// One document, labelled Doc 1, with pages 1-3 provided.
const oneDoc = [
  { label: 1, page: 1 },
  { label: 1, page: 2 },
  { label: 1, page: 3 },
]

describe('checkGrounding', () => {
  it('is not flagged when every citation matches a provided (doc, page) pair', () => {
    const result = checkGrounding('The cell makes energy (Doc 1, page 1) via mitochondria (Doc 1, page 3).', oneDoc)
    expect(result.citedPairs).toEqual([
      { label: 1, page: 1 },
      { label: 1, page: 3 },
    ])
    expect(result.hasUnknownCitation).toBe(false)
    expect(result.groundingWarning).toBe(false)
  })

  it('flags a citation to a page that was not provided for that document', () => {
    const result = checkGrounding('This is discussed on Doc 1, page 99.', oneDoc)
    expect(result.hasUnknownCitation).toBe(true)
    expect(result.groundingWarning).toBe(true)
  })

  it('flags a citation to a document that was not provided', () => {
    const result = checkGrounding('See Doc 2, page 1 for details.', oneDoc)
    expect(result.hasUnknownCitation).toBe(true)
    expect(result.groundingWarning).toBe(true)
  })

  it('flags no citation at all when the answer does not admit a gap', () => {
    const result = checkGrounding('The mitochondrion produces ATP for the cell.', oneDoc)
    expect(result.hasNoCitation).toBe(true)
    expect(result.groundingWarning).toBe(true)
  })

  it('does not flag a legitimate "not in the passages" answer with no citation', () => {
    const result = checkGrounding('The passages do not contain enough information to answer this question.', oneDoc)
    expect(result.hasNoCitation).toBe(false)
    expect(result.groundingWarning).toBe(false)
  })

  it('deduplicates repeated citations to the same (doc, page) pair', () => {
    const result = checkGrounding('See Doc 1, page 1. Also Doc 1, page 1 again.', [{ label: 1, page: 1 }])
    expect(result.citedPairs).toEqual([{ label: 1, page: 1 }])
  })

  it('still grounds correctly against a frozen, non-1 label from a prior conversation turn', () => {
    // Simulates Milestone 11 Phase C: turn 1 discovers doc 'a' (Doc 1) and doc 'b' (Doc
    // 2); turn 2 only retrieves 'b' again, so 'b' stays Doc 2 even though it's the only
    // document in this turn's providedPairs.
    const turn1Labels = assignDocLabels([{ documentId: 'a' }, { documentId: 'b' }])
    const turn2Labels = assignDocLabels([{ documentId: 'b' }], turn1Labels)
    const labelOfB = turn2Labels.find((d) => d.documentId === 'b')!.label
    expect(labelOfB).toBe(2)

    const providedPairs = [{ label: labelOfB, page: 1 }]
    const grounded = checkGrounding(`Gluten does it (Doc ${labelOfB}, page 1).`, providedPairs)
    expect(grounded.groundingWarning).toBe(false)

    const ungrounded = checkGrounding('Gluten does it (Doc 1, page 1).', providedPairs)
    expect(ungrounded.hasUnknownCitation).toBe(true)
    expect(ungrounded.groundingWarning).toBe(true)
  })
})
