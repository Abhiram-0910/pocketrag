import type { EgressRecord } from '../lib/egress'

export type BackendState = 'webgpu' | 'wasm-unavailable' | 'wasm-failed'

export interface EmbeddedChunk {
  index: number
  text: string
  tokenCount: number
  page: number
  embedding: number[]
  hasImage: boolean
  // v1.4: the chunk's [start, end) in its page's text (chunker.ts).
  start: number
  end: number
}

export interface PageInput {
  page: number
  text: string
  hasImage: boolean
}

export interface RerankCandidate {
  id: string
  text: string
}

export interface RerankScore {
  id: string
  score: number
}

export type WorkerRequest =
  | { type: 'embed-document'; pages: PageInput[] }
  | { type: 'embed-query'; text: string }
  | { type: 'rerank'; query: string; candidates: RerankCandidate[] }
  // Re-embeds stored passage text (no chunking) when a document's vectors came from an
  // older model — see src/lib/reindex.ts.
  | { type: 'embed-texts'; texts: string[] }

export type WorkerResponse =
  | { type: 'backend'; backend: BackendState; detail: string }
  // loaded/total: bytes across the model's files (v1.3, for "61 MB of 135 MB").
  | { type: 'model-progress'; percent: number; loaded?: number; total?: number }
  | { type: 'model-ready' }
  | { type: 'chunked'; chunkCount: number }
  | { type: 'embed-progress'; done: number; total: number }
  | { type: 'result'; chunks: EmbeddedChunk[]; dims: number }
  | { type: 'query-embedding'; embedding: number[] }
  | { type: 'rerank-result'; scores: RerankScore[] }
  | { type: 'texts-result'; embeddings: number[][] }
  | { type: 'error'; message: string; modelDownload?: boolean }
  // A model/runtime download, for the main thread's egress log (embeddingClient.ts).
  | { type: 'egress'; record: EgressRecord }
