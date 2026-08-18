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

// ponytail: KV get-then-put isn't atomic, so concurrent requests from the same IP
// in the same second could both read the same count and both be allowed — a soft
// cap, not an exact one. Fine for abuse protection; switch to a Durable Object if
// exact per-request accounting is ever needed.
export async function checkRateLimit(
  kv: KVLike,
  ip: string,
  bucket: string,
  limit = DEFAULT_DAILY_LIMIT,
): Promise<RateLimitResult> {
  const day = new Date().toISOString().slice(0, 10)
  const key = `ratelimit:${bucket}:${ip}:${day}`
  const resetAt = nextUtcMidnight()

  const current = Number((await kv.get(key)) ?? '0')
  if (current >= limit) {
    return { allowed: false, remaining: 0, resetAt }
  }

  await kv.put(key, String(current + 1), { expirationTtl: SECONDS_PER_DAY })
  return { allowed: true, remaining: limit - current - 1, resetAt }
}
