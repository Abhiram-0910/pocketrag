export interface InputChunk {
  text: string
  page: number
  score: number
  // Opaque per-document id (a client-generated UUID). Used only to group chunks by
  // document for "Doc N" labelling and grounding — never placed in the prompt.
  documentId: string
}

export type KeySource = 'shared' | 'own'

export const SUPPORTED_PROVIDERS = ['gemini', 'openai', 'anthropic'] as const
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

export interface AnswerRequestBody {
  question: string
  chunks: InputChunk[]
  // Missing keySource means an older client (or the shared/free-tier UI, which never
  // sends it) — defaults to 'shared' rather than being required, so this stays backward
  // compatible with a frontend deployed slightly before or after this Worker.
  keySource?: KeySource
  apiKey?: string
  provider?: SupportedProvider
  model?: string
}

export type ValidationResult =
  | { ok: true; question: string; chunks: InputChunk[]; keySource: 'shared' }
  | {
      ok: true
      question: string
      chunks: InputChunk[]
      keySource: 'own'
      apiKey: string
      provider: SupportedProvider
      model: string
    }
  | { ok: false; error: string }

// Server-side caps — the frontend only ever sends 3 short chunks, but the
// client can't be trusted to keep it that way (bug, tampering, or abuse).
export const MAX_CHUNKS = 5
export const MAX_CHUNK_TEXT_LENGTH = 2000
export const MAX_QUESTION_LENGTH = 500
// documentId must round-trip back to the client to resolve titles, so reject an
// oversized one rather than truncating it (a legit client sends a 36-char UUID).
export const MAX_DOCUMENT_ID_LENGTH = 128
// A real key is well under 100 chars for every provider on the roadmap; capped well
// above that so we reject junk payload size, never truncate — a truncated key is just
// a different wrong key, so silently accepting a cut one would be worse than clearly
// rejecting an oversized one.
export const MAX_API_KEY_LENGTH = 200
export const MAX_MODEL_LENGTH = 128

function isValidChunk(value: unknown): value is InputChunk {
  if (typeof value !== 'object' || value === null) return false
  const chunk = value as Record<string, unknown>
  return (
    typeof chunk.text === 'string' &&
    typeof chunk.page === 'number' &&
    typeof chunk.score === 'number' &&
    typeof chunk.documentId === 'string' &&
    chunk.documentId.length > 0 &&
    chunk.documentId.length <= MAX_DOCUMENT_ID_LENGTH
  )
}

export function validateAnswerRequest(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const { question, chunks, keySource, apiKey, provider, model } = body as Record<string, unknown>

  if (typeof question !== 'string' || question.trim().length === 0) {
    return { ok: false, error: 'question must be a non-empty string.' }
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return { ok: false, error: `question must be ${MAX_QUESTION_LENGTH} characters or fewer.` }
  }
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { ok: false, error: 'chunks must be a non-empty array.' }
  }

  const capped = chunks.slice(0, MAX_CHUNKS)
  const validatedChunks: InputChunk[] = []
  for (const chunk of capped) {
    if (!isValidChunk(chunk)) {
      return {
        ok: false,
        error: 'Each chunk must have text (string), page (number), score (number), and documentId (string).',
      }
    }
    validatedChunks.push({ ...chunk, text: chunk.text.slice(0, MAX_CHUNK_TEXT_LENGTH) })
  }

  const trimmedQuestion = question.trim()
  const resolvedKeySource = keySource ?? 'shared'
  if (resolvedKeySource !== 'shared' && resolvedKeySource !== 'own') {
    return { ok: false, error: 'keySource must be "shared" or "own".' }
  }

  if (resolvedKeySource === 'shared') {
    return { ok: true, question: trimmedQuestion, chunks: validatedChunks, keySource: 'shared' }
  }

  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH) {
    return { ok: false, error: `apiKey must be a non-empty string of ${MAX_API_KEY_LENGTH} characters or fewer.` }
  }
  if (typeof provider !== 'string' || !SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
    return { ok: false, error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}.` }
  }
  if (typeof model !== 'string' || model.length === 0 || model.length > MAX_MODEL_LENGTH) {
    return { ok: false, error: `model must be a non-empty string of ${MAX_MODEL_LENGTH} characters or fewer.` }
  }

  return {
    ok: true,
    question: trimmedQuestion,
    chunks: validatedChunks,
    keySource: 'own',
    apiKey,
    provider: provider as SupportedProvider,
    model,
  }
}

export interface ModelsRequestBody {
  provider: SupportedProvider
  apiKey: string
}

export type ModelsValidationResult =
  | { ok: true; provider: SupportedProvider; apiKey: string }
  | { ok: false; error: string }

export function validateModelsRequest(body: unknown): ModelsValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const { provider, apiKey } = body as Record<string, unknown>

  if (typeof provider !== 'string' || !SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
    return { ok: false, error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}.` }
  }
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > MAX_API_KEY_LENGTH) {
    return { ok: false, error: `apiKey must be a non-empty string of ${MAX_API_KEY_LENGTH} characters or fewer.` }
  }

  return { ok: true, provider: provider as SupportedProvider, apiKey }
}
