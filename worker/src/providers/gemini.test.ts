import { describe, expect, it, vi } from 'vitest'
import { callGemini, listGeminiModels, transcribeImage } from './gemini'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  } as Response)
}

describe('callGemini', () => {
  it('sends the API key as a header (never the URL), the model in the URL, and the prompt in the body', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { candidates: [{ content: { parts: [{ text: 'The answer (page 1).' }] } }] },
    })

    const answer = await callGemini(fetchImpl, 'test-key', 'gemini-3.5-flash-lite', 'What is x?')

    expect(answer).toBe('The answer (page 1).')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('gemini-3.5-flash-lite')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'test-key' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.contents[0].parts[0].text).toBe('What is x?')
  })

  it('throws with the status and body when Gemini returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'quota exceeded' })
    await expect(callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', 'q')).rejects.toThrow(/429/)
  })

  it('throws when the response has no candidate text', async () => {
    const fetchImpl = mockFetch({ jsonBody: { candidates: [] } })
    await expect(callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', 'q')).rejects.toThrow(
      /did not contain any answer text/,
    )
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'sk-super-secret-value-should-never-leak-12345'
    try {
      await callGemini(fetchImpl, secretKey, 'gemini-3.5-flash-lite', 'q')
      expect.unreachable('callGemini should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })

  describe('image (Milestone 10 Phase B)', () => {
    it('appends an inlineData part alongside the text part when an image is passed', async () => {
      const fetchImpl = mockFetch({
        jsonBody: { candidates: [{ content: { parts: [{ text: 'This chart shows rising values.' }] } }] },
      })

      await callGemini(fetchImpl, 'test-key', 'gemini-3.5-flash-lite', 'What does the chart show?', {
        mimeType: 'image/jpeg',
        base64: 'aGVsbG8=',
      })

      const [, init] = fetchImpl.mock.calls[0]
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body.contents[0].parts).toEqual([
        { text: 'What does the chart show?' },
        { inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } },
      ])
    })

    it('sends only the text part when no image is passed', async () => {
      const fetchImpl = mockFetch({
        jsonBody: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] },
      })

      await callGemini(fetchImpl, 'test-key', 'gemini-3.5-flash-lite', 'q')

      const [, init] = fetchImpl.mock.calls[0]
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body.contents[0].parts).toEqual([{ text: 'q' }])
    })
  })
})

describe('listGeminiModels', () => {
  it('returns only models that support generateContent, stripping the "models/" name prefix', async () => {
    const fetchImpl = mockFetch({
      jsonBody: {
        models: [
          {
            name: 'models/gemini-3.5-flash-lite',
            displayName: 'Gemini 3.5 Flash Lite',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/embedding-001',
            displayName: 'Embedding 001',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      },
    })

    const models = await listGeminiModels(fetchImpl, 'test-key')

    expect(models).toEqual([{ id: 'gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash Lite' }])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'test-key' })
  })

  it('falls back to the id when displayName is missing', async () => {
    const fetchImpl = mockFetch({
      jsonBody: {
        models: [{ name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] }],
      },
    })
    const models = await listGeminiModels(fetchImpl, 'key')
    expect(models).toEqual([{ id: 'gemini-x', displayName: 'gemini-x' }])
  })

  it('returns an empty array when the provider returns no models', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    expect(await listGeminiModels(fetchImpl, 'key')).toEqual([])
  })

  it('throws with the status and body on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 403, textBody: 'permission denied' })
    await expect(listGeminiModels(fetchImpl, 'key')).rejects.toThrow(/403/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'sk-another-secret-value-should-never-leak-67890'
    try {
      await listGeminiModels(fetchImpl, secretKey)
      expect.unreachable('listGeminiModels should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})

describe('transcribeImage', () => {
  it('sends the API key as a header, the OCR prompt and inlineData image in the body', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { candidates: [{ content: { parts: [{ text: 'Meeting notes: buy milk.' }] } }] },
    })

    const text = await transcribeImage(fetchImpl, 'test-key', 'gemini-3.5-flash-lite', {
      mimeType: 'image/jpeg',
      base64: 'aGVsbG8=',
    })

    expect(text).toBe('Meeting notes: buy milk.')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('gemini-3.5-flash-lite')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'test-key' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.contents[0].parts[0].text).toMatch(/transcribe/i)
    expect(body.contents[0].parts[0].text).toMatch(/exactly as written/i)
    expect(body.contents[0].parts[1]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } })
  })

  it('throws with the status and body when Gemini returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 500, textBody: 'internal error' })
    await expect(
      transcribeImage(fetchImpl, 'key', 'gemini-3.5-flash-lite', { mimeType: 'image/jpeg', base64: 'aGVsbG8=' }),
    ).rejects.toThrow(/500/)
  })

  it('throws when the response has no candidate text', async () => {
    const fetchImpl = mockFetch({ jsonBody: { candidates: [] } })
    await expect(
      transcribeImage(fetchImpl, 'key', 'gemini-3.5-flash-lite', { mimeType: 'image/jpeg', base64: 'aGVsbG8=' }),
    ).rejects.toThrow(/did not contain any transcribed text/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid API key' })
    const secretKey = 'sk-ocr-secret-value-should-never-leak-24680'
    try {
      await transcribeImage(fetchImpl, secretKey, 'gemini-3.5-flash-lite', {
        mimeType: 'image/jpeg',
        base64: 'aGVsbG8=',
      })
      expect.unreachable('transcribeImage should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})
