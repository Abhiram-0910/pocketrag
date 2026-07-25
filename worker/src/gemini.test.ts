import { describe, expect, it, vi } from 'vitest'
import { callGemini } from './gemini'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  } as Response)
}

describe('callGemini', () => {
  it('sends the API key as a query param and the prompt in the request body', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { candidates: [{ content: { parts: [{ text: 'The answer (page 1).' }] } }] },
    })

    const answer = await callGemini(fetchImpl, 'test-key', 'What is x?')

    expect(answer).toBe('The answer (page 1).')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('key=test-key')
    expect(url).toContain('gemini-3.5-flash-lite')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.contents[0].parts[0].text).toBe('What is x?')
  })

  it('throws with the status and body when Gemini returns a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'quota exceeded' })
    await expect(callGemini(fetchImpl, 'key', 'q')).rejects.toThrow(/429/)
  })

  it('throws when the response has no candidate text', async () => {
    const fetchImpl = mockFetch({ jsonBody: { candidates: [] } })
    await expect(callGemini(fetchImpl, 'key', 'q')).rejects.toThrow(/did not contain any answer text/)
  })
})
