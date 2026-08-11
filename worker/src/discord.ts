import type { KVLike } from './rateLimit'

export interface DiscordFailurePayload {
  provider: string
  model: string | null
  status: string | null
  message: string
}

const DISCORD_COLOR_RED = 0xed4245
const MAX_FIELD_LENGTH = 1000
export const DISCORD_SUPPRESS_WINDOW_SECONDS = 600 // one alert per provider per 10 min

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
          { name: 'Message', value: payload.message.slice(0, MAX_FIELD_LENGTH) },
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

export type DiscordEndpoint = 'answer' | 'models'

// ponytail: get-then-put isn't atomic — same accepted soft-cap tradeoff as
// rateLimit.ts's checkRateLimit. A burst of near-simultaneous failures for the same
// provider+endpoint could send slightly more than one alert per window. Fine for
// anti-spam, not a security boundary. Switch to a Durable Object if exact accounting
// matters.
//
// Keyed per (provider, endpoint) rather than provider alone: /answer and /models hit
// different provider endpoints and can fail independently (e.g. a model-list shape
// change while chat completions still works). Sharing one window risks a /models
// failure silently suppressing a later, more user-impacting /answer failure for the
// same provider. Nothing is lost from the record either way — Workers Logs still
// captures every failure on both endpoints unsuppressed — this only throttles the
// Discord alert itself, one per (provider, endpoint) per window.
export async function shouldNotify(kv: KVLike, provider: string, endpoint: DiscordEndpoint): Promise<boolean> {
  const key = `discord-notify:${provider}:${endpoint}`
  if (await kv.get(key)) return false
  await kv.put(key, '1', { expirationTtl: DISCORD_SUPPRESS_WINDOW_SECONDS })
  return true
}
