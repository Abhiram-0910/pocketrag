import { describe, expect, it, vi } from 'vitest'
import {
  DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS,
  DISCORD_SUPPRESS_WINDOW_SECONDS,
  buildDiscordPayload,
  sendDiscordAlert,
  shouldNotify,
} from './discord'

function mockFetch(response: Partial<Response> & { ok?: boolean; status?: number }) {
  return vi.fn().mockResolvedValue({ ok: response.ok ?? true, status: response.status ?? 204 } as Response)
}

describe('buildDiscordPayload', () => {
  it('includes provider, model, status, and message as embed fields', () => {
    const payload = buildDiscordPayload(
      { provider: 'grok', model: 'grok-4', status: '401', message: 'Grok API error 401: invalid API key', tier: 'own' },
      '2026-08-11T12:00:00.000Z',
    ) as { embeds: Array<{ title: string; fields: Array<{ name: string; value: string }>; timestamp: string }> }

    expect(payload.embeds[0].title).toBe('Provider call failed: grok')
    expect(payload.embeds[0].timestamp).toBe('2026-08-11T12:00:00.000Z')
    const fields = Object.fromEntries(payload.embeds[0].fields.map((f) => [f.name, f.value]))
    expect(fields.Provider).toBe('grok')
    expect(fields.Model).toBe('grok-4')
    expect(fields.Status).toBe('401')
    expect(fields.Message).toBe('Grok API error 401: invalid API key')
  })

  it('falls back to n/a and unknown when model/status are null', () => {
    const payload = buildDiscordPayload(
      { provider: 'openrouter', model: null, status: null, message: 'network error', tier: 'own' },
      '2026-08-11T12:00:00.000Z',
    ) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }

    const fields = Object.fromEntries(payload.embeds[0].fields.map((f) => [f.name, f.value]))
    expect(fields.Model).toBe('n/a')
    expect(fields.Status).toBe('unknown')
  })

  it('truncates an overlong message to stay under Discord\'s 1024-char embed field cap', () => {
    const longMessage = 'x'.repeat(2000)
    const payload = buildDiscordPayload(
      { provider: 'openai', model: 'gpt-4', status: '500', message: longMessage, tier: 'own' },
      '2026-08-11T12:00:00.000Z',
    ) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }

    const fields = Object.fromEntries(payload.embeds[0].fields.map((f) => [f.name, f.value]))
    expect(fields.Message.length).toBeLessThanOrEqual(1000)
  })

  it('sets allowed_mentions to parse nothing, defending against a ping-shaped provider error body', () => {
    const payload = buildDiscordPayload(
      { provider: 'grok', model: null, status: null, message: '@everyone invalid key', tier: 'own' },
      '2026-08-11T12:00:00.000Z',
    ) as { allowed_mentions: { parse: string[] } }

    expect(payload.allowed_mentions).toEqual({ parse: [] })
  })

  it('redacts a key-shaped string in message and never duplicates it into another field', () => {
    const secretLookalike = 'xai-super-secret-should-never-reach-discord-99999'
    const payload = buildDiscordPayload(
      { provider: 'grok', model: null, status: '401', message: `Grok API error 401: ${secretLookalike}`, tier: 'own' },
      '2026-08-11T12:00:00.000Z',
    ) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }

    // DiscordFailurePayload has no apiKey field at all; redactKeys is the backstop for a
    // key-shaped string that reaches `message` anyway.
    const fields = Object.fromEntries(payload.embeds[0].fields.map((f) => [f.name, f.value]))
    expect(fields.Message).toBe('Grok API error 401: [redacted]')
    expect(JSON.stringify(payload)).not.toContain(secretLookalike)
  })

  it('includes code, provider code, and tier fields, falling back to n/a when code fields are absent', () => {
    const withCodes = buildDiscordPayload(
      { provider: 'gemini', model: null, status: '429', message: 'quota', tier: 'shared', code: 'provider_rate_limited', providerCode: 'RESOURCE_EXHAUSTED' },
      '2026-08-11T12:00:00.000Z',
    ) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }
    const fields = Object.fromEntries(withCodes.embeds[0].fields.map((f) => [f.name, f.value]))
    expect(fields.Code).toBe('provider_rate_limited')
    expect(fields['Provider code']).toBe('RESOURCE_EXHAUSTED')
    expect(fields.Tier).toBe('shared')

    const without = buildDiscordPayload(
      { provider: 'gemini', model: null, status: null, message: 'OCR request failed.', tier: 'shared' },
      '2026-08-11T12:00:00.000Z',
    ) as { embeds: Array<{ fields: Array<{ name: string; value: string }> }> }
    const fallback = Object.fromEntries(without.embeds[0].fields.map((f) => [f.name, f.value]))
    expect(fallback.Code).toBe('n/a')
    expect(fallback['Provider code']).toBe('n/a')
  })
})

describe('sendDiscordAlert', () => {
  it('never throws when the fetch call itself rejects (network failure)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'))
    await expect(
      sendDiscordAlert(fetchImpl, 'https://discord.com/api/webhooks/1/token', {
        provider: 'grok',
        model: null,
        status: null,
        message: 'boom',
        tier: 'own',
      }),
    ).resolves.toBeUndefined()
  })

  it('never throws when Discord responds with a non-2xx status', async () => {
    const fetchImpl = mockFetch({ ok: false, status: 429 })
    await expect(
      sendDiscordAlert(fetchImpl, 'https://discord.com/api/webhooks/1/token', {
        provider: 'grok',
        model: null,
        status: null,
        message: 'boom',
        tier: 'own',
      }),
    ).resolves.toBeUndefined()
  })

  it('POSTs the sanitized payload to the webhook URL with no trace of a real secret', async () => {
    const fetchImpl = mockFetch({ ok: true, status: 204 })
    const realSecretKey = 'xai-real-secret-should-never-leak-24680'

    await sendDiscordAlert(fetchImpl, 'https://discord.com/api/webhooks/1/token', {
      provider: 'grok',
      model: 'grok-4',
      status: '401',
      message: 'Grok API error 401: invalid API key',
      tier: 'own',
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://discord.com/api/webhooks/1/token')
    expect((init as RequestInit).body as string).not.toContain(realSecretKey)
  })
})

describe('shouldNotify', () => {
  function makeKv() {
    const store = new Map<string, string>()
    return {
      store,
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value)
      },
    }
  }

  it('allows the first notification for a provider+endpoint and writes a suppression key', async () => {
    const kv = makeKv()
    expect(await shouldNotify(kv, 'grok', 'answer', 'own')).toBe(true)
    expect(kv.store.get('discord-notify:grok:answer:own')).toBe('1')
  })

  it('suppresses a second notification for the same provider+endpoint within the window', async () => {
    const kv = makeKv()
    expect(await shouldNotify(kv, 'grok', 'answer', 'own')).toBe(true)
    expect(await shouldNotify(kv, 'grok', 'answer', 'own')).toBe(false)
  })

  it('does not suppress a different provider', async () => {
    const kv = makeKv()
    expect(await shouldNotify(kv, 'grok', 'answer', 'own')).toBe(true)
    expect(await shouldNotify(kv, 'openrouter', 'answer', 'own')).toBe(true)
  })

  it('tracks /answer and /models suppression independently for the same provider', async () => {
    const kv = makeKv()
    expect(await shouldNotify(kv, 'grok', 'answer', 'own')).toBe(true)
    // A /models failure for the same provider must not be suppressed by the /answer
    // window — the two endpoints can fail independently.
    expect(await shouldNotify(kv, 'grok', 'models', 'own')).toBe(true)
    // Each endpoint still suppresses its own repeats.
    expect(await shouldNotify(kv, 'grok', 'answer', 'own')).toBe(false)
    expect(await shouldNotify(kv, 'grok', 'models', 'own')).toBe(false)
  })

  it('gives shared-tier rate limiting its own slot, independent of the shared slot', async () => {
    const kv = makeKv()
    expect(await shouldNotify(kv, 'gemini', 'answer', 'shared-ratelimit', DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS)).toBe(true)
    expect(await shouldNotify(kv, 'gemini', 'answer', 'shared')).toBe(true)
    expect(kv.store.has('discord-notify:gemini:answer:shared-ratelimit')).toBe(true)
  })

  it('tracks shared and own tiers independently for the same provider+endpoint', async () => {
    const kv = makeKv()
    expect(await shouldNotify(kv, 'gemini', 'answer', 'own')).toBe(true)
    expect(await shouldNotify(kv, 'gemini', 'answer', 'shared')).toBe(true)
    expect(kv.store.has('discord-notify:gemini:answer:shared')).toBe(true)
  })

  it('uses the documented 10-minute suppression window as the default KV TTL, and the passed window otherwise', async () => {
    const store = new Map<string, string>()
    const ttls: (number | undefined)[] = []
    const kv = {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string, options?: { expirationTtl?: number }) => {
        store.set(key, value)
        ttls.push(options?.expirationTtl)
      },
    }
    await shouldNotify(kv, 'grok', 'answer', 'own')
    await shouldNotify(kv, 'gemini', 'answer', 'shared', DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS)
    expect(ttls).toEqual([DISCORD_SUPPRESS_WINDOW_SECONDS, DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS])
    expect(DISCORD_SUPPRESS_WINDOW_SECONDS).toBe(600)
    expect(DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS).toBe(21600)
  })
})
