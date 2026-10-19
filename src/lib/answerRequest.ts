import { WorkerRequestError, parseWorkerErrorResponse, type FailureCode, type FailureSource } from './apiError'
import { egressFetch } from './egress'

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
) => Promise<AnswerResponse>

export type AnswerAttemptResult =
  | {
      outcome: 'success'
      answer: string
      groundingWarning: boolean
      docLabels: DocLabel[]
      webSources?: WebSource[]
      searchEntryPointHtml?: string
    }
  | { outcome: 'timeout' }
  | {
      outcome: 'error'
      message: string
      status?: number
      resetAt?: string
      code?: FailureCode
      source?: FailureSource
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
): Promise<AnswerAttemptResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const {
      answer,
      groundingWarning,
      docLabels: responseDocLabels,
      webSources,
      searchEntryPointHtml,
    } = await fetchAnswer(question, chunks, keyConfig, controller.signal, docLabels, history, image, enableWebSearch)
    return { outcome: 'success', answer, groundingWarning, docLabels: responseDocLabels, webSources, searchEntryPointHtml }
  } catch (err) {
    if (isAbortError(err)) return { outcome: 'timeout' }
    if (err instanceof WorkerRequestError) {
      return {
        outcome: 'error',
        message: err.message,
        status: err.status,
        resetAt: err.resetAt,
        code: err.code,
        source: err.source,
      }
    }
    return { outcome: 'error', message: err instanceof Error ? err.message : 'unknown error' }
  } finally {
    clearTimeout(timeoutId)
  }
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
) => {
  if (!API_BASE_URL) {
    throw new Error('Answer generation is not configured yet (VITE_API_BASE_URL is unset).')
  }
  const res = await egressFetch(
    `${API_BASE_URL}/answer`,
    {
      // `image`/`enableWebSearch` are undefined whenever their respective gate didn't
      // fire — JSON.stringify drops an undefined-valued key entirely, so the Worker sees
      // no field at all on an ordinary request, not an explicit `null`/`false`.
      json: { question, chunks, ...keyConfig, docLabels, history, image, enableWebSearch },
      signal,
    },
    { purpose: 'answer', upstream: keyConfig.keySource === 'own' ? keyConfig.provider : 'gemini' },
  )
  if (!res.ok) {
    throw await parseWorkerErrorResponse(res, `Answer request failed (${res.status}).`)
  }
  return (await res.json()) as AnswerResponse
}
