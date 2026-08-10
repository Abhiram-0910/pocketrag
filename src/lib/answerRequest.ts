// The Worker owns Doc N labelling and returns this label→documentId map so the client
// can resolve real titles for the legend/Sources (documentId → fileName lives locally).
export interface DocLabel {
  label: number
  documentId: string
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
  | { keySource: 'own'; apiKey: string; provider: 'gemini' | 'openai' | 'anthropic'; model: string }

export type FetchAnswerFn = (
  question: string,
  chunks: RequestAnswerChunk[],
  keyConfig: KeyConfig,
  signal: AbortSignal,
) => Promise<AnswerResponse>

export type AnswerAttemptResult =
  | { outcome: 'success'; answer: string; groundingWarning: boolean; docLabels: DocLabel[] }
  | { outcome: 'timeout' }
  | { outcome: 'error'; message: string }

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
): Promise<AnswerAttemptResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { answer, groundingWarning, docLabels } = await fetchAnswer(question, chunks, keyConfig, controller.signal)
    return { outcome: 'success', answer, groundingWarning, docLabels }
  } catch (err) {
    if (isAbortError(err)) return { outcome: 'timeout' }
    return { outcome: 'error', message: err instanceof Error ? err.message : 'unknown error' }
  } finally {
    clearTimeout(timeoutId)
  }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL

/** Real implementation of FetchAnswerFn — posts to the Cloudflare Worker. */
export const fetchAnswerFromWorker: FetchAnswerFn = async (question, chunks, keyConfig, signal) => {
  if (!API_BASE_URL) {
    throw new Error('Answer generation is not configured yet (VITE_API_BASE_URL is unset).')
  }
  const res = await fetch(`${API_BASE_URL}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, chunks, ...keyConfig }),
    signal,
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? `Answer request failed (${res.status}).`)
  }
  return (await res.json()) as AnswerResponse
}
