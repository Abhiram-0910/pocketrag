import { useState } from 'react'
import type { KeyConfig } from '../lib/answerRequest'
import { fetchModelsFromWorker, type ModelInfo } from '../lib/models'

interface ByokPanelProps {
  onChange: (config: KeyConfig | null) => void
}

type Provider = 'gemini' | 'openai'

const PROVIDER_LABELS: Record<Provider, string> = { gemini: 'Gemini', openai: 'OpenAI' }

/**
 * Own-key entry: provider picker, key input, "fetch models" call, model picker. The key
 * lives only in this component's local state — never Zustand, never IndexedDB — so it
 * can't be picked up by a devtools/logging integration attached to shared state later,
 * and it disappears on reload by construction (nothing persists it). `onChange` reports
 * `null` whenever BYOK is selected but not yet complete (no key, or key not yet resolved
 * to a model), so the caller never silently falls back to the shared key mid-setup.
 */
export function ByokPanel({ onChange }: ByokPanelProps) {
  const [useOwnKey, setUseOwnKey] = useState(false)
  const [provider, setProvider] = useState<Provider>('gemini')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleToggle = (next: boolean) => {
    setUseOwnKey(next)
    setModels([])
    setSelectedModel('')
    setError(null)
    onChange(next ? null : { keySource: 'shared' })
  }

  const handleProviderChange = (next: Provider) => {
    setProvider(next)
    // A changed provider invalidates any previously fetched model list — a Gemini
    // model id means nothing once OpenAI is selected, and vice versa.
    setModels([])
    setSelectedModel('')
    setError(null)
    onChange(null)
  }

  const handleApiKeyChange = (value: string) => {
    setApiKey(value)
    // A changed key invalidates any previously fetched model list — force a re-fetch
    // rather than letting a stale model id ride along with a new key.
    setModels([])
    setSelectedModel('')
    setError(null)
    onChange(null)
  }

  const handleFetchModels = async () => {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) return
    setFetching(true)
    setError(null)
    try {
      const fetched = await fetchModelsFromWorker(provider, trimmedKey)
      if (fetched.length === 0) {
        setError('This key returned no usable models.')
        setModels([])
        setSelectedModel('')
        onChange(null)
        return
      }
      setModels(fetched)
      setSelectedModel(fetched[0].id)
      onChange({ keySource: 'own', apiKey: trimmedKey, provider, model: fetched[0].id })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch model list.')
      setModels([])
      setSelectedModel('')
      onChange(null)
    } finally {
      setFetching(false)
    }
  }

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId)
    onChange({ keySource: 'own', apiKey: apiKey.trim(), provider, model: modelId })
  }

  return (
    <div className="mb-4 text-left text-sm">
      <label className="flex items-center gap-2 text-gray-700">
        <input type="checkbox" checked={useOwnKey} onChange={(e) => handleToggle(e.target.checked)} />
        Use your own API key
      </label>

      {useOwnKey && (
        <div className="mt-2 space-y-2 rounded border border-gray-200 p-3">
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as Provider)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          >
            {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>

          <div className="flex gap-2">
            <input
              type="password"
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder={`${PROVIDER_LABELS[provider]} API key`}
              autoComplete="off"
              className="flex-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={() => void handleFetchModels()}
              disabled={!apiKey.trim() || fetching}
              className="rounded bg-gray-800 px-3 py-1.5 text-sm text-white disabled:bg-gray-300"
            >
              {fetching ? 'Fetching…' : 'Fetch models'}
            </button>
          </div>

          {models.length > 0 && (
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  )
}
