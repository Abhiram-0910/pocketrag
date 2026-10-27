export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  /** ISO timestamp of the next UTC midnight — when this bucket's daily count resets. */
  resetAt: string
}

export const DEFAULT_DAILY_LIMIT = 50
// BYOK requests don't touch our own Gemini quota, so this isn't quota protection —
// it's a coarse guard against someone using our Worker as an anonymizing relay for
// unrelated traffic. Deliberately much higher than the shared-key limit.
export const BYOK_DAILY_LIMIT = 500
// Milestone 9 Phase A: a single OCR request is materially heavier than a /answer call
// (up to a full image's worth of Gemini input tokens vs. one prompt) — set lower than
// DEFAULT_DAILY_LIMIT so one Notes-tab burst can't consume a disproportionate share of
// the shared-tier abuse budget on an anonymous endpoint.
export const OCR_DAILY_LIMIT = 20
const SECONDS_PER_DAY = 86400

// The bucket's day boundary (UTC) doubles as the reset time shown to the user — same
// value already implicit in the KV key, just exposed rather than only used internally.
function nextUtcMidnight(): string {
  const now = new Date()
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return midnight.toISOString()
}

export type KvOp = 'get' | 'put'
// Called once per failed KV call — index.ts logs and (rarely) alerts. Never throws.
export type KvErrorReporter = (op: KvOp) => void

// ponytail: the fallback limiter is WEAK — one Map per isolate, and Cloudflare runs many
// short-lived isolates, so a determined client spread across them sees far more than the
// daily limit. It is a floor against a tight loop hitting one isolate while KV is down,
// not a quota. Exact limits across isolates need a Durable Object (TODO.md).
export const FALLBACK_MAX_ENTRIES = 10_000
const fallbackCounts = new Map<string, number>()

function fallbackCheck(key: string, limit: number, resetAt: string): RateLimitResult {
  const current = fallbackCounts.get(key) ?? 0
  if (current >= limit) return { allowed: false, remaining: 0, resetAt }
  // Re-insert so the Map's insertion order tracks recency; evict the oldest past the cap.
  fallbackCounts.delete(key)
  fallbackCounts.set(key, current + 1)
  if (fallbackCounts.size > FALLBACK_MAX_ENTRIES) fallbackCounts.delete(fallbackCounts.keys().next().value!)
  return { allowed: true, remaining: limit - current - 1, resetAt }
}

/** Test-only: the fallback Map is module state shared across tests. */
export function resetFallbackLimiter(): void {
  fallbackCounts.clear()
}
export function fallbackLimiterSize(): number {
  return fallbackCounts.size
}

// ponytail: KV get-then-put isn't atomic, so concurrent requests from the same IP
// in the same second could both read the same count and both be allowed — a soft
// cap, not an exact one. Fine for abuse protection; switch to a Durable Object if
// exact per-request accounting is ever needed.
//
// Fails OPEN: a KV error never throws. A failed get or put hands the request to the
// fallback limiter instead. A request KV counted (put succeeded) never touches the
// fallback, so nothing is counted twice.
export async function checkRateLimit(
  kv: KVLike,
  ip: string,
  bucket: string,
  limit = DEFAULT_DAILY_LIMIT,
  onKvError: KvErrorReporter = () => {},
): Promise<RateLimitResult> {
  const day = new Date().toISOString().slice(0, 10)
  const key = `ratelimit:${bucket}:${ip}:${day}`
  const resetAt = nextUtcMidnight()

  let current: number
  try {
    current = Number((await kv.get(key)) ?? '0')
  } catch {
    onKvError('get')
    return fallbackCheck(key, limit, resetAt)
  }
  if (current >= limit) {
    return { allowed: false, remaining: 0, resetAt }
  }

  try {
    await kv.put(key, String(current + 1), { expirationTtl: SECONDS_PER_DAY })
  } catch {
    onKvError('put')
    return fallbackCheck(key, limit, resetAt)
  }
  return { allowed: true, remaining: limit - current - 1, resetAt }
}
