import type { KVLike, KvErrorReporter } from './rateLimit'

// Shared-tier circuit breaker for Gemini (Step D). A real shared Gemini 429 with no
// active cooldown writes this key; while it's active, shared /answer and /ocr return the
// same rate-limited 502 without calling Gemini or spending anyone's quota. BYOK never
// reads or writes it. Requests that hit it never call Gemini, so they can't extend it.
// ponytail: KV is eventually consistent (up to ~60 s across locations), so a 429 seen in
// one colo may take a minute to stop calls elsewhere — a few extra 429s, not a leak.
export const BREAKER_KEY = 'cooldown:shared:gemini'
// No-hint escalation: 60 s, then 2, 4, 8, 15 min (the cap).
export const NO_HINT_DELAYS_SECONDS = [60, 120, 240, 480, 900] as const
export const CAP_STEP = NO_HINT_DELAYS_SECONDS.length - 1
// The step outlives the cooldown by this much, so the next no-hint 429 escalates instead
// of starting over at 60 s.
const ESCALATION_MEMORY_SECONDS = 30 * 60
const MIN_KV_TTL_SECONDS = 60 // Workers KV's floor for expirationTtl
export const MAX_BREAKER_TTL_SECONDS = 2 * 60 * 60
const MAX_COOLDOWN_MS = 3600 * 1000 // the largest hint we accept (errors.ts)
export const QUOTA_TIME_ZONE = 'America/Los_Angeles' // Gemini's daily quotas reset at midnight Pacific

export interface Cooldown {
  until: number // epoch ms
  step: number // last no-hint delay index used, -1 if none
  hinted: boolean
}

export interface RetryFields {
  retryAfterSeconds?: number
  resetAt?: string
  // At the cap only: seconds until the breaker's own cooldown ends. resetAt (midnight
  // Pacific) is a hedged upper bound, not a timer; a retry before this is free anyway
  // (answered from the breaker, no Gemini call), so the client gates its button on this.
  cooldownSeconds?: number
}

function parseCooldown(raw: string | null, now: number): Cooldown | null {
  if (raw === null) return null
  try {
    const c = JSON.parse(raw) as Partial<Cooldown>
    if (
      typeof c.until === 'number' &&
      Number.isFinite(c.until) &&
      c.until <= now + MAX_COOLDOWN_MS &&
      Number.isInteger(c.step) &&
      (c.step as number) >= -1 &&
      (c.step as number) <= CAP_STEP &&
      typeof c.hinted === 'boolean'
    ) {
      return { until: c.until, step: c.step as number, hinted: c.hinted }
    }
  } catch {
    // malformed → treated as no cooldown
  }
  return null
}

/** The stored cooldown, active or recently expired; null when absent, malformed, or KV failed. */
export async function readCooldown(kv: KVLike, onKvError: KvErrorReporter, now = Date.now()): Promise<Cooldown | null> {
  try {
    return parseCooldown(await kv.get(BREAKER_KEY), now)
  } catch {
    onKvError('get')
    return null
  }
}

export function isActive(c: Cooldown, now = Date.now()): boolean {
  return c.until > now
}

/**
 * Called on a real shared Gemini 429. Re-reads first: if a cooldown is already active
 * (another request tripped it), returns that one and writes nothing. A failed KV write is
 * swallowed — the response still carries the computed cooldown.
 */
export async function tripBreaker(
  kv: KVLike,
  hintSeconds: number | undefined,
  onKvError: KvErrorReporter,
  now = Date.now(),
): Promise<Cooldown> {
  const prev = await readCooldown(kv, onKvError, now)
  if (prev !== null && isActive(prev, now)) return prev
  const hinted = hintSeconds !== undefined
  const step = hinted ? (prev?.step ?? -1) : Math.min((prev?.step ?? -1) + 1, CAP_STEP)
  const seconds = hinted ? hintSeconds : NO_HINT_DELAYS_SECONDS[step]
  const next: Cooldown = { until: now + seconds * 1000, step, hinted }
  const ttl = Math.min(MAX_BREAKER_TTL_SECONDS, Math.max(MIN_KV_TTL_SECONDS, seconds + ESCALATION_MEMORY_SECONDS))
  try {
    await kv.put(BREAKER_KEY, JSON.stringify(next), { expirationTtl: ttl })
  } catch {
    onKvError('put')
  }
  return next
}

// The zone's UTC offset at an instant, read off Intl — never a fixed offset.
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant))
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(instant / 1000) * 1000
}

/** The next local midnight in `timeZone` after `now`, as an instant. */
export function nextMidnightIn(timeZone: string, now = Date.now()): Date {
  const local = new Date(now + zoneOffsetMs(now, timeZone))
  const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1)
  // Two passes: the offset at the target can differ from today's across a DST change.
  // Midnight never falls in a US DST gap (changes happen at 02:00), so this is exact.
  const guess = wall - zoneOffsetMs(wall, timeZone)
  return new Date(wall - zoneOffsetMs(guess, timeZone))
}

/**
 * What a shared rate-limited 502 tells the client, by cooldown kind:
 *   hinted          → retryAfterSeconds                (Gemini said when)
 *   no hint, < cap  → retryAfterSeconds + resetAt      (our probe time + the "if" bound)
 *   no hint, at cap → resetAt + cooldownSeconds        ("looks used up for today")
 * resetAt is the next midnight Pacific. cooldownSeconds is additive (Phase 5a): older
 * clients ignore it, and it keeps the cap's absence of retryAfterSeconds intact.
 */
export function cooldownFields(c: Cooldown, now = Date.now()): RetryFields {
  const retryAfterSeconds = Math.min(3600, Math.max(1, Math.ceil((c.until - now) / 1000)))
  if (c.hinted) return { retryAfterSeconds }
  const resetAt = nextMidnightIn(QUOTA_TIME_ZONE, now).toISOString()
  return c.step >= CAP_STEP ? { resetAt, cooldownSeconds: retryAfterSeconds } : { retryAfterSeconds, resetAt }
}
