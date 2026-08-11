const API_BASE = 'https://openrouter.ai/api/v1'
// Optional but recommended identifying headers — attribute this app's traffic on
// OpenRouter's own dashboard. Fixed values, not user-configurable; the first provider
// on this roadmap needing headers beyond auth on the chat call.
const OPENROUTER_REFERER = 'https://pocketrag.pages.dev'
const OPENROUTER_APP_TITLE = 'PocketRAG'

interface OpenRouterChatResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * Calls OpenRouter's Chat Completions endpoint — OpenAI-compatible request/response
 * shape, same `Authorization: Bearer` header pattern as `callOpenAI`/`callGrok`.
 * `fetchImpl` is injected so tests can mock it. Experimental provider: shipped without
 * a working test key (see ByokPanel.tsx's EXPERIMENTAL_PROVIDERS) — index.ts logs and
 * sanitizes any failure regardless of provider.
 */
export async function callOpenRouter(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const response = await fetchImpl(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': OPENROUTER_REFERER,
      'X-Title': OPENROUTER_APP_TITLE,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenRouter API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as OpenRouterChatResponse
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('OpenRouter response did not contain any answer text.')
  return text
}

export interface ModelInfo {
  id: string
  displayName: string
}

interface OpenRouterModelsListResponse {
  data?: { id?: string; name?: string }[]
}

/**
 * Lists models visible to this key. OpenRouter's /v1/models wraps the list under
 * `data` (same key as OpenAI) and each entry has a real `name` field — used as
 * displayName, falling back to id like every other provider when absent.
 */
export async function listOpenRouterModels(fetchImpl: typeof fetch, apiKey: string): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${API_BASE}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenRouter API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as OpenRouterModelsListResponse
  return (data.data ?? [])
    .filter((model): model is { id: string; name?: string } => typeof model.id === 'string')
    .map((model) => ({ id: model.id, displayName: model.name ?? model.id }))
}
