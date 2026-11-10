import { providerError } from './errors'

export const API_BASE = 'https://api.anthropic.com/v1'
const ANTHROPIC_API_VERSION = '2023-06-01'
// Anthropic's Messages API requires max_tokens (unlike Gemini/OpenAI, which use a
// provider-side default) — capped generously above what a grounded-QA answer needs.
// This is a new failure mode the other two providers don't have (a truncated answer
// or citation), but it's the BYOK user's own cost to bear, not the shared tier's.
const ANTHROPIC_MAX_OUTPUT_TOKENS = 2048

interface AnthropicMessageResponse {
  content?: { type?: string; text?: string }[]
}

/**
 * Calls Anthropic's Messages endpoint. `fetchImpl` is injected so tests can mock it.
 * The key goes in the `x-api-key` header, never the URL — same reasoning as the other
 * providers: this may be a user's own (BYOK) key, not just ours. Response text is read
 * from the first `type: "text"` content block rather than blindly indexing `content[0]`
 * — a model with thinking enabled could emit a non-text block first.
 */
export async function callAnthropic(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const response = await fetchImpl(`${API_BASE}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) throw await providerError('Anthropic', response, apiKey, prompt)

  const data = (await response.json()) as AnthropicMessageResponse
  const text = data.content?.find((block) => block.type === 'text')?.text
  if (!text) throw new Error('Anthropic response did not contain any answer text.')
  return text
}

/** v1.3: starts a streamed Messages answer; same contract as streamGemini. */
export async function streamAnthropic(fetchImpl: typeof fetch, apiKey: string, model: string, prompt: string): Promise<Response> {
  const response = await fetchImpl(`${API_BASE}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
    body: JSON.stringify({ model, max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS, messages: [{ role: 'user', content: prompt }], stream: true }),
  })
  if (!response.ok || !response.body) throw await providerError('Anthropic', response, apiKey, prompt)
  return response
}

export interface ModelInfo {
  id: string
  displayName: string
}

interface AnthropicModelsListResponse {
  data?: { id?: string; display_name?: string }[]
}

/**
 * Lists models visible to this key. Anthropic's /v1/models is Messages-models-only
 * (no embedding/moderation models mixed in like OpenAI's list), so it's returned
 * unfiltered correctly, not as a deferred tradeoff. It's also paginated (default page
 * size 20) unlike Gemini/OpenAI's single-shot lists — `limit=1000` sidesteps that in
 * one call rather than adding a pagination loop for a scenario (1000+ visible models)
 * that isn't real.
 */
export async function listAnthropicModels(fetchImpl: typeof fetch, apiKey: string): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${API_BASE}/models?limit=1000`, {
    method: 'GET',
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION },
  })

  if (!response.ok) throw await providerError('Anthropic', response, apiKey)

  const data = (await response.json()) as AnthropicModelsListResponse
  return (data.data ?? [])
    .filter((model): model is { id: string; display_name?: string } => typeof model.id === 'string')
    .map((model) => ({ id: model.id, displayName: model.display_name ?? model.id }))
}
