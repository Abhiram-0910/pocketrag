import { cosineSimilarity } from './similarity'
import { bm25Score } from './bm25'

export interface ScoredChunk<T extends { embedding: number[] }> {
  chunk: T
  score: number
}

/** Ranks chunks by cosine similarity to a query embedding, highest first. */
export function rankChunks<T extends { embedding: number[] }>(
  queryEmbedding: number[],
  chunks: T[],
  topK = 3,
): ScoredChunk<T>[] {
  return chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

export interface HybridChunk {
  id: string
  text: string
  embedding: number[]
}

// Standard default from the Reciprocal Rank Fusion literature — no tuning needed.
const RRF_K = 60

/**
 * Ranks chunks by combining embedding cosine similarity and BM25 keyword relevance
 * via Reciprocal Rank Fusion: score = 1/(k+cosineRank) + 1/(k+bm25Rank). RRF fuses on
 * rank position, not raw score, which is why it's used here instead of averaging the
 * two scores directly — BM25 is unbounded-positive and cosine is bounded, so naive
 * averaging would let whichever ranker produces larger absolute numbers dominate.
 */
export function hybridRankChunks<T extends HybridChunk>(
  queryEmbedding: number[],
  queryText: string,
  chunks: T[],
  topK = 3,
): ScoredChunk<T>[] {
  if (chunks.length === 0) return []

  const byCosine = rankChunks(queryEmbedding, chunks, chunks.length)
  const byBm25 = bm25Score(queryText, chunks).sort((a, b) => b.score - a.score)

  const cosineRank = new Map(byCosine.map(({ chunk }, i) => [chunk.id, i]))
  const bm25Rank = new Map(byBm25.map(({ id }, i) => [id, i]))

  return chunks
    .map((chunk) => ({
      chunk,
      score: 1 / (RRF_K + cosineRank.get(chunk.id)!) + 1 / (RRF_K + bm25Rank.get(chunk.id)!),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
