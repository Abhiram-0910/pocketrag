import { useEffect, useImperativeHandle, useReducer, useRef, useState, type Ref } from 'react'
import { flushSync } from 'react-dom'
import { Eye, EyeSlash } from '@phosphor-icons/react'
import type { KeyConfig } from '../lib/answerRequest'
import { PROVIDER_LABELS, fetchModelsFromWorker, type Provider } from '../lib/models'
import { buildLadder, INITIAL_PICKER, isValidModelId, pickerReducer, type Rung } from '../lib/modelLadder'
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

// Providers live-verified end-to-end against their real API (see AGENTS.md session
// logs). Everything else here is shipped selectable but flagged Experimental — built
// and unit-tested against mocked responses, never shown to produce a real answer. Its
// failures are classified by the Worker like any other provider's (worker/src/index.ts's
// classifyStatus) and shown as that code's fixed copy; only a failure the Worker can't
// classify gets the "isn't fully supported yet" copy. Must be a subset of
// worker/src/validate.ts's EXPERIMENTAL_PROVIDERS (experimentalProviders.test.ts).
// Anthropic was live-verified in Phase 6 (v1.0.1); the Worker's copy still lists it until
// the next Worker deploy.
const EXPERIMENTAL_PROVIDERS: Provider[] = ['grok', 'openrouter']

/**
 * Own-key entry: provider picker, key input, "Find a model" (the Worker's /models, then
 * modelLadder.ts ranks the list), one proposal at a time with Higher/Lower, confirmed
 * before use; plus a manual model-id escape hatch. No model list is ever rendered. The key
 * and model live only in this component's local state — never Zustand, never IndexedDB — so it
 * can't be picked up by a devtools/logging integration attached to shared state later,
 * and it disappears on reload by construction (nothing persists it). `onChange` reports
 * `null` whenever BYOK is selected but not yet complete (no key, or key not yet resolved
 * to a model), so the caller never silently falls back to the shared key mid-setup.
 */
export function ByokPanel({ onChange, ref }: ByokPanelProps) {
  const [useOwnKey, setUseOwnKey] = useState(false)
  const [provider, setProvider] = useState<Provider>('gemini')
  const [apiKey, setApiKey] = useState('')
  const [picker, dispatch] = useReducer(pickerReducer, INITIAL_PICKER)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<PanelError | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [manualId, setManualId] = useState('')
  const [manualError, setManualError] = useState<string | null>(null)
  const providerSelectRef = useRef<HTMLSelectElement>(null)
  const keyInputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const changeRef = useRef<HTMLButtonElement>(null)
  const manualInputRef = useRef<HTMLInputElement>(null)

  // The question box follows this: null (disabled) until a model is confirmed.
  useEffect(() => {
    if (!useOwnKey) onChange({ keySource: 'shared' })
    else onChange(picker.confirmed ? { keySource: 'own', apiKey: apiKey.trim(), provider, model: picker.confirmed } : null)
  }, [useOwnKey, picker.confirmed, apiKey, provider, onChange])

  const resetPicker = () => {
    dispatch({ type: 'reset' })
    setManualId('')
    setManualError(null)
    setError(null)
  }

  // Each step re-renders synchronously, then focus lands on the next thing to press.
  const step = (action: Parameters<typeof dispatch>[0], focus: () => HTMLElement | null = () => confirmRef.current) => {
    flushSync(() => dispatch(action))
    focus()?.focus()
  }

  const handleToggle = (next: boolean) => {
    setUseOwnKey(next)
    resetPicker()
  }

  // A changed provider or key invalidates the found model.
  const handleProviderChange = (next: Provider) => {
    setProvider(next)
    resetPicker()
  }

  const handleApiKeyChange = (value: string) => {
    setApiKey(value)
    resetPicker()
  }

  const handleFindModel = async () => {
    const trimmedKey = apiKey.trim()
    if (!trimmedKey) return
    setFetching(true)
    resetPicker()
    try {
      const fetched = await fetchModelsFromWorker(provider, trimmedKey)
      const ladder = buildLadder(provider, fetched)
      step({ type: 'loaded', ladder }, () => (ladder.rungs.length > 0 ? confirmRef.current : manualInputRef.current))
    } catch (err) {
      if (err instanceof WorkerRequestError) {
        const action = failureAction(err.code, err.source)
        setError({
          ...classify({ message: err.message, status: err.status, resetAt: err.resetAt }),
          // /models is always own-key, so only these two actions make sense here.
          action: action === 'check-key' || action === 'retry' ? action : null,
        })
      } else {
        setError(classify({ message: err instanceof Error ? err.message : 'Failed to fetch model list.' }))
      }
    } finally {
      setFetching(false)
    }
  }

  const handleManualSubmit = () => {
    const id = manualId.trim()
    if (!isValidModelId(provider, id)) {
      setManualError(
        provider === 'gemini'
          ? 'A model ID is 1-128 letters, digits, and . _ - characters.'
          : 'A model ID is 1-128 letters, digits, and . _ - : / ~ characters.',
      )
      manualInputRef.current?.focus()
      return
    }
    setManualError(null)
    step({ type: 'confirm-manual', id }, () => changeRef.current)
  }

  // key_rejected: the found model belongs to a key the provider just refused — drop it and
  // send the user to the key. "Find a model" stays enabled for the same key, so a key that
  // was only temporarily rejected can be retried without retyping it. choose-model (the
  // model was rejected): reopen the picker one rung LOWER, or the manual input if none.
  const handleFailureAction = (action: FailureAction) => {
    switch (action) {
      case 'check-key':
        // Drops the model but keeps the banner: the user still needs to read why.
        dispatch({ type: 'reset' })
        keyInputRef.current?.focus()
        break
      case 'choose-model': {
        if (!useOwnKey || picker.confirmed === null) break
        const next = pickerReducer(picker, { type: 'model-rejected' })
        step({ type: 'model-rejected' }, () => (next.manualOpen ? manualInputRef.current : confirmRef.current))
        break
      }
      case 'use-own-key':
        // flushSync so the provider select is mounted before we focus it.
        if (!useOwnKey) flushSync(() => handleToggle(true))
        providerSelectRef.current?.focus()
        break
      case 'retry':
        void handleFindModel()
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
          Free shared tier: Google uses what's sent and the answers to improve its products, and human reviewers may
          read them. Use your own paid key to avoid that.
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
            <Button onClick={() => void handleFindModel()} disabled={!apiKey.trim() || fetching} loading={fetching}>
              {fetching ? 'Finding…' : 'Find a model'}
            </Button>
          </div>

          {picker.rejected !== null && picker.confirmed === null && (
            <p className="text-slate-700 dark:text-slate-300">
              The provider rejected the last request with <span className="font-mono break-all">{picker.rejected}</span>.
            </p>
          )}
          {/* Always mounted while own-key is on, so the first proposal is announced too. Holds
              only the sentence: each step is announced once, never the buttons. */}
          <p aria-live="polite" aria-atomic="true" className="break-words font-medium text-slate-900 empty:hidden dark:text-slate-100">
            {pickerSentence(picker)}
          </p>

          {picker.ladder && (
            <ModelPicker
              picker={picker}
              confirmRef={confirmRef}
              changeRef={changeRef}
              onHigher={() => step({ type: 'higher' })}
              onLower={() => step({ type: 'lower' })}
              onConfirm={() => step({ type: 'confirm' }, () => changeRef.current)}
              onChange={() => step({ type: 'change' })}
            />
          )}

          {picker.ladder && (
            <details
              open={picker.manualOpen}
              onToggle={(e) => {
                const open = (e.currentTarget as HTMLDetailsElement).open
                if (open !== picker.manualOpen) dispatch({ type: 'toggle-manual', open })
              }}
            >
              <summary className="min-h-11 cursor-pointer py-2 text-slate-700 dark:text-slate-300">
                Enter a model ID yourself
              </summary>
              <div className="flex gap-2">
                <input
                  ref={manualInputRef}
                  aria-label="Model ID"
                  aria-invalid={manualError ? true : undefined}
                  aria-describedby={manualError ? 'byok-manual-error' : undefined}
                  value={manualId}
                  onChange={(e) => setManualId(e.target.value)}
                  onKeyDown={(e) => {
                    // preventDefault: focus moves to "Change" on submit, and the same Enter must not press it.
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleManualSubmit()
                    }
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  className="min-h-11 min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5 font-mono text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
                />
                <Button variant="secondary" onClick={handleManualSubmit} disabled={!manualId.trim()}>
                  Use this ID
                </Button>
              </div>
              {manualError && (
                <p id="byok-manual-error" className="mt-1 text-xs text-red-700 dark:text-red-400">
                  {manualError}
                </p>
              )}
            </details>
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

function modelName(r: Rung): string {
  return r.displayName === r.id ? r.id : `${r.displayName} (${r.id})`
}

interface ModelPickerProps {
  picker: ReturnType<typeof pickerReducer>
  confirmRef: Ref<HTMLButtonElement>
  changeRef: Ref<HTMLButtonElement>
  onHigher: () => void
  onLower: () => void
  onConfirm: () => void
  onChange: () => void
}

/** What the always-mounted live region says: one sentence per picker step. */
function pickerSentence(picker: ReturnType<typeof pickerReducer>): string {
  const ladder = picker.ladder
  if (ladder === null) return ''
  const rung = ladder.rungs[picker.index] as Rung | undefined
  if (picker.confirmed !== null) {
    const using = ladder.rungs.find((r) => r.id === picker.confirmed)
    return `Using ${using ? modelName(using) : picker.confirmed}.`
  }
  if (!rung) return "Couldn't pick a model automatically. Enter a model ID below."
  const tier = rung.tier ? ` (${rung.tier})` : ''
  const recommended = picker.index === ladder.recommendedIndex ? ' · Recommended' : ''
  return `We'll use ${modelName(rung)}${tier}${recommended}`
}

/** One proposal at a time; its sentence is in ByokPanel's live region, the buttons here. */
function ModelPicker({ picker, confirmRef, changeRef, onHigher, onLower, onConfirm, onChange }: ModelPickerProps) {
  const ladder = picker.ladder!
  const rung = ladder.rungs[picker.index] as Rung | undefined
  const top = picker.index === ladder.rungs.length - 1
  const bottom = picker.index === 0

  return (
    <div className="space-y-2">
      {picker.confirmed !== null ? (
        <Button ref={changeRef} variant="secondary" onClick={onChange}>
          Change
        </Button>
      ) : (
        rung && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button ref={confirmRef} onClick={onConfirm}>
                Use this model
              </Button>
              {!ladder.routerChooses && (
                <>
                  <Button variant="secondary" onClick={onHigher} disabled={top}>
                    Use a higher model
                  </Button>
                  <Button variant="secondary" onClick={onLower} disabled={bottom}>
                    Use a lower model
                  </Button>
                </>
              )}
            </div>
            {ladder.routerChooses ? (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                OpenRouter chooses the model for each question, so there's no higher or lower option.
              </p>
            ) : (
              <p className="text-xs text-slate-600 dark:text-slate-400">
                {top && 'This is the highest model we found for your key. '}
                {bottom && 'This is the lowest model we found for your key. '}
                Higher models usually cost more per question.
              </p>
            )}
          </>
        )
      )}
    </div>
  )
}
