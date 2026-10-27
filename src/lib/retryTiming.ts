import type { FailureCode, FailureSource } from './apiError'

// Step D: when a retry makes sense, from the Worker's numeric fields only. Never invent a
// timer — no field, no countdown (AGENTS.md). Time-bearing sentences are composed here
// because only the browser knows the user's time zone; everything else stays the Worker's
// copy, shown verbatim.

/** A per-second countdown only for short waits; longer ones show the absolute time only. */
export const TICK_MAX_MS = 15 * 60 * 1000

export type RetryTimingKind =
  | 'ours' // our own per-IP 429 (UTC midnight)
  | 'provider' // the provider said when (hint), shared or own key
  | 'breaker' // shared tier, no hint: our breaker's next probe, plus the midnight-Pacific bound
  | 'exhausted' // shared tier, breaker at its cap with no hint: "looks used up for today"

export interface RetryTiming {
  kind: RetryTimingKind
  shared: boolean
  retryAt: number // epoch ms, from this browser's clock at response arrival
  quotaResetAt?: number // midnight Pacific (breaker, exhausted)
  tick: boolean
}

export interface RetryFields {
  status?: number
  code?: FailureCode
  source?: FailureSource
  retryAfterSeconds?: number
  resetAt?: string
}

/** Fixed at response arrival: retryAfterSeconds counts from `arrivedAt`, not the server clock. */
export function retryTimingFor(f: RetryFields, arrivedAt: number): RetryTiming | null {
  const after = f.retryAfterSeconds === undefined ? undefined : arrivedAt + f.retryAfterSeconds * 1000
  const reset = f.resetAt === undefined ? undefined : Date.parse(f.resetAt)
  const make = (kind: RetryTimingKind, retryAt: number, quotaResetAt?: number): RetryTiming => ({
    kind,
    shared: f.source === 'shared',
    retryAt,
    quotaResetAt,
    tick: retryAt - arrivedAt <= TICK_MAX_MS,
  })
  if (f.status === 429) {
    const at = after ?? reset
    return at === undefined ? null : make('ours', at)
  }
  if (f.status !== 502 || f.code !== 'provider_rate_limited') return null
  if (f.source === 'shared') {
    if (after !== undefined && reset !== undefined) return make('breaker', after, reset)
    if (after !== undefined) return make('provider', after)
    if (reset !== undefined) return make('exhausted', reset, reset)
    return null
  }
  return after === undefined ? null : make('provider', after)
}

export function formatClock(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short', timeZone }).format(new Date(at))
}

/** "m:ss" (or "h:mm:ss"), rounded up so it never shows 0:00 before the button enables. */
export function formatRemaining(ms: number): string {
  const total = Math.ceil(Math.max(0, ms) / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

export interface RetryCopy {
  // Replaces the Worker's message only for 'exhausted'; otherwise the Worker's copy as-is.
  message: string
  lines: string[]
}

export function retryCopy(t: RetryTiming, workerMessage: string, opts: { ownKeyOption: boolean; timeZone?: string }): RetryCopy {
  const clock = (at: number) => formatClock(at, opts.timeZone)
  const midnight = t.quotaResetAt === undefined ? '' : `midnight Pacific (${clock(t.quotaResetAt)} your time)`
  switch (t.kind) {
    case 'ours':
      return { message: workerMessage, lines: [] }
    case 'provider':
      return {
        message: workerMessage,
        lines: [t.shared ? `PocketRAG will try Google again at ${clock(t.retryAt)}.` : `Try again at ${clock(t.retryAt)}.`],
      }
    case 'breaker':
      return {
        message: workerMessage,
        lines: [
          `PocketRAG will try Google again at ${clock(t.retryAt)}.`,
          `If the free tier's daily quota is used up, it resets at ${midnight}.`,
        ],
      }
    case 'exhausted':
      return {
        message: `The free shared tier looks used up for today. It normally resets at ${midnight}.${opts.ownKeyOption ? ' Or use your own key.' : ''}`,
        lines: [],
      }
  }
}

export interface CountdownState {
  remainingMs: number
  ready: boolean
}

interface VisibilitySource {
  readonly hidden: boolean
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
}

/**
 * Drives one countdown from the clock (never by counting ticks). Emits on start, every
 * second while `tick` and visible, once at zero, and on every visibility change; paused
 * (no timers) while hidden. Returns a stop function.
 */
export function startRetryCountdown(
  retryAt: number,
  tick: boolean,
  onState: (s: CountdownState) => void,
  doc: VisibilitySource = document,
  now: () => number = Date.now,
): () => void {
  let interval: ReturnType<typeof setInterval> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    clearInterval(interval)
    clearTimeout(timeout)
    interval = timeout = undefined
  }
  let done = false // zero is emitted exactly once
  const emit = () => {
    if (done) return 0
    const remainingMs = Math.max(0, retryAt - now())
    done = remainingMs === 0
    onState({ remainingMs, ready: done })
    return remainingMs
  }
  const sync = () => {
    clear()
    const remaining = emit()
    if (remaining === 0 || doc.hidden) return
    if (tick) {
      interval = setInterval(() => {
        if (emit() === 0) clear()
      }, 1000)
    }
    timeout = setTimeout(sync, remaining)
  }
  sync()
  doc.addEventListener('visibilitychange', sync)
  return () => {
    clear()
    doc.removeEventListener('visibilitychange', sync)
  }
}
