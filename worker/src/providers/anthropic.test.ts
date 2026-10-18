import { describe, expect, it, vi } from 'vitest'
import { callAnthropic, listAnthropicModels } from './anthropic'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  } as Response)
}

describe('callAnthropic', () => {
  it('sends the API key as an x-api-key header (never the URL), plus the version header, model, max_tokens, and prompt', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { content: [{ type: 'text', text: 'The answer (page 1).' }] },
    })

    const answer = await callAnthropic(fetchImpl, 'test-key', 'claude-sonnet-4-5', 'What is x?')

    expect(answer).toBe('The answer (page 1).')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/messages')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
    })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.max_tokens).toBe(2048)
    expect(body.messages[0].content).toBe('What is x?')
  })

  it('reads the first text content block, skipping any non-text block ahead of it', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { content: [{ type: 'thinking', text: 'internal reasoning' }, { type: 'text', text: 'The real answer.' }] },
    })
    const answer = await callAnthropic(fetchImpl, 'key', 'claude-sonnet-4-5', 'q')
    expect(answer).toBe('The real answer.')
  })

  it('throws a ProviderError carrying the status when Anthropic returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'rate limited' })
    await expect(callAnthropic(fetchImpl, 'key', 'claude-sonnet-4-5', 'q')).rejects.toThrow(/429/)
  })

  it('throws when the response has no text content block', async () => {
    const fetchImpl = mockFetch({ jsonBody: { content: [] } })
    await expect(callAnthropic(fetchImpl, 'key', 'claude-sonnet-4-5', 'q')).rejects.toThrow(
      /did not contain any answer text/,
    )
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const secretKey = 'sk-ant-super-secret-value-should-never-leak-12345'
    // The provider body echoes the key back — the exact-key scrub must remove it.
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      textBody: JSON.stringify({ error: { message: `invalid x-api-key: ${secretKey}` } }),
    })
    try {
      await callAnthropic(fetchImpl, secretKey, 'claude-sonnet-4-5', 'q')
      expect.unreachable('callAnthropic should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
      expect((err as Error).message).toContain('[redacted]')
    }
  })
})

describe('listAnthropicModels', () => {
  it('requests a large page size (limit=1000) and maps id/display_name to ModelInfo', async () => {
    const fetchImpl = mockFetch({
      jsonBody: {
        data: [
          { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
          { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
        ],
        first_id: 'claude-opus-4-6',
        has_more: false,
        last_id: 'claude-sonnet-4-5',
      },
    })

    const models = await listAnthropicModels(fetchImpl, 'test-key')

    expect(models).toEqual([
      { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
      { id: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5' },
    ])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('limit=1000')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
    })
  })

  it('falls back to id when display_name is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: [{ id: 'claude-sonnet-4-5' }] } })
    const models = await listAnthropicModels(fetchImpl, 'key')
    expect(models).toEqual([{ id: 'claude-sonnet-4-5', displayName: 'claude-sonnet-4-5' }])
  })

  it('returns an empty array when the provider returns no models', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    expect(await listAnthropicModels(fetchImpl, 'key')).toEqual([])
  })

  it('throws a ProviderError carrying the status on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 403, textBody: 'permission denied' })
    await expect(listAnthropicModels(fetchImpl, 'key')).rejects.toThrow(/403/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const secretKey = 'sk-ant-another-secret-value-should-never-leak-67890'
    // The provider body echoes the key back — the exact-key scrub must remove it.
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      textBody: JSON.stringify({ error: { message: `invalid x-api-key: ${secretKey}` } }),
    })
    try {
      await listAnthropicModels(fetchImpl, secretKey)
      expect.unreachable('listAnthropicModels should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
      expect((err as Error).message).toContain('[redacted]')
    }
  })
})
