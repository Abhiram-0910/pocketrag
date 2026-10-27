import {
  validateAnswerRequest,
  validateModelsRequest,
  validateOcrRequest,
  EXPERIMENTAL_PROVIDERS,
  type KeySource,
  type SupportedProvider,
} from './validate'
import { buildPrompt } from './prompt'
import { checkGrounding } from './grounding'
import { assignDocLabels } from './labels'
import { checkRateLimit, BYOK_DAILY_LIMIT, DEFAULT_DAILY_LIMIT, OCR_DAILY_LIMIT, type KvErrorReporter } from './rateLimit'
import {
  callGemini,
  listGeminiModels,
  transcribeImage,
  DEFAULT_SHARED_MODEL,
  type GeminiGroundingResult,
} from './providers/gemini'
import { callOpenAI, listOpenAIModels } from './providers/openai'
import { callAnthropic, listAnthropicModels } from './providers/anthropic'
import { callGrok, listGrokModels } from './providers/grok'
import { callOpenRouter, listOpenRouterModels } from './providers/openrouter'
import { ProviderError, redactKeys } from './providers/errors'
import { corsHeaders, resolveCorsOrigin } from './cors'
import {
  sendDiscordAlert,
  shouldNotify,
  shouldAlertKvFailure,
  KV_FAILURE_PAYLOAD,
  DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS,
  DISCORD_SUPPRESS_WINDOW_SECONDS,
  type DiscordEndpoint,
} from './discord'
import type { FailureCode } from './failureCodes'
import { isRegionRestricted } from './region'

const RATE_LIMIT_MESSAGE = "You've hit today's request limit. Please try again tomorrow."
// Client-facing copy per failure code. The provider's own text (safeMessage) never goes
// to the client — only to logProviderError/Discord below, already scrubbed. The two
// "isn't fully supported yet" strings are reserved for an Experimental provider's
// unclassified failure (one we can't explain from status/providerCode).
const ANSWER_UNAVAILABLE_MESSAGE =
  "This provider isn't fully supported yet. Please try Gemini or OpenAI for now — we're working on it."
const MODELS_UNAVAILABLE_MESSAGE =
  "This provider's model list isn't available yet. Please try Gemini or OpenAI for now — we're working on it."
const KEY_REJECTED_MESSAGE =
  "The provider rejected your API key. Check that it's correct, active, and has access to this model."
const OWN_RATE_LIMITED_MESSAGE =
  'Your provider account hit its rate limit, quota, or credit balance. Wait a moment or check your plan.'
const SHARED_RATE_LIMITED_MESSAGE =
  'The free shared tier is at capacity right now. Try again later, or use your own API key.'
const REQUEST_REJECTED_MESSAGE =
  'The provider rejected this request. The selected model may not be available to your key; try another.'
const PROVIDER_UNAVAILABLE_MESSAGE = "The provider couldn't respond right now. Please try again in a moment."
const SHARED_UNAVAILABLE_MESSAGE =
  "The free tier couldn't respond right now. Try again in a moment, or use your own API key."
const OCR_UNAVAILABLE_MESSAGE = "OCR isn't available right now. Please try again in a moment."
const SERVER_ERROR_MESSAGE = "PocketRAG's server had a problem. Try again."
const REGION_RESTRICTED_MESSAGE =
  "The free shared tier isn't available in your region because of Google's terms. Use your own API key instead."
// /ocr has no own-key path, so its copy can't point at one.
const OCR_REGION_RESTRICTED_MESSAGE =
  "OCR runs on the free shared tier, which isn't available in your region because of Google's terms."

// Shared tier only, and before the rate-limit counter or any provider call — a refused
// request spends nothing. No log, no Discord alert: the country and IP are never recorded.
function regionRestrictedResponse(message: string, origin: string | null): Response {
  return json({ error: message, code: 'region_restricted' satisfies FailureCode }, 403, origin)
}

interface ProviderFailure {
  provider: SupportedProvider
  model: string | null
  keySource: KeySource
  code: FailureCode
  status: number | null
  providerCode?: string
  safeMessage: string
  // True when nothing about the failure maps to a known cause (not a ProviderError, or
  // a status outside the table below) — the only case that gets the Experimental copy.
  unclassified: boolean
}

// A 400 is a bad key on Gemini (API_KEY_INVALID) and Grok (message only — its code is
// a generic "invalid-argument"), both confirmed live with fake keys 2026-10-18.
const KEY_REJECTED_PROVIDER_CODES = new Set(['API_KEY_INVALID', 'invalid_api_key'])
const API_KEY_MESSAGE_PATTERN = /\bapi key\b/i
const MAX_UNCLASSIFIED_MESSAGE_LENGTH = 200

function classifyStatus(
  keySource: KeySource,
  status: number,
  providerCode: string | undefined,
  safeMessage: string,
): { code: FailureCode; unclassified: boolean } {
  // Shared tier: the key is ours, so the user is never told "your key"/"your request"
  // was rejected — only capacity (429) or plain unavailability.
  if (keySource === 'shared') {
    return status === 429
      ? { code: 'provider_rate_limited', unclassified: false }
      : { code: 'provider_unavailable', unclassified: status < 500 }
  }
  if (providerCode !== undefined && KEY_REJECTED_PROVIDER_CODES.has(providerCode)) {
    return { code: 'key_rejected', unclassified: false }
  }
  if (status === 401 || status === 403) return { code: 'key_rejected', unclassified: false }
  // Fallback for providers with no key-specific code; safeMessage is already key-scrubbed.
  if (status === 400 && API_KEY_MESSAGE_PATTERN.test(safeMessage)) return { code: 'key_rejected', unclassified: false }
  if (status === 429 || status === 402) return { code: 'provider_rate_limited', unclassified: false }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return { code: 'request_rejected', unclassified: false }
  }
  if (status >= 500) return { code: 'provider_unavailable', unclassified: false }
  return { code: 'provider_unavailable', unclassified: true }
}

function classify(err: unknown, provider: SupportedProvider, model: string | null, keySource: KeySource): ProviderFailure {
  if (!(err instanceof ProviderError)) {
    // Network failure, unexpected response shape, empty answer text — no status to go on.
    const message = err instanceof Error ? err.message : 'unknown error'
    return {
      provider,
      model,
      keySource,
      code: 'provider_unavailable',
      status: null,
      safeMessage: message.slice(0, MAX_UNCLASSIFIED_MESSAGE_LENGTH),
      unclassified: true,
    }
  }
  const { code, unclassified } = classifyStatus(keySource, err.status, err.providerCode, err.safeMessage)
  return {
    provider,
    model,
    keySource,
    code,
    status: err.status,
    providerCode: err.providerCode,
    safeMessage: err.safeMessage,
    unclassified,
  }
}

function failureMessage(failure: ProviderFailure, endpoint: 'answer' | 'models'): string {
  if (failure.unclassified && EXPERIMENTAL_PROVIDERS.includes(failure.provider)) {
    return endpoint === 'answer' ? ANSWER_UNAVAILABLE_MESSAGE : MODELS_UNAVAILABLE_MESSAGE
  }
  switch (failure.code) {
    case 'key_rejected':
      return KEY_REJECTED_MESSAGE
    case 'provider_rate_limited':
      return failure.keySource === 'shared' ? SHARED_RATE_LIMITED_MESSAGE : OWN_RATE_LIMITED_MESSAGE
    case 'request_rejected':
      return REQUEST_REJECTED_MESSAGE
    default:
      return failure.keySource === 'shared' ? SHARED_UNAVAILABLE_MESSAGE : PROVIDER_UNAVAILABLE_MESSAGE
  }
}

// Status stays 502 for every provider failure (the frontend's errorTaxonomy keys off
// it); `code` and, for rate limits, `source` are additive fields.
function failureResponse(failure: ProviderFailure, endpoint: 'answer' | 'models', origin: string | null): Response {
  return json(
    {
      error: failureMessage(failure, endpoint),
      code: failure.code,
      ...(failure.code === 'provider_rate_limited' ? { source: failure.keySource } : {}),
    },
    502,
    origin,
  )
}

/**
 * Structured failure log for a provider call — lands in Cloudflare Workers Logs. Takes
 * only the classified ProviderFailure: no `err`, no apiKey. safeMessage was already
 * exact-key-scrubbed in the provider file; redactKeys is the pattern-based backstop.
 */
function logProviderError(failure: ProviderFailure): void {
  console.error(
    JSON.stringify({
      event: 'provider_call_failed',
      provider: failure.provider,
      model: failure.model,
      keySource: failure.keySource,
      code: failure.code,
      status: failure.status,
      providerCode: failure.providerCode === undefined ? undefined : redactKeys(failure.providerCode),
      message: redactKeys(failure.safeMessage),
    }),
  )
}

// Shared-tier failures always alert (our key, our problem). Own-key failures alert only
// when they might be ours to fix: provider_unavailable, or a request_rejected from an
// Experimental provider (our request shape is unproven there). A user's own bad key or
// exhausted quota/credit is theirs, not an incident.
function shouldAlert(failure: ProviderFailure): boolean {
  if (failure.keySource === 'shared') return true
  if (failure.code === 'provider_unavailable') return true
  return failure.code === 'request_rejected' && EXPERIMENTAL_PROVIDERS.includes(failure.provider)
}

// Fire-and-forget Discord alert, suppressed to one per (provider, endpoint, slot) per
// window (see discord.ts) — shared-tier rate limiting has its own slot with a 6h window,
// everything else uses the shared/own slot with 10 min. Inert (no KV read, no fetch) when the secret isn't set. Registered via
// ctx.waitUntil so the runtime doesn't tear it down after the response is sent —
// sendDiscordAlert itself never throws, so this never surfaces to the caller.
function notifyDiscordOfFailure(
  ctx: ExecutionContext,
  env: Env,
  failure: ProviderFailure,
  endpoint: DiscordEndpoint,
): void {
  if (!env.DISCORD_WEBHOOK_URL || !shouldAlert(failure)) return
  const sharedRateLimit = failure.keySource === 'shared' && failure.code === 'provider_rate_limited'
  const slot = sharedRateLimit ? 'shared-ratelimit' : failure.keySource
  const window = sharedRateLimit ? DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS : DISCORD_SUPPRESS_WINDOW_SECONDS
  ctx.waitUntil(
    shouldNotify(env.RATE_LIMIT_KV, failure.provider, endpoint, slot, window, kvErrorReporter(ctx, env)).then((notify) =>
      notify
        ? sendDiscordAlert(fetch, env.DISCORD_WEBHOOK_URL, {
            provider: failure.provider,
            model: failure.model,
            status: failure.status === null ? null : String(failure.status),
            message: redactKeys(failure.safeMessage),
            tier: failure.keySource,
            code: failure.code,
            providerCode: failure.providerCode,
          })
        : undefined,
    ),
  )
}

/**
 * Milestone 9 Phase A: a deliberately narrower failure logger for /ocr, separate from
 * logProviderError above. logProviderError logs the provider's scrubbed safeMessage —
 * fine for /answer and /models, which send only snippets and have the prompt echo
 * guard — but /ocr sends real note content (a full image, not a snippet), and some
 * providers' error bodies echo back fragments of the request on a 400. This function
 * has no `err`/`message` parameter to forward at all, so there's no field a future
 * edit could accidentally start logging — only `status`, read from ProviderError.status.
 */
function logOcrFailure(status: string | null): void {
  console.error(JSON.stringify({ event: 'ocr_call_failed', status }))
}

// Same "no raw message field to forward" restriction as logOcrFailure above, applied
// to the Discord alert — a fixed generic message, never the provider's safeMessage.
function notifyDiscordOfOcrFailure(ctx: ExecutionContext, env: Env, status: string | null): void {
  if (!env.DISCORD_WEBHOOK_URL) return
  ctx.waitUntil(
    shouldNotify(env.RATE_LIMIT_KV, 'gemini', 'ocr', 'shared', undefined, kvErrorReporter(ctx, env)).then((notify) =>
      notify
        ? sendDiscordAlert(fetch, env.DISCORD_WEBHOOK_URL, {
            provider: 'gemini',
            model: DEFAULT_SHARED_MODEL,
            status,
            message: 'OCR request failed.',
            tier: 'shared',
          })
        : undefined,
    ),
  )
}

/**
 * KV fails open (rateLimit.ts, discord.ts): a failed call is reported here instead of
 * thrown. Number-only log line — no IP, no key name, no error text — and at most one
 * Discord alert per isolate per hour, suppressed in memory since KV is what's failing.
 */
function kvErrorReporter(ctx: ExecutionContext, env: Env): KvErrorReporter {
  return (op) => {
    console.warn(JSON.stringify({ event: 'kv_call_failed', get: op === 'get' ? 1 : 0, put: op === 'put' ? 1 : 0 }))
    if (env.DISCORD_WEBHOOK_URL && shouldAlertKvFailure()) {
      ctx.waitUntil(sendDiscordAlert(fetch, env.DISCORD_WEBHOOK_URL, KV_FAILURE_PAYLOAD))
    }
  }
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  })
}

async function handleAnswer(
  request: Request,
  env: Env,
  origin: string | null,
  ip: string,
  country: unknown,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400, origin)
  }

  const validation = validateAnswerRequest(body)
  if (!validation.ok) {
    return json({ error: validation.error }, 400, origin)
  }

  if (validation.keySource === 'shared' && isRegionRestricted(country)) {
    return regionRestrictedResponse(REGION_RESTRICTED_MESSAGE, origin)
  }

  // Shared and BYOK requests from the same IP track independent quotas: BYOK doesn't
  // touch our Gemini quota, and a BYOK user's own traffic shouldn't burn the shared-tier
  // limit for others behind the same IP (or vice versa).
  const rateLimit =
    validation.keySource === 'own'
      ? await checkRateLimit(env.RATE_LIMIT_KV, ip, 'byok', BYOK_DAILY_LIMIT, kvErrorReporter(ctx, env))
      : await checkRateLimit(env.RATE_LIMIT_KV, ip, 'shared', DEFAULT_DAILY_LIMIT, kvErrorReporter(ctx, env))
  if (!rateLimit.allowed) {
    return json({ error: RATE_LIMIT_MESSAGE, resetAt: rateLimit.resetAt }, 429, origin)
  }

  // The Worker owns the Doc N labelling — it builds the prompt and grounds against
  // it — and returns the label→documentId map so the client can show real titles.
  // validation.docLabels is the map the client echoed back from its last response in
  // this conversation (Milestone 11 Phase C) — assignDocLabels only appends labels
  // for documents not already in it, keeping "Doc N" frozen across turns.
  const docLabels = assignDocLabels(validation.chunks, validation.docLabels)
  const labelOf = new Map(docLabels.map((doc) => [doc.documentId, doc.label]))
  // Milestone 10 Phase B: only the 'shared' branch of ValidationResult even has an
  // `image` field (see validate.ts) — a BYOK request selecting Gemini as its own
  // provider still falls into the `default:` case below, but gets `image: undefined`
  // unconditionally here, never validation.image, so it can never carry one through.
  // Derived before buildPrompt so the prompt's own instructions can acknowledge the
  // image when one is attached — without that, "answer using ONLY the passages" reads
  // as an instruction to ignore it (see prompt.ts's doc comment for how this was found).
  const image = validation.keySource === 'shared' ? validation.image : undefined
  // Milestone 12 final scope: grounding is BYOK-gemini-only — the shared branch of
  // ValidationResult has no enableWebSearch field at all (see validate.ts), so this
  // is always false for a shared-tier request, never just unset.
  const enableWebSearch = validation.keySource === 'own' ? validation.enableWebSearch : false
  const prompt = buildPrompt(
    validation.question,
    validation.chunks,
    labelOf,
    validation.history,
    image !== undefined,
    enableWebSearch,
  )

  // BYOK: the key lives only in this local, request-scoped variable — passed straight
  // into the provider call and never assigned anywhere else (no env, no KV, no logging).
  const apiKey = validation.keySource === 'own' ? validation.apiKey : env.GEMINI_API_KEY
  const model = validation.keySource === 'own' ? validation.model : DEFAULT_SHARED_MODEL
  const provider = validation.keySource === 'own' ? validation.provider : 'gemini'

  try {
    let answer: string
    // Milestone 12 final scope: webGrounding can now only ever populate on a
    // BYOK-gemini request — enableWebSearch is unconditionally false for the shared
    // tier (derived above), so a shared-tier request always calls callGemini with
    // grounding off and this stays undefined. Every non-Gemini provider's call site
    // is untouched either way and stays a plain string return.
    let webGrounding: GeminiGroundingResult | undefined
    switch (provider) {
      case 'openai':
        answer = await callOpenAI(fetch, apiKey, model, prompt)
        break
      case 'anthropic':
        answer = await callAnthropic(fetch, apiKey, model, prompt)
        break
      case 'grok':
        answer = await callGrok(fetch, apiKey, model, prompt)
        break
      case 'openrouter':
        answer = await callOpenRouter(fetch, apiKey, model, prompt)
        break
      default: {
        const result = await callGemini(fetch, apiKey, model, prompt, image, enableWebSearch)
        answer = result.text
        webGrounding = result.grounding
      }
    }
    const providedPairs = validation.chunks.map((chunk) => ({
      // Non-null assertion is safe by invariant: assignDocLabels labels every distinct
      // documentId in these chunks, so every chunk's documentId is guaranteed in labelOf.
      label: labelOf.get(chunk.documentId)!,
      page: chunk.page,
    }))
    const grounding = checkGrounding(answer, providedPairs)
    return json(
      {
        answer,
        groundingWarning: grounding.groundingWarning,
        docLabels,
        // Milestone 12: real, structured citation data from Gemini's own grounding —
        // replaces the earlier (reverted) Brave-search-era fabricated "Web N" label
        // scheme entirely. Always an array (empty when grounding wasn't enabled, or
        // was enabled but Gemini chose not to search this turn); searchEntryPointHtml
        // is present only when Gemini actually searched — see gemini.ts's doc comment
        // on the ToS requirement to display it alongside any grounded result shown.
        webSources: webGrounding?.webSources ?? [],
        searchEntryPointHtml: webGrounding?.searchEntryPointHtml,
        // The provider and model this answer came from, so the client's receipt can name
        // the shared tier's model instead of guessing it. There's no fallback chain: the
        // switch above made exactly one call, with exactly this model. (A provider-side
        // router id such as OpenRouter's openrouter/auto is echoed as sent — the provider,
        // not us, picks the model behind it.)
        provider,
        model,
      },
      200,
      origin,
    )
  } catch (err) {
    const failure = classify(err, provider, model, validation.keySource)
    logProviderError(failure)
    notifyDiscordOfFailure(ctx, env, failure, 'answer')
    return failureResponse(failure, 'answer', origin)
  }
}

async function handleModels(
  request: Request,
  env: Env,
  origin: string | null,
  ip: string,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400, origin)
  }

  const validation = validateModelsRequest(body)
  if (!validation.ok) {
    return json({ error: validation.error }, 400, origin)
  }

  // Model listing only exists for BYOK, so it always shares the BYOK bucket — same
  // reasoning as /answer's BYOK path (abuse guard on our Worker, not quota protection).
  const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, ip, 'byok', BYOK_DAILY_LIMIT, kvErrorReporter(ctx, env))
  if (!rateLimit.allowed) {
    return json({ error: RATE_LIMIT_MESSAGE, resetAt: rateLimit.resetAt }, 429, origin)
  }

  try {
    // validation.apiKey lives only in this local, request-scoped variable — passed
    // straight into the provider's model-list call and never assigned anywhere else.
    let models: { id: string; displayName: string }[]
    switch (validation.provider) {
      case 'openai':
        models = await listOpenAIModels(fetch, validation.apiKey)
        break
      case 'anthropic':
        models = await listAnthropicModels(fetch, validation.apiKey)
        break
      case 'grok':
        models = await listGrokModels(fetch, validation.apiKey)
        break
      case 'openrouter':
        models = await listOpenRouterModels(fetch, validation.apiKey)
        break
      default:
        models = await listGeminiModels(fetch, validation.apiKey)
    }
    return json({ models }, 200, origin)
  } catch (err) {
    const failure = classify(err, validation.provider, null, 'own')
    logProviderError(failure)
    notifyDiscordOfFailure(ctx, env, failure, 'models')
    return failureResponse(failure, 'models', origin)
  }
}

async function handleOcr(
  request: Request,
  env: Env,
  origin: string | null,
  ip: string,
  country: unknown,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400, origin)
  }

  const validation = validateOcrRequest(body)
  if (!validation.ok) {
    return json({ error: validation.error }, 400, origin)
  }

  // /ocr always runs on the shared key.
  if (isRegionRestricted(country)) {
    return regionRestrictedResponse(OCR_REGION_RESTRICTED_MESSAGE, origin)
  }

  // OCR has its own bucket (separate from 'shared' and 'byok') — a materially heavier
  // request than /answer, so it gets its own, lower daily limit (see rateLimit.ts).
  const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, ip, 'ocr', OCR_DAILY_LIMIT, kvErrorReporter(ctx, env))
  if (!rateLimit.allowed) {
    return json({ error: RATE_LIMIT_MESSAGE, resetAt: rateLimit.resetAt }, 429, origin)
  }

  try {
    const text = await transcribeImage(fetch, env.GEMINI_API_KEY, DEFAULT_SHARED_MODEL, {
      mimeType: validation.mimeType,
      base64: validation.base64,
    })
    return json({ text }, 200, origin)
  } catch (err) {
    const status = err instanceof ProviderError ? String(err.status) : null
    logOcrFailure(status)
    notifyDiscordOfOcrFailure(ctx, env, status)
    return json({ error: OCR_UNAVAILABLE_MESSAGE }, 502, origin)
  }
}

async function route(request: Request, env: Env, ctx: ExecutionContext, origin: string | null): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders(origin) })
  }

  const url = new URL(request.url)
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
  // Absent in local dev and in tests that don't set it — isRegionRestricted allows that.
  const country = request.cf?.country

  if (request.method === 'POST' && url.pathname === '/answer') {
    return handleAnswer(request, env, origin, ip, country, ctx)
  }
  if (request.method === 'POST' && url.pathname === '/models') {
    return handleModels(request, env, origin, ip, ctx)
  }
  if (request.method === 'POST' && url.pathname === '/ocr') {
    return handleOcr(request, env, origin, ip, country, ctx)
  }
  return json({ error: 'Not found.' }, 404, origin)
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const origin = resolveCorsOrigin(request.headers.get('Origin'), env.PAGES_ORIGIN)
    // Safety net: nothing uncaught may reach the browser as the runtime's CORS-less 500
    // (it reads as a network error). Fixed copy, no error text; the log line carries no
    // message either, since an error can quote a request body or a key.
    try {
      return await route(request, env, ctx, origin)
    } catch {
      console.error(JSON.stringify({ event: 'worker_unhandled_error' }))
      return json({ error: SERVER_ERROR_MESSAGE }, 500, origin)
    }
  },
} satisfies ExportedHandler<Env>
