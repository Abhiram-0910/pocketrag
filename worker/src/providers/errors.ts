// Shared failure shape for every provider file. A provider's raw error body is read,
// parsed for the few fields worth keeping, then dropped — it is never stored on the
// error, so nothing downstream (log, Discord, response) can forward it by accident.

const MAX_SAFE_MESSAGE_LENGTH = 200
const MAX_PROVIDER_CODE_LENGTH = 64
const PROVIDER_CODE_PATTERN = /^[\w.:-]+$/
// Echo guard: if any 20-char window of the (already truncated) message also appears in
// the prompt, the provider echoed request content back — withhold the whole message.
// ponytail: stride 5 means a contiguous echo shorter than 24 chars can slip through,
// and so can a fragment cut off at the 200-char truncation edge. Fine for log hygiene;
// stride 1 if that ceiling ever matters.
const ECHO_WINDOW = 20
const ECHO_STRIDE = 5
const REDACTED = '[redacted]'
export const ECHO_WITHHELD = '[withheld: echoed request content]'

// Backstop for the log/Discord sinks, independent of the exact-key scrub below: catches
// a key-shaped string even when it isn't the exact key we sent (e.g. OpenAI's masked
// "sk-abcd***wxyz" echo). \b(sk|xai)- also covers sk-ant- and sk-or-.
const KEY_PATTERN = /\b(?:sk|xai)-[\w*.-]{6,}|\bAIza[\w-]{10,}|Bearer\s+\S+/g

export function redactKeys(text: string): string {
  return text.replace(KEY_PATTERN, REDACTED)
}

export class ProviderError extends Error {
  readonly provider: string
  readonly status: number
  readonly providerCode?: string
  readonly safeMessage: string

  constructor(provider: string, status: number, safeMessage: string, providerCode?: string) {
    super(`${provider} API error ${status}: ${safeMessage}`)
    this.name = 'ProviderError'
    this.provider = provider
    this.status = status
    this.providerCode = providerCode
    this.safeMessage = safeMessage
  }
}

// Covers every error shape the 5 providers were observed returning live (2026-10-18):
//   Gemini     {error: {code: 400, status, message, details: [{reason: "API_KEY_INVALID"}]}}
//   OpenAI     {error: {type, code: "invalid_api_key", message}}
//   Anthropic  {type: "error", error: {type: "authentication_error", message}}
//   Grok       {code: "invalid-argument", error: "<message string>"}
//   OpenRouter {error: {code: 401, message}}
// providerCode precedence: Gemini's details[].reason, error.code (string only), error.type,
// error.status, then a top-level string code.
function extractErrorFields(body: unknown): { code?: unknown; message?: unknown } {
  if (typeof body !== 'object' || body === null) return {}
  const top = body as Record<string, unknown>
  if (typeof top.error === 'string') return { code: top.code, message: top.error }
  if (typeof top.error !== 'object' || top.error === null) return { code: top.code, message: top.message }
  const err = top.error as Record<string, unknown>
  const reason = Array.isArray(err.details)
    ? (err.details as Record<string, unknown>[]).find((d) => typeof d?.reason === 'string')?.reason
    : undefined
  const code = [reason, err.code, err.type, err.status, top.code].find((v) => typeof v === 'string')
  return { code, message: err.message }
}

function sanitizeProviderCode(code: unknown, apiKey: string): string | undefined {
  if (typeof code !== 'string') return undefined
  const capped = code.slice(0, MAX_PROVIDER_CODE_LENGTH)
  if (!PROVIDER_CODE_PATTERN.test(capped) || (apiKey && capped.includes(apiKey))) return undefined
  return capped
}

export function echoesPrompt(text: string, prompt: string): boolean {
  for (let i = 0; i + ECHO_WINDOW <= text.length; i += ECHO_STRIDE) {
    if (prompt.includes(text.slice(i, i + ECHO_WINDOW))) return true
  }
  return false
}

/**
 * Builds a ProviderError from a non-2xx response. Order matters: exact-key scrub runs
 * before truncation (truncating first could cut the key and stop it matching), and the
 * echo guard runs on the truncated text only — that's the only text that survives.
 * A non-JSON body (an HTML 5xx page, etc.) contributes nothing but its status.
 */
export async function providerError(
  provider: string,
  response: Response,
  apiKey: string,
  prompt?: string,
): Promise<ProviderError> {
  let body: unknown
  try {
    body = JSON.parse(await response.text())
  } catch {
    body = undefined
  }
  const { code, message } = extractErrorFields(body)
  const raw = typeof message === 'string' && message.length > 0 ? message : `HTTP ${response.status}`
  const scrubbed = (apiKey ? raw.replaceAll(apiKey, REDACTED) : raw).slice(0, MAX_SAFE_MESSAGE_LENGTH)
  const safeMessage = prompt && echoesPrompt(scrubbed, prompt) ? ECHO_WITHHELD : scrubbed
  return new ProviderError(provider, response.status, safeMessage, sanitizeProviderCode(code, apiKey))
}
