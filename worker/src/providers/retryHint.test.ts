import { describe, expect, it } from 'vitest'
import { parseRetryHint, providerError } from './errors'
import {
  ANTHROPIC_RATE_LIMIT,
  GEMINI_429_RECONSTRUCTED,
  GEMINI_429_WITH_RETRY_INFO,
  OPENAI_INSUFFICIENT_QUOTA,
  OPENROUTER_402,
} from '../fixtures/rateLimitBodies'

const NOW = Date.parse('2026-10-27T12:00:00.000Z')
const retryInfo = (retryDelay: unknown) => ({
  error: { code: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] },
})

describe('parseRetryHint — google.rpc.RetryInfo', () => {
  it.each([
    ['37s', 37],
    ['1.5s', 2], // rounded up
    ['0.001s', 1],
    ['0s', 1], // clamped to 1
    ['3600s', 3600],
    ['999999s', 3600], // clamped to 3600
    ['12.123456789s', 13],
  ])('%s → %i s', (delay, seconds) => {
    expect(parseRetryHint(429, retryInfo(delay), null, undefined, NOW)).toEqual({ seconds, source: 'retry-info' })
  })

  it.each(['37', '-5s', '1e3s', '1234567s', '1.1234567890s', ' 37s', '37s ', 'NaNs', '', 37, null])(
    'rejects %j',
    (delay) => {
      expect(parseRetryHint(429, retryInfo(delay), null, undefined, NOW)).toEqual({ source: 'none' })
    },
  )

  it('ignores a retryDelay on another detail type', () => {
    const body = { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.Help', retryDelay: '30s' }] } }
    expect(parseRetryHint(429, body, null, undefined, NOW)).toEqual({ source: 'none' })
  })
})

describe('parseRetryHint — Retry-After header', () => {
  it.each([
    ['120', 120],
    ['0', 1],
    ['1', 1],
    ['99999999', 3600],
    [' 30 ', 30],
    ['Tue, 27 Oct 2026 12:01:30 GMT', 90], // HTTP-date, 90 s ahead
    ['Tue, 27 Oct 2026 12:00:00 GMT', 1], // now → clamped to 1
    ['Mon, 26 Oct 2026 12:00:00 GMT', 1], // past → clamped to 1
    ['Fri, 27 Nov 2026 12:00:00 GMT', 3600], // a month out → clamped
  ])('%j → %i s', (header, seconds) => {
    expect(parseRetryHint(429, undefined, header, undefined, NOW)).toEqual({ seconds, source: 'header' })
  })

  it.each(['-1', '1.5', '12345678901', 'soon', '2026-10-27T12:01:30Z', 'Tue, 27 Oct 2026 12:01:30 PST', ''])(
    'rejects %j',
    (header) => {
      expect(parseRetryHint(429, undefined, header, undefined, NOW)).toEqual({ source: 'none' })
    },
  )
})

describe('parseRetryHint — precedence and scope', () => {
  it('the larger of RetryInfo and Retry-After wins', () => {
    expect(parseRetryHint(429, retryInfo('30s'), '90', undefined, NOW)).toEqual({ seconds: 90, source: 'header' })
    expect(parseRetryHint(429, retryInfo('90s'), '30', undefined, NOW)).toEqual({ seconds: 90, source: 'retry-info' })
    expect(parseRetryHint(429, retryInfo('30s'), '30', undefined, NOW)).toEqual({ seconds: 30, source: 'retry-info' })
  })

  it('an invalid one of the two leaves the other', () => {
    expect(parseRetryHint(429, retryInfo('bogus'), '45', undefined, NOW)).toEqual({ seconds: 45, source: 'header' })
  })

  it.each([400, 402, 500, 503])('only a 429 carries a hint (%i → none)', (status) => {
    expect(parseRetryHint(status, retryInfo('30s'), '30', undefined, NOW)).toEqual({ source: 'none' })
  })

  it('insufficient_quota never gets a timer, even with a Retry-After', () => {
    expect(parseRetryHint(429, OPENAI_INSUFFICIENT_QUOTA, '20', 'insufficient_quota', NOW)).toEqual({ source: 'none' })
  })
})

describe('providerError — retry hint from real Response objects (fixtures)', () => {
  const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers })

  it('Gemini 429 (RECONSTRUCTED live shape): no RetryInfo → no hint', async () => {
    const err = await providerError('Gemini', res(429, GEMINI_429_RECONSTRUCTED), 'key')
    expect(err.retryHint).toEqual({ source: 'none' })
  })

  it('Gemini 429 with the DOCUMENTED RetryInfo shape → 37 s', async () => {
    const err = await providerError('Gemini', res(429, GEMINI_429_WITH_RETRY_INFO), 'key')
    expect(err.retryHint).toEqual({ seconds: 37, source: 'retry-info' })
  })

  it('OpenAI insufficient_quota → no timer', async () => {
    const err = await providerError('OpenAI', res(429, OPENAI_INSUFFICIENT_QUOTA), 'sk-key')
    expect(err.providerCode).toBe('insufficient_quota')
    expect(err.retryHint).toEqual({ source: 'none' })
  })

  it('Anthropic 429 with retry-after → that many seconds; without → none', async () => {
    const withHeader = await providerError('Anthropic', res(429, ANTHROPIC_RATE_LIMIT, { 'retry-after': '20' }), 'k')
    expect(withHeader.retryHint).toEqual({ seconds: 20, source: 'header' })
    const without = await providerError('Anthropic', res(429, ANTHROPIC_RATE_LIMIT), 'k')
    expect(without.retryHint).toEqual({ source: 'none' })
  })

  it('OpenRouter 402 → no timer', async () => {
    const err = await providerError('OpenRouter', res(402, OPENROUTER_402, { 'retry-after': '60' }), 'sk-or-k')
    expect(err.retryHint).toEqual({ source: 'none' })
  })

  it('only a number and a fixed source leave the parser — scrub and echo guard untouched', async () => {
    const key = 'AIzaSyFAKEFAKEFAKEFAKEFAKE'
    const prompt = 'The mitochondrion is the powerhouse of the cell and makes ATP for it.'
    const body = {
      error: {
        code: 429,
        message: `quota for ${key}: ${prompt}`,
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '5s', note: key }],
      },
    }
    const err = await providerError('Gemini', res(429, body, { 'retry-after': `${key}` }), key, prompt)
    expect(err.retryHint).toEqual({ seconds: 5, source: 'retry-info' })
    expect(JSON.stringify(err.retryHint)).not.toContain(key)
    expect(err.safeMessage).not.toContain(key)
  })

  it('a Response-like object with no headers never throws', async () => {
    const odd = { ok: false, status: 429, text: async () => JSON.stringify(GEMINI_429_WITH_RETRY_INFO) } as unknown as Response
    expect((await providerError('Gemini', odd, 'k')).retryHint).toEqual({ seconds: 37, source: 'retry-info' })
  })
})
