import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EgressRecord } from './egress'

const WORKER = 'https://worker.test'

// egress.ts keeps the session log in module state, so every test gets a fresh instance.
let egress: typeof import('./egress')
beforeEach(async () => {
  vi.resetModules()
  egress = await import('./egress')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const log = () => egress.getSessionEgress().records

describe('payloadCategories / describePayload', () => {
  it('throws on a body key with no category outside production (tests and dev)', () => {
    expect(() => egress.payloadCategories({ question: 'q', surprise: 'x' })).toThrow(/"surprise" has no payload category/)
    expect(() => egress.payloadCategories({ surprise: 'x' }, 'development')).toThrow()
  })

  it("in production, doesn't throw — the record says 'uncategorized' alongside the known categories", () => {
    expect(egress.payloadCategories({ question: 'q', surprise: 'x' }, 'production')).toEqual(['question', 'uncategorized'])
  })

  it("doesn't treat Object.prototype names as known keys", () => {
    expect(() => egress.payloadCategories({ constructor: 'x' })).toThrow()
  })

  it('counts only keys that carry data: undefined is never sent, empty arrays carry nothing', () => {
    expect(
      egress.payloadCategories({ question: 'q', history: [], docLabels: [], image: undefined, enableWebSearch: false }),
    ).toEqual(['question'])
    expect(egress.describePayload({ keySource: 'shared' })).toEqual({ categories: ['none'], counts: {} })
  })

  it('counts passages and history turns by length, and document ids as distinct ids across chunks and docLabels', () => {
    const chunks = [
      { text: 'a', documentId: 'doc-1' },
      { text: 'b', documentId: 'doc-1' },
      { text: 'c', documentId: 'doc-2' },
    ]
    expect(
      egress.describePayload({
        question: 'q',
        chunks,
        docLabels: [{ label: 3, documentId: 'doc-3' }, { label: 1, documentId: 'doc-1' }],
        history: [{ question: 'q0', answer: 'a0' }, { question: 'q1', answer: 'a1' }],
        image: { mimeType: 'image/jpeg', base64: 'AA' },
        apiKey: 'k',
      }).counts,
    ).toEqual({ question: 1, 'passage-text': 3, history: 2, 'document-ids': 3, 'page-image': 1, 'api-key': 1 })
  })
})

describe('egressFetch', () => {
  it('records the request before it goes out, then its outcome, with UTF-8 body bytes', async () => {
    let atSend: EgressRecord | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        atSend = { ...log()[0] }
        return new Response('{}', { status: 200 })
      }),
    )
    const json = { question: 'Qu’est-ce que c’est ?' }

    await egress.egressFetch(`${WORKER}/ocr`, { json }, { purpose: 'ocr', upstream: 'gemini' })

    expect(atSend).toMatchObject({ outcome: 'in-flight', httpStatus: null, finalHost: null })
    expect(log()).toHaveLength(1)
    expect(log()[0]).toMatchObject({
      purpose: 'ocr',
      host: 'worker.test',
      finalHost: 'worker.test',
      via: 'worker',
      upstream: 'gemini',
      method: 'POST',
      categories: ['question'],
      counts: { question: 1 },
      bytesSent: new TextEncoder().encode(JSON.stringify(json)).byteLength,
      httpStatus: 200,
      outcome: 'ok',
    })
    expect(log()[0].bytesSent).toBeGreaterThan(JSON.stringify(json).length)
    expect(log()[0].durationMs).not.toBeNull()
  })

  it('records an HTTP error status, a network failure, and an abort', async () => {
    const meta = { purpose: 'models' as const, upstream: 'openai' as const }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })))
    await egress.egressFetch(`${WORKER}/models`, { json: { apiKey: 'k' } }, meta)
    expect(log().at(-1)).toMatchObject({ httpStatus: 502, outcome: 'http-error' })

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(egress.egressFetch(`${WORKER}/models`, { json: { apiKey: 'k' } }, meta)).rejects.toThrow('Failed to fetch')
    expect(log().at(-1)).toMatchObject({ httpStatus: null, outcome: 'network-error' })

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(egress.egressFetch(`${WORKER}/models`, { json: { apiKey: 'k' } }, meta)).rejects.toThrow()
    expect(log().at(-1)).toMatchObject({ outcome: 'aborted' })
    expect(log()).toHaveLength(3)
  })

  it("'answer' records never reach the session log — they go to the onRecord sink, or nowhere", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const sink: EgressRecord[] = []

    await egress.egressFetch(`${WORKER}/answer`, { json: { question: 'q' } }, { purpose: 'answer', upstream: 'gemini' }, (r) =>
      sink.push(r),
    )
    await egress.egressFetch(`${WORKER}/answer`, { json: { question: 'q' } }, { purpose: 'answer', upstream: 'gemini' })
    egress.recordEgress({ ...sink[1], id: 'direct-call' })

    expect(sink.map((r) => r.outcome)).toEqual(['in-flight', 'ok'])
    expect(log()).toEqual([])
  })
})

describe('session log', () => {
  const record = (id: string): EgressRecord => ({
    id,
    purpose: 'embed-model-download',
    host: 'huggingface.co',
    finalHost: null,
    via: 'direct',
    upstream: null,
    method: 'GET',
    categories: ['none'],
    counts: {},
    bytesSent: 0,
    startedAt: 1,
    durationMs: null,
    httpStatus: null,
    outcome: 'in-flight',
  })

  it('ring buffer: keeps the newest MAX_SESSION_EGRESS records and counts the dropped ones', () => {
    for (let i = 0; i < egress.MAX_SESSION_EGRESS + 5; i++) egress.recordEgress(record(`r${i}`))
    const { records, dropped } = egress.getSessionEgress()
    expect(records).toHaveLength(egress.MAX_SESSION_EGRESS)
    expect(records[0].id).toBe('r5')
    expect(records.at(-1)?.id).toBe(`r${egress.MAX_SESSION_EGRESS + 4}`)
    expect(dropped).toBe(5)
  })

  it('replacing a record keeps its place; subscribers are notified with a new snapshot each change', () => {
    const calls: number[] = []
    const unsubscribe = egress.subscribeSessionEgress(() => calls.push(egress.getSessionEgress().records.length))
    egress.recordEgress(record('a'))
    const before = egress.getSessionEgress()
    egress.recordEgress({ ...record('a'), outcome: 'ok' })
    unsubscribe()
    egress.recordEgress(record('b'))

    expect(before).not.toBe(egress.getSessionEgress())
    expect(calls).toEqual([1, 1])
    expect(egress.getSessionEgress().records.map((r) => [r.id, r.outcome])).toEqual([
      ['a', 'ok'],
      ['b', 'in-flight'],
    ])
  })
})

describe('downloadFetch (transformers.js env.fetch in the embedding worker)', () => {
  it('labels runtime, embedding-model and reranker downloads, with the post-redirect host', async () => {
    const emitted: EgressRecord[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({ ok: true, status: 200, url: url.replace('huggingface.co', 'us.aws.cdn.hf.co') }) as Response),
    )
    const fetchFn = egress.downloadFetch('Xenova/ms-marco-MiniLM-L-2-v2', (r) => emitted.push(r))

    await fetchFn('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.26.0/dist/ort-wasm-simd-threaded.asyncify.wasm')
    await fetchFn('https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx')
    await fetchFn(new URL('https://huggingface.co/Xenova/ms-marco-MiniLM-L-2-v2/resolve/main/config.json'))

    const settled = emitted.filter((r) => r.outcome !== 'in-flight')
    expect(settled.map((r) => r.purpose)).toEqual(['runtime-download', 'embed-model-download', 'rerank-model-download'])
    expect(settled[1]).toMatchObject({
      host: 'huggingface.co',
      finalHost: 'us.aws.cdn.hf.co',
      via: 'direct',
      upstream: null,
      method: 'GET',
      categories: ['none'],
      counts: {},
      bytesSent: 0,
    })
    expect(emitted).toHaveLength(6)
  })
})

// The three real request builders, each called for real (only fetch is stubbed) — the
// exact categories each one's body produces.
describe('request builders → recorded categories', () => {
  async function load() {
    vi.stubEnv('VITE_API_BASE_URL', WORKER)
    vi.resetModules()
    egress = await import('./egress')
    return {
      answer: await import('./answerRequest'),
      models: await import('./models'),
      ocr: await import('./ocrRequest'),
    }
  }
  const chunk = { text: 'passage', page: 1, score: 0.9, documentId: 'doc-a' }
  const okAnswer = () => vi.fn(async () => Response.json({ answer: 'a', groundingWarning: false, docLabels: [] }))
  const signal = () => new AbortController().signal

  it('/answer, shared tier, first turn: question + passages + their document ids', async () => {
    vi.stubGlobal('fetch', okAnswer())
    const { answer } = await load()
    const sink: EgressRecord[] = []
    await answer.fetchAnswerFromWorker('q', [chunk], { keySource: 'shared' }, signal(), [], [], undefined, undefined, (r) => sink.push(r))
    expect(sink.at(-1)).toMatchObject({
      purpose: 'answer',
      upstream: 'gemini',
      categories: ['question', 'passage-text', 'document-ids'],
      counts: { question: 1, 'passage-text': 1, 'document-ids': 1 },
    })
  })

  it('/answer, shared tier, follow-up with a page image: adds history and page-image', async () => {
    vi.stubGlobal('fetch', okAnswer())
    const { answer } = await load()
    const sink: EgressRecord[] = []
    await answer.fetchAnswerFromWorker(
      'q',
      [chunk],
      { keySource: 'shared' },
      signal(),
      [{ label: 1, documentId: 'doc-a' }],
      [{ question: 'q0', answer: 'a0' }],
      { mimeType: 'image/jpeg', base64: 'AAAA' },
      undefined,
      (r) => sink.push(r),
    )
    expect(sink.at(-1)?.categories).toEqual(['question', 'passage-text', 'history', 'document-ids', 'page-image'])
  })

  it('/answer, own key with web search: adds api-key, upstream is the chosen provider', async () => {
    vi.stubGlobal('fetch', okAnswer())
    const { answer } = await load()
    const sink: EgressRecord[] = []
    await answer.fetchAnswerFromWorker(
      'q',
      [chunk],
      { keySource: 'own', apiKey: 'AIzaFakeKey123', provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      signal(),
      [],
      [],
      undefined,
      true,
      (r) => sink.push(r),
    )
    expect(sink.at(-1)).toMatchObject({ upstream: 'gemini', categories: ['question', 'passage-text', 'document-ids', 'api-key'] })
  })

  it('attemptAnswer passes onEgress through to the request', async () => {
    vi.stubGlobal('fetch', okAnswer())
    const { answer } = await load()
    const sink: EgressRecord[] = []
    const result = await answer.attemptAnswer(
      answer.fetchAnswerFromWorker,
      'q',
      [chunk],
      { keySource: 'shared' },
      60_000,
      [],
      [],
      undefined,
      undefined,
      (r) => sink.push(r),
    )
    expect(result.outcome).toBe('success')
    expect(sink.map((r) => r.outcome)).toEqual(['in-flight', 'ok'])
  })

  it('/models: api-key only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: [] })))
    const { models } = await load()
    await models.fetchModelsFromWorker('openai', 'sk-fake-key-123')
    expect(log()[0]).toMatchObject({ purpose: 'models', upstream: 'openai', categories: ['api-key'] })
  })

  it('/ocr: the whole file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: 't' })))
    const { ocr } = await load()
    await ocr.fetchOcrFromWorker('image/png', 'iVBORw0KGgo', signal())
    expect(log()[0]).toMatchObject({ purpose: 'ocr', upstream: 'gemini', categories: ['ocr-file'], counts: { 'ocr-file': 1 } })
  })
})
