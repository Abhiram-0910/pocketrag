import type { PageInput, RerankCandidate, WorkerRequest, WorkerResponse } from '../workers/embedding.types'
import { recordEgress } from './egress'

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/embedding.worker.ts', import.meta.url), { type: 'module' })
    // The onmessage handlers below are swapped on every call, so egress records get their
    // own listener — a download can land while any of them is installed.
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'egress') recordEgress(event.data.record)
      // A failed model download poisons this worker (transformers.js memoizes the failed
      // lookup), so drop it: the next request, e.g. Try again, starts a fresh one that
      // really re-downloads. The failed request has already ended; nothing else is queued.
      if (event.data.type === 'error' && event.data.modelDownload) {
        worker?.terminate()
        worker = null
      }
    })
  }
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
      case 'egress':
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
      case 'egress':
        break
    }
  }
  const request: WorkerRequest = { type: 'embed-query', text }
  w.postMessage(request)
}

export interface RerankHandlers {
  onBackend: (payload: Extract<WorkerResponse, { type: 'backend' }>) => void
  onModelProgress: (payload: Extract<WorkerResponse, { type: 'model-progress' }>) => void
  onModelReady: () => void
  onRerankResult: (payload: Extract<WorkerResponse, { type: 'rerank-result' }>) => void
  onError: (payload: Extract<WorkerResponse, { type: 'error' }>) => void
}

/** Reranks a candidate pool through the same worker's cross-encoder model. */
export function rerankChunks(query: string, candidates: RerankCandidate[], handlers: RerankHandlers): void {
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
      case 'rerank-result':
        handlers.onRerankResult(msg)
        break
      case 'error':
        handlers.onError(msg)
        break
      case 'chunked':
      case 'embed-progress':
      case 'result':
      case 'query-embedding':
      case 'egress':
        break
    }
  }
  const request: WorkerRequest = { type: 'rerank', query, candidates }
  w.postMessage(request)
}
