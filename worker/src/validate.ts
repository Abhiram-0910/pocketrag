export interface InputChunk {
  text: string
  page: number
  score: number
  // Opaque per-document id (a client-generated UUID). Used only to group chunks by
  // document for "Doc N" labelling and grounding — never placed in the prompt.
  documentId: string
}

export interface AnswerRequestBody {
  question: string
  chunks: InputChunk[]
}

export type ValidationResult =
  | { ok: true; question: string; chunks: InputChunk[] }
  | { ok: false; error: string }

// Server-side caps — the frontend only ever sends 3 short chunks, but the
// client can't be trusted to keep it that way (bug, tampering, or abuse).
export const MAX_CHUNKS = 5
export const MAX_CHUNK_TEXT_LENGTH = 2000
export const MAX_QUESTION_LENGTH = 500
// documentId must round-trip back to the client to resolve titles, so reject an
// oversized one rather than truncating it (a legit client sends a 36-char UUID).
export const MAX_DOCUMENT_ID_LENGTH = 128

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
  const { question, chunks } = body as Record<string, unknown>

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
  const validated: InputChunk[] = []
  for (const chunk of capped) {
    if (!isValidChunk(chunk)) {
      return {
        ok: false,
        error: 'Each chunk must have text (string), page (number), score (number), and documentId (string).',
      }
    }
    validated.push({ ...chunk, text: chunk.text.slice(0, MAX_CHUNK_TEXT_LENGTH) })
  }

  return { ok: true, question: question.trim(), chunks: validated }
}
