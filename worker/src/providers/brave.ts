// Brave's Search plan (verified directly against api-dashboard.search.brave.com and
// brave.com/search/api, 2026-08-18): $5 per 1,000 requests, 50 req/sec, with $5 in
// free credit applied monthly (~1,000 free queries/month). This is metered, real-money
// usage, not a perpetual free tier like Gemini's shared key — see rateLimit.ts's
// WEBSEARCH_DAILY_LIMIT for why /websearch gets its own conservative per-IP cap.
const API_BASE = 'https://api.search.brave.com/res/v1/web/search'
const DEFAULT_RESULT_COUNT = 5

export interface WebResult {
  title: string
  url: string
  snippet: string
}

interface BraveSearchResponse {
  web?: { results?: { title?: string; url?: string; description?: string }[] }
}

/**
 * Calls Brave's Web Search API. The key goes in the `X-Subscription-Token` header —
 * Brave's documented auth scheme, not a Bearer token and never a URL param, same "keys
 * belong in headers, not URLs" reasoning as every other provider file here. Only the
 * query text goes in the URL (`q=`), which is the actual search being performed, not a
 * secret. Malformed entries in Brave's response (missing title/url/description) are
 * filtered out rather than thrown on — the Worker's own validate.ts re-caps and
 * re-validates whatever comes back before it's ever echoed into a prompt regardless.
 */
export async function searchBrave(
  fetchImpl: typeof fetch,
  apiKey: string,
  query: string,
  count: number = DEFAULT_RESULT_COUNT,
): Promise<WebResult[]> {
  const url = `${API_BASE}?q=${encodeURIComponent(query)}&count=${count}`
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Brave API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as BraveSearchResponse
  return (data.web?.results ?? [])
    .filter(
      (result): result is { title: string; url: string; description: string } =>
        typeof result.title === 'string' && typeof result.url === 'string' && typeof result.description === 'string',
    )
    .map((result) => ({ title: result.title, url: result.url, snippet: result.description }))
}
