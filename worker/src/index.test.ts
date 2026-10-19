import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { DEFAULT_SHARED_MODEL } from './providers/gemini'
import type { KVLike } from './rateLimit'

// No real Workers runtime in these tests (plain node vitest, no Miniflare), so
// ExecutionContext is hand-mocked. Every makeCtx() call in a test pushes into the
// same per-test array, reset in beforeEach — tests that care about the fire-and-forget
// Discord call await flushWaitUntil() before asserting on it.
let waitUntilPromises: Promise<unknown>[]
function makeCtx(): ExecutionContext {
  return { waitUntil: (p: Promise<unknown>) => waitUntilPromises.push(p) } as unknown as ExecutionContext
}
function flushWaitUntil(): Promise<unknown> {
  return Promise.all(waitUntilPromises)
}
beforeEach(() => {
  waitUntilPromises = []
})

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

// Client-facing copy, duplicated here on purpose: a test that imported these from
// index.ts would pass even if the wording regressed.
const KEY_REJECTED_COPY = "The provider rejected your API key. Check that it's correct, active, and has access to this model."
const OWN_RATE_LIMITED_COPY = 'Your provider account hit its rate limit, quota, or credit balance. Wait a moment or check your plan.'
const SHARED_RATE_LIMITED_COPY = 'The free shared tier is at capacity right now. Try again later, or use your own API key.'
const REQUEST_REJECTED_COPY = 'The provider rejected this request. The selected model may not be available to your key; try another.'
const PROVIDER_UNAVAILABLE_COPY = "The provider couldn't respond right now. Please try again in a moment."
const SHARED_UNAVAILABLE_COPY = "The free tier couldn't respond right now. Try again in a moment, or use your own API key."
const EXPERIMENTAL_ANSWER_COPY =
  "This provider isn't fully supported yet. Please try Gemini or OpenAI for now — we're working on it."
const EXPERIMENTAL_MODELS_COPY =
  "This provider's model list isn't available yet. Please try Gemini or OpenAI for now — we're working on it."

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

function ocrRequest(body: unknown, init: RequestInit = {}): IncomingRequest {
  return request('/ocr', body, init)
}

const validOcrBody = { mimeType: 'image/jpeg', base64: 'aGVsbG8=' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('worker fetch handler — /answer, shared key', () => {
  it('returns a composed answer, doc labels, and CORS headers for a valid request', async () => {
    mockGeminiSuccess('The mitochondrion powers the cell (Doc 1, page 1).')
    const res = await worker.fetch(answerRequest(validBody), makeEnv(), makeCtx())

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

  it('keeps a prior-turn docLabels entry frozen and appends a new document at the next label', async () => {
    mockGeminiSuccess('See Doc 2, page 1.')
    const body = {
      question: 'What gives bread its chewy texture?',
      chunks: [{ text: 'Kneading develops gluten.', page: 1, score: 0.7, documentId: 'doc-2' }],
      docLabels: [{ label: 1, documentId: 'doc-1' }],
    }
    const res = await worker.fetch(answerRequest(body), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const data = (await res.json()) as { docLabels: { label: number; documentId: string }[] }
    expect(data.docLabels).toEqual([
      { label: 1, documentId: 'doc-1' },
      { label: 2, documentId: 'doc-2' },
    ])
  })

  it('interpolates a history array into the prompt sent to the provider', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const body = {
      ...validBody,
      history: [{ question: 'What is the mitochondrion?', answer: 'The powerhouse of the cell (Doc 1, page 1).' }],
    }
    await worker.fetch(answerRequest(body), makeEnv(), makeCtx())

    const [, init] = fetchSpy.mock.calls[0]
    const requestBody = JSON.parse((init as RequestInit).body as string) as {
      contents: { parts: { text: string }[] }[]
    }
    const prompt = requestBody.contents[0].parts[0].text
    expect(prompt).toContain('Conversation so far')
    expect(prompt).toContain('Q: What is the mitochondrion?')
    expect(prompt).toContain('A: The powerhouse of the cell (Doc 1, page 1).')
  })

  it('omits the conversation section from the prompt when no history is given', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    await worker.fetch(answerRequest(validBody), makeEnv(), makeCtx())

    const [, init] = fetchSpy.mock.calls[0]
    const requestBody = JSON.parse((init as RequestInit).body as string) as {
      contents: { parts: { text: string }[] }[]
    }
    expect(requestBody.contents[0].parts[0].text).not.toContain('Conversation so far')
  })

  it('forwards a shared-tier image as an inlineData part alongside the prompt (Milestone 10 Phase B)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'The chart shows rising values.' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const body = { ...validBody, image: { mimeType: 'image/jpeg', base64: 'aGVsbG8=' } }
    const res = await worker.fetch(answerRequest(body), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const [, init] = fetchSpy.mock.calls[0]
    const requestBody = JSON.parse((init as RequestInit).body as string) as {
      contents: { parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] }[]
    }
    expect(requestBody.contents[0].parts).toContainEqual({
      inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' },
    })
  })

  it('calls Gemini with the env secret key when keySource is omitted (backward compatible)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'answer' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    await worker.fetch(answerRequest(validBody), makeEnv({ GEMINI_API_KEY: 'env-secret-key' }), makeCtx())

    const [, init] = fetchSpy.mock.calls[0]
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'env-secret-key' })
  })

  it('rejects a non-POST /answer request with 404', async () => {
    const res = await worker.fetch(asIncoming(new Request('http://worker.local/answer')), makeEnv(), makeCtx())
    expect(res.status).toBe(404)
  })

  it('rejects an unknown path with 404', async () => {
    const res = await worker.fetch(
      asIncoming(new Request('http://worker.local/other', { method: 'POST', body: '{}' })),
      makeEnv(), makeCtx()
    )
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid input without calling Gemini', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest({ question: '', chunks: [] }), makeEnv(), makeCtx())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns 429 once the shared rate limit is exceeded, with a resetAt timestamp', async () => {
    mockGeminiSuccess('answer (page 1).')
    const env = makeEnv()
    for (let i = 0; i < 50; i++) {
      await worker.fetch(answerRequest(validBody), env, makeCtx())
    }
    const res = await worker.fetch(answerRequest(validBody), env, makeCtx())
    expect(res.status).toBe(429)
    const data = (await res.json()) as { error: string; resetAt: string }
    expect(data.resetAt).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/)
  })

  it('returns 502 with a sanitized message when the Gemini call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }))
    const res = await worker.fetch(answerRequest(validBody), makeEnv(), makeCtx())
    expect(res.status).toBe(502)
    const data = (await res.json()) as { error: string; code: string }
    expect(data.error).toBe(SHARED_UNAVAILABLE_COPY)
    expect(data.code).toBe('provider_unavailable')
    expect(data.error).not.toContain('server error')
  })

  it('handles OPTIONS preflight with CORS headers and no body', async () => {
    const res = await worker.fetch(
      asIncoming(
        new Request('http://worker.local/answer', {
          method: 'OPTIONS',
          headers: { Origin: 'http://localhost:5173' },
        }),
      ),
      makeEnv(), makeCtx()
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
      makeEnv(), makeCtx()
    )
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })
})

describe('worker fetch handler — /answer provider/model echo', () => {
  type Echo = { provider?: string; model?: string }

  it('shared tier: echoes gemini and the model of the one upstream call that answered', async () => {
    mockGeminiSuccess('answer (Doc 1, page 1).')
    const res = await worker.fetch(answerRequest(validBody), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const data = (await res.json()) as Echo
    const calls = vi.mocked(fetch).mock.calls
    expect(calls).toHaveLength(1)
    expect(String(calls[0][0])).toContain(`/models/${data.model}:generateContent`)
    expect(data).toMatchObject({ provider: 'gemini', model: DEFAULT_SHARED_MODEL })
  })

  it('own key, Gemini: echoes the requested model', async () => {
    mockGeminiSuccess('answer')
    const res = await worker.fetch(answerRequest(byokBody), makeEnv(), makeCtx())
    expect((await res.json()) as Echo).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-pro' })
  })

  it('own key, OpenAI: echoes the provider and the model sent in the request body', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'answer' } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest({ ...byokBody, provider: 'openai', model: 'gpt-4o-mini' }), makeEnv(), makeCtx())

    const sent = JSON.parse(String((fetchSpy.mock.calls[0][1] as RequestInit).body)) as { model: string }
    expect((await res.json()) as Echo).toMatchObject({ provider: 'openai', model: sent.model })
    expect(sent.model).toBe('gpt-4o-mini')
  })

  it('a failed answer carries no provider/model fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' }))
    const res = await worker.fetch(answerRequest(validBody), makeEnv(), makeCtx())
    expect(res.status).toBe(502)
    const data = (await res.json()) as Record<string, unknown>
    expect(data).not.toHaveProperty('provider')
    expect(data).not.toHaveProperty('model')
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
    const res = await worker.fetch(answerRequest(byokBody), makeEnv({ GEMINI_API_KEY: 'env-secret-key' }), makeCtx())

    expect(res.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('gemini-3.5-pro')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'user-supplied-key' })
    expect((init as RequestInit).headers).not.toMatchObject({ 'x-goog-api-key': 'env-secret-key' })
  })

  it('rejects a BYOK request end-to-end when it includes an image, even for provider "gemini" (Milestone 10 Phase B)', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const body = { ...byokBody, image: { mimeType: 'image/jpeg', base64: 'aGVsbG8=' } }
    const res = await worker.fetch(answerRequest(body), makeEnv(), makeCtx())

    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('dispatches to OpenAI, not Gemini, when the BYOK request specifies provider "openai"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'answer' } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(
      answerRequest({ ...byokBody, provider: 'openai', model: 'gpt-4o-mini' }),
      makeEnv({ GEMINI_API_KEY: 'env-secret-key' }), makeCtx()
    )

    expect(res.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-supplied-key' })
  })

  it('dispatches to Anthropic, not Gemini, when the BYOK request specifies provider "anthropic"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'answer' }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(
      answerRequest({ ...byokBody, provider: 'anthropic', model: 'claude-sonnet-4-5' }),
      makeEnv({ GEMINI_API_KEY: 'env-secret-key' }), makeCtx()
    )

    expect(res.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'user-supplied-key' })
  })

  it('dispatches to Grok, not Gemini, when the BYOK request specifies provider "grok"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'answer' } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(
      answerRequest({ ...byokBody, provider: 'grok', model: 'grok-4' }),
      makeEnv({ GEMINI_API_KEY: 'env-secret-key' }), makeCtx()
    )

    expect(res.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('api.x.ai')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-supplied-key' })
  })

  it('dispatches to OpenRouter, not Gemini, when the BYOK request specifies provider "openrouter"', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: 'answer' } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(
      answerRequest({ ...byokBody, provider: 'openrouter', model: 'openai/gpt-4o-mini' }),
      makeEnv({ GEMINI_API_KEY: 'env-secret-key' }), makeCtx()
    )

    expect(res.status).toBe(200)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('openrouter.ai')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-supplied-key' })
  })

  it('logs a structured, key-free entry with the classified code when a provider rejects the key (real Grok body shape)', async () => {
    const realSecretKey = 'xai-real-secret-should-never-appear-in-logs-13579'
    // Grok's live fake-key response: a 400 whose only key signal is the message text.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ code: 'invalid-argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await worker.fetch(
      answerRequest({ ...byokBody, provider: 'grok', model: 'grok-4', apiKey: realSecretKey }),
      makeEnv(), makeCtx()
    )

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: KEY_REJECTED_COPY, code: 'key_rejected' })

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const logged = consoleErrorSpy.mock.calls[0][0] as string
    expect(JSON.parse(logged)).toEqual({
      event: 'provider_call_failed',
      provider: 'grok',
      model: 'grok-4',
      keySource: 'own',
      code: 'key_rejected',
      status: 400,
      providerCode: 'invalid-argument',
      message: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.',
    })
    expect(logged).not.toContain(realSecretKey)

    consoleErrorSpy.mockRestore()
  })

  describe('key + passage echo (Step A test a): neither reaches the log, Discord, or the response', () => {
    const realSecretKey = 'sk-or-v1-REAL-SECRET-echoed-by-provider-0123456789'
    // >=40 chars and part of the prompt (it's the chunk text).
    const passage = 'PASSAGE-MARKER-zq81-confidential-clause-about-indemnity-terms'
    const discordWebhookUrl = 'https://discord.com/api/webhooks/1/token'

    async function run(endpoint: '/answer' | '/models', body: unknown) {
      // 503 so the own-key failure is provider_unavailable and Discord fires.
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (url === discordWebhookUrl) return { ok: true, status: 204, text: async () => '' }
        return {
          ok: false,
          status: 503,
          text: async () => JSON.stringify({ error: { message: `Upstream failed for key ${realSecretKey} on input "${passage}"` } }),
        }
      })
      vi.stubGlobal('fetch', fetchSpy)
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = await worker.fetch(request(endpoint, body), makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl }), makeCtx())
      await flushWaitUntil()
      const discordCall = fetchSpy.mock.calls.find(([url]) => url === discordWebhookUrl)
      const out = {
        status: res.status,
        responseText: await res.text(),
        logged: consoleErrorSpy.mock.calls.map((c) => String(c[0])).join('\n'),
        discordBody: discordCall ? String((discordCall[1] as RequestInit).body) : undefined,
      }
      consoleErrorSpy.mockRestore()
      return out
    }

    it('/answer', async () => {
      expect(passage.length).toBeGreaterThanOrEqual(40)
      const out = await run('/answer', {
        ...byokBody,
        provider: 'openrouter',
        model: 'openai/gpt-4o-mini',
        apiKey: realSecretKey,
        chunks: [{ text: passage, page: 1, score: 0.9, documentId: 'doc-1' }],
      })
      expect(out.status).toBe(502)
      expect(out.discordBody).toBeDefined()
      for (const sink of [out.responseText, out.logged, out.discordBody!]) {
        expect(sink).not.toContain(realSecretKey)
        expect(sink).not.toContain(passage)
      }
      // The echo guard, not just the key scrub, is what kept the passage out.
      expect(out.logged).toContain('[withheld: echoed request content]')
    })

    it('/models', async () => {
      const out = await run('/models', { provider: 'openrouter', apiKey: realSecretKey })
      expect(out.status).toBe(502)
      expect(out.discordBody).toBeDefined()
      for (const sink of [out.responseText, out.logged, out.discordBody!]) {
        expect(sink).not.toContain(realSecretKey)
      }
      expect(out.logged).toContain('[redacted]')
    })
  })

  it('suppresses a second Discord alert for the same provider+endpoint within the window', async () => {
    const discordWebhookUrl = 'https://discord.com/api/webhooks/1/token'
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url === discordWebhookUrl) return { ok: true, status: 204, text: async () => '' }
      return { ok: false, status: 500, text: async () => 'server error' }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl })

    await worker.fetch(answerRequest({ ...byokBody, provider: 'grok', model: 'grok-4' }), env, makeCtx())
    await flushWaitUntil()
    await worker.fetch(answerRequest({ ...byokBody, provider: 'grok', model: 'grok-4' }), env, makeCtx())
    await flushWaitUntil()

    const discordCalls = fetchSpy.mock.calls.filter(([url]) => url === discordWebhookUrl)
    expect(discordCalls).toHaveLength(1)

    consoleErrorSpy.mockRestore()
  })

  it('does not let a /models failure for a provider suppress a subsequent /answer failure for the same provider', async () => {
    const discordWebhookUrl = 'https://discord.com/api/webhooks/1/token'
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url === discordWebhookUrl) return { ok: true, status: 204, text: async () => '' }
      return { ok: false, status: 500, text: async () => 'server error' }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const env = makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl })

    await worker.fetch(request('/models', { provider: 'grok', apiKey: 'user-key' }), env, makeCtx())
    await flushWaitUntil()
    await worker.fetch(answerRequest({ ...byokBody, provider: 'grok', model: 'grok-4' }), env, makeCtx())
    await flushWaitUntil()

    const discordCalls = fetchSpy.mock.calls.filter(([url]) => url === discordWebhookUrl)
    expect(discordCalls).toHaveLength(2)

    consoleErrorSpy.mockRestore()
  })

  it('does not attempt a Discord alert when DISCORD_WEBHOOK_URL is not set (default env)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await worker.fetch(answerRequest(validBody), makeEnv(), makeCtx())
    await flushWaitUntil()

    expect(fetchSpy).toHaveBeenCalledTimes(1) // only the provider call, no Discord call attempted

    consoleErrorSpy.mockRestore()
  })

  it('rejects a BYOK request missing apiKey/provider/model without calling Gemini', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest({ ...validBody, keySource: 'own' }), makeEnv(), makeCtx())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('does not share a rate-limit bucket with shared-key requests from the same IP', async () => {
    mockGeminiSuccess('answer (page 1).')
    const env = makeEnv()
    // Exhaust the shared bucket (limit 50).
    for (let i = 0; i < 50; i++) {
      await worker.fetch(answerRequest(validBody), env, makeCtx())
    }
    const sharedBlocked = await worker.fetch(answerRequest(validBody), env, makeCtx())
    expect(sharedBlocked.status).toBe(429)

    // A BYOK request from the same IP must still go through — separate bucket.
    const byokRes = await worker.fetch(answerRequest(byokBody), env, makeCtx())
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
    const res = await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'user-key' }), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    const data = (await res.json()) as { models: { id: string; displayName: string }[] }
    expect(data.models).toEqual([{ id: 'gemini-3.5-pro', displayName: 'Gemini 3.5 Pro' }])
  })

  it('sends the request-supplied key as a header, never in the URL', async () => {
    mockGeminiModelList()
    await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'user-key' }), makeEnv(), makeCtx())
    const fetchSpy = fetch as ReturnType<typeof vi.fn>
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).not.toContain('user-key')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'user-key' })
  })

  it('rejects a request with a bad provider or missing apiKey without calling the provider', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(modelsRequest({ provider: 'mistral', apiKey: 'user-key' }), makeEnv(), makeCtx())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('dispatches to OpenAI, not Gemini, when provider is "openai"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'gpt-4o-mini' }] }),
        text: async () => '',
      }),
    )
    const res = await worker.fetch(modelsRequest({ provider: 'openai', apiKey: 'user-key' }), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const data = (await res.json()) as { models: { id: string; displayName: string }[] }
    expect(data.models).toEqual([{ id: 'gpt-4o-mini', displayName: 'gpt-4o-mini' }])
    const fetchSpy = fetch as ReturnType<typeof vi.fn>
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-key' })
  })

  it('dispatches to Anthropic, not Gemini, when provider is "anthropic"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] }),
        text: async () => '',
      }),
    )
    const res = await worker.fetch(modelsRequest({ provider: 'anthropic', apiKey: 'user-key' }), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const data = (await res.json()) as { models: { id: string; displayName: string }[] }
    expect(data.models).toEqual([{ id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' }])
    const fetchSpy = fetch as ReturnType<typeof vi.fn>
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect((init as RequestInit).headers).toMatchObject({ 'x-api-key': 'user-key' })
  })

  it('dispatches to Grok, not Gemini, when provider is "grok" (and hits /language-models, not /models)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ models: [{ id: 'grok-4' }] }),
        text: async () => '',
      }),
    )
    const res = await worker.fetch(modelsRequest({ provider: 'grok', apiKey: 'user-key' }), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const data = (await res.json()) as { models: { id: string; displayName: string }[] }
    expect(data.models).toEqual([{ id: 'grok-4', displayName: 'grok-4' }])
    const fetchSpy = fetch as ReturnType<typeof vi.fn>
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('api.x.ai')
    expect(url).toContain('/language-models')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-key' })
  })

  it('dispatches to OpenRouter, not Gemini, when provider is "openrouter"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini' }] }),
        text: async () => '',
      }),
    )
    const res = await worker.fetch(modelsRequest({ provider: 'openrouter', apiKey: 'user-key' }), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const data = (await res.json()) as { models: { id: string; displayName: string }[] }
    expect(data.models).toEqual([{ id: 'openai/gpt-4o-mini', displayName: 'OpenAI: GPT-4o-mini' }])
    const fetchSpy = fetch as ReturnType<typeof vi.fn>
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toContain('openrouter.ai')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer user-key' })
  })

  it('logs a structured, key-free entry and returns key_rejected when OpenRouter /key rejects the key', async () => {
    const realSecretKey = 'sk-or-real-secret-should-never-appear-in-logs-97531'
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: { message: 'User not found.', code: 401 } }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await worker.fetch(modelsRequest({ provider: 'openrouter', apiKey: realSecretKey }), makeEnv(), makeCtx())

    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: KEY_REJECTED_COPY, code: 'key_rejected' })
    expect(fetchSpy).toHaveBeenCalledTimes(1) // stopped at /key, never fetched the public catalog

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const logged = consoleErrorSpy.mock.calls[0][0] as string
    const parsed = JSON.parse(logged) as Record<string, unknown>
    expect(parsed).toMatchObject({ provider: 'openrouter', model: null, keySource: 'own', code: 'key_rejected', status: 401, message: 'User not found.' })
    expect(logged).not.toContain(realSecretKey)

    consoleErrorSpy.mockRestore()
  })

  it('sends a Discord alert for an unclassified /models failure with sanitized details, model null, and never the raw API key', async () => {
    const realSecretKey = 'sk-or-real-secret-should-never-reach-discord-44556'
    const discordWebhookUrl = 'https://discord.com/api/webhooks/1/token'
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url === discordWebhookUrl) return { ok: true, status: 204, text: async () => '' }
      return { ok: false, status: 503, text: async () => JSON.stringify({ error: { message: `overloaded (${realSecretKey})` } }) }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await worker.fetch(
      modelsRequest({ provider: 'openrouter', apiKey: realSecretKey }),
      makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl }), makeCtx()
    )
    expect(res.status).toBe(502)
    await flushWaitUntil()

    const discordCall = fetchSpy.mock.calls.find(([url]) => url === discordWebhookUrl)
    expect(discordCall).toBeDefined()
    const [, init] = discordCall!
    const body = (init as RequestInit).body as string
    expect(body).not.toContain(realSecretKey)
    const parsed = JSON.parse(body) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }
    const fields = Object.fromEntries(parsed.embeds[0].fields.map((f) => [f.name, f.value]))
    expect(fields.Provider).toBe('openrouter')
    expect(fields.Model).toBe('n/a')
    expect(fields.Status).toBe('503')
    expect(fields.Code).toBe('provider_unavailable')
    expect(fields.Tier).toBe('own')
    expect(fields.Message).toBe('overloaded ([redacted])')

    consoleErrorSpy.mockRestore()
  })

  it('rejects a non-POST /models request with 404', async () => {
    const res = await worker.fetch(asIncoming(new Request('http://worker.local/models')), makeEnv(), makeCtx())
    expect(res.status).toBe(404)
  })

  it('returns 502 with a sanitized message when the provider call fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'invalid key' }))
    const res = await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'bad-key-123' }), makeEnv(), makeCtx())
    expect(res.status).toBe(502)
    const data = (await res.json()) as { error: string; code: string }
    expect(data.error).toBe(KEY_REJECTED_COPY)
    expect(data.code).toBe('key_rejected')
    expect(data.error).not.toContain('invalid key')
  })

  it('shares the BYOK rate-limit bucket with BYOK /answer requests from the same IP', async () => {
    mockGeminiModelList()
    const env = makeEnv()
    // Exhaust the BYOK bucket (limit 500) via /models calls only.
    for (let i = 0; i < 500; i++) {
      await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'user-key' }), env, makeCtx())
    }
    const modelsBlocked = await worker.fetch(modelsRequest({ provider: 'gemini', apiKey: 'user-key' }), env, makeCtx())
    expect(modelsBlocked.status).toBe(429)

    // A BYOK /answer request from the same IP must also be blocked — same bucket.
    const answerBlocked = await worker.fetch(answerRequest(byokBody), env, makeCtx())
    expect(answerBlocked.status).toBe(429)
  })
})

describe('worker fetch handler — /ocr (Milestone 9 Phase A)', () => {
  it('returns transcribed text and CORS headers for a valid request', async () => {
    mockGeminiSuccess('Meeting notes: buy milk, call Alex, project deadline Friday.')
    const res = await worker.fetch(ocrRequest(validOcrBody), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173')
    const data = (await res.json()) as { text: string }
    expect(data.text).toBe('Meeting notes: buy milk, call Alex, project deadline Friday.')
  })

  it('rejects a request with an unsupported mimeType without calling Gemini', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(ocrRequest({ mimeType: 'text/plain', base64: 'aGVsbG8=' }), makeEnv(), makeCtx())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('rejects a request carrying keySource/apiKey — OcrRequestBody has no such field, so it is simply ignored, never routed to a BYOK provider', async () => {
    mockGeminiSuccess('transcribed text')
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('generativelanguage.googleapis.com')) {
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }
      }
      throw new Error(`unexpected fetch to ${url}`)
    })
    vi.stubGlobal('fetch', fetchSpy)

    const res = await worker.fetch(
      ocrRequest({ ...validOcrBody, keySource: 'own', apiKey: 'sk-should-be-ignored', provider: 'openai' }),
      makeEnv(),
      makeCtx(),
    )

    expect(res.status).toBe(200)
    // Only Gemini's own generateContent endpoint was ever hit — proves the ignored
    // apiKey/provider fields never reached a dispatch switch.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect((fetchSpy.mock.calls[0][0] as string)).toContain('generativelanguage.googleapis.com')
  })

  it('has its own rate-limit bucket, independent of the shared /answer bucket', async () => {
    mockGeminiSuccess('answer (page 1).')
    const env = makeEnv()
    // Exhaust the OCR bucket (limit 20).
    for (let i = 0; i < 20; i++) {
      await worker.fetch(ocrRequest(validOcrBody), env, makeCtx())
    }
    const ocrBlocked = await worker.fetch(ocrRequest(validOcrBody), env, makeCtx())
    expect(ocrBlocked.status).toBe(429)

    // The shared /answer bucket (limit 50) must be untouched by the 20 OCR calls above.
    const answerStillAllowed = await worker.fetch(answerRequest(validBody), env, makeCtx())
    expect(answerStillAllowed.status).toBe(200)
  })

  // Milestone 9 Phase A: /ocr sends real note content (a full image), not a retrieved
  // snippet — unlike /answer's logProviderError, which logs err.message verbatim and
  // is safe only because nothing sent to a provider there is private in the same way.
  // This proves the dedicated, narrower /ocr failure path never forwards the raw
  // provider error body — which could in principle echo back request content on a
  // 400 — into either Workers Logs or the Discord alert. Only status/generic text.
  it('never logs or Discords real content from a failed OCR call — only status and a generic message', async () => {
    const noteContent = 'Patient chart: diagnosis confidential, SSN 555-12-3456, do not disclose'
    const discordWebhookUrl = 'https://discord.com/api/webhooks/1/token'
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url === discordWebhookUrl) return { ok: true, status: 204, text: async () => '' }
      // A realistic-shaped failure whose body happens to echo request content back —
      // the exact scenario this test exists to guard against.
      return { ok: false, status: 400, text: async () => `Bad request, received: "${noteContent}"` }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await worker.fetch(
      ocrRequest(validOcrBody),
      makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl }),
      makeCtx(),
    )
    expect(res.status).toBe(502)
    const data = (await res.json()) as { error: string }
    expect(data.error).not.toContain(noteContent)
    await flushWaitUntil()

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
    const logged = consoleErrorSpy.mock.calls[0][0] as string
    expect(logged).not.toContain(noteContent)
    const parsedLog = JSON.parse(logged) as { event: string; status: string }
    expect(parsedLog).toEqual({ event: 'ocr_call_failed', status: '400' })

    const discordCall = fetchSpy.mock.calls.find(([url]) => url === discordWebhookUrl)
    expect(discordCall).toBeDefined()
    const [, init] = discordCall!
    const discordBody = (init as RequestInit).body as string
    expect(discordBody).not.toContain(noteContent)
    const parsedDiscord = JSON.parse(discordBody) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }
    const fields = Object.fromEntries(parsedDiscord.embeds[0].fields.map((f) => [f.name, f.value]))
    expect(fields.Status).toBe('400')
    expect(fields.Message).toBe('OCR request failed.')

    consoleErrorSpy.mockRestore()
  })

  it('does not attempt a Discord alert when DISCORD_WEBHOOK_URL is not set (default env)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await worker.fetch(ocrRequest(validOcrBody), makeEnv(), makeCtx())
    await flushWaitUntil()

    expect(fetchSpy).toHaveBeenCalledTimes(1) // only the Gemini call, no Discord call attempted

    consoleErrorSpy.mockRestore()
  })
})

function mockGeminiGroundedSuccess(text: string, webSources: { uri: string; title: string }[], searchEntryPointHtml?: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text }] },
            groundingMetadata: {
              searchEntryPoint: searchEntryPointHtml !== undefined ? { renderedContent: searchEntryPointHtml } : undefined,
              groundingChunks: webSources.map((web) => ({ web })),
            },
          },
        ],
      }),
      text: async () => '',
    }),
  )
}

describe('worker fetch handler — /answer, Gemini-native grounding (Milestone 12, final scope: BYOK-gemini only)', () => {
  it('rejects enableWebSearch on a shared-tier request with a 400, never reaching the provider call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest({ ...validBody, enableWebSearch: true }), makeEnv(), makeCtx())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('still answers a shared-tier request normally when enableWebSearch is omitted — no tools field sent, no grounding fields populated', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'answer (Doc 1, page 1).' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest(validBody), makeEnv(), makeCtx())

    expect(res.status).toBe(200)
    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.tools).toBeUndefined()
    const data = (await res.json()) as { webSources: unknown[]; searchEntryPointHtml?: string }
    expect(data.webSources).toEqual([])
    expect(data.searchEntryPointHtml).toBeUndefined()
  })

  it('sends tools: [{"google_search": {}}] to Gemini on a BYOK-gemini request with enableWebSearch true', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'answer (Doc 1, page 1).' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    await worker.fetch(answerRequest({ ...byokBody, enableWebSearch: true }), makeEnv(), makeCtx())
    const [, init] = fetchSpy.mock.calls[0]
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.tools).toEqual([{ google_search: {} }])
  })

  it('returns webSources: [] when grounding was enabled but Gemini chose not to search this turn (BYOK-gemini)', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'answer (Doc 1, page 1).' }] } }] }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchSpy)
    const res = await worker.fetch(answerRequest({ ...byokBody, enableWebSearch: true }), makeEnv(), makeCtx())
    const data = (await res.json()) as { webSources: unknown[] }
    expect(data.webSources).toEqual([])
  })

  it('accepts enableWebSearch on a BYOK request that chose provider "gemini"', async () => {
    mockGeminiGroundedSuccess('answer.', [{ uri: 'https://example.com', title: 'Source' }])
    const res = await worker.fetch(answerRequest({ ...byokBody, enableWebSearch: true }), makeEnv(), makeCtx())
    expect(res.status).toBe(200)
    const data = (await res.json()) as { webSources: { uri: string; title: string }[] }
    expect(data.webSources).toEqual([{ uri: 'https://example.com', title: 'Source' }])
  })

  it('rejects enableWebSearch on a BYOK request for a non-Gemini provider with a 400, never reaching the provider call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const nonGeminiByokBody = {
      ...validBody,
      keySource: 'own',
      apiKey: 'user-supplied-key',
      provider: 'openai',
      model: 'gpt-4o-mini',
      enableWebSearch: true,
    }
    const res = await worker.fetch(answerRequest(nonGeminiByokBody), makeEnv(), makeCtx())
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('provider failure classification (Step A): status → code, client copy, and Discord gating', () => {
  const discordWebhookUrl = 'https://discord.com/api/webhooks/1/token'
  const MODEL_FOR: Record<string, string> = {
    gemini: 'gemini-3.5-pro',
    openai: 'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-5',
    grok: 'grok-4',
    openrouter: 'openai/gpt-4o-mini',
  }

  async function failWith(tier: 'shared' | 'own', provider: string, status: number, body: unknown) {
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url === discordWebhookUrl) return { ok: true, status: 204, text: async () => '' }
      return { ok: false, status, text: async () => JSON.stringify(body) }
    })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const reqBody = tier === 'shared' ? validBody : { ...byokBody, provider, model: MODEL_FOR[provider] }
    const res = await worker.fetch(answerRequest(reqBody), makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl }), makeCtx())
    await flushWaitUntil()
    consoleErrorSpy.mockRestore()
    return {
      status: res.status,
      json: (await res.json()) as Record<string, unknown>,
      alerted: fetchSpy.mock.calls.some(([url]) => url === discordWebhookUrl),
    }
  }

  const msg = (message: string) => ({ error: { message } })

  it.each([
    // tier,   provider,     status, body,                                                                                     code,                    source,    copy,                        alerts
    ['shared', 'gemini',     429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } },          'provider_rate_limited', 'shared',  SHARED_RATE_LIMITED_COPY,    true],
    ['shared', 'gemini',     400, { error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }, 'provider_unavailable', undefined, SHARED_UNAVAILABLE_COPY,   true],
    ['shared', 'gemini',     403, { error: { code: 403, status: 'PERMISSION_DENIED', message: 'denied' } },                   'provider_unavailable',  undefined, SHARED_UNAVAILABLE_COPY,     true],
    ['shared', 'gemini',     503, { error: { code: 503, status: 'UNAVAILABLE', message: 'overloaded' } },                     'provider_unavailable',  undefined, SHARED_UNAVAILABLE_COPY,     true],
    ['own',    'gemini',     400, { error: { code: 400, message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }, 'key_rejected',       undefined, KEY_REJECTED_COPY,           false],
    ['own',    'openai',     401, { error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Incorrect API key' } }, 'key_rejected',  undefined, KEY_REJECTED_COPY,           false],
    ['own',    'anthropic',  401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },  'key_rejected',          undefined, KEY_REJECTED_COPY,           false],
    ['own',    'openai',     403, msg('Project does not have access'),                                                        'key_rejected',          undefined, KEY_REJECTED_COPY,           false],
    ['own',    'grok',       400, { code: 'invalid-argument', error: 'Incorrect API key provided.' },                         'key_rejected',          undefined, KEY_REJECTED_COPY,           false],
    ['own',    'openai',     429, { error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } },                  'provider_rate_limited', 'own',     OWN_RATE_LIMITED_COPY,       false],
    ['own',    'openrouter', 402, { error: { code: 402, message: 'Insufficient credits' } },                                  'provider_rate_limited', 'own',     OWN_RATE_LIMITED_COPY,       false],
    ['own',    'openai',     400, msg("Unsupported parameter: 'messages'"),                                                   'request_rejected',      undefined, REQUEST_REJECTED_COPY,       false],
    ['own',    'openai',     404, { error: { code: 'model_not_found', message: 'The api key cannot use model x' } },          'request_rejected',      undefined, REQUEST_REJECTED_COPY,       false],
    ['own',    'openai',     413, msg('Request too large'),                                                                   'request_rejected',      undefined, REQUEST_REJECTED_COPY,       false],
    ['own',    'anthropic',  400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens too large' } }, 'request_rejected',     undefined, REQUEST_REJECTED_COPY,       true],
    ['own',    'openrouter', 404, msg('No endpoints found for model'),                                                        'request_rejected',      undefined, REQUEST_REJECTED_COPY,       true],
    ['own',    'grok',       422, msg('Unprocessable'),                                                                       'request_rejected',      undefined, REQUEST_REJECTED_COPY,       true],
    ['own',    'openai',     500, msg('server error'),                                                                        'provider_unavailable',  undefined, PROVIDER_UNAVAILABLE_COPY,   true],
    ['own',    'anthropic',  529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },              'provider_unavailable',  undefined, PROVIDER_UNAVAILABLE_COPY,   true],
    ['own',    'openai',     418, msg('teapot'),                                                                              'provider_unavailable',  undefined, PROVIDER_UNAVAILABLE_COPY,   true],
    ['own',    'grok',       418, msg('teapot'),                                                                              'provider_unavailable',  undefined, EXPERIMENTAL_ANSWER_COPY,    true],
  ] as const)(
    '%s %s %i → %s',
    async (tier, provider, status, body, code, source, copy, alerts) => {
      const out = await failWith(tier, provider, status, body)
      expect(out.status).toBe(502)
      expect(out.json).toEqual(source === undefined ? { error: copy, code } : { error: copy, code, source })
      expect(out.alerted).toBe(alerts)
    },
  )

  it.each([
    ['grok', EXPERIMENTAL_ANSWER_COPY],
    ['openai', PROVIDER_UNAVAILABLE_COPY],
  ])('a network failure (fetch rejects) on %s is unclassified provider_unavailable and alerts', async (provider, copy) => {
    const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
      if (url === discordWebhookUrl) return { ok: true, status: 204, text: async () => '' }
      throw new TypeError('Network connection lost.')
    })
    vi.stubGlobal('fetch', fetchSpy)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await worker.fetch(
      answerRequest({ ...byokBody, provider, model: MODEL_FOR[provider] }),
      makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl }),
      makeCtx(),
    )
    await flushWaitUntil()
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: copy, code: 'provider_unavailable' })
    expect(JSON.parse(consoleErrorSpy.mock.calls[0][0] as string)).toMatchObject({ status: null, message: 'Network connection lost.' })
    expect(fetchSpy.mock.calls.some(([url]) => url === discordWebhookUrl)).toBe(true)
    consoleErrorSpy.mockRestore()
  })

  it('uses the Experimental /models copy for an unclassified /models failure on an Experimental provider', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 418, text: async () => '' }))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await worker.fetch(request('/models', { provider: 'grok', apiKey: 'xai-user-key-123' }), makeEnv(), makeCtx())
    expect(await res.json()).toEqual({ error: EXPERIMENTAL_MODELS_COPY, code: 'provider_unavailable' })
    consoleErrorSpy.mockRestore()
  })

  it('a shared 429 then a shared 503 on /answer within the window both alert (rate limiting has its own slot)', async () => {
    const env = makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let providerStatus = 429
    const fetchSpy = vi.fn().mockImplementation(async (url: string) =>
      url === discordWebhookUrl
        ? { ok: true, status: 204, text: async () => '' }
        : { ok: false, status: providerStatus, text: async () => '' },
    )
    vi.stubGlobal('fetch', fetchSpy)

    await worker.fetch(answerRequest(validBody), env, makeCtx())
    await flushWaitUntil()
    providerStatus = 503
    await worker.fetch(answerRequest(validBody), env, makeCtx())
    await flushWaitUntil()

    const alerts = fetchSpy.mock.calls.filter(([url]) => url === discordWebhookUrl)
    expect(alerts).toHaveLength(2)
    const codes = alerts.map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }
      return body.embeds[0].fields.find((f) => f.name === 'Code')?.value
    })
    expect(codes).toEqual(['provider_rate_limited', 'provider_unavailable'])
    consoleErrorSpy.mockRestore()
  })

  it('suppresses a shared-tier rate-limit alert for 6h in its own slot, and other alerts for 10 min', async () => {
    const puts: { key: string; ttl?: number }[] = []
    const store: Record<string, string> = {}
    const kv: KVLike = {
      get: async (key) => store[key] ?? null,
      put: async (key, value, options) => {
        store[key] = value
        puts.push({ key, ttl: options?.expirationTtl })
      },
    }
    const env = makeEnv({ DISCORD_WEBHOOK_URL: discordWebhookUrl, RATE_LIMIT_KV: kv as unknown as Env['RATE_LIMIT_KV'] })
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failingFetch = (status: number) =>
      vi.fn().mockImplementation(async (url: string) =>
        url === discordWebhookUrl ? { ok: true, status: 204, text: async () => '' } : { ok: false, status, text: async () => '' },
      )

    vi.stubGlobal('fetch', failingFetch(429))
    await worker.fetch(answerRequest(validBody), env, makeCtx())
    vi.stubGlobal('fetch', failingFetch(503))
    await worker.fetch(answerRequest({ ...byokBody, provider: 'openai', model: 'gpt-4o-mini' }), env, makeCtx())
    await flushWaitUntil()

    const discordPuts = puts.filter((p) => p.key.startsWith('discord-notify:'))
    expect(discordPuts).toEqual([
      { key: 'discord-notify:gemini:answer:shared-ratelimit', ttl: 21600 },
      { key: 'discord-notify:openai:answer:own', ttl: 600 },
    ])
    consoleErrorSpy.mockRestore()
  })
})

describe('BYOK key validation end-to-end (Step A tests b and e)', () => {
  it.each([
    ['a newline', 'sk-abcdef\n12345'],
    ['a non-latin1 char', 'sk-abcdefĀ-12345'],
  ])('rejects a key containing %s with 400 on /answer and /models, never reaching fetch', async (_label, apiKey) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const answer = await worker.fetch(answerRequest({ ...byokBody, provider: 'openai', model: 'gpt-4o-mini', apiKey }), makeEnv(), makeCtx())
    const models = await worker.fetch(request('/models', { provider: 'openai', apiKey }), makeEnv(), makeCtx())
    expect(answer.status).toBe(400)
    expect(models.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', {}],
    ['empty', { apiKey: '' }],
  ])('keySource own with a %s apiKey → 400, and env.GEMINI_API_KEY is never sent', async (_label, keyField) => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { apiKey: _omit, ...withoutKey } = byokBody
    const res = await worker.fetch(
      answerRequest({ ...withoutKey, ...keyField }),
      makeEnv({ GEMINI_API_KEY: 'ENV-SHARED-KEY-must-not-be-used' }),
      makeCtx(),
    )
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
