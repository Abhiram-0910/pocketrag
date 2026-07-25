export type BackendState = 'webgpu' | 'wasm-unavailable' | 'wasm-failed'

export interface EmbeddedChunk {
  index: number
  text: string
  tokenCount: number
  page: number
  embedding: number[]
}

export interface PageInput {
  page: number
  text: string
}

export type WorkerRequest =
  | { type: 'embed-document'; pages: PageInput[] }
  | { type: 'embed-query'; text: string }

export type WorkerResponse =
  | { type: 'backend'; backend: BackendState; detail: string }
  | { type: 'model-progress'; percent: number }
  | { type: 'model-ready' }
  | { type: 'chunked'; chunkCount: number }
  | { type: 'embed-progress'; done: number; total: number }
  | { type: 'result'; chunks: EmbeddedChunk[]; dims: number }
  | { type: 'query-embedding'; embedding: number[] }
  | { type: 'error'; message: string }
