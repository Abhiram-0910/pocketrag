export interface InputChunk {
  text: string
  page: number
  score: number
  // Opaque per-document id (a client-generated UUID). Used only to group chunks by
  // document for "Doc N" labelling and grounding — never placed in the prompt.
  documentId: string
}

export interface DocLabel {
  label: number
  documentId: string
}

// A prior turn's {question, answer} pair, interpolated into the prompt as
// conversation context only (Milestone 11 Phase C2) — never used for retrieval,
// which is a separate client-side-only blended query string (see conversation.ts)
// that never crosses the wire.
export interface HistoryTurn {
  question: string
  answer: string
}

export type KeySource = 'shared' | 'own'

export const SUPPORTED_PROVIDERS = ['gemini', 'openai', 'anthropic', 'grok', 'openrouter'] as const
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
  // The label→documentId map the client last received from this same conversation
  // (Milestone 11 Phase C) — echoed back so assignDocLabels can keep "Doc N" frozen
  // instead of recomputing it fresh every request. Missing/absent means a fresh
  // conversation (or an older client that predates this field).
  docLabels?: DocLabel[]
  // Capped list of recent {question, answer} pairs from this conversation
  // (Milestone 11 Phase C2), interpolated into the prompt as context only. Missing/
  // absent means a fresh conversation or an older client that predates this field.
  history?: HistoryTurn[]
}

export type ValidationResult =
  | {
      ok: true
      question: string
      chunks: InputChunk[]
      keySource: 'shared'
      docLabels: DocLabel[]
      history: HistoryTurn[]
    }
  | {
      ok: true
      question: string
      chunks: InputChunk[]
      keySource: 'own'
      apiKey: string
      provider: SupportedProvider
      model: string
      docLabels: DocLabel[]
      history: HistoryTurn[]
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
// A conversation realistically cites a handful of distinct documents, not dozens —
// generous enough for real multi-doc use, small enough to bound the label lookup.
export const MAX_DOC_LABELS = 20
// A handful of recent turns is enough for follow-up context without letting the
// prompt grow unbounded over a long-lived conversation.
export const MAX_HISTORY_TURNS = 3
// Reuses MAX_QUESTION_LENGTH for the history question field (same shape as a live
// question); a generated answer tends to run longer, so it gets its own cap.
export const MAX_HISTORY_ANSWER_LENGTH = 1000

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

function isValidDocLabel(value: unknown): value is DocLabel {
  if (typeof value !== 'object' || value === null) return false
  const label = value as Record<string, unknown>
  return (
    typeof label.label === 'number' &&
    Number.isInteger(label.label) &&
    label.label >= 1 &&
    label.label <= MAX_DOC_LABELS &&
    typeof label.documentId === 'string' &&
    label.documentId.length > 0 &&
    label.documentId.length <= MAX_DOCUMENT_ID_LENGTH
  )
}

function isValidHistoryTurn(value: unknown): value is HistoryTurn {
  if (typeof value !== 'object' || value === null) return false
  const turn = value as Record<string, unknown>
  return typeof turn.question === 'string' && typeof turn.answer === 'string'
}

// A legitimate client only ever echoes back a docLabels map exactly as this same
// Worker last returned it — well-formed by construction. A duplicate documentId or
// label number means the map was corrupted (bug, tampering, or a stale/mixed-up
// client state), so fail closed rather than guess which entry to keep.
function hasDuplicateDocLabels(labels: DocLabel[]): boolean {
  const documentIds = new Set(labels.map((l) => l.documentId))
  const labelNumbers = new Set(labels.map((l) => l.label))
  return documentIds.size !== labels.length || labelNumbers.size !== labels.length
}

export function validateAnswerRequest(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const { question, chunks, keySource, apiKey, provider, model, docLabels, history } = body as Record<string, unknown>

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

  const validatedDocLabels: DocLabel[] = []
  if (docLabels !== undefined) {
    if (!Array.isArray(docLabels)) {
      return { ok: false, error: 'docLabels must be an array.' }
    }
    const cappedLabels = docLabels.slice(0, MAX_DOC_LABELS)
    for (const label of cappedLabels) {
      if (!isValidDocLabel(label)) {
        return { ok: false, error: 'Each docLabels entry must have label (integer) and documentId (string).' }
      }
      validatedDocLabels.push(label)
    }
    if (hasDuplicateDocLabels(validatedDocLabels)) {
      return { ok: false, error: 'docLabels must not contain duplicate label or documentId values.' }
    }
  }

  // history is content the app itself already produced/received (a prior question the
  // user asked and the answer this same Worker returned) rather than fresh attacker-
  // controlled payload, so oversized fields are truncated, not rejected — same reasoning
  // as chunk text.
  const validatedHistory: HistoryTurn[] = []
  if (history !== undefined) {
    if (!Array.isArray(history)) {
      return { ok: false, error: 'history must be an array.' }
    }
    const cappedHistory = history.slice(0, MAX_HISTORY_TURNS)
    for (const turn of cappedHistory) {
      if (!isValidHistoryTurn(turn)) {
        return { ok: false, error: 'Each history entry must have question (string) and answer (string).' }
      }
      validatedHistory.push({
        question: turn.question.slice(0, MAX_QUESTION_LENGTH),
        answer: turn.answer.slice(0, MAX_HISTORY_ANSWER_LENGTH),
      })
    }
  }

  const trimmedQuestion = question.trim()
  const resolvedKeySource = keySource ?? 'shared'
  if (resolvedKeySource !== 'shared' && resolvedKeySource !== 'own') {
    return { ok: false, error: 'keySource must be "shared" or "own".' }
  }

  if (resolvedKeySource === 'shared') {
    return {
      ok: true,
      question: trimmedQuestion,
      chunks: validatedChunks,
      keySource: 'shared',
      docLabels: validatedDocLabels,
      history: validatedHistory,
    }
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
    docLabels: validatedDocLabels,
    history: validatedHistory,
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
