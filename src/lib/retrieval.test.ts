import { describe, expect, it } from 'vitest'
import { hybridRankChunks, rankChunks } from './retrieval'

interface TestChunk {
  id: string
  embedding: number[]
}

interface TestHybridChunk {
  id: string
  text: string
  embedding: number[]
}

describe('rankChunks', () => {
  it('ranks a known-similar chunk above a known-different one', () => {
    const query = [1, 0, 0]
    const similar: TestChunk = { id: 'similar', embedding: [0.99, 0.01, 0] }
    const different: TestChunk = { id: 'different', embedding: [0, 1, 0] }

    const ranked = rankChunks(query, [different, similar], 2)

    expect(ranked[0].chunk.id).toBe('similar')
    expect(ranked[1].chunk.id).toBe('different')
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score)
  })

  it('gives the highest score to an identical vector', () => {
    const query = [0.5, 0.5, 0.7071]
    const chunks: TestChunk[] = [
      { id: 'identical', embedding: [0.5, 0.5, 0.7071] },
      { id: 'orthogonal', embedding: [0.7071, -0.7071, 0] },
      { id: 'opposite', embedding: [-0.5, -0.5, -0.7071] },
    ]

    const ranked = rankChunks(query, chunks, 3)

    expect(ranked[0].chunk.id).toBe('identical')
    expect(ranked[0].score).toBeCloseTo(1, 4)
    expect(ranked[2].chunk.id).toBe('opposite')
    expect(ranked[2].score).toBeCloseTo(-1, 4)
  })

  it('respects topK and defaults to 3', () => {
    const query = [1, 0]
    const chunks: TestChunk[] = Array.from({ length: 10 }, (_, i) => ({
      id: `chunk-${i}`,
      embedding: [1 - i * 0.05, i * 0.05],
    }))

    expect(rankChunks(query, chunks)).toHaveLength(3)
    expect(rankChunks(query, chunks, 5)).toHaveLength(5)
  })

  it('returns an empty array when there are no chunks', () => {
    expect(rankChunks([1, 0], [], 3)).toEqual([])
  })

  it('preserves the full chunk object, not just its score', () => {
    const query = [1, 0]
    const chunk: TestChunk = { id: 'only', embedding: [1, 0] }
    const [top] = rankChunks(query, [chunk], 1)
    expect(top.chunk).toBe(chunk)
  })
})

describe('hybridRankChunks', () => {
  it('returns an empty array for an empty pool', () => {
    expect(hybridRankChunks([1, 0, 0], 'anything', [], 3)).toEqual([])
  })

  it('returns the single chunk in a one-chunk pool', () => {
    const chunk: TestHybridChunk = { id: 'only', text: 'hello world', embedding: [1, 0, 0] }
    const ranked = hybridRankChunks([1, 0, 0], 'hello', [chunk], 3)
    expect(ranked).toHaveLength(1)
    expect(ranked[0].chunk.id).toBe('only')
  })

  it('respects topK', () => {
    const chunks: TestHybridChunk[] = Array.from({ length: 10 }, (_, i) => ({
      id: `chunk-${i}`,
      text: `filler text number ${i}`,
      embedding: [1 - i * 0.05, i * 0.05, 0],
    }))
    expect(hybridRankChunks([1, 0, 0], 'filler', chunks, 4)).toHaveLength(4)
  })

  it('ranks a chunk that wins both cosine similarity and BM25 first', () => {
    // A chunk that is simultaneously the best cosine match AND the best BM25 match
    // must win under RRF regardless of the k constant: it has rank 0 on both terms,
    // so its fused score (2/k) is the maximum any chunk in the pool can achieve.
    const chunks: TestHybridChunk[] = [
      { id: 'best', text: 'mitochondria produce cellular energy', embedding: [1, 0, 0] },
      { id: 'mid', text: 'chloroplasts perform photosynthesis', embedding: [0.7, 0.7, 0] },
      { id: 'worst', text: 'ribosomes synthesize proteins', embedding: [0, 0, 1] },
    ]
    const ranked = hybridRankChunks([1, 0, 0], 'mitochondria energy', chunks, 3)
    expect(ranked[0].chunk.id).toBe('best')
  })

  it('surfaces a chunk with a strong keyword match that pure cosine similarity alone would exclude from topK', () => {
    // chunkX has the worst possible cosine match (orthogonal to the query) but is the
    // only chunk containing the query keyword — hand-verified: pure cosine ranks it
    // dead last (5th of 5, excluded from top 3); RRF fusion pulls it into the top 3
    // since it wins the BM25 term outright (rank 0) while only losing the cosine term
    // by the same margin c0 loses the BM25 term by (a tie at 2nd/3rd with c0), and c1
    // — good but not best on either axis — wins outright.
    const chunks: TestHybridChunk[] = [
      { id: 'chunkX', text: 'the zeta protocol was ratified', embedding: [0, 0, 1] },
      { id: 'c1', text: 'irrelevant filler one', embedding: [0.8, 0.6, 0] },
      { id: 'c2', text: 'irrelevant filler two', embedding: [0.6, 0.8, 0] },
      { id: 'c3', text: 'irrelevant filler three', embedding: [0.4, 0.9, 0.17] },
      { id: 'c0', text: 'irrelevant filler zero', embedding: [1, 0, 0] },
    ]
    const queryEmbedding = [1, 0, 0]

    const pureCosine = rankChunks(queryEmbedding, chunks, 3)
    expect(pureCosine.map((r) => r.chunk.id)).toEqual(['c0', 'c1', 'c2'])

    const hybrid = hybridRankChunks(queryEmbedding, 'zeta', chunks, 3)
    expect(hybrid.map((r) => r.chunk.id)).toContain('chunkX')
  })

  it('gives chunks that match no query term no BM25 credit, so pool order cannot reorder them', () => {
    // No chunk contains "zzz": before v1.1 every chunk still got a BM25 rank, in pool
    // order, which outweighed this small cosine gap and put 'first' on top.
    const chunks: TestHybridChunk[] = [
      { id: 'first', text: 'alpha beta', embedding: [0.9, 0.436, 0] },
      { id: 'second', text: 'gamma delta', embedding: [0.91, 0.415, 0] },
    ]
    expect(hybridRankChunks([1, 0, 0], 'zzz', chunks, 2).map((r) => r.chunk.id)).toEqual(['second', 'first'])
  })

  it('matches keywords in any script (Hindi), not just ASCII', () => {
    const chunks: TestHybridChunk[] = [
      { id: 'other', text: 'आमाशय में प्रोटीन पचता', embedding: [1, 0, 0] },
      { id: 'monsoon', text: 'केरल में मानसून जून में पहुँचता है', embedding: [0, 1, 0] },
    ]
    // Cosine favours 'other' (and it comes first in the pool); only the keyword "मानसून"
    // can lift 'monsoon' above it.
    const ranked = hybridRankChunks([1, 0, 0], 'मानसून कब आता है', chunks, 2)
    expect(ranked[0].chunk.id).toBe('monsoon')
  })
})
