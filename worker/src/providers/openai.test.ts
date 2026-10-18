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

  it('throws a ProviderError carrying the status when OpenAI returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'quota exceeded' })
    await expect(callOpenAI(fetchImpl, 'key', 'gpt-4o-mini', 'q')).rejects.toThrow(/429/)
  })

  it('throws when the response has no message content', async () => {
    const fetchImpl = mockFetch({ jsonBody: { choices: [] } })
    await expect(callOpenAI(fetchImpl, 'key', 'gpt-4o-mini', 'q')).rejects.toThrow(/did not contain any answer text/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const secretKey = 'sk-super-secret-value-should-never-leak-12345'
    // The provider body echoes the key back — the exact-key scrub must remove it.
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      textBody: JSON.stringify({ error: { message: `invalid API key: ${secretKey}` } }),
    })
    try {
      await callOpenAI(fetchImpl, secretKey, 'gpt-4o-mini', 'q')
      expect.unreachable('callOpenAI should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
      expect((err as Error).message).toContain('[redacted]')
    }
  })
})

describe('listOpenAIModels', () => {
  it('drops non-chat model families via the deny pattern and keeps chat models', async () => {
    const denied = [
      'text-embedding-3-small',
      'omni-moderation-latest',
      'whisper-1',
      'tts-1-hd',
      'gpt-4o-mini-tts',
      'gpt-4o-transcribe',
      'gpt-4o-realtime-preview',
      'gpt-4o-audio-preview',
      'gpt-image-1',
      'dall-e-3',
      'sora-2',
      'davinci-002',
      'babbage-002',
      'gpt-3.5-turbo-instruct',
      'o3-pro',
      'o3-pro-2025-06-10',
      'gpt-5-pro',
      'gpt-5-codex',
    ]
    const kept = ['gpt-4o-mini', 'gpt-4.1', 'o4-mini', 'gpt-5', 'chatgpt-4o-latest', 'o1', 'o3', 'o3-mini', 'gpt-5-mini']
    const fetchImpl = mockFetch({
      jsonBody: { data: [...denied, ...kept].map((id) => ({ id, object: 'model' })) },
    })

    const models = await listOpenAIModels(fetchImpl, 'test-key')

    expect(models).toEqual(kept.map((id) => ({ id, displayName: id })))
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer test-key' })
  })

  it('returns an empty array when the provider returns no models', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    expect(await listOpenAIModels(fetchImpl, 'key')).toEqual([])
  })

  it('throws a ProviderError carrying the status on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 403, textBody: 'permission denied' })
    await expect(listOpenAIModels(fetchImpl, 'key')).rejects.toThrow(/403/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const secretKey = 'sk-another-secret-value-should-never-leak-67890'
    // The provider body echoes the key back — the exact-key scrub must remove it.
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      textBody: JSON.stringify({ error: { message: `invalid API key: ${secretKey}` } }),
    })
    try {
      await listOpenAIModels(fetchImpl, secretKey)
      expect.unreachable('listOpenAIModels should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
      expect((err as Error).message).toContain('[redacted]')
    }
  })
})
