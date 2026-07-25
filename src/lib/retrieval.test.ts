import { describe, expect, it } from 'vitest'
import { rankChunks } from './retrieval'

interface TestChunk {
  id: string
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
