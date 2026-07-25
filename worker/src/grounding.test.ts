import { describe, expect, it } from 'vitest'
import { checkGrounding } from './grounding'

describe('checkGrounding', () => {
  it('is not flagged when every citation matches a provided page', () => {
    const result = checkGrounding('The cell makes energy (page 1) via mitochondria (page 3).', [1, 2, 3])
    expect(result.citedPages.sort()).toEqual([1, 3])
    expect(result.hasUnknownCitation).toBe(false)
    expect(result.groundingWarning).toBe(false)
  })

  it('flags a citation to a page that was not provided', () => {
    const result = checkGrounding('This is discussed on page 99.', [1, 2, 3])
    expect(result.hasUnknownCitation).toBe(true)
    expect(result.groundingWarning).toBe(true)
  })

  it('flags no citation at all when the answer does not admit a gap', () => {
    const result = checkGrounding('The mitochondrion produces ATP for the cell.', [1, 2])
    expect(result.hasNoCitation).toBe(true)
    expect(result.groundingWarning).toBe(true)
  })

  it('does not flag a legitimate "not in the passages" answer with no citation', () => {
    const result = checkGrounding('The passages do not contain enough information to answer this question.', [1, 2])
    expect(result.hasNoCitation).toBe(false)
    expect(result.groundingWarning).toBe(false)
  })

  it('deduplicates repeated citations to the same page', () => {
    const result = checkGrounding('See page 1. Also page 1 again.', [1])
    expect(result.citedPages).toEqual([1])
  })
})
