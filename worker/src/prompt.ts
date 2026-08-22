import type { HistoryTurn, InputChunk } from './validate'

// Joins rule fragments into a natural-language list: "A", "A and B", "A, B, and C".
function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? 'the passages'
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/**
 * Grounded-QA prompt: answer only from the passages (and the attached image, and/or a
 * live web search, if enabled), cite the document + page, admit gaps instead of
 * guessing. Each passage is labelled "[Doc N, Page M]" so the model can disambiguate
 * pages across multiple documents; `labelOf` maps a chunk's documentId to its "Doc N"
 * number (see labels.ts). `history` (Milestone 11 Phase C2) is a capped list of recent
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
 *
 * `enableWebSearch` (Milestone 12, Gemini-native grounding) — same reasoning as
 * hasImage: `tools: [{"google_search": {}}]` is passed to Gemini alongside this exact
 * prompt text (see providers/gemini.ts's callGemini), and without acknowledging it
 * here, "answer using ONLY the passages... do not use outside knowledge" directly
 * contradicts granting the model a live search tool — the model would either ignore
 * the tool or ignore the instruction, inconsistently. Unlike hasImage/the old
 * (reverted) Brave-search-era Web N design, there is no separate content section or
 * citation-format instruction to add here: Gemini fetches and reasons over live search
 * results entirely inside its own infrastructure, never as raw text this file
 * assembles, and the structured citation data (real URLs, not a fabricated label) comes
 * back out-of-band via groundingMetadata — see providers/gemini.ts's
 * GeminiGroundingResult. This flag only ever widens sourceRule's source list; nothing
 * else about the prompt changes when it's set.
 */
export function buildPrompt(
  question: string,
  chunks: InputChunk[],
  labelOf: Map<string, number>,
  history: HistoryTurn[] = [],
  hasImage: boolean = false,
  enableWebSearch: boolean = false,
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

  const sources: string[] = ['the passages']
  if (hasImage) sources.push('the attached image')
  if (enableWebSearch) sources.push('the results of a live web search')
  const sourceRule = joinWithAnd(sources)

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
