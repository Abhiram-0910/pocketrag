import { cosineSimilarity } from './similarity'

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
