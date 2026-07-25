export interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
}

export const DEFAULT_DAILY_LIMIT = 50
const SECONDS_PER_DAY = 86400

// ponytail: KV get-then-put isn't atomic, so concurrent requests from the same IP
// in the same second could both read the same count and both be allowed — a soft
// cap, not an exact one. Fine for abuse protection; switch to a Durable Object if
// exact per-request accounting is ever needed.
export async function checkRateLimit(kv: KVLike, ip: string, limit = DEFAULT_DAILY_LIMIT): Promise<RateLimitResult> {
  const day = new Date().toISOString().slice(0, 10)
  const key = `ratelimit:${ip}:${day}`

  const current = Number((await kv.get(key)) ?? '0')
  if (current >= limit) {
    return { allowed: false, remaining: 0 }
  }

  await kv.put(key, String(current + 1), { expirationTtl: SECONDS_PER_DAY })
  return { allowed: true, remaining: limit - current - 1 }
}
