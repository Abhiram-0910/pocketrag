import type { InputChunk } from './validate'

/**
 * Grounded-QA prompt: answer only from the passages, cite the document + page, admit
 * gaps instead of guessing. Each passage is labelled "[Doc N, Page M]" so the model
 * can disambiguate pages across multiple documents; `labelOf` maps a chunk's
 * documentId to its "Doc N" number (see labels.ts).
 */
export function buildPrompt(question: string, chunks: InputChunk[], labelOf: Map<string, number>): string {
  const passages = chunks
    .map((chunk) => `[Doc ${labelOf.get(chunk.documentId)}, Page ${chunk.page}]\n${chunk.text}`)
    .join('\n\n')

  return `You are answering a question using ONLY the passages below, extracted from one or more PDF documents.

Rules:
- Answer using only information found in the passages. Do not use outside knowledge, even if you know the answer.
- Each passage is labelled with its document ("Doc N") and page. Cite both inline for every claim, in the form "(Doc N, page M)".
- If the passages do not contain enough information to answer, say so explicitly instead of guessing.

Passages:
${passages}

Question: ${question}

Answer:`
}
