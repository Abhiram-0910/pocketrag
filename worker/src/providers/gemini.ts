// gemini-2.5-flash-lite (named in the original spec) returns 404 "no longer
// available to new users" for this API key — pinned to 3.5 instead, deliberately,
// not via the floating `gemini-flash-lite-latest` alias. Confirmed working 2026-07-25.
export const DEFAULT_SHARED_MODEL = 'gemini-3.5-flash-lite'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

export interface GeminiImageInput {
  mimeType: string
  base64: string
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

/**
 * Shared POST to Gemini's generateContent endpoint — both callGemini (answer
 * composition) and transcribeImage (Milestone 9 OCR) send a `parts` array and read
 * back the first candidate's text; only the parts/prompt differ between them. The key
 * goes in the `x-goog-api-key` header, never the URL — URLs are far more likely to end
 * up in some layer's access logs than headers are, and this key may be a user's own
 * (BYOK), not just ours.
 */
async function generateContent(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  emptyResponseMessage: string,
): Promise<string> {
  const response = await fetchImpl(`${API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
    }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as GeminiGenerateResponse
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) throw new Error(emptyResponseMessage)
  return text
}

/**
 * Calls Gemini's generateContent endpoint for answer composition. `image` (Milestone
 * 10 Phase B) is optional and additive to the existing `parts` array — `contents[].parts`
 * already supported mixing `inlineData` alongside `text`, so this isn't a new request
 * shape. Only ever passed by index.ts for a validated shared-tier request; never for
 * BYOK, even when the BYOK provider is also Gemini.
 */
export async function callGemini(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  prompt: string,
  image?: GeminiImageInput,
): Promise<string> {
  const parts: GeminiPart[] = [{ text: prompt }]
  if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } })
  return generateContent(fetchImpl, apiKey, model, parts, 'Gemini response did not contain any answer text.')
}

// Deliberately instructs verbatim transcription, not summarization or correction — an
// LLM-based OCR path can otherwise "fix" spelling/grammar or paraphrase, which a real
// OCR engine wouldn't do. [illegible] gives the model an explicit way to signal
// uncertainty instead of guessing at unreadable text.
const OCR_PROMPT =
  'Transcribe all text in this image exactly as written. Do not correct spelling, grammar, or ' +
  'punctuation. Do not summarize, paraphrase, or add commentary of your own. If any text is ' +
  'illegible, write [illegible] in its place. Output only the transcribed text, nothing else.'

/**
 * OCRs a single image via Gemini vision (Milestone 9, Phase A) — reuses the same
 * generateContent request shape as callGemini's image attachment, just with a
 * transcription-only prompt and no retrieved-chunk context. Shared-tier only: index.ts
 * never has an apiKey to pass here other than env.GEMINI_API_KEY (see validate.ts's
 * OcrRequestBody, which has no keySource/apiKey field to begin with).
 */
export async function transcribeImage(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  image: GeminiImageInput,
): Promise<string> {
  const parts: GeminiPart[] = [{ text: OCR_PROMPT }, { inlineData: { mimeType: image.mimeType, data: image.base64 } }]
  return generateContent(fetchImpl, apiKey, model, parts, 'Gemini response did not contain any transcribed text.')
}

export interface ModelInfo {
  id: string
  displayName: string
}

interface GeminiModelsListResponse {
  models?: { name?: string; displayName?: string; supportedGenerationMethods?: string[] }[]
}

/**
 * Lists Gemini models that support generateContent (excludes embedding-only models,
 * etc.), stripping the "models/" prefix Gemini's API puts on `name` so the returned id
 * is exactly what `callGemini`'s `model` argument expects.
 */
export async function listGeminiModels(fetchImpl: typeof fetch, apiKey: string): Promise<ModelInfo[]> {
  const response = await fetchImpl(`${API_BASE}/models`, {
    method: 'GET',
    headers: { 'x-goog-api-key': apiKey },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Gemini API error ${response.status}: ${body}`)
  }

  const data = (await response.json()) as GeminiModelsListResponse
  return (data.models ?? [])
    .filter(
      (model): model is { name: string; displayName?: string; supportedGenerationMethods: string[] } =>
        typeof model.name === 'string' && (model.supportedGenerationMethods?.includes('generateContent') ?? false),
    )
    .map((model) => {
      const id = model.name.replace(/^models\//, '')
      return { id, displayName: model.displayName ?? id }
    })
}
