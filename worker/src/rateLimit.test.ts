import { describe, expect, it } from 'vitest'
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

describe('checkRateLimit', () => {
  it('allows the first request from a fresh IP', async () => {
    const kv = fakeKV()
    const result = await checkRateLimit(kv, '1.2.3.4', 5)
    expect(result.allowed).toBe(true)
    expect(result.remaining).toBe(4)
  })

  it('increments the stored count on each allowed request', async () => {
    const kv = fakeKV()
    await checkRateLimit(kv, '1.2.3.4', 5)
    await checkRateLimit(kv, '1.2.3.4', 5)
    const result = await checkRateLimit(kv, '1.2.3.4', 5)
    expect(result.remaining).toBe(2)
  })

  it('denies once the limit is reached', async () => {
    const kv = fakeKV()
    for (let i = 0; i < 3; i++) await checkRateLimit(kv, '1.2.3.4', 3)
    const result = await checkRateLimit(kv, '1.2.3.4', 3)
    expect(result.allowed).toBe(false)
    expect(result.remaining).toBe(0)
  })

  it('tracks different IPs independently', async () => {
    const kv = fakeKV()
    await checkRateLimit(kv, '1.1.1.1', 1)
    const result = await checkRateLimit(kv, '2.2.2.2', 1)
    expect(result.allowed).toBe(true)
  })

  it('sets an expiration TTL of roughly one day', async () => {
    let capturedTtl: number | undefined
    const kv: KVLike = {
      get: async () => null,
      put: async (_key, _value, options) => {
        capturedTtl = options?.expirationTtl
      },
    }
    await checkRateLimit(kv, '1.2.3.4', 5)
    expect(capturedTtl).toBe(86400)
  })
})
