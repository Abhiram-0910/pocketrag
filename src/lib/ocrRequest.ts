import { WorkerRequestError, parseWorkerErrorResponse } from './apiError'
import { egressFetch } from './egress'

export interface OcrResponse {
  text: string
}

export type FetchOcrFn = (mimeType: string, base64: string, signal: AbortSignal) => Promise<OcrResponse>

export type OcrAttemptResult =
  | { outcome: 'success'; text: string }
  | { outcome: 'timeout' }
  | { outcome: 'error'; message: string; status?: number; resetAt?: string }

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** Runs one OCR attempt with a hard timeout — mirrors answerRequest.ts's attemptAnswer. */
export async function attemptOcr(
  fetchOcr: FetchOcrFn,
  mimeType: string,
  base64: string,
  timeoutMs: number,
): Promise<OcrAttemptResult> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const { text } = await fetchOcr(mimeType, base64, controller.signal)
    return { outcome: 'success', text }
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

/** Real implementation of FetchOcrFn — posts to the Cloudflare Worker's /ocr route. */
export const fetchOcrFromWorker: FetchOcrFn = async (mimeType, base64, signal) => {
  if (!API_BASE_URL) {
    throw new Error('OCR is not configured yet (VITE_API_BASE_URL is unset).')
  }
  // /ocr always uses the shared Gemini key (worker/src/index.ts).
  const res = await egressFetch(`${API_BASE_URL}/ocr`, { json: { mimeType, base64 }, signal }, { purpose: 'ocr', upstream: 'gemini' })
  if (!res.ok) {
    throw await parseWorkerErrorResponse(res, `OCR request failed (${res.status}).`)
  }
  return (await res.json()) as OcrResponse
}
