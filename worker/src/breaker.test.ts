import { describe, expect, it } from 'vitest'
import {
  BREAKER_KEY,
  CAP_STEP,
  MAX_BREAKER_TTL_SECONDS,
  cooldownFields,
  isActive,
  nextMidnightIn,
  readCooldown,
  tripBreaker,
} from './breaker'
import type { KVLike } from './rateLimit'

function recordingKV() {
  const store: Record<string, string> = {}
  const puts: { key: string; value: string; ttl?: number }[] = []
  const kv: KVLike = {
    get: async (k) => store[k] ?? null,
    put: async (k, v, o) => {
      store[k] = v
      puts.push({ key: k, value: v, ttl: o?.expirationTtl })
    },
  }
  return { kv, store, puts }
}
const noop = () => {}
const T0 = Date.parse('2026-10-27T12:00:00.000Z')

describe('tripBreaker — escalation', () => {
  it('no hint: 60 s, 2, 4, 8, 15 min, then stays at the 15 min cap', async () => {
    const { kv } = recordingKV()
    let now = T0
    const delays: number[] = []
    for (let i = 0; i < 7; i++) {
      const c = await tripBreaker(kv, undefined, noop, now)
      delays.push((c.until - now) / 1000)
      now = c.until + 1 // the next 429 lands right after this cooldown ends
    }
    expect(delays).toEqual([60, 120, 240, 480, 900, 900, 900])
  })

  it('a hint is used as-is and keeps the escalation step', async () => {
    const { kv } = recordingKV()
    const first = await tripBreaker(kv, undefined, noop, T0) // step 0, 60 s
    const hinted = await tripBreaker(kv, 37, noop, first.until + 1)
    expect(hinted).toMatchObject({ hinted: true, step: 0, until: first.until + 1 + 37_000 })
    const next = await tripBreaker(kv, undefined, noop, hinted.until + 1)
    expect((next.until - hinted.until - 1) / 1000).toBe(120) // step 1
  })

  it('starts over at 60 s once the escalation memory has expired (key gone)', async () => {
    const { kv, store } = recordingKV()
    await tripBreaker(kv, undefined, noop, T0)
    delete store[BREAKER_KEY] // KV TTL elapsed
    const c = await tripBreaker(kv, undefined, noop, T0 + 3 * 3600_000)
    expect(c.step).toBe(0)
  })

  it('writes once: an active cooldown is returned unchanged and nothing is written', async () => {
    const { kv, puts } = recordingKV()
    const first = await tripBreaker(kv, undefined, noop, T0)
    const again = await tripBreaker(kv, 600, noop, T0 + 10_000)
    expect(again).toEqual(first)
    expect(puts).toHaveLength(1)
  })
})

describe('tripBreaker — TTL caps', () => {
  it.each([
    [undefined, 60 + 1800],
    [1, 1 + 1800],
    [3600, 3600 + 1800],
    [1_000_000, MAX_BREAKER_TTL_SECONDS], // backstop: parseRetryHint never passes more than 3600
  ])('hint %s → TTL %i (min 60, max 2 h)', async (hint, ttl) => {
    const { kv, puts } = recordingKV()
    await tripBreaker(kv, hint, noop, T0)
    expect(puts[0].ttl).toBe(ttl)
    expect(puts[0].ttl).toBeGreaterThanOrEqual(60)
    expect(puts[0].ttl).toBeLessThanOrEqual(MAX_BREAKER_TTL_SECONDS)
  })
})

describe('readCooldown / tripBreaker — KV failures and bad values', () => {
  const boom = (): Promise<never> => Promise.reject(new Error('KV down'))

  it('a failed read is "no cooldown" and is reported', async () => {
    const ops: string[] = []
    expect(await readCooldown({ get: boom, put: boom }, (op) => ops.push(op), T0)).toBeNull()
    expect(ops).toEqual(['get'])
  })

  it('a failed write is swallowed; the computed cooldown is still returned', async () => {
    const ops: string[] = []
    const c = await tripBreaker({ get: async () => null, put: boom }, undefined, (op) => ops.push(op), T0)
    expect(c).toEqual({ until: T0 + 60_000, step: 0, hinted: false })
    expect(ops).toEqual(['put'])
  })

  it.each([
    'not json',
    '{}',
    JSON.stringify({ until: 'soon', step: 0, hinted: false }),
    JSON.stringify({ until: T0 + 60_000, step: 9, hinted: false }),
    JSON.stringify({ until: T0 + 60_000, step: 0.5, hinted: false }),
    JSON.stringify({ until: T0 + 60_000, step: 0 }),
    JSON.stringify({ until: T0 + 7200_000, step: 0, hinted: true }), // longer than any cooldown we write
  ])('ignores a malformed stored value: %s', async (raw) => {
    expect(await readCooldown({ get: async () => raw, put: async () => {} }, noop, T0)).toBeNull()
  })

  it('isActive is strictly before until', () => {
    const c = { until: T0, step: 0, hinted: false }
    expect(isActive(c, T0 - 1)).toBe(true)
    expect(isActive(c, T0)).toBe(false)
  })
})

describe('nextMidnightIn America/Los_Angeles — Intl, both sides of a DST change', () => {
  // US DST ends 2026-11-01 02:00 PDT → 01:00 PST.
  it.each([
    ['2026-10-27T12:00:00.000Z', '2026-10-28T07:00:00.000Z'], // PDT: midnight = 07:00Z
    ['2026-10-31T23:00:00.000Z', '2026-11-01T07:00:00.000Z'], // Oct 31 16:00 PDT → Nov 1 00:00 PDT
    ['2026-11-01T06:59:59.000Z', '2026-11-01T07:00:00.000Z'], // one second before PDT midnight
    ['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z'], // at midnight → the next one, now PST (25 h day)
    ['2026-11-01T08:30:00.000Z', '2026-11-02T08:00:00.000Z'], // 01:30 PDT, before the fallback
    ['2026-11-01T10:30:00.000Z', '2026-11-02T08:00:00.000Z'], // 02:30 PST, after it
    ['2026-11-02T12:00:00.000Z', '2026-11-03T08:00:00.000Z'], // PST: midnight = 08:00Z
    ['2027-03-14T07:59:00.000Z', '2027-03-14T08:00:00.000Z'], // spring: last PST midnight
    ['2027-03-14T12:00:00.000Z', '2027-03-15T07:00:00.000Z'], // after spring forward → PDT (23 h day)
  ])('%s → %s', (now, midnight) => {
    expect(nextMidnightIn('America/Los_Angeles', Date.parse(now)).toISOString()).toBe(midnight)
  })
})

describe('cooldownFields', () => {
  const now = Date.parse('2026-10-31T23:00:00.000Z')
  it('hinted → retryAfterSeconds only', () => {
    expect(cooldownFields({ until: now + 37_000, step: 2, hinted: true }, now)).toEqual({ retryAfterSeconds: 37 })
  })
  it('no hint below the cap → retryAfterSeconds + the midnight-Pacific bound', () => {
    expect(cooldownFields({ until: now + 120_000, step: 1, hinted: false }, now)).toEqual({
      retryAfterSeconds: 120,
      resetAt: '2026-11-01T07:00:00.000Z',
    })
  })
  it('no hint at the cap → resetAt only ("looks used up for today")', () => {
    expect(cooldownFields({ until: now + 900_000, step: CAP_STEP, hinted: false }, now)).toEqual({
      resetAt: '2026-11-01T07:00:00.000Z',
    })
  })
  it('rounds up and never sends 0', () => {
    expect(cooldownFields({ until: now + 100, step: 0, hinted: true }, now)).toEqual({ retryAfterSeconds: 1 })
  })
})
