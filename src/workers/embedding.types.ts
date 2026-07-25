export type BackendState = 'webgpu' | 'wasm-unavailable' | 'wasm-failed'

export interface EmbeddedChunk {
  index: number
  text: string
  tokenCount: number
  embedding: number[]
}

export interface WorkerRequest {
  type: 'embed-document'
  text: string
}

export type WorkerResponse =
  | { type: 'backend'; backend: BackendState; detail: string }
  | { type: 'model-progress'; percent: number }
  | { type: 'model-ready' }
  | { type: 'chunked'; chunkCount: number }
  | { type: 'embed-progress'; done: number; total: number }
  | { type: 'result'; chunks: EmbeddedChunk[]; dims: number }
  | { type: 'error'; message: string }
