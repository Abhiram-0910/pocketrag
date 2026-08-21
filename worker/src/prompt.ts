import type { HistoryTurn, InputChunk } from './validate'

/**
 * Grounded-QA prompt: answer only from the passages (and the attached image, if one is
 * given), cite the document + page, admit gaps instead of guessing. Each passage is
 * labelled "[Doc N, Page M]" so the model can disambiguate pages across multiple
 * documents; `labelOf` maps a chunk's documentId to its "Doc N" number (see
 * labels.ts). `history` (Milestone 11 Phase C2) is a capped list of recent
 * {question, answer} pairs from this conversation, shown for context only — the model
 * is told explicitly not to cite from it, since a prior answer's citations aren't
 * guaranteed to hold for this turn's actual passages (see grounding.ts's doc comment
 * for what happens if the model does anyway).
 *
 * `hasImage` (Milestone 10 Phase B) — the image itself is never in this string, it's
 * a separate inlineData part the caller (providers/gemini.ts) appends alongside this
 * text. Without this flag, the base prompt's "ONLY the passages" / "no outside
 * knowledge" instructions read as telling the model to ignore an attached image
 * entirely — confirmed as a real failure mode by live-verification against real
 * Gemini before this flag existed (the model explicitly said it was reasoning from
 * text only, despite the image being correctly attached), not a hypothetical concern.
 */
export function buildPrompt(
  question: string,
  chunks: InputChunk[],
  labelOf: Map<string, number>,
  history: HistoryTurn[] = [],
  hasImage: boolean = false,
): string {
  const passages = chunks
    .map((chunk) => `[Doc ${labelOf.get(chunk.documentId)}, Page ${chunk.page}]\n${chunk.text}`)
    .join('\n\n')

  const historySection =
    history.length > 0
      ? `Conversation so far (for context only — do not cite from this, only from Passages below):
${history.map((turn) => `Q: ${turn.question}\nA: ${turn.answer}`).join('\n\n')}

`
      : ''

  const imageNote = hasImage
    ? ' An image of the most relevant page has also been attached — use it together with the passages to answer, especially for anything visual (colors, shapes, chart values, diagram layout) that plain text can\'t capture.'
    : ''
  const sourceRule = hasImage ? 'the passages and the attached image' : 'the passages'
  const imageCitationRule = hasImage
    ? ' If a claim comes from the attached image, cite the page it was rendered from the same way.'
    : ''

  return `You are answering a question using ONLY the passages below, extracted from one or more PDF documents.${imageNote}

Rules:
- Answer using only information found in ${sourceRule}. Do not use outside knowledge, even if you know the answer.
- Each passage is labelled with its document ("Doc N") and page. Cite both inline for every claim, in the form "(Doc N, page M)".${imageCitationRule}
- If ${sourceRule} do not contain enough information to answer, say so explicitly instead of guessing.

${historySection}Passages:
${passages}

Question: ${question}

Answer:`
}
