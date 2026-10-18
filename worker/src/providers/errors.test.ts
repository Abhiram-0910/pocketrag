import { describe, expect, it } from 'vitest'
import { ECHO_WITHHELD, ProviderError, providerError, redactKeys } from './errors'

function fakeResponse(status: number, body: string): Response {
  return { ok: false, status, text: async () => body } as Response
}

describe('providerError — live error shapes (fake-key responses captured 2026-10-18)', () => {
  it.each([
    {
      provider: 'Gemini',
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' },
          ],
        },
      },
      providerCode: 'API_KEY_INVALID',
      safeMessage: 'API key not valid. Please pass a valid API key.',
    },
    {
      provider: 'OpenAI',
      status: 401,
      body: { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', param: null, code: 'invalid_api_key' } },
      providerCode: 'invalid_api_key',
      safeMessage: 'Incorrect API key provided.',
    },
    {
      provider: 'Anthropic',
      status: 401,
      body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' }, request_id: 'req_1' },
      providerCode: 'authentication_error',
      safeMessage: 'invalid x-api-key',
    },
    {
      provider: 'Grok',
      status: 400,
      body: { code: 'invalid-argument', error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.' },
      providerCode: 'invalid-argument',
      safeMessage: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.',
    },
    {
      provider: 'OpenRouter',
      status: 401,
      body: { error: { message: 'User not found.', code: 401 } },
      providerCode: undefined,
      safeMessage: 'User not found.',
    },
  ])('$provider $status → providerCode $providerCode', async ({ provider, status, body, providerCode, safeMessage }) => {
    const err = await providerError(provider, fakeResponse(status, JSON.stringify(body)), 'unrelated-key-123')
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ provider, status, providerCode, safeMessage })
    expect(err.message).toBe(`${provider} API error ${status}: ${safeMessage}`)
  })

  it('keeps nothing from a non-JSON body — only its status', async () => {
    const err = await providerError('OpenAI', fakeResponse(502, '<html>Bad Gateway: upstream secret-ish detail</html>'), 'key-12345678')
    expect(err.safeMessage).toBe('HTTP 502')
    expect(err.providerCode).toBeUndefined()
    expect(err.message).not.toContain('upstream')
  })

  it('never stores the raw body on the error', async () => {
    const body = JSON.stringify({ error: { message: 'short', extra: 'EXTRA-FIELD-NEVER-KEPT' } })
    const err = await providerError('OpenAI', fakeResponse(400, body), 'key-12345678')
    expect(JSON.stringify(err)).not.toContain('EXTRA-FIELD-NEVER-KEPT')
    expect(Object.values(err).some((v) => typeof v === 'string' && v.includes('EXTRA-FIELD'))).toBe(false)
  })
})

describe('providerError — scrubbing order', () => {
  it('scrubs the exact key before truncating, so a key straddling the 200-char cut is still removed', async () => {
    const apiKey = 'sk-proj-EXACTKEY-0123456789abcdefghij'
    // Key starts at char 195 — truncating first would leave "sk-pr", which then no
    // longer matches the exact key.
    const message = `${'x'.repeat(195)}${apiKey} trailing`
    const err = await providerError('OpenAI', fakeResponse(401, JSON.stringify({ error: { message } })), apiKey)
    expect(err.safeMessage).not.toContain('sk-pr')
    // The placeholder itself is what gets cut at 200, not the key.
    expect(err.safeMessage).toBe(`${'x'.repeat(195)}[reda`)
  })

  it('caps safeMessage at 200 chars', async () => {
    const err = await providerError('OpenAI', fakeResponse(400, JSON.stringify({ error: { message: 'y'.repeat(1000) } })), 'key-12345678')
    expect(err.safeMessage).toHaveLength(200)
  })

  it('caps providerCode at 64 chars and drops one outside [\\w.:-] or containing the key', async () => {
    const long = await providerError('OpenAI', fakeResponse(400, JSON.stringify({ error: { code: 'C'.repeat(100) } })), 'key-12345678')
    expect(long.providerCode).toBe('C'.repeat(64))

    const badCharset = await providerError('OpenAI', fakeResponse(400, JSON.stringify({ error: { code: 'bad code <script>' } })), 'key-12345678')
    expect(badCharset.providerCode).toBeUndefined()

    const apiKey = 'sk-codekey-12345678'
    const keyed = await providerError('OpenAI', fakeResponse(400, JSON.stringify({ error: { code: apiKey } })), apiKey)
    expect(keyed.providerCode).toBeUndefined()
  })
})

describe('providerError — prompt echo guard', () => {
  // ≥40 chars and part of the prompt, per the Step A spec.
  const passageMarker = 'PASSAGE-MARKER-zq81-the-mitochondrion-is-the-powerhouse'
  const prompt = `Answer using ONLY these passages.\n[Doc 1, page 3] ${passageMarker} of the cell.\nQuestion: what?`

  it('withholds the whole message when the provider echoes prompt content back', async () => {
    expect(passageMarker.length).toBeGreaterThanOrEqual(40)
    expect(prompt).toContain(passageMarker)
    const body = JSON.stringify({ error: { message: `Invalid content near: "${passageMarker}"` } })
    const err = await providerError('OpenAI', fakeResponse(400, body), 'key-12345678', prompt)
    expect(err.safeMessage).toBe(ECHO_WITHHELD)
    expect(err.message).not.toContain(passageMarker)
  })

  it('leaves an ordinary message untouched when nothing in it appears in the prompt', async () => {
    const body = JSON.stringify({ error: { message: 'The model `gpt-9` does not exist or you do not have access to it.' } })
    const err = await providerError('OpenAI', fakeResponse(404, body), 'key-12345678', prompt)
    expect(err.safeMessage).toBe('The model `gpt-9` does not exist or you do not have access to it.')
  })

  it('runs on the truncated text only: an echo entirely past char 200 is cut, not withheld', async () => {
    const message = `${'z'.repeat(200)}${passageMarker}`
    const err = await providerError('OpenAI', fakeResponse(400, JSON.stringify({ error: { message } })), 'key-12345678', prompt)
    expect(err.safeMessage).toBe('z'.repeat(200))
  })
})

describe('redactKeys', () => {
  it.each([
    ['OpenAI', 'key sk-proj-abcdef123456 here'],
    ['Anthropic', 'key sk-ant-api03-abcdef123456 here'],
    ['OpenRouter', 'key sk-or-v1-abcdef123456 here'],
    ['xAI', 'key xai-abcdef123456 here'],
    ['Google', 'key AIzaSyAbcdef1234567890 here'],
    ['Bearer header', 'Authorization: Bearer abc.def.ghi here'],
    ["OpenAI's masked echo", 'Incorrect API key provided: sk-FAKEa***********7890. You can'],
  ])('redacts a %s-shaped key', (_label, text) => {
    const out = redactKeys(text)
    expect(out).toContain('[redacted]')
    expect(out).not.toMatch(/sk-|xai-|AIza|Bearer abc/)
  })

  it('does not touch ordinary words that merely contain the prefixes', () => {
    const text = 'task-manager and risk-free and maxai-thing'
    expect(redactKeys(text)).toBe(text)
  })
})
