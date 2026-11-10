import { FAILURE_CODES, WorkerRequestError, parseWorkerErrorResponse, type FailureCode, type FailureSource } from './apiError'
import { egressFetch, egressStream, type EgressRecord } from './egress'
import { readAnswerStream } from './sse'
import { PROVIDERS, type Provider } from './models'

// The Worker owns Doc N labelling and returns this label→documentId map so the client
// can resolve real titles for the legend/Sources (documentId → fileName lives locally).
export interface DocLabel {
  label: number
  documentId: string
}

// A prior turn's {question, answer} pair, sent as conversation context (Milestone 11
// Phase C2) — mirrors the Worker's HistoryTurn shape (worker/src/validate.ts).
export interface HistoryTurn {
  question: string
  answer: string
}

// Milestone 12 (Gemini-native grounding): a single real, structured web source from
// Gemini's own groundingChunks — replaces the earlier (reverted) Brave-search-era
// fabricated "Web N" label scheme entirely.
export interface WebSource {
  uri: string
  title: string
}

export interface AnswerResponse {
  answer: string
  groundingWarning: boolean
  docLabels: DocLabel[]
  // Always present on a real Worker response (empty array when grounding wasn't
  // enabled, or was enabled but Gemini chose not to search) — optional here
  // defensively so no pre-existing mocked response in this file's own tests needs
  // updating for a field they don't exercise.
  webSources?: WebSource[]
  // Google's Grounding ToS (ai.google.dev/gemini-api/terms#grounding-with-google-search)
  // requires displaying this HTML/CSS "Search Suggestions" widget alongside any grounded
  // result shown to an end user — present only when Gemini actually searched.
  searchEntryPointHtml?: string
  // The provider and model that answered, echoed by the Worker (absent from an older
  // Worker, or dropped by fetchAnswerFromWorker when malformed).
  provider?: Provider
  model?: string
}

// Milestone 10 Phase B: at most one page image per request, produced by
// src/lib/pageRender.ts. Mirrors the Worker's ImageAttachment shape
// (worker/src/validate.ts) — the Worker independently rejects it outright for any
// non-shared keySource, so this being optional here doesn't rely on the client
// remembering not to send it.
export interface ImageAttachment {
  mimeType: string
  base64: string
}

export interface RequestAnswerChunk {
  text: string
  page: number
  score: number
  documentId: string
}

// Mirrors the Worker's validate.ts ValidationResult shape. The 'own' variant's apiKey
// lives only in this object, passed straight through to fetch() — never stored,
// never logged, discarded once the request settles.
export type KeyConfig =
  | { keySource: 'shared' }
  | {
      keySource: 'own'
      apiKey: string
      provider: 'gemini' | 'openai' | 'anthropic' | 'grok' | 'openrouter'
      model: string
    }

export type FetchAnswerFn = (
  question: string,
  chunks: RequestAnswerChunk[],
  keyConfig: KeyConfig,
  signal: AbortSignal,
  docLabels: DocLabel[],
  history: HistoryTurn[],
  image?: ImageAttachment,
  // Milestone 12: Gemini-specific (see the Worker's validate.ts) — accepted for the
  // shared tier and for BYOK requests that chose provider 'gemini', rejected outright
  // for every other BYOK provider.
  enableWebSearch?: boolean,
  // Where this request's egress records go — the turn's chatStore.appendEgress. Without
  // it an answer request isn't recorded (egress.ts keeps answers out of the session log).
  onEgress?: (record: EgressRecord) => void,
  // v1.1: the first chunk is a worked example the question follows with new values
  // (src/lib/sourceMatch.ts); the Worker asks for that example's method.
  followMethod?: boolean,
  // v1.3: ask for a streamed answer. `onDelta` gets each piece of text; `onActivity` every
  // chunk (for the idle timeout). Omitted: the JSON request, unchanged.
  stream?: { onDelta: (text: string) => void; onActivity: () => void },
) => Promise<AnswerResponse>

// The Worker streams these (worker/src/stream.ts STREAMING_PROVIDERS); the rest answer in
// one piece. Web-search answers never stream (Search Suggestions come with the result).
const STREAMING_PROVIDERS: readonly Provider[] = ['gemini', 'openai', 'anthropic']
export function canStream(keyConfig: KeyConfig, enableWebSearch: boolean): boolean {
  if (enableWebSearch) return false
  return keyConfig.keySource === 'shared' || STREAMING_PROVIDERS.includes(keyConfig.provider)
}

// A streamed answer that started but didn't finish: the Worker's error event (its copy,
// shown verbatim), or a stream cut off with no event at all.
export class StreamInterruptedError extends Error {
  readonly partial: string
  readonly code?: FailureCode
  constructor(partial: string, message: string, code?: FailureCode) {
    super(message)
    this.partial = partial
    this.code = code
  }
}
// Client copy only for the cases the Worker can't report: the connection itself ended.
export const STREAM_CUT_MESSAGE = 'The connection ended before the answer finished.'
export const STREAM_STALLED_MESSAGE = 'The answer stopped arriving.'

export type AnswerAttemptResult =
  | {
      outcome: 'success'
      answer: string
      groundingWarning: boolean
      docLabels: DocLabel[]
      webSources?: WebSource[]
      searchEntryPointHtml?: string
      provider?: Provider
      model?: string
    }
  | { outcome: 'timeout' }
  // v1.3: part of a streamed answer arrived (or none, if Stop came first). Never a success.
  | { outcome: 'interrupted'; partial: string; reason: 'stopped' | 'error'; message?: string; code?: FailureCode }
  | {
      outcome: 'error'
      message: string
      status?: number
      resetAt?: string
      code?: FailureCode
      source?: FailureSource
      retryAfterSeconds?: number
      cooldownSeconds?: number
    }

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** Runs one answer-composition attempt with a hard timeout. Has no notion of retries. */
export async function attemptAnswer(
  fetchAnswer: FetchAnswerFn,
  question: string,
  chunks: RequestAnswerChunk[],
  keyConfig: KeyConfig,
  timeoutMs: number,
  docLabels: DocLabel[] = [],
  history: HistoryTurn[] = [],
  image?: ImageAttachment,
  enableWebSearch?: boolean,
  onEgress?: (record: EgressRecord) => void,
  followMethod?: boolean,
  // v1.3. `onDelta` present: request a stream (if this provider streams). `stopSignal`: the
  // user's Stop, for either kind of request. While a stream is arriving, `timeoutMs` is an
  // idle timeout (reset on every chunk) instead of a total.
  live?: { onDelta?: (text: string) => void; stopSignal?: AbortSignal },
): Promise<AnswerAttemptResult> {
  const controller = new AbortController()
  let stopped = false
  const stop = () => {
    stopped = true
    controller.abort()
  }
  if (live?.stopSignal?.aborted) stop()
  live?.stopSignal?.addEventListener('abort', stop)
  let timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  const onActivity = () => {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  }
  const stream = live?.onDelta && canStream(keyConfig, enableWebSearch === true) ? { onDelta: live.onDelta, onActivity } : undefined
  try {
    const args = [question, chunks, keyConfig, controller.signal, docLabels, history, image, enableWebSearch, onEgress, followMethod] as const
    // The non-streaming call keeps exactly its pre-v1.3 arguments.
    const {
      answer,
      groundingWarning,
      docLabels: responseDocLabels,
      webSources,
      searchEntryPointHtml,
      provider,
      model,
    } = stream ? await fetchAnswer(...args, stream) : await fetchAnswer(...args)
    return {
      outcome: 'success',
      answer,
      groundingWarning,
      docLabels: responseDocLabels,
      webSources,
      searchEntryPointHtml,
      provider,
      model,
    }
  } catch (err) {
    if (err instanceof StreamInterruptedError) {
      return { outcome: 'interrupted', partial: err.partial, reason: 'error', message: err.message, code: err.code }
    }
    // Reading the stream failed part-way: Stop, the idle timeout, or the network.
    const partial = (err as { partial?: unknown } | null)?.partial
    if (stopped) return { outcome: 'interrupted', partial: typeof partial === 'string' ? partial : '', reason: 'stopped' }
    if (typeof partial === 'string') {
      return { outcome: 'interrupted', partial, reason: 'error', message: isAbortError(err) ? STREAM_STALLED_MESSAGE : STREAM_CUT_MESSAGE }
    }
    if (isAbortError(err)) return { outcome: 'timeout' }
    if (err instanceof WorkerRequestError) {
      return {
        outcome: 'error',
        message: err.message,
        status: err.status,
        resetAt: err.resetAt,
        code: err.code,
        source: err.source,
        retryAfterSeconds: err.retryAfterSeconds,
        cooldownSeconds: err.cooldownSeconds,
      }
    }
    return { outcome: 'error', message: err instanceof Error ? err.message : 'unknown error' }
  } finally {
    clearTimeout(timeoutId)
    live?.stopSignal?.removeEventListener('abort', stop)
  }
}

// Same character set as the Worker's MODEL_PATTERN (worker/src/validate.ts).
const ECHOED_MODEL_PATTERN = /^[A-Za-z0-9._:/~-]{1,128}$/

/** The Worker's {provider, model} echo, kept only when both are well-formed — it ends up
 * on a receipt, so a malformed value is dropped rather than shown. */
export function parseServedBy(data: { provider?: unknown; model?: unknown }): { provider: Provider; model: string } | undefined {
  const { provider, model } = data
  if (!(PROVIDERS as readonly unknown[]).includes(provider)) return undefined
  if (typeof model !== 'string' || !ECHOED_MODEL_PATTERN.test(model)) return undefined
  return { provider: provider as Provider, model }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

/** Real implementation of FetchAnswerFn — posts to the Cloudflare Worker. */
export const fetchAnswerFromWorker: FetchAnswerFn = async (
  question,
  chunks,
  keyConfig,
  signal,
  docLabels,
  history,
  image,
  enableWebSearch,
  onEgress,
  followMethod,
  stream,
) => {
  if (!API_BASE_URL) {
    throw new Error('Answer generation is not configured yet (VITE_API_BASE_URL is unset).')
  }
  if (stream) return fetchStreamedAnswer({ question, chunks, ...keyConfig, docLabels, history, image, followMethod: followMethod || undefined, stream: true }, keyConfig, signal, stream, onEgress)
  const res = await egressFetch(
    `${API_BASE_URL}/answer`,
    {
      // `image`/`enableWebSearch` are undefined whenever their respective gate didn't
      // fire — JSON.stringify drops an undefined-valued key entirely, so the Worker sees
      // no field at all on an ordinary request, not an explicit `null`/`false`. Same for
      // followMethod: sent only when true, so other requests are unchanged byte for byte.
      json: { question, chunks, ...keyConfig, docLabels, history, image, enableWebSearch, followMethod: followMethod || undefined },
      signal,
    },
    { purpose: 'answer', upstream: keyConfig.keySource === 'own' ? keyConfig.provider : 'gemini' },
    onEgress,
  )
  if (!res.ok) {
    throw await parseWorkerErrorResponse(res, `Answer request failed (${res.status}).`)
  }
  const data = (await res.json()) as AnswerResponse
  const servedBy = parseServedBy(data)
  return { ...data, provider: servedBy?.provider, model: servedBy?.model }
}

const isFailureCode = (value: unknown): value is FailureCode => (FAILURE_CODES as readonly unknown[]).includes(value)

/**
 * v1.3: the streamed /answer. A non-2xx is the Worker's normal JSON failure (it only streams
 * once the provider has answered); a 2xx JSON body is its non-streaming fallback (a provider
 * that can't stream); otherwise the event stream: `done` → a normal answer, an `error`
 * event or a cut-off stream → StreamInterruptedError with the partial text. The Receipt row
 * ends 'ok' only for a complete answer, else 'interrupted'.
 */
async function fetchStreamedAnswer(
  json: Record<string, unknown>,
  keyConfig: KeyConfig,
  signal: AbortSignal,
  stream: { onDelta: (text: string) => void; onActivity: () => void },
  onEgress?: (record: EgressRecord) => void,
): Promise<AnswerResponse> {
  const { response, settle } = await egressStream(
    `${API_BASE_URL}/answer`,
    { json, signal },
    { purpose: 'answer', upstream: keyConfig.keySource === 'own' ? keyConfig.provider : 'gemini' },
    onEgress,
  )
  if (!response.ok) throw await parseWorkerErrorResponse(response, `Answer request failed (${response.status}).`)
  if (!(response.headers.get('Content-Type') ?? '').includes('text/event-stream') || !response.body) {
    const data = (await response.json()) as AnswerResponse
    const servedBy = parseServedBy(data)
    return { ...data, provider: servedBy?.provider, model: servedBy?.model }
  }
  let result
  try {
    result = await readAnswerStream(response.body, stream.onDelta, stream.onActivity)
  } catch (err) {
    settle('interrupted')
    throw err
  }
  if (!result.done) {
    settle('interrupted')
    const message = typeof result.error?.error === 'string' ? result.error.error : STREAM_CUT_MESSAGE
    throw new StreamInterruptedError(result.text, message, isFailureCode(result.error?.code) ? result.error.code : undefined)
  }
  settle('ok')
  const servedBy = parseServedBy(result.meta ?? {})
  return {
    answer: result.text,
    groundingWarning: result.done.groundingWarning === true,
    docLabels: Array.isArray(result.done.docLabels) ? (result.done.docLabels as DocLabel[]) : [],
    provider: servedBy?.provider,
    model: servedBy?.model,
  }
}

