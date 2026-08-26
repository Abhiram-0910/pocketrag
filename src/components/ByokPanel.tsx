import { useState } from 'react'
import { Eye, EyeSlash } from '@phosphor-icons/react'
import type { KeyConfig } from '../lib/answerRequest'
import { fetchModelsFromWorker, type ModelInfo } from '../lib/models'
import { WorkerRequestError } from '../lib/apiError'
import { classify, type TaxonomyResult } from '../lib/errorTaxonomy'
import { StatusBanner } from './ui/StatusBanner'
import { Button } from './ui/Button'

interface ByokPanelProps {
  onChange: (config: KeyConfig | null) => void
}

type Provider = 'gemini' | 'openai' | 'anthropic' | 'grok' | 'openrouter'

const PROVIDER_LABELS: Record<Provider, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Claude',
  grok: 'Grok',
  openrouter: 'OpenRouter',
}

// Providers live-verified end-to-end against their real API (see AGENTS.md session
// logs). Everything else here is shipped selectable but flagged Experimental — built
// and unit-tested against mocked responses, never exercised against a real account. A
// failure on an Experimental provider is logged server-side (worker/src/index.ts's
// logProviderError) and surfaced to the user as a calm generic message, never raw
// provider error text — see QueryPanel's answerError display.
const EXPERIMENTAL_PROVIDERS: Provider[] = ['anthropic', 'grok', 'openrouter']

// Gemini's /models list isn't filtered by "available to new users" — it can return a
// since-deprecated model (e.g. gemini-2.5-flash) ahead of working ones, so picking
// fetched[0] blindly can auto-select a model that 404s on the very first real question.
// Prefer the same model the shared tier already pins for exactly this reason
// (worker/src/providers/gemini.ts's DEFAULT_SHARED_MODEL) when it's present in the
// fetched list; fall back to fetched[0] only if it's genuinely absent. Found live via
// Milestone 16's BYOK-Gemini retest (Session 28).
const PREFERRED_GEMINI_MODEL = 'gemini-3.5-flash-lite'

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
  const [error, setError] = useState<TaxonomyResult | null>(null)
  const [showKey, setShowKey] = useState(false)

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
        setError({ type: 'unknown', severity: 'error', message: 'This key returned no usable models.' })
        setModels([])
        setSelectedModel('')
        onChange(null)
        return
      }
      const defaultModel =
        (provider === 'gemini' && fetched.find((m) => m.id === PREFERRED_GEMINI_MODEL)) || fetched[0]
      setModels(fetched)
      setSelectedModel(defaultModel.id)
      onChange({ keySource: 'own', apiKey: trimmedKey, provider, model: defaultModel.id })
    } catch (err) {
      const classified =
        err instanceof WorkerRequestError
          ? classify({ message: err.message, status: err.status, resetAt: err.resetAt })
          : classify({ message: err instanceof Error ? err.message : 'Failed to fetch model list.' })
      setError(classified)
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
    <div className="text-left text-sm">
      <label className="flex min-h-11 cursor-pointer items-center gap-2 text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={useOwnKey}
          onChange={(e) => handleToggle(e.target.checked)}
          className="size-4 cursor-pointer accent-blue-600"
        />
        Use your own API key
      </label>

      {useOwnKey && (
        <div className="mt-2 space-y-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as Provider)}
            className="min-h-11 w-full rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          >
            {(Object.keys(PROVIDER_LABELS) as Provider[]).map((p) => (
              <option key={p} value={p}>
                {EXPERIMENTAL_PROVIDERS.includes(p) ? `${PROVIDER_LABELS[p]} (Experimental)` : PROVIDER_LABELS[p]}
              </option>
            ))}
          </select>

          {EXPERIMENTAL_PROVIDERS.includes(provider) && (
            <StatusBanner variant="warning">
              Experimental — this provider hasn't been verified against a live account yet. If something goes
              wrong, you'll see a generic error message.
            </StatusBanner>
          )}

          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => handleApiKeyChange(e.target.value)}
                placeholder={`${PROVIDER_LABELS[provider]} API key`}
                autoComplete="off"
                className="min-h-11 w-full rounded border border-slate-300 py-1.5 pr-9 pl-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                className="absolute inset-y-0 right-0 flex w-9 cursor-pointer items-center justify-center text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
              >
                {showKey ? <EyeSlash className="size-4" weight="bold" /> : <Eye className="size-4" weight="bold" />}
              </button>
            </div>
            <Button onClick={() => void handleFetchModels()} disabled={!apiKey.trim() || fetching} loading={fetching}>
              {fetching ? 'Fetching…' : 'Fetch models'}
            </Button>
          </div>

          {models.length > 0 && (
            <select
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="min-h-11 w-full rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          )}

          {error && <StatusBanner variant={error.severity}>{error.message}</StatusBanner>}
        </div>
      )}
    </div>
  )
}
