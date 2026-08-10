const API_BASE = 'https://api.openai.com/v1'

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[]
}

/**
 * Calls OpenAI's Chat Completions endpoint. `fetchImpl` is injected so tests can mock
 * it. The key goes in the `Authorization: Bearer` header, never the URL — same reasoning
 * as `callGemini`: this may be a user's own (BYOK) key, not just ours.
 */
export async function callOpenAI(
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

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as OpenAiChatResponse
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('OpenAI response did not contain any answer text.')
  return text
}

export interface ModelInfo {
  id: string
  displayName: string
}

interface OpenAiModelsListResponse {
  data?: { id?: string }[]
}

/**
 * Lists models visible to this key. Unlike Gemini's models.list, OpenAI's response has
 * no capability field to filter chat-capable models from embedding/moderation/image
 * ones — returned unfiltered; a model that can't do chat completions surfaces as a
 * normal 502 from callOpenAI on the next question, same as any other provider error.
 */
export async function listOpenAIModels(fetchImpl: typeof fetch, apiKey: string): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${API_BASE}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as OpenAiModelsListResponse
  return (data.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === 'string')
    .map((model) => ({ id: model.id, displayName: model.id }))
}
