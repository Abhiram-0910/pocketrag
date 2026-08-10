import { validateAnswerRequest, validateModelsRequest } from './validate'
import { buildPrompt } from './prompt'
import { checkGrounding } from './grounding'
import { assignDocLabels } from './labels'
import { checkRateLimit, BYOK_DAILY_LIMIT } from './rateLimit'
import { callGemini, listGeminiModels, DEFAULT_SHARED_MODEL } from './providers/gemini'
import { callOpenAI, listOpenAIModels } from './providers/openai'
import { corsHeaders, resolveCorsOrigin } from './cors'

const RATE_LIMIT_MESSAGE = "You've hit today's request limit. Please try again tomorrow."

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  })
}

async function handleAnswer(request: Request, env: Env, origin: string | null, ip: string): Promise<Response> {
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
    return json({ error: RATE_LIMIT_MESSAGE }, 429, origin)
  }

  // The Worker owns the Doc N labelling — it builds the prompt and grounds against
  // it — and returns the label→documentId map so the client can show real titles.
  const docLabels = assignDocLabels(validation.chunks)
  const labelOf = new Map(docLabels.map((doc) => [doc.documentId, doc.label]))
  const prompt = buildPrompt(validation.question, validation.chunks, labelOf)

  // BYOK: the key lives only in this local, request-scoped variable — passed straight
  // into the provider call and never assigned anywhere else (no env, no KV, no logging).
  const apiKey = validation.keySource === 'own' ? validation.apiKey : env.GEMINI_API_KEY
  const model = validation.keySource === 'own' ? validation.model : DEFAULT_SHARED_MODEL
  const provider = validation.keySource === 'own' ? validation.provider : 'gemini'

  try {
    const answer =
      provider === 'openai'
        ? await callOpenAI(fetch, apiKey, model, prompt)
        : await callGemini(fetch, apiKey, model, prompt)
    const providedPairs = validation.chunks.map((chunk) => ({
      // Non-null assertion is safe by invariant: assignDocLabels labels every distinct
      // documentId in these chunks, so every chunk's documentId is guaranteed in labelOf.
      label: labelOf.get(chunk.documentId)!,
      page: chunk.page,
    }))
    const grounding = checkGrounding(answer, providedPairs)
    return json({ answer, groundingWarning: grounding.groundingWarning, docLabels }, 200, origin)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Failed to generate an answer.' }, 502, origin)
  }
}

async function handleModels(request: Request, env: Env, origin: string | null, ip: string): Promise<Response> {
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
    return json({ error: RATE_LIMIT_MESSAGE }, 429, origin)
  }

  try {
    // validation.apiKey lives only in this local, request-scoped variable — passed
    // straight into the provider's model-list call and never assigned anywhere else.
    const models =
      validation.provider === 'openai'
        ? await listOpenAIModels(fetch, validation.apiKey)
        : await listGeminiModels(fetch, validation.apiKey)
    return json({ models }, 200, origin)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Failed to fetch the model list.' }, 502, origin)
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const origin = resolveCorsOrigin(request.headers.get('Origin'), env.PAGES_ORIGIN)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) })
    }

    const url = new URL(request.url)
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'

    if (request.method === 'POST' && url.pathname === '/answer') {
      return handleAnswer(request, env, origin, ip)
    }
    if (request.method === 'POST' && url.pathname === '/models') {
      return handleModels(request, env, origin, ip)
    }
    return json({ error: 'Not found.' }, 404, origin)
  },
} satisfies ExportedHandler<Env>
