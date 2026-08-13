// How many prior turns' questions to fold into the retrieval query (Milestone 11
// Phase C2). One turn resolves the common pronoun follow-up ("what page is that on?")
// without diluting cosine/BM25 matching with stale topic keywords from older turns.
// A one-line change to widen later if that trade-off ever needs revisiting.
export const RETRIEVAL_HISTORY_TURNS = 1

/**
 * Blends the immediately preceding question into the current one for retrieval only
 * (never sent to the Worker as-is — the literal `question` is still what's asked).
 * Deliberately excludes the prior answer's text: BM25 is exact-term, and a generated
 * answer's phrasing isn't guaranteed to share vocabulary with the source passages the
 * way the user's own question usually does.
 */
export function buildRetrievalQuery(previousQuestion: string | null, question: string): string {
  return previousQuestion ? `${previousQuestion} ${question}` : question
}
