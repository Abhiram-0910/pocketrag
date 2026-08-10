import { describe, expect, it, vi } from 'vitest'
import { callOpenAI, listOpenAIModels } from './openai'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  } as Response)
}

describe('callOpenAI', () => {
  it('sends the API key as a Bearer header (never the URL), the model and prompt in the body', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { choices: [{ message: { content: 'The answer (page 1).' } }] },
    })

    const answer = await callOpenAI(fetchImpl, 'test-key', 'gpt-4o-mini', 'What is x?')

    expect(answer).toBe('The answer (page 1).')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('/chat/completions')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages[0].content).toBe('What is x?')
  })

  it('throws with the status and body when OpenAI returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'quota exceeded' })
    await expect(callOpenAI(fetchImpl, 'key', 'gpt-4o-mini', 'q')).rejects.toThrow(/429/)
  })

  it('throws when the response has no message content', async () => {
    const fetchImpl = mockFetch({ jsonBody: { choices: [] } })
    await expect(callOpenAI(fetchImpl, 'key', 'gpt-4o-mini', 'q')).rejects.toThrow(/did not contain any answer text/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'sk-super-secret-value-should-never-leak-12345'
    try {
      await callOpenAI(fetchImpl, secretKey, 'gpt-4o-mini', 'q')
      expect.unreachable('callOpenAI should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})

describe('listOpenAIModels', () => {
  it('returns every model id from the response, unfiltered (no capability field to filter on)', async () => {
    const fetchImpl = mockFetch({
      jsonBody: {
        data: [
          { id: 'gpt-4o-mini', object: 'model' },
          { id: 'text-embedding-3-small', object: 'model' },
        ],
      },
    })

    const models = await listOpenAIModels(fetchImpl, 'test-key')

    expect(models).toEqual([
      { id: 'gpt-4o-mini', displayName: 'gpt-4o-mini' },
      { id: 'text-embedding-3-small', displayName: 'text-embedding-3-small' },
    ])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('returns an empty array when the provider returns no models', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    expect(await listOpenAIModels(fetchImpl, 'key')).toEqual([])
  })

  it('throws with the status and body on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 403, textBody: 'permission denied' })
    await expect(listOpenAIModels(fetchImpl, 'key')).rejects.toThrow(/403/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'sk-another-secret-value-should-never-leak-67890'
    try {
      await listOpenAIModels(fetchImpl, secretKey)
      expect.unreachable('listOpenAIModels should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})
