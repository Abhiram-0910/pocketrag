import { describe, expect, it, vi } from 'vitest'
import type { WorkerResponse } from '../workers/embedding.types'

// A stand-in Worker: records what's posted; reply() delivers a message like the real one.
class FakeWorker {
  static last: FakeWorker
  posted: { type: string }[] = []
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null
  constructor() {
    FakeWorker.last = this
  }
  addEventListener() {}
  postMessage(message: { type: string }) {
    this.posted.push(message)
  }
  terminate() {}
  reply(data: WorkerResponse) {
    this.onmessage?.({ data })
  }
}
vi.stubGlobal('Worker', FakeWorker)
const { embedQuery, embedTexts } = await import('./embeddingClient')
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const noop = { onBackend: () => {}, onModelProgress: () => {}, onModelReady: () => {}, onError: () => {} }

describe('embeddingClient', () => {
  it('runs one request at a time, so a question asked mid-embedding cannot take its messages', async () => {
    const textsResult = vi.fn()
    const queryResult = vi.fn()
    embedTexts(['a', 'b'], { ...noop, onEmbedProgress: () => {}, onResult: textsResult })
    embedQuery('q', { ...noop, onQueryEmbedding: queryResult })
    await flush()
    const w = FakeWorker.last
    expect(w.posted.map((m) => m.type)).toEqual(['embed-texts'])

    w.reply({ type: 'embed-progress', done: 1, total: 2 })
    w.reply({ type: 'texts-result', embeddings: [[1], [2]] })
    expect(textsResult).toHaveBeenCalledOnce()
    await flush()
    expect(w.posted.map((m) => m.type)).toEqual(['embed-texts', 'embed-query'])

    w.reply({ type: 'query-embedding', embedding: [3] })
    expect(queryResult).toHaveBeenCalledWith({ type: 'query-embedding', embedding: [3] })
    expect(textsResult).toHaveBeenCalledOnce()
  })

  it('ends a request whose worker script fails, instead of stalling the queue behind it', async () => {
    const onError = vi.fn()
    const next = vi.fn()
    embedQuery('q1', { ...noop, onError, onQueryEmbedding: () => {} })
    embedQuery('q2', { ...noop, onQueryEmbedding: next })
    await flush()
    FakeWorker.last.onerror?.({ message: 'boom', preventDefault() {} })
    expect(onError).toHaveBeenCalledWith({ type: 'error', message: 'boom' })
    await flush()
    // A fresh worker took the next request.
    expect(FakeWorker.last.posted.map((m) => m.type)).toEqual(['embed-query'])
    FakeWorker.last.reply({ type: 'query-embedding', embedding: [1] })
    expect(next).toHaveBeenCalledOnce()
  })
})
