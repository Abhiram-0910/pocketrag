import { providerError } from './errors'

// gemini-2.5-flash-lite (named in the original spec) returns 404 "no longer
// available to new users" for this API key — pinned to 3.5 instead, deliberately,
// not via the floating `gemini-flash-lite-latest` alias. Confirmed working 2026-07-25.
export const DEFAULT_SHARED_MODEL = 'gemini-3.5-flash-lite'

export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// Milestone 12 (Gemini-native grounding): only the fields this file actually reads are
// typed, matching GeminiGenerateResponse's existing convention below — the real
// response carries more (webSearchQueries, groundingSupports, etc.) this project
// doesn't use yet. Field names and nesting confirmed against ai.google.dev/gemini-api/
// docs/generate-content/google-search (the Legacy generateContent docs, fetched
// 2026-08-21): groundingChunks[].web carries {uri, title}; searchEntryPoint.
// renderedContent is the HTML/CSS "Search Suggestions" widget Google's Grounding ToS
// (ai.google.dev/gemini-api/terms#grounding-with-google-search) requires displaying
// alongside grounded results shown to an end user, with no free/paid tier distinction.
interface GeminiGroundingMetadata {
  searchEntryPoint?: { renderedContent?: string }
  groundingChunks?: { web?: { uri?: string; title?: string } }[]
}

interface GeminiGenerateResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: GeminiGroundingMetadata }[]
}

export interface GeminiImageInput {
  mimeType: string
  base64: string
}

// Milestone 12: the real, structured source list from Gemini's own grounding —
// replaces the earlier (reverted) Brave-search-era fabricated "Web N" label scheme
// entirely. webSources is always an array (empty when grounding was enabled but
// Gemini chose not to search this turn, or wasn't enabled at all); searchEntryPointHtml
// is present only when Gemini actually searched, since that's the only time Google's
// widget content exists to show.
export interface GeminiGroundingResult {
  webSources: { uri: string; title: string }[]
  searchEntryPointHtml?: string
}

// Defensive circuit-breaker, not an empirically measured bound like MAX_IMAGE_BASE64_LENGTH
// (no sample response to measure against) — the real widget is a small HTML/CSS chip set,
// so this only ever fires against a degenerate/oversized response. Client-side sanitization
// (sanitizeGroundingHtml) is what actually neutralizes malicious content; this just bounds
// how much of it can ever reach the client at all. Worker-to-client, so this lives here
// rather than in validate.ts, which only shapes client-to-Worker input.
const MAX_SEARCH_ENTRY_POINT_HTML_LENGTH = 50_000

// A malformed groundingChunks entry (missing uri or title) is filtered out rather than
// thrown on — same defensive stance every other response-parsing function in this file
// already takes toward a provider's response shape.
function extractGrounding(metadata: GeminiGroundingMetadata | undefined): GeminiGroundingResult | undefined {
  if (!metadata) return undefined
  const webSources = (metadata.groundingChunks ?? [])
    .map((chunk) => chunk.web)
    .filter((web): web is { uri: string; title: string } => typeof web?.uri === 'string' && typeof web?.title === 'string')
  const searchEntryPointHtml = metadata.searchEntryPoint?.renderedContent?.slice(0, MAX_SEARCH_ENTRY_POINT_HTML_LENGTH)
  if (webSources.length === 0 && searchEntryPointHtml === undefined) return undefined
  return { webSources, searchEntryPointHtml }
}

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } }

interface GenerateContentResult {
  text: string
  grounding?: GeminiGroundingResult
}

/**
 * Shared POST to Gemini's generateContent endpoint — callGemini (answer composition),
 * transcribeImage (Milestone 9 OCR), both send a `parts` array and read back the first
 * candidate's text; only the parts/prompt/grounding differ between them. The key goes
 * in the `x-goog-api-key` header, never the URL — URLs are far more likely to end up in
 * some layer's access logs than headers are, and this key may be a user's own (BYOK),
 * not just ours.
 *
 * `enableGrounding` (Milestone 12) appends `tools: [{"google_search": {}}]` to the
 * request body — snake_case in the raw JSON, confirmed against the Legacy
 * generateContent REST example (the SDK docs show camelCase `googleSearch`, but that's
 * SDK-side translation; this file talks to the raw REST endpoint directly, same as
 * every other request it sends). The docs confirm this is compatible with an arbitrary,
 * non-trivial prompt in `contents` — Google explicitly documents combining grounding
 * with the more invasive case of custom function-calling tools, so there's no
 * documented restriction on prompt complexity. Still flagged for live verification
 * against this project's actual multi-passage prompt shape before being called done
 * (see AGENTS.md's session note) — the docs' own example is a bare one-line question,
 * not proof of this app's specific case.
 */
async function generateContent(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  parts: GeminiPart[],
  emptyResponseMessage: string,
  enableGrounding: boolean = false,
): Promise<GenerateContentResult> {
  const response = await fetchImpl(`${API_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      ...(enableGrounding ? { tools: [{ google_search: {} }] } : {}),
    }),
  })

  if (!response.ok) {
    // Echo guard covers the text parts only — the prompt (and, for OCR, the fixed
    // OCR_PROMPT). An image's base64 isn't matched, but /ocr never logs the message.
    const promptText = parts.map((p) => ('text' in p ? p.text : '')).join('\n')
    throw await providerError('Gemini', response, apiKey, promptText)
  }

  const data = (await response.json()) as GeminiGenerateResponse
  const candidate = data.candidates?.[0]
  const text = candidate?.content?.parts?.[0]?.text
  if (!text) throw new Error(emptyResponseMessage)
  return { text, grounding: extractGrounding(candidate?.groundingMetadata) }
}

/**
 * Calls Gemini's generateContent endpoint for answer composition. `image` (Milestone
 * 10 Phase B) is optional and additive to the existing `parts` array — `contents[].parts`
 * already supported mixing `inlineData` alongside `text`, so this isn't a new request
 * shape. Only ever passed by index.ts for a validated shared-tier request; never for
 * BYOK, even when the BYOK provider is also Gemini.
 *
 * `enableWebSearch` (Milestone 12) is Gemini-specific — available to shared-tier
 * requests (always Gemini) and to BYOK requests that specifically chose Gemini as
 * their own provider (their own key, their own grounding cost), never to any other
 * BYOK provider. See validate.ts for the type-level enforcement of that restriction.
 */
export async function callGemini(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  prompt: string,
  image?: GeminiImageInput,
  enableWebSearch: boolean = false,
): Promise<GenerateContentResult> {
  const parts: GeminiPart[] = [{ text: prompt }]
  if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } })
  return generateContent(fetchImpl, apiKey, model, parts, 'Gemini response did not contain any answer text.', enableWebSearch)
}

// Deliberately instructs verbatim transcription, not summarization or correction — an
// LLM-based OCR path can otherwise "fix" spelling/grammar or paraphrase, which a real
// OCR engine wouldn't do. [illegible] gives the model an explicit way to signal
// uncertainty instead of guessing at unreadable text. Says "file", not "image" — Phase
// B (Milestone 9) sends multi-page PDFs through this same prompt, and "image" would be
// a real inaccuracy in the model's own instructions, not just cosmetic.
const OCR_PROMPT =
  'Transcribe all text in this file exactly as written. Do not correct spelling, grammar, or ' +
  'punctuation. Do not summarize, paraphrase, or add commentary of your own. If any text is ' +
  'illegible, write [illegible] in its place. Output only the transcribed text, nothing else.'

/**
 * OCRs a single image or PDF via Gemini vision/document understanding (Milestone 9,
 * Phase A images + Phase B multi-page PDFs) — reuses the same generateContent request
 * shape as callGemini's image attachment, just with a transcription-only prompt and no
 * retrieved-chunk context. Shared-tier only: index.ts never has an apiKey to pass here
 * other than env.GEMINI_API_KEY (see validate.ts's OcrRequestBody, which has no
 * keySource/apiKey field to begin with). Never grounded — OCR has no question to
 * answer, just a file to transcribe verbatim.
 */
export async function transcribeImage(
  fetchImpl: typeof fetch,
  apiKey: string,
  model: string,
  image: GeminiImageInput,
): Promise<string> {
  const parts: GeminiPart[] = [{ text: OCR_PROMPT }, { inlineData: { mimeType: image.mimeType, data: image.base64 } }]
  const { text } = await generateContent(fetchImpl, apiKey, model, parts, 'Gemini response did not contain any transcribed text.')
  return text
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

  if (!response.ok) throw await providerError('Gemini', response, apiKey)

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
