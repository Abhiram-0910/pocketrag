import { validateAnswerRequest } from './validate'
import { buildPrompt } from './prompt'
import { checkGrounding } from './grounding'
import { checkRateLimit } from './rateLimit'
import { callGemini } from './gemini'
import { corsHeaders, resolveCorsOrigin } from './cors'

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  })
}

export default {
  async fetch(request, env): Promise<Response> {
    const origin = resolveCorsOrigin(request.headers.get('Origin'), env.PAGES_ORIGIN)

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) })
    }

    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/answer') {
      return json({ error: 'Not found.' }, 404, origin)
    }

    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'
    const rateLimit = await checkRateLimit(env.RATE_LIMIT_KV, ip)
    if (!rateLimit.allowed) {
      return json({ error: "You've hit today's question limit. Please try again tomorrow." }, 429, origin)
    }

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

    const prompt = buildPrompt(validation.question, validation.chunks)

    try {
      const answer = await callGemini(fetch, env.GEMINI_API_KEY, prompt)
      const grounding = checkGrounding(
        answer,
        validation.chunks.map((chunk) => chunk.page),
      )
      return json({ answer, groundingWarning: grounding.groundingWarning }, 200, origin)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Failed to generate an answer.' }, 502, origin)
    }
  },
} satisfies ExportedHandler<Env>
