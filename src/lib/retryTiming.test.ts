import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseWorkerErrorResponse } from './apiError'
import {
  TICK_MAX_MS,
  formatRemaining,
  retryCopy,
  retryTimingFor,
  startRetryCountdown,
  type CountdownState,
} from './retryTiming'

const SHARED_RL = 'The free shared tier is at capacity right now. Try again later, or use your own API key.'
const OWN_RL = 'Your provider account hit its rate limit, quota, or credit balance. Wait a moment or check your plan.'
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('parseWorkerErrorResponse — retryAfterSeconds / resetAt bounds (Step D)', () => {
  it.each<[number, unknown, number | undefined]>([
    [429, 0, 0],
    [429, 86_400, 86_400],
    [429, 86_401, undefined],
    [429, -1, undefined],
    [429, 1.5, undefined],
    [429, '30', undefined],
    [429, Number.MAX_SAFE_INTEGER, undefined],
  ])('our 429: %i with %j → %s', async (status, value, expected) => {
    const err = await parseWorkerErrorResponse(json(status, { error: 'x', resetAt: '2026-10-28T00:00:00.000Z', retryAfterSeconds: value }), 'f')
    expect(err.retryAfterSeconds).toBe(expected)
  })

  it.each<[unknown, number | undefined]>([
    [1, 1],
    [3600, 3600],
    [0, undefined],
    [3601, undefined],
    [null, undefined],
  ])('rate-limited 502: %j → %s', async (value, expected) => {
    const err = await parseWorkerErrorResponse(
      json(502, { error: SHARED_RL, code: 'provider_rate_limited', source: 'shared', retryAfterSeconds: value }),
      'f',
    )
    expect(err.retryAfterSeconds).toBe(expected)
  })

  it('reads the fields only on our 429 or a provider_rate_limited 502', async () => {
    for (const body of [
      { error: 'x', code: 'provider_unavailable', retryAfterSeconds: 30, resetAt: '2026-10-28T00:00:00.000Z' },
      { error: 'x', code: 'region_restricted', retryAfterSeconds: 30 },
    ]) {
      const err = await parseWorkerErrorResponse(json(body.code === 'region_restricted' ? 403 : 502, body), 'f')
      expect(err.retryAfterSeconds).toBeUndefined()
      expect(err.resetAt).toBeUndefined()
    }
  })

  it('resetAt on a 502 only from the shared tier, and only a parseable date', async () => {
    const own = await parseWorkerErrorResponse(
      json(502, { error: OWN_RL, code: 'provider_rate_limited', source: 'own', resetAt: '2026-11-01T07:00:00.000Z' }),
      'f',
    )
    expect(own.resetAt).toBeUndefined()
    const bad = await parseWorkerErrorResponse(
      json(502, { error: SHARED_RL, code: 'provider_rate_limited', source: 'shared', resetAt: 'tomorrow-ish' }),
      'f',
    )
    expect(bad.resetAt).toBeUndefined()
  })
})

describe('retryTimingFor', () => {
  const T = Date.parse('2026-10-31T23:00:00.000Z')
  const MIDNIGHT = '2026-11-01T07:00:00.000Z'

  it('counts from the arrival clock, not the server', () => {
    const t = retryTimingFor({ status: 502, code: 'provider_rate_limited', source: 'own', retryAfterSeconds: 20 }, T)
    expect(t).toEqual({ kind: 'provider', shared: false, retryAt: T + 20_000, quotaResetAt: undefined, tick: true })
  })

  it('shared: both fields → breaker; hint only → provider; resetAt only → exhausted', () => {
    const base = { status: 502, code: 'provider_rate_limited' as const, source: 'shared' as const }
    expect(retryTimingFor({ ...base, retryAfterSeconds: 120, resetAt: MIDNIGHT }, T)).toMatchObject({
      kind: 'breaker',
      retryAt: T + 120_000,
      quotaResetAt: Date.parse(MIDNIGHT),
      tick: true,
    })
    expect(retryTimingFor({ ...base, retryAfterSeconds: 37 }, T)).toMatchObject({ kind: 'provider', shared: true })
    expect(retryTimingFor({ ...base, resetAt: MIDNIGHT }, T)).toMatchObject({
      kind: 'exhausted',
      retryAt: Date.parse(MIDNIGHT),
      tick: false, // 8 h away → absolute time only
    })
  })

  it('unknown wait → no timer at all', () => {
    expect(retryTimingFor({ status: 502, code: 'provider_rate_limited', source: 'shared' }, T)).toBeNull()
    expect(retryTimingFor({ status: 502, code: 'provider_rate_limited', source: 'own' }, T)).toBeNull()
    expect(retryTimingFor({ status: 502, code: 'provider_unavailable', retryAfterSeconds: 30 }, T)).toBeNull()
    expect(retryTimingFor({ status: 429 }, T)).toBeNull()
    expect(retryTimingFor({}, T)).toBeNull()
  })

  it('our 429 prefers retryAfterSeconds over resetAt, and ticks only within 15 min', () => {
    expect(retryTimingFor({ status: 429, retryAfterSeconds: 900, resetAt: MIDNIGHT }, T)).toMatchObject({
      kind: 'ours',
      retryAt: T + 900_000,
      tick: true,
    })
    expect(retryTimingFor({ status: 429, retryAfterSeconds: 901 }, T)?.tick).toBe(false)
    expect(retryTimingFor({ status: 429, resetAt: MIDNIGHT }, T)?.retryAt).toBe(Date.parse(MIDNIGHT))
    expect(TICK_MAX_MS).toBe(900_000)
  })
})

describe('retryCopy — wording and midnight Pacific in the user’s zone, across DST', () => {
  const opts = (timeZone: string, ownKeyOption = true) => ({ timeZone, ownKeyOption })
  // US DST ends 2026-11-01 02:00 PDT. Midnight Pacific: Nov 1 = 07:00Z (PDT), Nov 2 = 08:00Z (PST).
  const before = { kind: 'exhausted' as const, shared: true, retryAt: Date.parse('2026-11-01T07:00:00Z'), quotaResetAt: Date.parse('2026-11-01T07:00:00Z'), tick: false }
  const after = { ...before, retryAt: Date.parse('2026-11-02T08:00:00Z'), quotaResetAt: Date.parse('2026-11-02T08:00:00Z') }

  it.each([
    ['America/Los_Angeles', before, '12:00'],
    ['America/Los_Angeles', after, '12:00'],
    ['Asia/Kolkata', before, '12:30'], // IST is UTC+5:30 year-round: midnight PDT = 12:30 PM
    ['Asia/Kolkata', after, '1:30'], // midnight PST = 1:30 PM
    // New York leaves DST an hour before LA (06:00Z vs 09:00Z), so for that one night
    // midnight Pacific is 2:00 AM Eastern, not the usual 3:00.
    ['America/New_York', before, '2:00'],
    ['America/New_York', after, '3:00'],
    ['Europe/London', after, '8:00'], // GMT
  ])('%s: escalated copy names midnight Pacific as local time (%#)', (zone, timing, clock) => {
    const { message, lines } = retryCopy(timing, SHARED_RL, opts(zone))
    expect(message).toMatch(
      new RegExp(`^The free shared tier looks used up for today\\. It normally resets at midnight Pacific \\(${clock}\\s?[AP]M your time\\)\\. Or use your own key\\.$`),
    )
    expect(lines).toEqual([])
  })

  it('breaker below the cap: our probe time plus the "if" bound; the Worker message kept', () => {
    const t = { kind: 'breaker' as const, shared: true, retryAt: Date.parse('2026-10-31T23:02:00Z'), quotaResetAt: Date.parse('2026-11-01T07:00:00Z'), tick: true }
    const { message, lines } = retryCopy(t, SHARED_RL, opts('UTC'))
    expect(message).toBe(SHARED_RL)
    expect(lines).toEqual([
      'PocketRAG will try Google again at 11:02 PM.',
      "If the free tier's daily quota is used up, it resets at midnight Pacific (7:00 AM your time).",
    ])
  })

  it('a shared hint names our retry; an own-key hint just the time; ours adds nothing (classify says "Resets at")', () => {
    const at = Date.parse('2026-10-31T23:00:37Z')
    expect(retryCopy({ kind: 'provider', shared: true, retryAt: at, tick: true }, SHARED_RL, opts('UTC')).lines).toEqual([
      'PocketRAG will try Google again at 11:00 PM.',
    ])
    expect(retryCopy({ kind: 'provider', shared: false, retryAt: at, tick: true }, OWN_RL, opts('UTC')).lines).toEqual([
      'Try again at 11:00 PM.',
    ])
    expect(retryCopy({ kind: 'ours', shared: true, retryAt: at, tick: true }, 'x', opts('UTC'))).toEqual({ message: 'x', lines: [] })
  })

  it('OCR (no own-key path) drops "Or use your own key."', () => {
    expect(retryCopy(before, SHARED_RL, opts('UTC', false)).message).toMatch(/your time\)\.$/)
  })
})

describe('formatRemaining', () => {
  it.each([
    [0, '0:00'],
    [1, '0:01'], // rounds up
    [59_001, '1:00'],
    [125_000, '2:05'],
    [900_000, '15:00'],
    [3_600_000, '1:00:00'],
  ])('%i ms → %s', (ms, text) => expect(formatRemaining(ms)).toBe(text))
})

describe('startRetryCountdown — from the clock, paused while hidden, zero once', () => {
  afterEach(() => vi.useRealTimers())

  function fakeDoc() {
    const listeners = new Set<() => void>()
    return {
      hidden: false,
      addEventListener: (_t: 'visibilitychange', l: () => void) => listeners.add(l),
      removeEventListener: (_t: 'visibilitychange', l: () => void) => listeners.delete(l),
      setHidden(h: boolean) {
        this.hidden = h
        for (const l of listeners) l()
      },
      listeners,
    }
  }

  it('ticks each second, reaches zero exactly once, then stops', () => {
    vi.useFakeTimers()
    const start = Date.now()
    const states: CountdownState[] = []
    startRetryCountdown(start + 3000, true, (s) => states.push(s), fakeDoc())
    vi.advanceTimersByTime(10_000)
    expect(states.map((s) => s.remainingMs)).toEqual([3000, 2000, 1000, 0])
    expect(states.filter((s) => s.ready)).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('no tick for long waits: one state at start, one at zero', () => {
    vi.useFakeTimers()
    const states: CountdownState[] = []
    startRetryCountdown(Date.now() + 20 * 60_000, false, (s) => states.push(s), fakeDoc())
    vi.advanceTimersByTime(20 * 60_000)
    expect(states.map((s) => s.ready)).toEqual([false, true])
  })

  it('recomputes from the clock, not tick count, when time jumps', () => {
    vi.useFakeTimers()
    const states: CountdownState[] = []
    startRetryCountdown(Date.now() + 60_000, true, (s) => states.push(s), fakeDoc())
    vi.setSystemTime(Date.now() + 45_000) // a sleep/clock jump with no timers fired
    vi.advanceTimersByTime(1000)
    expect(states.at(-1)?.remainingMs).toBe(14_000)
  })

  it('pauses while hidden (no timers) and resumes from the clock on show', () => {
    vi.useFakeTimers()
    const doc = fakeDoc()
    const states: CountdownState[] = []
    startRetryCountdown(Date.now() + 30_000, true, (s) => states.push(s), doc)
    vi.advanceTimersByTime(2000)
    doc.setHidden(true)
    const whileHidden = states.length
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(20_000)
    expect(states.length).toBe(whileHidden)
    doc.setHidden(false)
    expect(states.at(-1)?.remainingMs).toBe(8000)
  })

  it('shown after the deadline passed while hidden: zero, once', () => {
    vi.useFakeTimers()
    const doc = fakeDoc()
    const states: CountdownState[] = []
    startRetryCountdown(Date.now() + 5000, true, (s) => states.push(s), doc)
    doc.setHidden(true)
    vi.setSystemTime(Date.now() + 60_000)
    doc.setHidden(false)
    doc.setHidden(true)
    doc.setHidden(false)
    expect(states.filter((s) => s.ready)).toHaveLength(1)
  })

  it('stop() clears timers and the listener', () => {
    vi.useFakeTimers()
    const doc = fakeDoc()
    const stop = startRetryCountdown(Date.now() + 5000, true, () => {}, doc)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(doc.listeners.size).toBe(0)
  })
})
