import { describe, expect, it, vi } from 'vitest'
import { callGrok, listGrokModels } from './grok'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  } as Response)
}

describe('callGrok', () => {
  it('sends the API key as a Bearer header (never the URL), the model and prompt in the body', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { choices: [{ message: { content: 'The answer (page 1).' } }] },
    })

    const answer = await callGrok(fetchImpl, 'test-key', 'grok-4', 'What is x?')

    expect(answer).toBe('The answer (page 1).')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/chat/completions')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('grok-4')
    expect(body.messages[0].content).toBe('What is x?')
  })

  it('throws with the status and body when Grok returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'quota exceeded' })
    await expect(callGrok(fetchImpl, 'key', 'grok-4', 'q')).rejects.toThrow(/429/)
  })

  it('throws when the response has no message content', async () => {
    const fetchImpl = mockFetch({ jsonBody: { choices: [] } })
    await expect(callGrok(fetchImpl, 'key', 'grok-4', 'q')).rejects.toThrow(/did not contain any answer text/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'xai-super-secret-value-should-never-leak-12345'
    try {
      await callGrok(fetchImpl, secretKey, 'grok-4', 'q')
      expect.unreachable('callGrok should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})

describe('listGrokModels', () => {
  it('requests /language-models (not /models) and maps id to ModelInfo (no display-name field)', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { models: [{ id: 'grok-4', aliases: ['grok-4-latest'] }] },
    })

    const models = await listGrokModels(fetchImpl, 'test-key')

    expect(models).toEqual([{ id: 'grok-4', displayName: 'grok-4' }])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/language-models')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('returns an empty array when the provider returns no models', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    expect(await listGrokModels(fetchImpl, 'key')).toEqual([])
  })

  it('throws with the status and body on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 403, textBody: 'permission denied' })
    await expect(listGrokModels(fetchImpl, 'key')).rejects.toThrow(/403/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'xai-another-secret-value-should-never-leak-67890'
    try {
      await listGrokModels(fetchImpl, secretKey)
      expect.unreachable('listGrokModels should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})
