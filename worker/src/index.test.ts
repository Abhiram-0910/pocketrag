import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import type { KVLike } from './rateLimit'

function fakeKV(): KVLike {
  const store: Record<string, string> = {}
  return {
    get: async (key) => store[key] ?? null,
    put: async (key, value) => {
      store[key] = value
    },
  }
}

// PAGES_ORIGIN is typed as the literal "" from wrangler.jsonc's placeholder value —
// it's meant to be overridden per-deploy, so widen it for test purposes.
type TestEnv = Omit<Env, 'PAGES_ORIGIN'> & { PAGES_ORIGIN: string }

function makeEnv(overrides: Partial<TestEnv> = {}): Env {
  return {
    RATE_LIMIT_KV: fakeKV() as unknown as Env['RATE_LIMIT_KV'],
    GEMINI_API_KEY: 'test-key',
    PAGES_ORIGIN: 'https://pocketrag.pages.dev',
    ...overrides,
  } as Env
}

function mockGeminiSuccess(text: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      text: async () => '',
    }),
  )
}

const validBody = {
  question: 'What powers the cell?',
  chunks: [{ text: 'The mitochondrion is the powerhouse of the cell.', page: 1, score: 0.9, documentId: 'doc-1' }],
}

const byokBody = {
  ...validBody,
  keySource: 'own',
  apiKey: 'user-supplied-key',
  provider: 'gemini',
  model: 'gemini-3.5-pro',
}

type IncomingRequest = Parameters<typeof worker.fetch>[0]

// A locally-constructed Request lacks the edge-only `cf` metadata the ambient Workers
// types expect on an incoming Request — irrelevant here since the handler never reads
// `request.cf`. Cast once, in test code only.
function asIncoming(req: Request): IncomingRequest {
  return req as unknown as IncomingRequest
}

function request(path: string, body: unknown, init: RequestInit = {}): IncomingRequest {
  return asIncoming(
    new Request(`http://worker.local${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: JSON.stringify(body),
      ...init,
    }),
  )
}

function answerRequest(body: unknown, init: RequestInit = {}): IncomingRequest {
  return request('/answer', body, init)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('worker fetch handler — /answer, shared key', () => {
  it('returns a composed answer, doc labels, and CORS headers for a valid request', async () => {
    mockGeminiSuccess('The mitochondrion powers the cell (Doc 1, page 1).')
    const res = await worker.fetch(answerRequest(validBody), makeEnv())

    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    const data = (await res.json()) as {
      answer: string
      groundingWarning: boolean
      docLabels: { label: number; documentId: string }[]
    }
    expect(data.answer).toBe('The mitochondrion powers the cell (Doc 1, page 1).')
    expect(data.groundingWarning).toBe(false)
    expect(data.docLabels).toEqual([{ label: 1, documentId: 'doc-1' }])
  })

  it('calls Gemini with the env secret key when keySource is omitted (backward compatible)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    await worker.fetch(answerRequest(validBody), makeEnv({ GEMINI_API_KEY: 'env-secret-key' }))

    const [, init] = fetchSpy.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'env-secret-key' })
  })

  it('rejects a non-POST /answer request with 404', async () => {
    const res = await worker.fetch(asIncoming(new Request('http://worker.local/answer')), makeEnv())
    expect(res.status).toBe(404)
  })

  it('rejects an unknown path with 404', async () => {
    const res = await worker.fetch(
      asIncoming(new Request('http://worker.local/other', { method: 'POST', body: '{}' })),
      makeEnv(),
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid input without calling Gemini', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest({ question: '', chunks: [] }), makeEnv())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 429 once the shared rate limit is exceeded', async () => {
    mockGeminiSuccess('answer (page 1).')
    const env = makeEnv()
    for (let i = 0; i < 50; i++) {
      await worker.fetch(answerRequest(validBody), env)
    }
    const res = await worker.fetch(answerRequest(validBody), env)
    expect(res.status).toBe(429)
  })

  it('returns 502 when the Gemini call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }))
    const res = await worker.fetch(answerRequest(validBody), makeEnv())
    expect(res.status).toBe(502)
  })

  it('handles OPTIONS preflight with CORS headers and no body', async () => {
    const res = await worker.fetch(
      asIncoming(
        new Request('http://worker.local/answer', {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:5173' },
        }),
      ),
      makeEnv(),
    )
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
  })

  it('omits CORS headers for a disallowed origin', async () => {
    mockGeminiSuccess('answer (page 1).')
    const res = await worker.fetch(
      asIncoming(
        new Request('http://worker.local/answer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
          body: JSON.stringify(validBody),
        }),
      ),
      makeEnv(),
    )
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('worker fetch handler — /answer, BYOK', () => {
  it('calls Gemini with the request-supplied key and model, not the env secret', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest(byokBody), makeEnv({ GEMINI_API_KEY: 'env-secret-key' }))

    expect(res.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('gemini-3.5-pro')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'user-supplied-key' })
    expect((init as RequestInit).headers).not.toMatchObject({ 'x-goog-api-key': 'env-secret-key' })
  })

  it('rejects a BYOK request missing apiKey/provider/model without calling Gemini', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest({ ...validBody, keySource: 'own' }), makeEnv())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not share a rate-limit bucket with shared-key requests from the same IP', async () => {
    mockGeminiSuccess('answer (page 1).')
    const env = makeEnv()
    // Exhaust the shared bucket (limit 50).
    for (let i = 0; i < 50; i++) {
      await worker.fetch(answerRequest(validBody), env)
    }
    const sharedBlocked = await worker.fetch(answerRequest(validBody), env)
    expect(sharedBlocked.status).toBe(429)

    // A BYOK request from the same IP must still go through — separate bucket.
    const byokRes = await worker.fetch(answerRequest(byokBody), env)
    expect(byokRes.status).toBe(200)
  })
})

describe('worker fetch handler — /models', () => {
  function modelsRequest(body: unknown): IncomingRequest {
    return request('/models', body)
  }

  function mockGeminiModelList() {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            {
              name: 'models/gemini-3.5-pro',
              displayName: 'Gemini 3.5 Pro',
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        }),
        text: async () => '',
      }),
    )
  }

  it('returns the model list with CORS headers for a valid request', async () => {
    mockGeminiModelList()
    const res = await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'user-key' }), makeEnv())

    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    const data = (await res.json()) as { models: { id: string; displayName: string }[] }
    expect(data.models).toEqual([{ id: 'gemini-3.5-pro', displayName: 'Gemini 3.5 Pro' }])
  })

  it('sends the request-supplied key as a header, never in the URL', async () => {
    mockGeminiModelList()
    await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'user-key' }), makeEnv())
    const fetchSpy = fetch as ReturnType<typeof vi.fn>
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).not.toContain('user-key')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'user-key' })
  })

  it('rejects a request with a bad provider or missing apiKey without calling the provider', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(modelsRequest({ provider: 'openai', apiKey: 'user-key' }), makeEnv())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a non-POST /models request with 404', async () => {
    const res = await worker.fetch(asIncoming(new Request('http://worker.local/models')), makeEnv())
    expect(res.status).toBe(404)
  })

  it('returns 502 when the provider call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid key' }))
    const res = await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'bad-key' }), makeEnv())
    expect(res.status).toBe(502)
  })

  it('shares the BYOK rate-limit bucket with BYOK /answer requests from the same IP', async () => {
    mockGeminiModelList()
    const env = makeEnv()
    // Exhaust the BYOK bucket (limit 500) via /models calls only.
    for (let i = 0; i < 500; i++) {
      await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'user-key' }), env)
    }
    const modelsBlocked = await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'user-key' }), env)
    expect(modelsBlocked.status).toBe(429)

    // A BYOK /answer request from the same IP must also be blocked — same bucket.
    const answerBlocked = await worker.fetch(answerRequest(byokBody), env)
    expect(answerBlocked.status).toBe(429)
  })
})
