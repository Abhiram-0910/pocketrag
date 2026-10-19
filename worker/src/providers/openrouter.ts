import { providerError } from './errors'

export const API_BASE = 'https://openrouter.ai/api/v1'
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

  if (!response.ok) throw await providerError('OpenRouter', response, apiKey, prompt)

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
  data?: { id?: string; name?: string; architecture?: { output_modalities?: unknown } }[]
}

// Keeps text-only models. A model with no output_modalities field is kept (unknown is
// not evidence it can't answer in text); anything that also emits image/audio is dropped.
function isTextOnly(outputModalities: unknown): boolean {
  if (outputModalities == null) return true
  return Array.isArray(outputModalities) && outputModalities.length === 1 && outputModalities[0] === 'text'
}

/**
 * Lists OpenRouter's text-only models. /v1/models is a public catalog that returns 200
 * for any key (see SECURITY_REVIEW.md §1), so the key is checked first against
 * GET /v1/key — a fake key gets 401 "User not found." there (confirmed live
 * 2026-10-18) — and a bad key fails here instead of on the first /answer call.
 * Entries use `name` as displayName, falling back to id like every other provider.
 */
export async function listOpenRouterModels(fetchImpl: typeof fetch, apiKey: string): Promise<ModelInfo[]> {
  const keyResponse = await fetchImpl(`${API_BASE}/key`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!keyResponse.ok) throw await providerError('OpenRouter', keyResponse, apiKey)

  const response = await fetchImpl(`${API_BASE}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!response.ok) throw await providerError('OpenRouter', response, apiKey)

  const data = (await response.json()) as OpenRouterModelsListResponse
  return (data.data ?? [])
    .filter(
      (model): model is { id: string; name?: string } =>
        typeof model.id === 'string' && isTextOnly(model.architecture?.output_modalities),
    )
    .map((model) => ({ id: model.id, displayName: model.name ?? model.id }))
}
