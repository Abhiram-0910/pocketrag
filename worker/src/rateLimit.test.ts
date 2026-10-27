import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkRateLimit, fallbackLimiterSize, resetFallbackLimiter, FALLBACK_MAX_ENTRIES, type KVLike } from './rateLimit'

function fakeKV(initial: Record<string, string> = {}): KVLike & { store: Record<string, string> } {
  const store = { ...initial }
  return {
    store,
    get: async (key) => store[key] ?? null,
    put: async (key, value) => {
      store[key] = value
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  resetFallbackLimiter()
})

describe('checkRateLimit', () => {
  it('allows the first request from a fresh IP', async () => {
    const kv = fakeKV()
    const result = await checkRateLimit(kv, '1.2.3.4', 'shared', 5)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
  })

  it('increments the stored count on each allowed request', async () => {
    const kv = fakeKV()
    await checkRateLimit(kv, '1.2.3.4', 'shared', 5)
    await checkRateLimit(kv, '1.2.3.4', 'shared', 5)
    const result = await checkRateLimit(kv, '1.2.3.4', 'shared', 5)
    expect(result.remaining).toBe(2)
  })

  it('denies once the limit is reached', async () => {
    const kv = fakeKV()
    for (let i = 0; i < 3; i++) await checkRateLimit(kv, '1.2.3.4', 'shared', 3)
    const result = await checkRateLimit(kv, '1.2.3.4', 'shared', 3)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('tracks different IPs independently', async () => {
    const kv = fakeKV()
    await checkRateLimit(kv, '1.1.1.1', 'shared', 1)
    const result = await checkRateLimit(kv, '2.2.2.2', 'shared', 1)
    expect(result.allowed).toBe(true)
  })

  it('tracks different buckets for the same IP independently', async () => {
    const kv = fakeKV()
    await checkRateLimit(kv, '1.2.3.4', 'shared', 1)
    const sharedSecond = await checkRateLimit(kv, '1.2.3.4', 'shared', 1)
    const byokFirst = await checkRateLimit(kv, '1.2.3.4', 'byok', 1)
    expect(sharedSecond.allowed).toBe(false)
    expect(byokFirst.allowed).toBe(true)
  })

  it('sets an expiration TTL of roughly one day', async () => {
    let capturedTtl: number | undefined
    const kv: KVLike = {
      get: async () => null,
      put: async (_key, _value, options) => {
        capturedTtl = options?.expirationTtl
      },
    }
    await checkRateLimit(kv, '1.2.3.4', 'shared', 5)
    expect(capturedTtl).toBe(86400)
  })

  it('defaults to DEFAULT_DAILY_LIMIT when no limit is given', async () => {
    const kv = fakeKV()
    const result = await checkRateLimit(kv, '1.2.3.4', 'shared')
    expect(result.remaining).toBe(49)
  })

  it('resetAt is the next UTC midnight, both when allowed and when denied', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T15:42:00.000Z'))
    const kv = fakeKV()
    const allowed = await checkRateLimit(kv, '1.2.3.4', 'shared', 1)
    expect(allowed.resetAt).toBe('2026-08-12T00:00:00.000Z')
    const denied = await checkRateLimit(kv, '1.2.3.4', 'shared', 1)
    expect(denied.allowed).toBe(false)
    expect(denied.resetAt).toBe('2026-08-12T00:00:00.000Z')
    vi.useRealTimers()
  })
})

describe('checkRateLimit — KV failures fail open', () => {
  const boom = async (): Promise<never> => {
    throw new Error('KV put() limit exceeded for the day.')
  }
  const getThrows = (): KVLike => ({ get: boom, put: async () => {} })
  const putThrows = (): KVLike & { store: Record<string, string> } => ({ ...fakeKV(), put: boom })
  const bothThrow = (): KVLike => ({ get: boom, put: boom })

  it.each([
    ['get throws', getThrows, ['get']],
    ['put throws', putThrows, ['put']],
    ['both throw', bothThrow, ['get']],
  ] as const)('%s: allows, reports the op, never throws', async (_name, make, ops) => {
    const reported: string[] = []
    const result = await checkRateLimit(make(), '1.2.3.4', 'shared', 5, (op) => reported.push(op))
    expect(result).toMatchObject({ allowed: true, remaining: 4 })
    expect(reported).toEqual(ops)
  })

  it.each(['shared', 'byok', 'ocr'])('the fallback enforces the same limit per (bucket, IP): %s', async (bucket) => {
    const kv = bothThrow()
    for (let i = 0; i < 3; i++) expect((await checkRateLimit(kv, '1.2.3.4', bucket, 3)).allowed).toBe(true)
    expect(await checkRateLimit(kv, '1.2.3.4', bucket, 3)).toMatchObject({ allowed: false, remaining: 0 })
    // Another IP and another bucket each have their own fallback count.
    expect((await checkRateLimit(kv, '5.6.7.8', bucket, 3)).allowed).toBe(true)
    expect((await checkRateLimit(kv, '1.2.3.4', `${bucket}-other`, 3)).allowed).toBe(true)
  })

  it('never counts a request KV counted: only failed puts reach the fallback', async () => {
    let putFails = false
    const base = fakeKV()
    const kv: KVLike = {
      get: base.get,
      put: async (k, v) => {
        if (putFails) throw new Error('down')
        await base.put(k, v)
      },
    }
    await checkRateLimit(kv, '1.2.3.4', 'shared', 3)
    await checkRateLimit(kv, '1.2.3.4', 'shared', 3)
    expect(fallbackLimiterSize()).toBe(0)
    expect(base.store).toMatchObject({ [Object.keys(base.store)[0]]: '2' })
    putFails = true
    // KV still reads 2 (< 3); the put fails, so the fallback counts this one — from 0.
    expect(await checkRateLimit(kv, '1.2.3.4', 'shared', 3)).toMatchObject({ allowed: true, remaining: 2 })
    expect(fallbackLimiterSize()).toBe(1)
  })

  it('a KV read showing the limit still denies, even when puts fail', async () => {
    const kv = putThrows()
    const day = new Date().toISOString().slice(0, 10)
    kv.store[`ratelimit:shared:1.2.3.4:${day}`] = '5'
    expect((await checkRateLimit(kv, '1.2.3.4', 'shared', 5)).allowed).toBe(false)
    expect(fallbackLimiterSize()).toBe(0)
  })

  it('caps the fallback Map and evicts the oldest entry', async () => {
    const kv = bothThrow()
    for (let i = 0; i < FALLBACK_MAX_ENTRIES; i++) await checkRateLimit(kv, `ip-${i}`, 'shared', 1)
    expect(fallbackLimiterSize()).toBe(FALLBACK_MAX_ENTRIES)
    // ip-0 is spent; one more distinct IP evicts it (the oldest), so ip-0 starts over.
    expect((await checkRateLimit(kv, 'ip-0', 'shared', 1)).allowed).toBe(false)
    await checkRateLimit(kv, 'ip-new', 'shared', 1)
    expect(fallbackLimiterSize()).toBe(FALLBACK_MAX_ENTRIES)
    // A denied check doesn't refresh recency, so ip-0 was still the oldest and got evicted.
    expect((await checkRateLimit(kv, 'ip-0', 'shared', 1)).allowed).toBe(true)
    expect((await checkRateLimit(kv, 'ip-2', 'shared', 1)).allowed).toBe(false)
  })
})
