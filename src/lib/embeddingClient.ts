import type { WorkerRequest, WorkerResponse } from '../workers/embedding.types'

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
export function embedDocument(text: string, handlers: EmbedDocumentHandlers): void {
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
    }
  }
  const request: WorkerRequest = { type: 'embed-document', text }
  w.postMessage(request)
}
