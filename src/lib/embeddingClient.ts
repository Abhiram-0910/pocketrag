import type { PageInput, WorkerRequest, WorkerResponse } from '../workers/embedding.types'

let worker: Worker | null = null

function getWorker(): Worker {
  worker ??= new Worker(new URL('../workers/embedding.worker.ts', import.meta.url), { type: 'module' })
  return worker
}

export interface EmbedDocumentHandlers {
  onBackend: (payload: Extract<WorkerResponse, { type: 'backend' }>) => void
  onModelProgress: (payload: Extract<WorkerResponse, { type: 'model-progress' }>) => void
  onModelReady: () => void
  onChunked: (payload: Extract<WorkerResponse, { type: 'chunked' }>) => void
  onEmbedProgress: (payload: Extract<WorkerResponse, { type: 'embed-progress' }>) => void
  onResult: (payload: Extract<WorkerResponse, { type: 'result' }>) => void
  onError: (payload: Extract<WorkerResponse, { type: 'error' }>) => void
}

/** Reuses a single worker across documents so the model only loads once per session. */
export function embedDocument(pages: PageInput[], handlers: EmbedDocumentHandlers): void {
  const w = getWorker()
  w.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data
    switch (msg.type) {
      case 'backend':
        handlers.onBackend(msg)
        break
      case 'model-progress':
        handlers.onModelProgress(msg)
        break
      case 'model-ready':
        handlers.onModelReady()
        break
      case 'chunked':
        handlers.onChunked(msg)
        break
      case 'embed-progress':
        handlers.onEmbedProgress(msg)
        break
      case 'result':
        handlers.onResult(msg)
        break
      case 'error':
        handlers.onError(msg)
        break
      case 'query-embedding':
        break
    }
  }
  const request: WorkerRequest = { type: 'embed-document', pages }
  w.postMessage(request)
}

export interface EmbedQueryHandlers {
  onBackend: (payload: Extract<WorkerResponse, { type: 'backend' }>) => void
  onModelProgress: (payload: Extract<WorkerResponse, { type: 'model-progress' }>) => void
  onModelReady: () => void
  onQueryEmbedding: (payload: Extract<WorkerResponse, { type: 'query-embedding' }>) => void
  onError: (payload: Extract<WorkerResponse, { type: 'error' }>) => void
}

/** Embeds a single query string through the same worker/model — no chunking. */
export function embedQuery(text: string, handlers: EmbedQueryHandlers): void {
  const w = getWorker()
  w.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const msg = event.data
    switch (msg.type) {
      case 'backend':
        handlers.onBackend(msg)
        break
      case 'model-progress':
        handlers.onModelProgress(msg)
        break
      case 'model-ready':
        handlers.onModelReady()
        break
      case 'query-embedding':
        handlers.onQueryEmbedding(msg)
        break
      case 'error':
        handlers.onError(msg)
        break
      case 'chunked':
      case 'embed-progress':
      case 'result':
        break
    }
  }
  const request: WorkerRequest = { type: 'embed-query', text }
  w.postMessage(request)
}
