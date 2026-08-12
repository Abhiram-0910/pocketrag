import { describe, expect, it } from 'vitest'
import { bm25Score } from './bm25'

describe('bm25Score', () => {
  it('matches the exact BM25 value for the simplest possible case (N=1, df=1, tf=1, |D|=avgdl)', () => {
    // With a single document containing the query term exactly once, the length-
    // normalization factor collapses to 1 (tf=1, |D|=avgdl), so the score reduces to
    // pure IDF: ln(1 + (N-df+0.5)/(df+0.5)) = ln(1 + 0.5/1.5) = ln(4/3).
    const [result] = bm25Score('cat', [{ id: 'd1', text: 'cat' }])
    expect(result.score).toBeCloseTo(Math.log(4 / 3), 10)
  })

  it('scores a document with no matching terms as exactly 0', () => {
    const [result] = bm25Score('dog', [{ id: 'd1', text: 'cat sat mat' }])
    expect(result.score).toBe(0)
  })

  it('returns 0 for every document when the query has no terms', () => {
    const results = bm25Score('   ', [
      { id: 'd1', text: 'cat sat mat' },
      { id: 'd2', text: 'dog ran far' },
    ])
    expect(results).toEqual([
      { id: 'd1', score: 0 },
      { id: 'd2', score: 0 },
    ])
  })

  it('returns an empty array for an empty document pool', () => {
    expect(bm25Score('cat', [])).toEqual([])
  })

  it('gives a rarer term a higher score than a common term, all else equal', () => {
    // "rare" appears in only one of three docs; "common" appears in all three —
    // rare should score higher purely from IDF, with tf/length held identical.
    const docs = [
      { id: 'd1', text: 'rare common word' },
      { id: 'd2', text: 'common word only' },
      { id: 'd3', text: 'common word again' },
    ]
    const [rareResult] = bm25Score('rare', docs)
    const [commonResult] = bm25Score('common', docs)
    expect(rareResult.score).toBeGreaterThan(commonResult.score)
  })

  it('applies term-frequency saturation — doubling term frequency less than doubles the score', () => {
    const docs = [
      { id: 'once', text: 'cat sat on the mat' },
      { id: 'twice', text: 'cat cat sat on the mat' },
      { id: 'quadruple', text: 'cat cat cat cat sat on the mat' },
    ]
    const results = bm25Score('cat', docs)
    const byId = Object.fromEntries(results.map((r) => [r.id, r.score]))

    expect(byId.twice).toBeGreaterThan(byId.once)
    expect(byId.quadruple).toBeGreaterThan(byId.twice)
    // Saturation: going from 2→4 occurrences gains less than going from 1→2 did.
    const firstGain = byId.twice - byId.once
    const secondGain = byId.quadruple - byId.twice
    expect(secondGain).toBeLessThan(firstGain)
  })

  it('penalizes a longer document over a shorter one with the same term frequency', () => {
    const docs = [
      { id: 'short', text: 'cat sat' },
      { id: 'long', text: 'cat sat on the mat by the door near the old wooden fence outside' },
    ]
    const results = bm25Score('cat', docs)
    const byId = Object.fromEntries(results.map((r) => [r.id, r.score]))
    expect(byId.short).toBeGreaterThan(byId.long)
  })

  it('tokenizes case-insensitively', () => {
    const [result] = bm25Score('CAT', [{ id: 'd1', text: 'cat sat mat' }])
    expect(result.score).toBeGreaterThan(0)
  })

  it('sums contributions across multiple distinct query terms', () => {
    // Same pool for both calls (IDF/avgdl must match) — only the query changes.
    // "catOnly" contains zero occurrences of "dog", so adding "dog" to the query
    // must contribute exactly 0 to its score, leaving it identical to the
    // "cat"-only score.
    const docs = [
      { id: 'both', text: 'cat and dog live here' },
      { id: 'catOnly', text: 'cat lives here' },
    ]
    const catOnlyScore = bm25Score('cat', docs).find((r) => r.id === 'catOnly')!.score
    const catDogScore = bm25Score('cat dog', docs).find((r) => r.id === 'catOnly')!.score
    expect(catDogScore).toBeCloseTo(catOnlyScore, 10)
  })
})
