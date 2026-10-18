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

// Milestone 10 Phase B: at most one page image per request, only ever produced by
// src/lib/pageRender.ts client-side (always JPEG, always base64) — never per-chunk,
// since only one page is ever rendered per query regardless of how many chunks matched.
export interface ImageAttachment {
  mimeType: string
  base64: string
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
// Must match ByokPanel.tsx's EXPERIMENTAL_PROVIDERS (enforced by a frontend test) —
// these keep the "isn't fully supported yet" copy for unclassified failures and alert
// Discord on request_rejected, since a rejection there may be our request shape.
export const EXPERIMENTAL_PROVIDERS: readonly SupportedProvider[] = ['anthropic', 'grok', 'openrouter']

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
  // Milestone 10 Phase B: an optional page image, only ever accepted for the shared
  // tier (keySource 'shared') — rejected outright if present alongside 'own', not
  // silently dropped. See the plan's provider-support table for why BYOK is excluded
  // in this phase even for a BYOK request that happens to select Gemini as its provider.
  image?: ImageAttachment
  // Milestone 12 (Gemini-native grounding): requests Gemini's built-in Google Search
  // tool. Restricted to BYOK requests that specifically chose provider 'gemini'
  // (their own key, their own grounding cost) — rejected outright, not silently
  // dropped, for the shared tier and for every other BYOK provider. Final, deliberate
  // scope: free-tier Google Search grounding appears to require a billing-linked
  // Google Cloud project to unlock any real quota (three separate free keys/accounts
  // all returned 429 RESOURCE_EXHAUSTED on every grounded call attempted, while
  // non-grounded calls on the same keys succeeded instantly — consistent with
  // multiple reports on Google's own developer forums), so shipping this on the
  // shared tier would mean shipping a feature that doesn't actually work for anyone
  // using it. Never live-verified against a real billing-enabled grounding call —
  // shipped explicitly marked unverified, same honesty standard as Milestone 10 Phase
  // C and the three Experimental BYOK providers. Revisit if a billing-enabled key
  // becomes available.
  enableWebSearch?: boolean
}

export type ValidationResult =
  | {
      ok: true
      question: string
      chunks: InputChunk[]
      keySource: 'shared'
      docLabels: DocLabel[]
      history: HistoryTurn[]
      // Only the 'shared' variant can carry an image (Milestone 10 Phase B) — the
      // 'own' variant below deliberately has no such field, so a BYOK code path can
      // never read an image off validation even by mistake; the type itself enforces
      // the "shared-Gemini only" restriction, not just a runtime check.
      image: ImageAttachment | undefined
      // Milestone 12: deliberately NOT present on the shared branch at all — grounding
      // is BYOK-gemini-only in this project's final scope (see AnswerRequestBody's
      // enableWebSearch doc comment for why), so there is nothing for a shared-tier
      // code path to ever read, even by mistake. Mirrors the same "the type itself
      // enforces the restriction" rigor `image` already uses above, just the other
      // tier.
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
      // Milestone 12: only ever true here when `provider` is 'gemini' — enforced in
      // validateAnswerRequest below, not just documented.
      enableWebSearch: boolean
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
export const MIN_API_KEY_LENGTH = 8
export const MAX_MODEL_LENGTH = 128
// Printable ASCII, no spaces, MIN..MAX length. The key goes into an HTTP header — a
// newline or non-latin1 char makes fetch() throw a TypeError whose message can carry
// the header value, i.e. the key, into our own logs. Rejected here, before any fetch.
const API_KEY_PATTERN = /^[\x21-\x7E]{8,200}$/
// Gemini puts the model in the URL path (models/<model>:generateContent), so it gets
// the strictest set: no '/', ':', '?', '#', '%'. Other providers put it in a JSON body;
// '/' and ':' are real id chars there (openai/gpt-4o:free) and '~' prefixes
// OpenRouter's alias ids (~openai/gpt-mini-latest). '..' is rejected for every provider.
const GEMINI_MODEL_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
const MODEL_PATTERN = /^[A-Za-z0-9._:/~-]{1,128}$/
// A conversation realistically cites a handful of distinct documents, not dozens —
// generous enough for real multi-doc use, small enough to bound the label lookup.
export const MAX_DOC_LABELS = 20
// A handful of recent turns is enough for follow-up context without letting the
// prompt grow unbounded over a long-lived conversation.
export const MAX_HISTORY_TURNS = 3
// Reuses MAX_QUESTION_LENGTH for the history question field (same shape as a live
// question); a generated answer tends to run longer, so it gets its own cap.
export const MAX_HISTORY_ANSWER_LENGTH = 1000
// Milestone 10 Phase B: caps the base64 image payload as a string length, same
// checking pattern as MAX_CHUNK_TEXT_LENGTH. Empirically derived, not guessed — a real
// pdf.js render → canvas → JPEG pipeline at src/lib/pageRender.ts's actual resolution
// (1024px long edge) and quality (0.8) produced 88,092-100,887 raw JPEG bytes across a
// representative chart-like page and a rougher photo-like page. That worst case
// (100,887 bytes) is scaled up ~1.3x for a near-square page's larger pixel count
// (~130,600 bytes), then doubled for content-complexity headroom beyond the two tested
// cases (~261,200 bytes), rounded to a clean 300,000-byte raw-JPEG target — then
// inflated by base64's ~4/3 overhead to the actual wire-format cap checked here.
// Changing pageRender.ts's resolution/quality without re-measuring invalidates this.
export const MAX_IMAGE_BASE64_LENGTH = 400_000
const IMAGE_MIME_TYPE = 'image/jpeg'

function isValidApiKey(value: unknown): value is string {
  return typeof value === 'string' && API_KEY_PATTERN.test(value)
}

function isValidModel(provider: SupportedProvider, value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('..')) return false
  return (provider === 'gemini' ? GEMINI_MODEL_PATTERN : MODEL_PATTERN).test(value)
}

// Never interpolates the value itself — a rejected key must not be echoed back.
const API_KEY_ERROR = `apiKey must be ${MIN_API_KEY_LENGTH}-${MAX_API_KEY_LENGTH} printable ASCII characters with no spaces.`

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

// mimeType is checked against an exact match, not a generic image/* allowlist —
// pageRender.ts only ever produces 'image/jpeg', so anything else is either a bug or
// tampering, and there's no real use case yet to support otherwise.
function isValidImage(value: unknown): value is ImageAttachment {
  if (typeof value !== 'object' || value === null) return false
  const image = value as Record<string, unknown>
  return (
    image.mimeType === IMAGE_MIME_TYPE &&
    typeof image.base64 === 'string' &&
    image.base64.length > 0 &&
    image.base64.length <= MAX_IMAGE_BASE64_LENGTH
  )
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
  const { question, chunks, keySource, apiKey, provider, model, docLabels, history, image, enableWebSearch } =
    body as Record<string, unknown>

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

  let validatedImage: ImageAttachment | undefined
  if (image !== undefined) {
    if (!isValidImage(image)) {
      return {
        ok: false,
        error: `image must have mimeType "${IMAGE_MIME_TYPE}" and a non-empty base64 string of ${MAX_IMAGE_BASE64_LENGTH} characters or fewer.`,
      }
    }
    validatedImage = image
  }

  if (enableWebSearch !== undefined && typeof enableWebSearch !== 'boolean') {
    return { ok: false, error: 'enableWebSearch must be a boolean.' }
  }
  const resolvedEnableWebSearch = enableWebSearch ?? false

  const trimmedQuestion = question.trim()
  const resolvedKeySource = keySource ?? 'shared'
  if (resolvedKeySource !== 'shared' && resolvedKeySource !== 'own') {
    return { ok: false, error: 'keySource must be "shared" or "own".' }
  }

  // Milestone 10 Phase B ships shared-Gemini only — fail closed rather than silently
  // dropping an image a BYOK request happened to include, same "don't guess, reject"
  // reasoning as hasDuplicateDocLabels above.
  if (validatedImage && resolvedKeySource !== 'shared') {
    return { ok: false, error: 'image is only supported for the shared tier in this phase.' }
  }

  // Milestone 12: grounding is BYOK-gemini-only in this project's final scope — fail
  // closed rather than silently dropping enableWebSearch on a shared-tier request,
  // same "don't guess, reject" reasoning as the image restriction above (just the
  // other tier). See AnswerRequestBody's enableWebSearch doc comment for why.
  if (resolvedEnableWebSearch && resolvedKeySource === 'shared') {
    return { ok: false, error: 'enableWebSearch is only supported for BYOK requests with provider "gemini".' }
  }

  if (resolvedKeySource === 'shared') {
    return {
      ok: true,
      question: trimmedQuestion,
      chunks: validatedChunks,
      keySource: 'shared',
      docLabels: validatedDocLabels,
      history: validatedHistory,
      image: validatedImage,
    }
  }

  if (!isValidApiKey(apiKey)) {
    return { ok: false, error: API_KEY_ERROR }
  }
  if (typeof provider !== 'string' || !SUPPORTED_PROVIDERS.includes(provider as SupportedProvider)) {
    return { ok: false, error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(', ')}.` }
  }
  if (!isValidModel(provider as SupportedProvider, model)) {
    return {
      ok: false,
      error: `model must be 1-${MAX_MODEL_LENGTH} characters of letters, digits, and . _ - (plus : / ~ for non-Gemini providers), with no "..".`,
    }
  }

  // Milestone 12: grounding is Gemini-specific — fail closed rather than silently
  // dropping enableWebSearch for a BYOK request that picked a different provider, same
  // "don't guess, reject" reasoning as hasDuplicateDocLabels/the image restriction above.
  if (resolvedEnableWebSearch && provider !== 'gemini') {
    return { ok: false, error: 'enableWebSearch is only supported when provider is "gemini".' }
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
    enableWebSearch: resolvedEnableWebSearch,
  }
}

// Milestone 9 Phase A: the Notes tab's OCR request. Deliberately has NO keySource or
// apiKey field at all — not just an unused one — so there is nothing for a dispatch
// switch to ever branch BYOK on. This endpoint is structurally shared-tier-only: the
// type itself enforces it, the same "type + validation + dispatch, not just a policy
// note" rigor Milestone 10 Phase B used for excluding BYOK from the image attachment.
export interface OcrRequestBody {
  mimeType: string
  base64: string
}

export type OcrValidationResult =
  | { ok: true; mimeType: string; base64: string }
  | { ok: false; error: string }

// Exact mimeType allowlist (not a generic image/*|application/* match) — same "no real
// use case yet to support otherwise" reasoning as isValidImage above. application/pdf
// added in Phase B (multi-page scans) — reuses the same inlineData request shape
// transcribeImage already sends for images, so no dispatch-level branching needed.
export const OCR_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const

// Derived, not guessed: 15MB raw-file cap (see NotesDropZone.tsx / AGENTS.md's Phase A
// session for the full reasoning — keeps every request under Gemini's 20MB inline-
// recommended threshold, avoiding the File API's separate upload+poll+reference flow,
// and well under Cloudflare Workers' 100MB request body limit on this project's plan).
// Base64 inflates raw bytes by 4/3 (15,728,640 * 4/3 = 20,971,520); rounded up for
// padding/JSON-escaping overhead. This derivation was never image-specific — it's
// Gemini's generic inline-request-size guidance — so Phase B (PDF) reuses it unchanged
// rather than deriving a new number. Confirmed against a real 23-page scanned notebook
// (daa-unit2.pdf, Phase A/B's live-verification file): 6,837,990 raw bytes / 9,117,320
// base64 chars, ~57% headroom under this cap.
export const MAX_OCR_BASE64_LENGTH = 21_000_000

function isValidOcrMimeType(value: unknown): value is (typeof OCR_ALLOWED_MIME_TYPES)[number] {
  return typeof value === 'string' && (OCR_ALLOWED_MIME_TYPES as readonly string[]).includes(value)
}

export function validateOcrRequest(body: unknown): OcrValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Request body must be a JSON object.' }
  }
  const { mimeType, base64 } = body as Record<string, unknown>

  if (!isValidOcrMimeType(mimeType)) {
    return { ok: false, error: `mimeType must be one of: ${OCR_ALLOWED_MIME_TYPES.join(', ')}.` }
  }
  if (typeof base64 !== 'string' || base64.length === 0 || base64.length > MAX_OCR_BASE64_LENGTH) {
    return { ok: false, error: `base64 must be a non-empty string of ${MAX_OCR_BASE64_LENGTH} characters or fewer.` }
  }

  return { ok: true, mimeType, base64 }
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
  if (!isValidApiKey(apiKey)) {
    return { ok: false, error: API_KEY_ERROR }
  }

  return { ok: true, provider: provider as SupportedProvider, apiKey }
}
