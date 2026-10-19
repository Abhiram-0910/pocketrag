import { describe, expect, it } from 'vitest'
import { failureAction, parseWorkerErrorResponse, type FailureCode, type FailureSource } from './apiError'

// Real response bodies from the deployed Worker (worker/src/index.ts's copy table, Step A).
const KEY_REJECTED = "The provider rejected your API key. Check that it's correct, active, and has access to this model."
const SHARED_RATE_LIMITED = 'The free shared tier is at capacity right now. Try again later, or use your own API key.'
const OWN_RATE_LIMITED =
  'Your provider account hit its rate limit, quota, or credit balance. Wait a moment or check your plan.'
const REQUEST_REJECTED =
  'The provider rejected this request. The selected model may not be available to your key; try another.'
const SHARED_UNAVAILABLE = "The free tier couldn't respond right now. Try again in a moment, or use your own API key."
const OWN_UNAVAILABLE = "The provider couldn't respond right now. Please try again in a moment."
const EXPERIMENTAL_UNCLASSIFIED =
  "This provider isn't fully supported yet. Please try Gemini or OpenAI for now — we're working on it."
const OUR_RATE_LIMIT = "You've hit today's request limit. Please try again tomorrow."
const RESET_AT = '2026-10-20T00:00:00.000Z'

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('parseWorkerErrorResponse', () => {
  it.each<[string, Record<string, unknown>, FailureCode, FailureSource | undefined]>([
    ['key_rejected', { error: KEY_REJECTED, code: 'key_rejected' }, 'key_rejected', undefined],
    [
      'provider_rate_limited (shared)',
      { error: SHARED_RATE_LIMITED, code: 'provider_rate_limited', source: 'shared' },
      'provider_rate_limited',
      'shared',
    ],
    [
      'provider_rate_limited (own)',
      { error: OWN_RATE_LIMITED, code: 'provider_rate_limited', source: 'own' },
      'provider_rate_limited',
      'own',
    ],
    ['request_rejected', { error: REQUEST_REJECTED, code: 'request_rejected' }, 'request_rejected', undefined],
    [
      'provider_unavailable (shared copy)',
      { error: SHARED_UNAVAILABLE, code: 'provider_unavailable' },
      'provider_unavailable',
      undefined,
    ],
    ['provider_unavailable (own copy)', { error: OWN_UNAVAILABLE, code: 'provider_unavailable' }, 'provider_unavailable', undefined],
    [
      'Experimental unclassified',
      { error: EXPERIMENTAL_UNCLASSIFIED, code: 'provider_unavailable' },
      'provider_unavailable',
      undefined,
    ],
  ])('parses a real Step A 502 body: %s', async (_name, body, code, source) => {
    const err = await parseWorkerErrorResponse(jsonResponse(502, body), 'fallback')
    expect(err.status).toBe(502)
    expect(err.message).toBe(body.error)
    expect(err.code).toBe(code)
    expect(err.source).toBe(source)
    expect(err.resetAt).toBeUndefined()
  })

  it('parses our own per-IP 429: resetAt kept, no code or source', async () => {
    const err = await parseWorkerErrorResponse(jsonResponse(429, { error: OUR_RATE_LIMIT, resetAt: RESET_AT }), 'fallback')
    expect(err).toMatchObject({ status: 429, message: OUR_RATE_LIMIT, resetAt: RESET_AT })
    expect(err.code).toBeUndefined()
    expect(err.source).toBeUndefined()
  })

  it('handles an older Worker body with no code (pre-Step A) — message only', async () => {
    const err = await parseWorkerErrorResponse(jsonResponse(502, { error: EXPERIMENTAL_UNCLASSIFIED }), 'fallback')
    expect(err).toMatchObject({ status: 502, message: EXPERIMENTAL_UNCLASSIFIED })
    expect(err.code).toBeUndefined()
    expect(failureAction(err.code, err.source)).toBeNull()
  })

  it('drops an unknown code and an unknown source', async () => {
    const err = await parseWorkerErrorResponse(
      jsonResponse(502, { error: OWN_UNAVAILABLE, code: 'bogus', source: 'shared' }),
      'fallback',
    )
    expect(err.code).toBeUndefined()
    expect(err.source).toBeUndefined()
    const weird = await parseWorkerErrorResponse(
      jsonResponse(502, { error: OWN_RATE_LIMITED, code: 'provider_rate_limited', source: 'someone-else' }),
      'fallback',
    )
    expect(weird.code).toBe('provider_rate_limited')
    expect(weird.source).toBeUndefined()
  })

  it('ignores resetAt on a 502 and code/source on a 429, so the two limits can never be confused', async () => {
    const provider = await parseWorkerErrorResponse(
      jsonResponse(502, { error: OWN_RATE_LIMITED, code: 'provider_rate_limited', source: 'own', resetAt: RESET_AT }),
      'fallback',
    )
    expect(provider.resetAt).toBeUndefined()
    const ours = await parseWorkerErrorResponse(
      jsonResponse(429, { error: OUR_RATE_LIMIT, resetAt: RESET_AT, code: 'provider_rate_limited', source: 'shared' }),
      'fallback',
    )
    expect(ours.code).toBeUndefined()
    expect(ours.source).toBeUndefined()
  })

  it('falls back to the given message for a non-JSON body', async () => {
    const err = await parseWorkerErrorResponse(new Response('<html>Bad Gateway</html>', { status: 502 }), 'fallback')
    expect(err).toMatchObject({ status: 502, message: 'fallback' })
    expect(err.code).toBeUndefined()
  })

  it('falls back when `error` is not a string', async () => {
    const err = await parseWorkerErrorResponse(jsonResponse(502, { error: { nested: true } }), 'fallback')
    expect(err.message).toBe('fallback')
  })
})

describe('failureAction', () => {
  it.each<[FailureCode | undefined, FailureSource | undefined, ReturnType<typeof failureAction>]>([
    ['key_rejected', undefined, 'check-key'],
    ['provider_rate_limited', 'shared', 'use-own-key'],
    ['provider_rate_limited', 'own', null],
    ['provider_rate_limited', undefined, null],
    ['request_rejected', undefined, 'choose-model'],
    ['provider_unavailable', undefined, 'retry'],
    [undefined, undefined, null],
  ])('%s / %s → %s', (code, source, expected) => {
    expect(failureAction(code, source)).toBe(expected)
  })
})
