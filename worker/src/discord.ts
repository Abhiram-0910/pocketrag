import type { KVLike } from './rateLimit'
import { redactKeys } from './providers/errors'

export type DiscordTier = 'shared' | 'own'
// Suppression slot in the KV key. Shared-tier rate limiting gets its own slot so its 6h
// window can't swallow a shared-tier 5xx alert for the same provider+endpoint.
export type DiscordSuppressionSlot = DiscordTier | 'shared-ratelimit'

export interface DiscordFailurePayload {
  provider: string
  model: string | null
  status: string | null
  message: string
  tier: DiscordTier
  // Our classification (index.ts's ErrorCode) and the provider's own error code — both
  // optional since /ocr's deliberately narrow alert carries neither.
  code?: string
  providerCode?: string
}

const DISCORD_COLOR_RED = 0xed4245
const MAX_FIELD_LENGTH = 1000
export const DISCORD_SUPPRESS_WINDOW_SECONDS = 600 // one alert per provider per 10 min
// Shared-tier quota exhaustion is a daily condition, not an incident — one alert per 6h.
export const DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS = 6 * 60 * 60

export function buildDiscordPayload(payload: DiscordFailurePayload, timestamp: string): unknown {
  return {
    embeds: [
      {
        title: `Provider call failed: ${payload.provider}`,
        color: DISCORD_COLOR_RED,
        fields: [
          { name: 'Provider', value: payload.provider, inline: true },
          { name: 'Model', value: payload.model ?? 'n/a', inline: true },
          { name: 'Status', value: payload.status ?? 'unknown', inline: true },
          { name: 'Code', value: payload.code ?? 'n/a', inline: true },
          { name: 'Provider code', value: payload.providerCode ? redactKeys(payload.providerCode) : 'n/a', inline: true },
          { name: 'Tier', value: payload.tier, inline: true },
          // redactKeys is a backstop at the sink: index.ts already redacts before calling.
          { name: 'Message', value: redactKeys(payload.message).slice(0, MAX_FIELD_LENGTH) },
        ],
        timestamp,
      },
    ],
    // Defensive: a provider's raw error text could in principle contain something
    // ping-shaped (e.g. "@everyone") — this guarantees it's never treated as a mention.
    allowed_mentions: { parse: [] },
  }
}

/**
 * Fire-and-forget Discord notification for a provider-call failure. Never throws —
 * a Discord delivery failure must not affect the request/response cycle.
 * logProviderError's console.error already ran and stays the source of truth
 * regardless of what happens here.
 */
export async function sendDiscordAlert(
  fetchImpl: typeof fetch,
  webhookUrl: string,
  payload: DiscordFailurePayload,
): Promise<void> {
  try {
    await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildDiscordPayload(payload, new Date().toISOString())),
    })
  } catch {
    // swallow — fire-and-forget
  }
}

export type DiscordEndpoint = 'answer' | 'models' | 'ocr'

// ponytail: get-then-put isn't atomic — same accepted soft-cap tradeoff as
// rateLimit.ts's checkRateLimit. A burst of near-simultaneous failures for the same
// provider+endpoint could send slightly more than one alert per window. Fine for
// anti-spam, not a security boundary. Switch to a Durable Object if exact accounting
// matters.
//
// Keyed per (provider, endpoint, slot) rather than provider alone: /answer and /models hit
// different provider endpoints and can fail independently (e.g. a model-list shape
// change while chat completions still works). Sharing one window risks a /models
// failure silently suppressing a later, more user-impacting /answer failure for the
// same provider. The slot (shared / own / shared-ratelimit) is in the key so an own-key
// failure can't suppress a shared-tier alert for the same provider+endpoint (or vice
// versa), and a 6h shared rate-limit window can't suppress a shared 5xx. Nothing is lost from the record either way — Workers Logs still
// captures every failure on both endpoints unsuppressed — this only throttles the
// Discord alert itself, one per (provider, endpoint) per window.
export async function shouldNotify(
  kv: KVLike,
  provider: string,
  endpoint: DiscordEndpoint,
  slot: DiscordSuppressionSlot,
  windowSeconds: number = DISCORD_SUPPRESS_WINDOW_SECONDS,
): Promise<boolean> {
  const key = `discord-notify:${provider}:${endpoint}:${slot}`
  if (await kv.get(key)) return false
  await kv.put(key, '1', { expirationTtl: windowSeconds })
  return true
}
