export type ErrorTaxonomyType = 'rate-limit' | 'provider-unavailable' | 'network' | 'corrupt-pdf' | 'webgpu-unsupported' | 'unknown'
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

/**
 * Classifies a Worker API failure (from /answer or /models) into a plain-language
 * taxonomy type. Note there is no separate "invalid key" type: the Worker
 * deliberately sanitizes every provider-call failure (bad key, provider outage,
 * unsupported model, etc.) into the same generic 502 message across all 5 providers
 * (see AGENTS.md Sessions 11-13) — that's a security decision, not a gap here, so
 * "invalid key" and "provider down" are genuinely indistinguishable client-side and
 * both map to `provider-unavailable`.
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
