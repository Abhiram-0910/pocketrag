import { WorkerRequestError, parseWorkerErrorResponse } from './apiError'

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

export interface AnswerResponse {
  answer: string
  groundingWarning: boolean
  docLabels: DocLabel[]
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
) => Promise<AnswerResponse>

export type AnswerAttemptResult =
  | { outcome: 'success'; answer: string; groundingWarning: boolean; docLabels: DocLabel[] }
  | { outcome: 'timeout' }
  | { outcome: 'error'; message: string; status?: number; resetAt?: string }

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
): Promise<AnswerAttemptResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { answer, groundingWarning, docLabels: responseDocLabels } = await fetchAnswer(
      question,
      chunks,
      keyConfig,
      controller.signal,
      docLabels,
      history,
    )
    return { outcome: 'success', answer, groundingWarning, docLabels: responseDocLabels }
  } catch (err) {
    if (isAbortError(err)) return { outcome: 'timeout' }
    if (err instanceof WorkerRequestError) {
      return { outcome: 'error', message: err.message, status: err.status, resetAt: err.resetAt }
    }
    return { outcome: 'error', message: err instanceof Error ? err.message : 'unknown error' }
  } finally {
    clearTimeout(timeoutId)
  }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

/** Real implementation of FetchAnswerFn — posts to the Cloudflare Worker. */
export const fetchAnswerFromWorker: FetchAnswerFn = async (question, chunks, keyConfig, signal, docLabels, history) => {
  if (!API_BASE_URL) {
    throw new Error('Answer generation is not configured yet (VITE_API_BASE_URL is unset).')
  }
  const res = await fetch(`${API_BASE_URL}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, chunks, ...keyConfig, docLabels, history }),
    signal,
  })
  if (!res.ok) {
    throw await parseWorkerErrorResponse(res, `Answer request failed (${res.status}).`)
  }
  return (await res.json()) as AnswerResponse
}
