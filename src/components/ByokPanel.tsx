import { useImperativeHandle, useRef, useState, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { Eye, EyeSlash } from '@phosphor-icons/react'
import type { KeyConfig } from '../lib/answerRequest'
import { defaultModelFor, fetchModelsFromWorker, type ModelInfo, type Provider } from '../lib/models'
import { WorkerRequestError, failureAction, type FailureAction } from '../lib/apiError'
import { classify, type TaxonomyResult } from '../lib/errorTaxonomy'
import { StatusBanner } from './ui/StatusBanner'
import { Button } from './ui/Button'

/** Lets QueryPanel's answer-failure actions (via App) reach this panel's local state. */
export interface ByokPanelHandle {
  handleFailureAction: (action: FailureAction) => void
}

interface ByokPanelProps {
  onChange: (config: KeyConfig | null) => void
  ref?: Ref<ByokPanelHandle>
}

type PanelError = TaxonomyResult & { action?: FailureAction | null }

const PROVIDER_LABELS: Record<Provider, string> = {
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Claude',
  grok: 'Grok',
  openrouter: 'OpenRouter',
}

// Providers live-verified end-to-end against their real API (see AGENTS.md session
// logs). Everything else here is shipped selectable but flagged Experimental — built
// and unit-tested against mocked responses, never shown to produce a real answer. Its
// failures are classified by the Worker like any other provider's (worker/src/index.ts's
// classifyStatus) and shown as that code's fixed copy; only a failure the Worker can't
// classify gets the "isn't fully supported yet" copy. Must match worker/src/validate.ts's
// EXPERIMENTAL_PROVIDERS (experimentalProviders.test.ts).
const EXPERIMENTAL_PROVIDERS: Provider[] = ['anthropic', 'grok', 'openrouter']

/**
 * Own-key entry: provider picker, key input, "fetch models" call, model picker. The key
 * lives only in this component's local state — never Zustand, never IndexedDB — so it
 * can't be picked up by a devtools/logging integration attached to shared state later,
 * and it disappears on reload by construction (nothing persists it). `onChange` reports
 * `null` whenever BYOK is selected but not yet complete (no key, or key not yet resolved
 * to a model), so the caller never silently falls back to the shared key mid-setup.
 */
export function ByokPanel({ onChange, ref }: ByokPanelProps) {
  const [useOwnKey, setUseOwnKey] = useState(false)
  const [provider, setProvider] = useState<Provider>('gemini')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('')
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [showKey, setShowKey] = useState(false)
  const providerSelectRef = useRef<HTMLSelectElement>(null)
  const keyInputRef = useRef<HTMLInputElement>(null)
  const modelSelectRef = useRef<HTMLSelectElement>(null)

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
      // '' leaves the "Choose a model" placeholder selected and the key config unset, so
      // Ask stays disabled until the user picks a model themselves.
      const defaultModel = defaultModelFor(provider, fetched)
      setModels(fetched)
      setSelectedModel(defaultModel)
      onChange(defaultModel ? { keySource: 'own', apiKey: trimmedKey, provider, model: defaultModel } : null)
    } catch (err) {
      if (err instanceof WorkerRequestError) {
        const action = failureAction(err.code, err.source)
        setError({
          ...classify({ message: err.message, status: err.status, resetAt: err.resetAt }),
          // A failed fetch leaves no model list to choose from, and /models is always
          // own-key, so only these two actions make sense here.
          action: action === 'check-key' || action === 'retry' ? action : null,
        })
      } else {
        setError(classify({ message: err instanceof Error ? err.message : 'Failed to fetch model list.' }))
      }
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

  // key_rejected: the fetched list belongs to a key the provider just refused — drop it
  // and send the user to the key. "Fetch models" stays enabled for the same key, so a
  // key that was only temporarily rejected can be re-fetched without retyping it.
  const handleFailureAction = (action: FailureAction) => {
    switch (action) {
      case 'check-key':
        setModels([])
        setSelectedModel('')
        onChange(null)
        keyInputRef.current?.focus()
        break
      case 'choose-model':
        modelSelectRef.current?.focus()
        break
      case 'use-own-key':
        // flushSync so the provider select is mounted before we focus it.
        if (!useOwnKey) flushSync(() => handleToggle(true))
        providerSelectRef.current?.focus()
        break
      case 'retry':
        void handleFetchModels()
        break
    }
  }

  useImperativeHandle(ref, () => ({ handleFailureAction }))

  const errorAction = error?.action ?? null

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

      {/* Shared tier only. Same meaning as LandingPage's free-tier line (Gemini API terms,
          "Unpaid Services"); hidden once the user switches to their own key. */}
      {!useOwnKey && (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
          Free shared tier: Google uses what's sent to improve its products and human reviewers may read it. Use your
          own paid key to avoid that.
        </p>
      )}

      {useOwnKey && (
        <div className="mt-2 space-y-2 rounded border border-slate-200 p-3 dark:border-slate-700">
          <select
            ref={providerSelectRef}
            aria-label="Provider"
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
              Experimental — this provider hasn't been verified end to end with a real API key yet, so it may not
              work.
            </StatusBanner>
          )}

          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                ref={keyInputRef}
                aria-label={`${PROVIDER_LABELS[provider]} API key`}
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
              ref={modelSelectRef}
              aria-label="Model"
              value={selectedModel}
              onChange={(e) => handleModelChange(e.target.value)}
              className="min-h-11 w-full rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            >
              <option value="" disabled>
                Choose a model
              </option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          )}

          <div aria-live="polite" aria-atomic="true">
            {error && (
              <StatusBanner variant={error.severity} inLiveRegion>
                <span className="block">{error.message}</span>
                {errorAction && (
                  <Button variant="secondary" className="mt-2" onClick={() => handleFailureAction(errorAction)}>
                    {errorAction === 'check-key' ? 'Check your key' : 'Try again'}
                  </Button>
                )}
              </StatusBanner>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
