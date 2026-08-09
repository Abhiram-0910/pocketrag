// gemini-2.5-flash-lite (named in the original spec) returns 404 "no longer
// available to new users" for this API key — pinned to 3.5 instead, deliberately,
// not via the floating `gemini-flash-lite-latest` alias. Confirmed working 2026-07-25.
export const DEFAULT_SHARED_MODEL = 'gemini-3.5-flash-lite'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

/**
 * Calls Gemini's generateContent endpoint for the given model. `fetchImpl` is injected
 * so tests can mock it. The key goes in the `x-goog-api-key` header, never the URL —
 * URLs are far more likely to end up in some layer's access logs than headers are, and
 * this key may be a user's own (BYOK), not just ours.
 */
export async function callGemini(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const response = await fetchImpl(`${API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as GeminiGenerateResponse
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error('Gemini response did not contain any answer text.')
  return text
}

export interface ModelInfo {
  id: string
  displayName: string
}

interface GeminiModelsListResponse {
  models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[]
}

/**
 * Lists Gemini models that support generateContent (excludes embedding-only models,
 * etc.), stripping the "models/" prefix Gemini's API puts on `name` so the returned id
 * is exactly what `callGemini`'s `model` argument expects.
 */
export async function listGeminiModels(fetchImpl: typeof fetch, apiKey: string): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${API_BASE}/models`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as GeminiModelsListResponse
  return (data.models ?? [])
    .filter(
      (model): model is { name: string; displayName?: string; supportedGenerationMethods: string[] } =>
        typeof model.name === 'string' && (model.supportedGenerationMethods?.includes('generateContent') ?? false),
    )
    .map((model) => {
      const id = model.name.replace(/^models\//, '')
      return { id, displayName: model.displayName ?? id }
    })
}
