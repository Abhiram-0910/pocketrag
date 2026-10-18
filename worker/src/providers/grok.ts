import { providerError } from './errors'

const API_BASE = 'https://api.x.ai/v1'

interface GrokChatResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * Calls xAI's (Grok) Chat Completions endpoint — OpenAI-compatible request/response
 * shape, same `Authorization: Bearer` header pattern as `callOpenAI`. `fetchImpl` is
 * injected so tests can mock it. Experimental provider: shipped without a working test
 * key (see ByokPanel.tsx's EXPERIMENTAL_PROVIDERS), so failures here are expected to be
 * exercised by real users first — index.ts logs and sanitizes any failure regardless.
 */
export async function callGrok(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const response = await fetchImpl(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) throw await providerError('Grok', response, apiKey, prompt)

  const data = (await response.json()) as GrokChatResponse
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('Grok response did not contain any answer text.')
  return text
}

export interface ModelInfo {
  id: string
  displayName: string
}

interface GrokModelsListResponse {
  models?: { id?: string }[]
}

/**
 * Lists models visible to this key. Unlike OpenAI's /v1/models, xAI's models endpoint
 * is at /v1/language-models and wraps the list under a `models` key, not `data` — the
 * one genuinely new shape difference from the OpenAI pattern. No display-name field
 * (only `id`/`aliases`), same as OpenAI — displayName falls back to id.
 */
export async function listGrokModels(fetchImpl: typeof fetch, apiKey: string): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${API_BASE}/language-models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!response.ok) throw await providerError('Grok', response, apiKey)

  const data = (await response.json()) as GrokModelsListResponse
  return (data.models ?? [])
    .filter((model): model is { id: string } => typeof model.id === 'string')
    .map((model) => ({ id: model.id, displayName: model.id }))
}
