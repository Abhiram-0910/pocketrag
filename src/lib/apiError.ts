// The Worker's provider-failure codes (worker/src/failureCodes.ts) — kept as a separate
// copy so the frontend never imports Worker code; failureCodes.test.ts enforces parity.
export const FAILURE_CODES = ['key_rejected', 'provider_rate_limited', 'request_rejected', 'provider_unavailable'] as const
export type FailureCode = (typeof FAILURE_CODES)[number]
export type FailureSource = 'shared' | 'own'

/** Structured failure from a Worker call — carries the HTTP status and any extra
 * fields (rate-limit's resetAt, a provider failure's code/source) the plain
 * `Error.message` string can't. */
export class WorkerRequestError extends Error {
  status: number
  resetAt?: string
  code?: FailureCode
  source?: FailureSource

  constructor(message: string, status: number, resetAt?: string, code?: FailureCode, source?: FailureSource) {
    super(message)
    this.name = 'WorkerRequestError'
    this.status = status
    this.resetAt = resetAt
    this.code = code
    this.source = source
  }
}

function isFailureCode(value: unknown): value is FailureCode {
  return (FAILURE_CODES as readonly unknown[]).includes(value)
}

/** Parses a non-ok Worker response into a WorkerRequestError, shared by every API call site.
 * Fields are read by status: resetAt only on our own 429, code/source only on a provider
 * 502 — so a provider rate limit can never be mistaken for ours. Unknown values (or an
 * older Worker that sends no code) leave the field undefined. */
export async function parseWorkerErrorResponse(res: Response, fallbackMessage: string): Promise<WorkerRequestError> {
  const data = (await res.json().catch(() => null)) as {
    error?: unknown
    resetAt?: unknown
    code?: unknown
    source?: unknown
  } | null
  const message = typeof data?.error === 'string' ? data.error : fallbackMessage
  const resetAt = res.status === 429 && typeof data?.resetAt === 'string' ? data.resetAt : undefined
  const code = res.status === 502 && isFailureCode(data?.code) ? data.code : undefined
  const source =
    code === 'provider_rate_limited' && (data?.source === 'shared' || data?.source === 'own') ? data.source : undefined
  return new WorkerRequestError(message, res.status, resetAt, code, source)
}

export type FailureAction = 'check-key' | 'use-own-key' | 'choose-model' | 'retry'

/** What the UI offers beside the Worker's message. The message itself is always shown
 * as-is; only this decides behavior. No code (older Worker, non-provider error) → none. */
export function failureAction(code: FailureCode | undefined, source: FailureSource | undefined): FailureAction | null {
  switch (code) {
    case 'key_rejected':
      return 'check-key'
    case 'provider_rate_limited':
      return source === 'shared' ? 'use-own-key' : null
    case 'request_rejected':
      return 'choose-model'
    case 'provider_unavailable':
      return 'retry'
    default:
      return null
  }
}
