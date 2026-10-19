import { providerError } from './errors'

export const API_BASE = 'https://api.openai.com/v1'

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

  if (!response.ok) throw await providerError('OpenAI', response, apiKey, prompt)

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

// Model ids that can't serve a Chat Completions text answer: embeddings, moderation,
// speech/transcription/realtime/audio, and image/video generation, plus the legacy
// completions-only base models (all matched as substrings, case-insensitively), and the
// anchored Responses-API-only families o1-pro, o3-pro, gpt-5-pro, gpt-5-codex (each
// model page says "available in the Responses API only", checked 2026-10-18; anchored
// so snapshots like o3-pro-2025-06-10 match but o1/o3/gpt-5-mini don't).
// ponytail: name-based deny list (OpenAI's /v1/models has no capability field) — a new
// non-chat family slips through until added here, and surfaces as a normal 502 on the
// next question. codex-mini-latest and *-deep-research are unverified (their pages
// don't state Chat Completions support either way) and intentionally not listed.
const NON_CHAT_MODEL_PATTERN =
  /embedding|moderation|whisper|tts|transcribe|realtime|audio|image|dall-e|sora|davinci|babbage|instruct|^(?:o1-pro|o3-pro|gpt-5-pro|gpt-5-codex)/i

/**
 * Lists models visible to this key, minus NON_CHAT_MODEL_PATTERN matches.
 */
export async function listOpenAIModels(fetchImpl: typeof fetch, apiKey: string): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${API_BASE}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  if (!response.ok) throw await providerError('OpenAI', response, apiKey)

  const data = (await response.json()) as OpenAiModelsListResponse
  return (data.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === 'string' && !NON_CHAT_MODEL_PATTERN.test(model.id))
    .map((model) => ({ id: model.id, displayName: model.id }))
}
