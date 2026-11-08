import { parseWorkerErrorResponse } from './apiError'
import { egressFetch } from './egress'

export interface ModelInfo {
  id: string
  displayName: string
}

// Same list as the Worker's SUPPORTED_PROVIDERS (worker/src/validate.ts) — providers.test.ts
// fails if they drift. A runtime list so the Worker's provider echo can be checked.
export const PROVIDERS = ['gemini', 'openai', 'anthropic', 'grok', 'openrouter'] as const
export type Provider = (typeof PROVIDERS)[number]

export const PROVIDER_LABELS: Record<Provider, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Claude',
  grok: 'Grok',
  openrouter: 'OpenRouter',
}

// Where our Worker forwards each provider's requests — the host of that provider file's
// API_BASE in worker/src/providers/. Receipts show it as "Then to"; it's the Worker's
// contract, not something the browser can observe.
export const PROVIDER_HOSTS: Record<Provider, string> = {
  gemini: 'generativelanguage.googleapis.com',
  openai: 'api.openai.com',
  anthropic: 'api.anthropic.com',
  grok: 'api.x.ai',
  openrouter: 'openrouter.ai',
}

// No default model lives here: the BYOK picker ranks a key's list by family and version in
// modelLadder.ts. The shared tier's pinned model is the Worker's (providers/gemini.ts).

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
