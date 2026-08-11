import { describe, expect, it, vi } from 'vitest'
import { callOpenRouter, listOpenRouterModels } from './openrouter'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  } as Response)
}

describe('callOpenRouter', () => {
  it('sends the API key as a Bearer header (never the URL), the model and prompt in the body, and the HTTP-Referer/X-Title identifying headers', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { choices: [{ message: { content: 'The answer (page 1).' } }] },
    })

    const answer = await callOpenRouter(fetchImpl, 'test-key', 'openai/gpt-4o-mini', 'What is x?')

    expect(answer).toBe('The answer (page 1).')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/chat/completions')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'HTTP-Referer': 'https://pocketrag.pages.dev',
      'X-Title': 'PocketRAG',
    })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('openai/gpt-4o-mini')
    expect(body.messages[0].content).toBe('What is x?')
  })

  it('throws with the status and body when OpenRouter returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'quota exceeded' })
    await expect(callOpenRouter(fetchImpl, 'key', 'openai/gpt-4o-mini', 'q')).rejects.toThrow(/429/)
  })

  it('throws when the response has no message content', async () => {
    const fetchImpl = mockFetch({ jsonBody: { choices: [] } })
    await expect(callOpenRouter(fetchImpl, 'key', 'openai/gpt-4o-mini', 'q')).rejects.toThrow(
      /did not contain any answer text/,
    )
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'sk-or-super-secret-value-should-never-leak-12345'
    try {
      await callOpenRouter(fetchImpl, secretKey, 'openai/gpt-4o-mini', 'q')
      expect.unreachable('callOpenRouter should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})

describe('listOpenRouterModels', () => {
  it('returns every model, mapping id/name to ModelInfo', async () => {
    const fetchImpl = mockFetch({
      jsonBody: {
        data: [
          { id: 'openai/gpt-4o-mini', name: 'OpenAI: GPT-4o-mini' },
          { id: 'anthropic/claude-sonnet-4-5', name: 'Anthropic: Claude Sonnet 4.5' },
        ],
      },
    })

    const models = await listOpenRouterModels(fetchImpl, 'test-key')

    expect(models).toEqual([
      { id: 'openai/gpt-4o-mini', displayName: 'OpenAI: GPT-4o-mini' },
      { id: 'anthropic/claude-sonnet-4-5', displayName: 'Anthropic: Claude Sonnet 4.5' },
    ])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('falls back to id when name is missing', async () => {
    const fetchImpl = mockFetch({ jsonBody: { data: [{ id: 'openai/gpt-4o-mini' }] } })
    const models = await listOpenRouterModels(fetchImpl, 'key')
    expect(models).toEqual([{ id: 'openai/gpt-4o-mini', displayName: 'openai/gpt-4o-mini' }])
  })

  it('returns an empty array when the provider returns no models', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    expect(await listOpenRouterModels(fetchImpl, 'key')).toEqual([])
  })

  it('throws with the status and body on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 403, textBody: 'permission denied' })
    await expect(listOpenRouterModels(fetchImpl, 'key')).rejects.toThrow(/403/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'sk-or-another-secret-value-should-never-leak-67890'
    try {
      await listOpenRouterModels(fetchImpl, secretKey)
      expect.unreachable('listOpenRouterModels should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})
