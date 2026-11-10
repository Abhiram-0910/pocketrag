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

    const result = await callGemini(fetchImpl, 'test-key', 'gemini-3.5-flash-lite', 'What is x?')

    expect(result.text).toBe('The answer (page 1).')
    expect(result.grounding).toBeUndefined()
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('gemini-3.5-flash-lite')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ 'x-goog-api-key': 'test-key' })
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.contents[0].parts[0].text).toBe('What is x?')
  })

  it('throws a ProviderError carrying the status when Gemini returns a non-2xx response', async () => {
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
    const secretKey = 'sk-super-secret-value-should-never-leak-12345'
    // The provider body echoes the key back — the exact-key scrub must remove it.
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      textBody: JSON.stringify({ error: { message: `invalid API key: ${secretKey}` } }),
    })
    try {
      await callGemini(fetchImpl, secretKey, 'gemini-3.5-flash-lite', 'q')
      expect.unreachable('callGemini should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
      expect((err as Error).message).toContain('[redacted]')
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

  describe('grounding with Google Search (Milestone 12)', () => {
    it('omits the tools field entirely when enableWebSearch is false or omitted', async () => {
      const fetchImpl = mockFetch({ jsonBody: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] } })
      await callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', 'q')
      const [, init] = fetchImpl.mock.calls[0]
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body.tools).toBeUndefined()
    })

    it('sends tools: [{"google_search": {}}] (snake_case, the confirmed Legacy REST wire shape) when enableWebSearch is true', async () => {
      const fetchImpl = mockFetch({ jsonBody: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] } })
      await callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', 'q', undefined, true)
      const [, init] = fetchImpl.mock.calls[0]
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body.tools).toEqual([{ google_search: {} }])
    })

    it('sends the full multi-passage prompt text unchanged alongside the grounding tool — grounding does not alter or truncate the prompt', async () => {
      const fetchImpl = mockFetch({ jsonBody: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] } })
      const richPrompt =
        'You are answering a question using ONLY the passages and the results of a live web search below.\n\n' +
        'Passages:\n[Doc 1, Page 1]\nThe mitochondrion is the powerhouse of the cell.\n\n' +
        '[Doc 2, Page 3]\nKneading develops gluten in bread dough.\n\nQuestion: What is the mitochondrion?\n\nAnswer:'
      await callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', richPrompt, undefined, true)
      const [, init] = fetchImpl.mock.calls[0]
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body.contents[0].parts[0].text).toBe(richPrompt)
      expect(body.tools).toEqual([{ google_search: {} }])
    })

    it('parses groundingChunks into webSources and searchEntryPoint.renderedContent into searchEntryPointHtml', async () => {
      const fetchImpl = mockFetch({
        jsonBody: {
          candidates: [
            {
              content: { parts: [{ text: 'Team A won (Web source).' }] },
              groundingMetadata: {
                searchEntryPoint: { renderedContent: '<div>search suggestions</div>' },
                groundingChunks: [
                  { web: { uri: 'https://example.com/result-a', title: 'Result A' } },
                  { web: { uri: 'https://example.com/result-b', title: 'Result B' } },
                ],
              },
            },
          ],
        },
      })

      const result = await callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', 'q', undefined, true)

      expect(result.text).toBe('Team A won (Web source).')
      expect(result.grounding).toEqual({
        webSources: [
          { uri: 'https://example.com/result-a', title: 'Result A' },
          { uri: 'https://example.com/result-b', title: 'Result B' },
        ],
        searchEntryPointHtml: '<div>search suggestions</div>',
      })
    })

    it('returns grounding: undefined when enableWebSearch is true but Gemini chose not to search (no groundingMetadata in the response)', async () => {
      const fetchImpl = mockFetch({ jsonBody: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] } })
      const result = await callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', 'q', undefined, true)
      expect(result.grounding).toBeUndefined()
    })

    it('filters out a malformed groundingChunks entry missing uri or title', async () => {
      const fetchImpl = mockFetch({
        jsonBody: {
          candidates: [
            {
              content: { parts: [{ text: 'answer' }] },
              groundingMetadata: {
                groundingChunks: [
                  { web: { uri: 'https://example.com/ok', title: 'OK' } },
                  { web: { uri: 'https://example.com/missing-title' } },
                  { web: { title: 'missing uri' } },
                ],
              },
            },
          ],
        },
      })
      const result = await callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', 'q', undefined, true)
      expect(result.grounding?.webSources).toEqual([{ uri: 'https://example.com/ok', title: 'OK' }])
    })

    it('truncates an oversized searchEntryPoint.renderedContent to MAX_SEARCH_ENTRY_POINT_HTML_LENGTH (50,000 chars) — a defensive circuit-breaker against a degenerate/oversized response, not the normal path', async () => {
      const oversized = '<div>'.repeat(20_000) // well over 50,000 chars
      const fetchImpl = mockFetch({
        jsonBody: {
          candidates: [
            {
              content: { parts: [{ text: 'answer' }] },
              groundingMetadata: { searchEntryPoint: { renderedContent: oversized } },
            },
          ],
        },
      })
      const result = await callGemini(fetchImpl, 'key', 'gemini-3.5-flash-lite', 'q', undefined, true)
      expect(result.grounding?.searchEntryPointHtml).toHaveLength(50_000)
    })
  })
})

describe('callGemini / transcribeImage: multi-part responses (v1.1)', () => {
  // Seen live on production (2026-11-10): a step-by-step answer split across parts, and the
  // Worker returned only the first ("…for 4 years.\n\n**").
  const parts = [{ text: 'Following Step 1 (Doc 1, page 1):\n\n**' }, { text: 'Step 2:** A = 25000 × (1.06)⁴' }, { text: ' = 31561.92.' }]

  it('joins every text part of an answer, in order', async () => {
    const fetchImpl = mockFetch({ jsonBody: { candidates: [{ content: { parts } }] } })
    const result = await callGemini(fetchImpl, 'test-key', 'gemini-3.5-flash-lite', 'q')
    expect(result.text).toBe('Following Step 1 (Doc 1, page 1):\n\n**Step 2:** A = 25000 × (1.06)⁴ = 31561.92.')
  })

  it('joins an OCR transcription split across parts too, and skips thought parts', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Line one.\n' }, { text: 'Line two.' }] } }] },
    })
    expect(await transcribeImage(fetchImpl, 'test-key', 'gemini-3.5-flash-lite', { mimeType: 'image/jpeg', base64: 'aGVsbG8=' })).toBe('Line one.\nLine two.')
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

  it('throws a ProviderError carrying the status on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 403, textBody: 'permission denied' })
    await expect(listGeminiModels(fetchImpl, 'key')).rejects.toThrow(/403/)
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
      await listGeminiModels(fetchImpl, secretKey)
      expect.unreachable('listGeminiModels should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
      expect((err as Error).message).toContain('[redacted]')
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
    expect(body.tools).toBeUndefined()
  })

  it('throws a ProviderError carrying the status when Gemini returns a non-2xx response', async () => {
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
    const secretKey = 'sk-ocr-secret-value-should-never-leak-24680'
    // The provider body echoes the key back — the exact-key scrub must remove it.
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      textBody: JSON.stringify({ error: { message: `invalid API key: ${secretKey}` } }),
    })
    try {
      await transcribeImage(fetchImpl, secretKey, 'gemini-3.5-flash-lite', {
        mimeType: 'image/jpeg',
        base64: 'aGVsbG8=',
      })
      expect.unreachable('transcribeImage should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
      expect((err as Error).message).toContain('[redacted]')
    }
  })
})
