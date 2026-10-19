import { parseWorkerErrorResponse } from './apiError'
import { egressFetch } from './egress'

export interface ModelInfo {
  id: string
  displayName: string
}

export type Provider = 'gemini' | 'openai' | 'anthropic' | 'grok' | 'openrouter'

// Gemini's /models list isn't filtered by "available to new users" — it can return a
// since-deprecated model (e.g. gemini-2.5-flash) ahead of working ones, so picking
// fetched[0] blindly can auto-select a model that 404s on the very first real question.
// The shared tier pins this same model for exactly this reason (worker/src/providers/
// gemini.ts's DEFAULT_SHARED_MODEL). Found live via Milestone 16's BYOK-Gemini retest
// (Session 28).
export const PREFERRED_GEMINI_MODEL = 'gemini-3.5-flash-lite'

/**
 * The model to pre-select after a fetch, or '' for "Choose a model". Only Gemini's
 * pinned model is ever auto-selected: no other provider's list order is a safe default
 * (OpenAI/OpenRouter/Grok are unordered or include models that can't answer; Anthropic's
 * newest-first would silently pick the most expensive model).
 */
export function defaultModelFor(provider: Provider, fetched: ModelInfo[]): string {
  if (provider === 'gemini' && fetched.some((m) => m.id === PREFERRED_GEMINI_MODEL)) return PREFERRED_GEMINI_MODEL
  return ''
}

export type FetchModelsFn = (
  provider: Provider,
  apiKey: string,
) => Promise<ModelInfo[]>

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

/** Real implementation of FetchModelsFn — posts to the Cloudflare Worker's /models endpoint. */
export const fetchModelsFromWorker: FetchModelsFn = async (provider, apiKey) => {
  if (!API_BASE_URL) {
    throw new Error('Model listing is not configured yet (VITE_API_BASE_URL is unset).')
  }
  const res = await egressFetch(`${API_BASE_URL}/models`, { json: { provider, apiKey } }, { purpose: 'models', upstream: provider })
  if (!res.ok) {
    throw await parseWorkerErrorResponse(res, `Model list request failed (${res.status}).`)
  }
  const data = (await res.json()) as { models: ModelInfo[] }
  return data.models
}
