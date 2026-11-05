// The Worker's provider-failure codes (worker/src/failureCodes.ts) — kept as a separate
// copy so the frontend never imports Worker code; failureCodes.test.ts enforces parity.
export const FAILURE_CODES = ['key_rejected', 'provider_rate_limited', 'request_rejected', 'provider_unavailable', 'region_restricted'] as const
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
  // Whole seconds until a retry makes sense, when the Worker knows (Step D). Absent = unknown.
  retryAfterSeconds?: number
  // Shared breaker at its cap only: seconds until its cooldown ends (Phase 5a). Absent = older Worker.
  cooldownSeconds?: number

  constructor(
    message: string,
    status: number,
    resetAt?: string,
    code?: FailureCode,
    source?: FailureSource,
    retryAfterSeconds?: number,
    cooldownSeconds?: number,
  ) {
    super(message)
    this.name = 'WorkerRequestError'
    this.status = status
    this.resetAt = resetAt
    this.code = code
    this.source = source
    this.retryAfterSeconds = retryAfterSeconds
    this.cooldownSeconds = cooldownSeconds
  }
}

// Our own 429 waits until UTC midnight (≤ 1 day); a provider hint or our breaker ≤ 1 hour.
const MAX_OUR_RETRY_AFTER = 86_400
const MAX_PROVIDER_RETRY_AFTER = 3600

function boundedSeconds(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isFailureCode(value: unknown): value is FailureCode {
  return (FAILURE_CODES as readonly unknown[]).includes(value)
}

/** Parses a non-ok Worker response into a WorkerRequestError, shared by every API call site.
 * Fields are read by status: code/source only on a provider 502 — so a provider rate
 * limit can never be mistaken for ours — and region_restricted only on the shared tier's
 * 403. resetAt and retryAfterSeconds only on our own 429 or a provider_rate_limited 502
 * (resetAt there only from the shared tier: its midnight-Pacific bound). Unknown or
 * out-of-range values (or an older Worker) leave the field undefined — never a guess. */
export async function parseWorkerErrorResponse(res: Response, fallbackMessage: string): Promise<WorkerRequestError> {
  const data = (await res.json().catch(() => null)) as {
    error?: unknown
    resetAt?: unknown
    code?: unknown
    source?: unknown
    retryAfterSeconds?: unknown
    cooldownSeconds?: unknown
  } | null
  const message = typeof data?.error === 'string' ? data.error : fallbackMessage
  const rawCode = isFailureCode(data?.code) ? data.code : undefined
  const code =
    (res.status === 502 && rawCode !== 'region_restricted') || (res.status === 403 && rawCode === 'region_restricted')
      ? rawCode
      : undefined
  const source =
    code === 'provider_rate_limited' && (data?.source === 'shared' || data?.source === 'own') ? data.source : undefined
  const ours = res.status === 429
  const providerRateLimited = res.status === 502 && code === 'provider_rate_limited'
  const resetAt = (ours || (providerRateLimited && source === 'shared')) && isDateString(data?.resetAt) ? data.resetAt : undefined
  const retryAfterSeconds = ours
    ? boundedSeconds(data?.retryAfterSeconds, 0, MAX_OUR_RETRY_AFTER)
    : providerRateLimited
      ? boundedSeconds(data?.retryAfterSeconds, 1, MAX_PROVIDER_RETRY_AFTER)
      : undefined
  const cooldownSeconds =
    providerRateLimited && source === 'shared' ? boundedSeconds(data?.cooldownSeconds, 1, MAX_PROVIDER_RETRY_AFTER) : undefined
  return new WorkerRequestError(message, res.status, resetAt, code, source, retryAfterSeconds, cooldownSeconds)
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
    case 'region_restricted':
      return 'use-own-key'
    default:
      return null
  }
}
