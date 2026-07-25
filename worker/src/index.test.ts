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
  chunks: [{ text: 'The mitochondrion is the powerhouse of the cell.', page: 1, score: 0.9 }],
}

type IncomingRequest = Parameters<typeof worker.fetch>[0]

// A locally-constructed Request lacks the edge-only `cf` metadata the ambient Workers
// types expect on an incoming Request — irrelevant here since the handler never reads
// `request.cf`. Cast once, in test code only.
function asIncoming(req: Request): IncomingRequest {
  return req as unknown as IncomingRequest
}

function request(body: unknown, init: RequestInit = {}): IncomingRequest {
  return asIncoming(
    new Request('http://worker.local/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
      body: JSON.stringify(body),
      ...init,
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('worker fetch handler', () => {
  it('returns a composed answer with CORS headers for a valid request', async () => {
    mockGeminiSuccess('The mitochondrion powers the cell (page 1).')
    const res = await worker.fetch(request(validBody), makeEnv())

    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    const data = (await res.json()) as { answer: string; groundingWarning: boolean }
    expect(data.answer).toBe('The mitochondrion powers the cell (page 1).')
    expect(data.groundingWarning).toBe(false)
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
    const res = await worker.fetch(request({ question: '', chunks: [] }), makeEnv())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 429 once the rate limit is exceeded', async () => {
    mockGeminiSuccess('answer (page 1).')
    const env = makeEnv()
    for (let i = 0; i < 50; i++) {
      await worker.fetch(request(validBody), env)
    }
    const res = await worker.fetch(request(validBody), env)
    expect(res.status).toBe(429)
  })

  it('returns 502 when the Gemini call fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }),
    )
    const res = await worker.fetch(request(validBody), makeEnv())
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
