import type { DocLabel, HistoryTurn } from './answerRequest'
import type { TurnRecord } from './historyDb'

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

// ---- Conversation tree (persisted history, src/lib/historyDb.ts) ----
// Turns form a tree through parentId: editing or regenerating a turn adds a sibling under
// the same parent, and a conversation shows one root-to-leaf path at a time.

// How many prior turns go upstream as `history`. Same value as QueryPanel's
// SENT_HISTORY_TURNS, which keeps its own copy until QueryPanel moves onto chatStore.
export const SENT_HISTORY_TURNS = 3

type TreeTurn = Pick<TurnRecord, 'id' | 'parentId' | 'createdAt'>
type ContextTurn = Pick<TurnRecord, 'question' | 'answer' | 'status' | 'webGrounded' | 'docLabels'>

/** A turn's children, oldest first (null = the conversation's root turns). */
export function childrenOf<T extends TreeTurn>(turns: T[], parentId: string | null): T[] {
  return turns.filter((t) => t.parentId === parentId).sort((a, b) => a.createdAt - b.createdAt)
}

/** The root-to-leaf path ending at `leafId`, root first; [] for null or an unknown id. */
export function pathTo<T extends TreeTurn>(turns: T[], leafId: string | null): T[] {
  const byId = new Map(turns.map((t) => [t.id, t]))
  const path: T[] = []
  let current = leafId === null ? undefined : byId.get(leafId)
  // The length bound stops a corrupted parentId cycle from hanging the tab.
  while (current && path.length < turns.length) {
    path.unshift(current)
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return path
}

/** The newest leaf below `turnId` (following the newest child each step) — the turn to show
 * when the user switches to the branch that starts at `turnId`. */
export function latestLeafUnder<T extends TreeTurn>(turns: T[], turnId: string): string {
  let id = turnId
  for (let step = 0; step < turns.length; step++) {
    const newest = childrenOf(turns, id).at(-1)
    if (!newest) break
    id = newest.id
  }
  return id
}

/**
 * The `history` sent with a new turn whose ancestors are `path`: the most recent answered
 * turns, never a grounded one. A grounded answer isn't stored (historyDb.ts's saveTurn),
 * and the Gemini terms only allow resubmitting grounded text to Google via a function call
 * to refine that result — not as context, and not to another provider.
 */
export function historyForRequest(path: ContextTurn[], maxTurns: number = SENT_HISTORY_TURNS): HistoryTurn[] {
  return path
    .filter((t): t is ContextTurn & { answer: string } => t.status === 'answered' && !t.webGrounded && t.answer !== null)
    .slice(-maxTurns)
    .map(({ question, answer }) => ({ question, answer }))
}

/** The nearest answered ancestor's question, for buildRetrievalQuery. */
export function previousQuestionFor(path: ContextTurn[]): string | null {
  return path.findLast((t) => t.status === 'answered')?.question ?? null
}

/** The Doc N map to echo back: the nearest answered ancestor's (failed turns got none). */
export function docLabelsFor(path: ContextTurn[]): DocLabel[] {
  return path.findLast((t) => t.status === 'answered')?.docLabels ?? []
}
