export interface RerankScore {
  id: string
  score: number
}

export interface RerankedChunk<T> {
  chunk: T
  score: number
}

/**
 * Applies cross-encoder rerank scores to a candidate pool and returns the final
 * top-K, highest score first. Pure/synchronous — the actual model inference happens
 * in the embedding worker (see `embedding.worker.ts`'s 'rerank' message handler);
 * this is the same "keep the scoring/sort logic pure and testable, keep the
 * model-loading shell separate" split `rankChunks`/`cosineSimilarity` already use.
 * A candidate missing from `scores` (should not happen in practice — every candidate
 * sent to the worker gets a score back) sorts last rather than throwing.
 */
export function applyRerank<T extends { id: string }>(
  scores: RerankScore[],
  candidates: T[],
  topK: number,
): RerankedChunk<T>[] {
  const scoreById = new Map(scores.map((s) => [s.id, s.score]))
  return candidates
    .map((chunk) => ({ chunk, score: scoreById.get(chunk.id) ?? -Infinity }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
