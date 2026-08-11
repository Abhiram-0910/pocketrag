export interface ModelInfo {
  id: string
  displayName: string
}

export type FetchModelsFn = (
  provider: 'gemini' | 'openai' | 'anthropic' | 'grok' | 'openrouter',
  apiKey: string,
) => Promise<ModelInfo[]>

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

/** Real implementation of FetchModelsFn — posts to the Cloudflare Worker's /models endpoint. */
export const fetchModelsFromWorker: FetchModelsFn = async (provider, apiKey) => {
  if (!API_BASE_URL) {
    throw new Error('Model listing is not configured yet (VITE_API_BASE_URL is unset).')
  }
  const res = await fetch(`${API_BASE_URL}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, apiKey }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? `Model list request failed (${res.status}).`)
  }
  const data = (await res.json()) as { models: ModelInfo[] }
  return data.models
}
