import { validateAnswerRequest, validateModelsRequest } from './validate'
import { buildPrompt } from './prompt'
import { checkGrounding } from './grounding'
import { assignDocLabels } from './labels'
import { checkRateLimit, BYOK_DAILY_LIMIT } from './rateLimit'
import { callGemini, listGeminiModels, DEFAULT_SHARED_MODEL } from './providers/gemini'
import { callOpenAI, listOpenAIModels } from './providers/openai'
import { callAnthropic, listAnthropicModels } from './providers/anthropic'
import { callGrok, listGrokModels } from './providers/grok'
import { callOpenRouter, listOpenRouterModels } from './providers/openrouter'
import { corsHeaders, resolveCorsOrigin } from './cors'
import { sendDiscordAlert, shouldNotify, type DiscordEndpoint } from './discord'

const RATE_LIMIT_MESSAGE = "You've hit today's request limit. Please try again tomorrow."
// Sanitized client-facing messages for a provider-call failure — the real reason (raw
// provider error text, which could be a confusing or unexpected third-party string)
// goes to logProviderError below instead, never straight to the client.
const ANSWER_UNAVAILABLE_MESSAGE =
  "This provider isn't fully supported yet. Please try Gemini or OpenAI for now — we're working on it."
const MODELS_UNAVAILABLE_MESSAGE =
  "This provider's model list isn't available yet. Please try Gemini or OpenAI for now — we're working on it."

// `status` is pulled from the "<Provider> API error <status>: <body>" shape every
// provider file already throws, rather than adding a custom error class. Shared by
// logProviderError and the Discord notifier below so both read the same extraction.
function extractFailureDetails(err: unknown): { status: string | null; message: string } {
  const message = err instanceof Error ? err.message : 'unknown error'
  const status = message.match(/error (\d{3}):/)?.[1] ?? null
  return { status, message }
}

/**
 * Structured, key-free failure log for a provider call — lands in Cloudflare Workers
 * Logs automatically, no new infra. `err.message` is already proven key-free by each
 * provider's own two key-leak tests, but this call site gets its own dedicated test
 * too (see index.test.ts) since it's a new place that could regress independently of
 * those.
 */
function logProviderError(provider: string, model: string | null, err: unknown): void {
  const { status, message } = extractFailureDetails(err)
  console.error(JSON.stringify({ event: 'provider_call_failed', provider, model, status, message }))
}

// Fire-and-forget Discord alert, suppressed to one per (provider, endpoint) per
// suppression window (see discord.ts — /answer and /models are tracked independently
// since they can fail independently). Inert (no KV read, no fetch) when the secret
// isn't set, so this is safe to deploy before DISCORD_WEBHOOK_URL exists. Registered
// via ctx.waitUntil so the Workers runtime doesn't tear it down after the response is
// sent — sendDiscordAlert itself never throws, so this never surfaces to the caller.
function notifyDiscordOfFailure(
  ctx: ExecutionContext,
  env: Env,
  provider: string,
  model: string | null,
  err: unknown,
  endpoint: DiscordEndpoint,
): void {
  if (!env.DISCORD_WEBHOOK_URL) return
  const { status, message } = extractFailureDetails(err)
  ctx.waitUntil(
    shouldNotify(env.RATE_LIMIT_KV, provider, endpoint).then((notify) =>
      notify ? sendDiscordAlert(fetch, env.DISCORD_WEBHOOK_URL, { provider, model, status, message }) : undefined,
    ),
  )
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

  // Shared and BYOK requests from the same IP track independent quotas: BYOK doesn't
  // touch our Gemini quota, and a BYOK user's own traffic shouldn't burn the shared-tier
  // limit for others behind the same IP (or vice versa).
  const rateLimit =
    validation.keySource === 'own'
      ? await checkRateLimit(env.RATE_LIMIT_KV, ip, 'byok', BYOK_DAILY_LIMIT)
      : await checkRateLimit(env.RATE_LIMIT_KV, ip, 'shared')
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
  const prompt = buildPrompt(validation.question, validation.chunks, labelOf)

  // BYOK: the key lives only in this local, request-scoped variable — passed straight
  // into the provider call and never assigned anywhere else (no env, no KV, no logging).
  const apiKey = validation.keySource === 'own' ? validation.apiKey : env.GEMINI_API_KEY
  const model = validation.keySource === 'own' ? validation.model : DEFAULT_SHARED_MODEL
  const provider = validation.keySource === 'own' ? validation.provider : 'gemini'

  try {
    let answer: string
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
      default:
        answer = await callGemini(fetch, apiKey, model, prompt)
    }
    const providedPairs = validation.chunks.map((chunk) => ({
      // Non-null assertion is safe by invariant: assignDocLabels labels every distinct
      // documentId in these chunks, so every chunk's documentId is guaranteed in labelOf.
      label: labelOf.get(chunk.documentId)!,
      page: chunk.page,
    }))
    const grounding = checkGrounding(answer, providedPairs)
    return json({ answer, groundingWarning: grounding.groundingWarning, docLabels }, 200, origin)
  } catch (err) {
    logProviderError(provider, model, err)
    notifyDiscordOfFailure(ctx, env, provider, model, err, 'answer')
    return json({ error: ANSWER_UNAVAILABLE_MESSAGE }, 502, origin)
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
  const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, ip, 'byok', BYOK_DAILY_LIMIT)
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
    logProviderError(validation.provider, null, err)
    notifyDiscordOfFailure(ctx, env, validation.provider, null, err, 'models')
    return json({ error: MODELS_UNAVAILABLE_MESSAGE }, 502, origin)
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const origin = resolveCorsOrigin(request.headers.get('Origin'), env.PAGES_ORIGIN)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) })
    }

    const url = new URL(request.url)
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

    if (request.method === 'POST' && url.pathname === '/answer') {
      return handleAnswer(request, env, origin, ip, ctx)
    }
    if (request.method === 'POST' && url.pathname === '/models') {
      return handleModels(request, env, origin, ip, ctx)
    }
    return json({ error: 'Not found.' }, 404, origin)
  },
} satisfies ExportedHandler<Env>
