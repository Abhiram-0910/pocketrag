import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkRateLimit, type KVLike } from './rateLimit'

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
