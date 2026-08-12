import { describe, expect, it } from 'vitest'
import { applyRerank } from './reranker'

interface TestCandidate {
  id: string
  label: string
}

describe('applyRerank', () => {
  it('sorts candidates by score descending, highest first', () => {
    const candidates: TestCandidate[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
      { id: 'c', label: 'C' },
    ]
    const scores = [
      { id: 'a', score: 0.1 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.5 },
    ]
    const ranked = applyRerank(scores, candidates, 3)
    expect(ranked.map((r) => r.chunk.id)).toEqual(['b', 'c', 'a'])
    expect(ranked.map((r) => r.score)).toEqual([0.9, 0.5, 0.1])
  })

  it('truncates to topK', () => {
    const candidates: TestCandidate[] = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, label: `${i}` }))
    const scores = candidates.map((c, i) => ({ id: c.id, score: i }))
    expect(applyRerank(scores, candidates, 3)).toHaveLength(3)
  })

  it('returns an empty array for an empty candidate pool', () => {
    expect(applyRerank([], [], 3)).toEqual([])
  })

  it('preserves the full candidate object, not just its score', () => {
    const candidate: TestCandidate = { id: 'only', label: 'Only' }
    const [top] = applyRerank([{ id: 'only', score: 5 }], [candidate], 1)
    expect(top.chunk).toBe(candidate)
  })

  it('sorts a candidate missing from scores last rather than throwing', () => {
    const candidates: TestCandidate[] = [
      { id: 'scored', label: 'Scored' },
      { id: 'unscored', label: 'Unscored' },
    ]
    const ranked = applyRerank([{ id: 'scored', score: -3 }], candidates, 2)
    expect(ranked.map((r) => r.chunk.id)).toEqual(['scored', 'unscored'])
  })

  it('handles negative raw logit scores correctly (cross-encoder output is unbounded, not 0-1)', () => {
    const candidates: TestCandidate[] = [
      { id: 'relevant', label: 'Relevant' },
      { id: 'irrelevant', label: 'Irrelevant' },
    ]
    const scores = [
      { id: 'relevant', score: 8.6 },
      { id: 'irrelevant', score: -11.2 },
    ]
    const ranked = applyRerank(scores, candidates, 2)
    expect(ranked[0].chunk.id).toBe('relevant')
    expect(ranked[1].chunk.id).toBe('irrelevant')
  })
})
