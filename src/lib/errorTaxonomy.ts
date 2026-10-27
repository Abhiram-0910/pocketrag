export type ErrorTaxonomyType = 'rate-limit' | 'provider-unavailable' | 'region-restricted' | 'network' | 'corrupt-pdf' | 'webgpu-unsupported' | 'unknown'
export type ErrorSeverity = 'error' | 'warning' | 'info'

export interface TaxonomyResult {
  type: ErrorTaxonomyType
  severity: ErrorSeverity
  message: string
}

export interface ClassifiableError {
  message: string
  status?: number
  resetAt?: string
}

const RATE_LIMIT_STATUS = 429
const PROVIDER_UNAVAILABLE_STATUS = 502
// The Worker's only 403: the shared tier refusing an EEA/CH/UK request (region_restricted).
const REGION_RESTRICTED_STATUS = 403

/**
 * Classifies a Worker API failure (from /answer or /models) into a plain-language
 * taxonomy type, keyed on HTTP status only. Every provider-call failure is a 502 whose
 * `error` is already user-ready copy (bad key, provider rate limit, rejected request,
 * outage — see the Worker's classification table in ARCHITECTURE.md), so all of them
 * map to `provider-unavailable` with the message shown as-is. What the UI *offers*
 * per failure (check key, retry, …) comes from the 502's `code` via apiError.ts's
 * failureAction, not from here. Only our own per-IP limit is a 429 with `resetAt`.
 */
export function classify(input: ClassifiableError): TaxonomyResult {
  if (input.status === RATE_LIMIT_STATUS) {
    return {
      type: 'rate-limit',
      severity: 'warning',
      message: input.resetAt ? formatRateLimitMessage(input.resetAt) : input.message,
    }
  }
  if (input.status === PROVIDER_UNAVAILABLE_STATUS) {
    return { type: 'provider-unavailable', severity: 'warning', message: input.message }
  }
  if (input.status === REGION_RESTRICTED_STATUS) {
    return { type: 'region-restricted', severity: 'warning', message: input.message }
  }
  if (input.status !== undefined) {
    return { type: 'unknown', severity: 'error', message: input.message }
  }
  // No status at all means fetch() never got a response — a real network failure
  // (offline, DNS, CORS), not something the Worker returned.
  return { type: 'network', severity: 'error', message: "Network error — check your connection and try again." }
}

export function classifyPdfError(message: string): TaxonomyResult {
  return { type: 'corrupt-pdf', severity: 'error', message }
}

export function classifyWebgpuFallback(backend: 'wasm-unavailable' | 'wasm-failed', detail: string): TaxonomyResult {
  const reason = backend === 'wasm-unavailable' ? "your browser doesn't support WebGPU" : 'WebGPU failed at runtime'
  return {
    type: 'webgpu-unsupported',
    severity: 'info',
    message: `Using the WASM backend instead — ${reason}.${detail ? ` ${detail}` : ''}`,
  }
}

function formatRateLimitMessage(resetAt: string): string {
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(resetAt))
  return `You've hit today's request limit. Resets at ${time}.`
}
