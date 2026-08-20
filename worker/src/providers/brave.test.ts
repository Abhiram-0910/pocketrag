import { describe, expect, it, vi } from 'vitest'
import { searchBrave } from './brave'

function mockFetch(response: Partial<Response> & { jsonBody?: unknown; textBody?: string }) {
  return vi.fn().mockResolvedValue({
    ok: response.ok ?? true,
    status: response.status ?? 200,
    json: async () => response.jsonBody,
    text: async () => response.textBody ?? '',
  } as Response)
}

describe('searchBrave', () => {
  it('sends the API key as an X-Subscription-Token header (never the URL), the query as a q param', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { web: { results: [{ title: 'Result', url: 'https://example.com', description: 'A snippet.' }] } },
    })

    const results = await searchBrave(fetchImpl, 'test-key', 'what is a mitochondrion')

    expect(results).toEqual([{ title: 'Result', url: 'https://example.com', snippet: 'A snippet.' }])
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toContain('q=what%20is%20a%20mitochondrion')
    expect(url).not.toContain('test-key')
    expect((init as RequestInit).headers).toMatchObject({ 'X-Subscription-Token': 'test-key' })
  })

  it('maps Brave\'s "description" field to snippet, and passes count through', async () => {
    const fetchImpl = mockFetch({
      jsonBody: { web: { results: [{ title: 'a', url: 'https://a.com', description: 'first' }] } },
    })
    await searchBrave(fetchImpl, 'key', 'q', 3)
    const [url] = fetchImpl.mock.calls[0]
    expect(url).toContain('count=3')
  })

  it('returns an empty array when there are no web results', async () => {
    const fetchImpl = mockFetch({ jsonBody: {} })
    expect(await searchBrave(fetchImpl, 'key', 'q')).toEqual([])
  })

  it('filters out malformed entries missing a required field', async () => {
    const fetchImpl = mockFetch({
      jsonBody: {
        web: {
          results: [
            { title: 'ok', url: 'https://example.com', description: 'fine' },
            { title: 'missing url and description' },
          ],
        },
      },
    })
    const results = await searchBrave(fetchImpl, 'key', 'q')
    expect(results).toEqual([{ title: 'ok', url: 'https://example.com', snippet: 'fine' }])
  })

  it('throws with the status and body on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429, textBody: 'rate limited' })
    await expect(searchBrave(fetchImpl, 'key', 'q')).rejects.toThrow(/429/)
  })

  it('never includes the raw API key in a thrown error message', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 401, textBody: 'invalid token' })
    const secretKey = 'BSA-super-secret-value-should-never-leak-12345'
    try {
      await searchBrave(fetchImpl, secretKey, 'q')
      expect.unreachable('searchBrave should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).not.toContain(secretKey)
    }
  })
})
