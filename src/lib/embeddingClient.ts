import type { PageInput, RerankCandidate, WorkerRequest, WorkerResponse } from '../workers/embedding.types'
import { recordEgress } from './egress'

let worker: Worker | null = null

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/embedding.worker.ts', import.meta.url), { type: 'module' })
    // Egress records get their own listener — a download can land during any request.
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === 'egress') recordEgress(event.data.record)
      // A failed model download poisons this worker (transformers.js memoizes the failed
      // lookup), so drop it: the next request, e.g. Try again, starts a fresh one that
      // really re-downloads. The failed request has already ended.
      if (event.data.type === 'error' && event.data.modelDownload) {
        worker?.terminate()
        worker = null
      }
    })
  }
  return worker
}

// The worker has one message handler, so requests run one at a time, in order: before
// v1.1 a question asked while a document was embedding swapped the handler and the
// document's progress and result were lost. A request ends at its result or an error.
let queue: Promise<void> = Promise.resolve()
const TERMINAL: ReadonlySet<WorkerResponse['type']> = new Set(['result', 'query-embedding', 'rerank-result', 'texts-result', 'error'])

function send(request: WorkerRequest, onMessage: (msg: WorkerResponse) => void): void {
  queue = queue.then(
    () =>
      new Promise<void>((done) => {
        const w = getWorker()
        w.onmessage = (event: MessageEvent<WorkerResponse>) => {
          onMessage(event.data)
          if (TERMINAL.has(event.data.type)) done()
        }
        // The worker script itself failed (not a model error, which arrives as a message):
        // end this request instead of stalling every one queued behind it.
        w.onerror = (event) => {
          event.preventDefault()
          worker?.terminate()
          worker = null
          onMessage({ type: 'error', message: event.message || 'The search worker stopped unexpectedly.' })
          done()
        }
        w.postMessage(request)
      }),
  )
}

type Handler<T extends WorkerResponse['type']> = (payload: Extract<WorkerResponse, { type: T }>) => void

interface ModelHandlers {
  onBackend: Handler<'backend'>
  onModelProgress: Handler<'model-progress'>
  onModelReady: () => void
  onError: Handler<'error'>
}

// Routes the messages every request can get (model loading, errors); returns false for the rest.
function common(msg: WorkerResponse, handlers: ModelHandlers): boolean {
  if (msg.type === 'backend') handlers.onBackend(msg)
  else if (msg.type === 'model-progress') handlers.onModelProgress(msg)
  else if (msg.type === 'model-ready') handlers.onModelReady()
  else if (msg.type === 'error') handlers.onError(msg)
  else return false
  return true
}

export interface EmbedDocumentHandlers extends ModelHandlers {
  onChunked: Handler<'chunked'>
  onEmbedProgress: Handler<'embed-progress'>
  onResult: Handler<'result'>
}

/** Reuses a single worker across documents so the model only loads once per session. */
export function embedDocument(pages: PageInput[], handlers: EmbedDocumentHandlers): void {
  send({ type: 'embed-document', pages }, (msg) => {
    if (common(msg, handlers)) return
    if (msg.type === 'chunked') handlers.onChunked(msg)
    else if (msg.type === 'embed-progress') handlers.onEmbedProgress(msg)
    else if (msg.type === 'result') handlers.onResult(msg)
  })
}

export interface EmbedTextsHandlers extends ModelHandlers {
  onEmbedProgress: Handler<'embed-progress'>
  onResult: Handler<'texts-result'>
}

/** Embeds already-chunked passage text, in order — for re-indexing a stored document. */
export function embedTexts(texts: string[], handlers: EmbedTextsHandlers): void {
  send({ type: 'embed-texts', texts }, (msg) => {
    if (common(msg, handlers)) return
    if (msg.type === 'embed-progress') handlers.onEmbedProgress(msg)
    else if (msg.type === 'texts-result') handlers.onResult(msg)
  })
}

export interface EmbedQueryHandlers extends ModelHandlers {
  onQueryEmbedding: Handler<'query-embedding'>
}

/** Embeds a single query string through the same worker/model — no chunking. */
export function embedQuery(text: string, handlers: EmbedQueryHandlers): void {
  send({ type: 'embed-query', text }, (msg) => {
    if (common(msg, handlers)) return
    if (msg.type === 'query-embedding') handlers.onQueryEmbedding(msg)
  })
}

export interface RerankHandlers extends ModelHandlers {
  onRerankResult: Handler<'rerank-result'>
}

/** Reranks a candidate pool through the same worker's cross-encoder model. */
export function rerankChunks(query: string, candidates: RerankCandidate[], handlers: RerankHandlers): void {
  send({ type: 'rerank', query, candidates }, (msg) => {
    if (common(msg, handlers)) return
    if (msg.type === 'rerank-result') handlers.onRerankResult(msg)
  })
}
