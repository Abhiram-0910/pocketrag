import type { InputChunk } from './validate'

/** Grounded-QA prompt: answer only from the passages, cite pages, admit gaps instead of guessing. */
export function buildPrompt(question: string, chunks: InputChunk[]): string {
  const passages = chunks.map((chunk) => `[Page ${chunk.page}]\n${chunk.text}`).join('\n\n')

  return `You are answering a question using ONLY the passages below, extracted from a PDF document.

Rules:
- Answer using only information found in the passages. Do not use outside knowledge, even if you know the answer.
- Cite the page number inline for every claim, in the form "(page N)".
- If the passages do not contain enough information to answer, say so explicitly instead of guessing.

Passages:
${passages}

Question: ${question}

Answer:`
}
