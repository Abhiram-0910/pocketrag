import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadFetch, egressFetch, payloadCategories, sessionEgressLog, type EgressRecord } from './egress'

const WORKER = 'https://worker.test'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  sessionEgressLog.length = 0
})

describe('payloadCategories', () => {
  it('throws on a body key with no category outside production (tests and dev)', () => {
    expect(() => payloadCategories({ question: 'q', surprise: 'x' })).toThrow(/"surprise" has no payload category/)
    expect(() => payloadCategories({ surprise: 'x' }, 'development')).toThrow()
  })

  it("in production, doesn't throw — the record says 'uncategorized' alongside the known categories", () => {
    expect(payloadCategories({ question: 'q', surprise: 'x' }, 'production')).toEqual(['question', 'uncategorized'])
  })

  it("doesn't treat Object.prototype names as known keys", () => {
    expect(() => payloadCategories({ constructor: 'x' })).toThrow()
  })

  it('counts only keys that carry data: undefined is never sent, empty arrays carry nothing', () => {
    expect(payloadCategories({ question: 'q', history: [], docLabels: [], image: undefined, enableWebSearch: false })).toEqual([
      'question',
    ])
    expect(payloadCategories({ keySource: 'shared' })).toEqual(['none'])
  })
})

describe('egressFetch', () => {
  it('records the request before it goes out, then its outcome, with UTF-8 body bytes', async () => {
    let atSend: EgressRecord | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        atSend = { ...sessionEgressLog[0] }
        return new Response('{}', { status: 200 })
      }),
    )
    const json = { question: 'Qu’est-ce que c’est ?' }

    await egressFetch(`${WORKER}/answer`, { json }, { purpose: 'answer', upstream: 'gemini' })

    expect(atSend).toMatchObject({ outcome: 'in-flight', httpStatus: null, finalHost: null })
    expect(sessionEgressLog).toHaveLength(1)
    expect(sessionEgressLog[0]).toMatchObject({
      purpose: 'answer',
      host: 'worker.test',
      finalHost: 'worker.test',
      via: 'worker',
      upstream: 'gemini',
      method: 'POST',
      categories: ['question'],
      bytesSent: new TextEncoder().encode(JSON.stringify(json)).byteLength,
      httpStatus: 200,
      outcome: 'ok',
    })
    expect(sessionEgressLog[0].bytesSent).toBeGreaterThan(JSON.stringify(json).length)
    expect(sessionEgressLog[0].durationMs).not.toBeNull()
  })

  it('records an HTTP error status, a network failure, and an abort', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 502 })))
    await egressFetch(`${WORKER}/answer`, { json: { question: 'q' } }, { purpose: 'answer', upstream: 'gemini' })
    expect(sessionEgressLog.at(-1)).toMatchObject({ httpStatus: 502, outcome: 'http-error' })

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))))
    await expect(egressFetch(`${WORKER}/answer`, { json: { question: 'q' } }, { purpose: 'answer', upstream: 'gemini' })).rejects.toThrow(
      'Failed to fetch',
    )
    expect(sessionEgressLog.at(-1)).toMatchObject({ httpStatus: null, outcome: 'network-error' })

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(egressFetch(`${WORKER}/answer`, { json: { question: 'q' } }, { purpose: 'answer', upstream: 'gemini' })).rejects.toThrow()
    expect(sessionEgressLog.at(-1)).toMatchObject({ outcome: 'aborted' })
    expect(sessionEgressLog).toHaveLength(3)
  })
})

describe('downloadFetch (transformers.js env.fetch in the embedding worker)', () => {
  it('labels runtime, embedding-model and reranker downloads, with the post-redirect host', async () => {
    const emitted: EgressRecord[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({ ok: true, status: 200, url: url.replace('huggingface.co', 'us.aws.cdn.hf.co') }) as Response),
    )
    const fetchFn = downloadFetch('Xenova/ms-marco-MiniLM-L-2-v2', (r) => emitted.push(r))

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
    const egress = await import('./egress')
    return {
      log: egress.sessionEgressLog,
      answer: await import('./answerRequest'),
      models: await import('./models'),
      ocr: await import('./ocrRequest'),
    }
  }
  const chunk = { text: 'passage', page: 1, score: 0.9, documentId: 'doc-a' }

  it('/answer, shared tier, first turn: question + passages + their document ids', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answer: 'a', groundingWarning: false, docLabels: [] })))
    const { log, answer } = await load()
    await answer.fetchAnswerFromWorker('q', [chunk], { keySource: 'shared' }, new AbortController().signal, [], [])
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ purpose: 'answer', upstream: 'gemini', categories: ['question', 'passage-text', 'document-ids'] })
  })

  it('/answer, shared tier, follow-up with a page image: adds history and page-image', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answer: 'a', groundingWarning: false, docLabels: [] })))
    const { log, answer } = await load()
    await answer.fetchAnswerFromWorker(
      'q',
      [chunk],
      { keySource: 'shared' },
      new AbortController().signal,
      [{ label: 1, documentId: 'doc-a' }],
      [{ question: 'q0', answer: 'a0' }],
      { mimeType: 'image/jpeg', base64: 'AAAA' },
    )
    expect(log[0].categories).toEqual(['question', 'passage-text', 'history', 'document-ids', 'page-image'])
  })

  it('/answer, own key with web search: adds api-key, upstream is the chosen provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answer: 'a', groundingWarning: false, docLabels: [] })))
    const { log, answer } = await load()
    await answer.fetchAnswerFromWorker(
      'q',
      [chunk],
      { keySource: 'own', apiKey: 'AIzaFakeKey123', provider: 'gemini', model: 'gemini-3.5-flash-lite' },
      new AbortController().signal,
      [],
      [],
      undefined,
      true,
    )
    expect(log[0]).toMatchObject({ upstream: 'gemini', categories: ['question', 'passage-text', 'document-ids', 'api-key'] })
  })

  it('/models: api-key only', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ models: [] })))
    const { log, models } = await load()
    await models.fetchModelsFromWorker('openai', 'sk-fake-key-123')
    expect(log[0]).toMatchObject({ purpose: 'models', upstream: 'openai', categories: ['api-key'] })
  })

  it('/ocr: the whole file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: 't' })))
    const { log, ocr } = await load()
    await ocr.fetchOcrFromWorker('image/png', 'iVBORw0KGgo', new AbortController().signal)
    expect(log[0]).toMatchObject({ purpose: 'ocr', upstream: 'gemini', categories: ['ocr-file'] })
  })
})
