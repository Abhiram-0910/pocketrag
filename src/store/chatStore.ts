import { create } from 'zustand'
import type { DocLabel, HistoryTurn, WebSource } from '../lib/answerRequest'
import type { EgressRecord } from '../lib/egress'
import {
  deleteAllHistory,
  deleteConversation,
  getConversations,
  getTurns,
  onHistoryDbEvent,
  saveConversation,
  saveTurn,
  sweepInterruptedTurns,
  type Citation,
  type ConversationRecord,
  type TurnFailure,
  type TurnRecord,
} from '../lib/historyDb'
import { docLabelsFor, historyForRequest, latestLeafUnder, pathTo, previousQuestionFor } from '../lib/conversation'

// 'ok' until a history write or read fails. The conversation itself always keeps working
// in memory; this only says whether it's being saved. 'quota' = QuotaExceededError,
// 'blocked' = another tab holds an older DB version open, 'outdated' = another tab opened a
// newer version and this tab let go of its connection.
export type HistoryStorageState = 'ok' | 'unavailable' | 'quota' | 'blocked' | 'outdated'

const TITLE_LENGTH = 80

export interface NewTurn {
  question: string
  // Omitted: continue from the active leaf. Pass an existing turn's parentId to edit or
  // regenerate it (the new turn becomes its sibling).
  parentId?: string | null
  citations: Citation[]
  scope: TurnRecord['scope']
  tier: TurnRecord['tier']
  provider: TurnRecord['provider']
  model: string | null
  imageIncluded: boolean
  webSearchRequested: boolean
}

// What the caller sends with the new turn's request, derived from its ancestors.
export interface TurnRequestContext {
  turnId: string
  history: HistoryTurn[]
  docLabels: DocLabel[]
  previousQuestion: string | null
}

// Which tier/provider/model a request goes out with — updated on retry, since the user may
// have switched keys since the turn was first asked.
export type TurnKey = Pick<TurnRecord, 'tier' | 'provider' | 'model'>

export type TurnOutcome =
  | {
      status: 'answered'
      answer: string
      groundingWarning: boolean
      docLabels: DocLabel[]
      webGrounded: boolean
      // From the Worker's echo; absent from an older Worker. Replaces what startTurn
      // recorded (the shared tier's model is null until then) when present.
      provider?: TurnRecord['provider']
      model?: string
      // Grounded results only — kept in groundedSession, never in the turn record.
      webSources?: WebSource[]
      searchEntryPointHtml?: string
    }
  | { status: 'failed'; failure: TurnFailure }
  | { status: 'timed-out' }

// What this session keeps of a grounded result, for display only. Never written to
// IndexedDB (the Gemini terms — SECURITY_REVIEW.md §1.1). conversationId lets deleting a
// conversation free its entries even when it isn't the one open.
export interface GroundedSessionEntry {
  conversationId: string
  answer: string
  webSources?: WebSource[]
  searchEntryPointHtml?: string
}

interface ChatState {
  conversations: ConversationRecord[]
  activeConversationId: string | null
  // The active conversation's turns, exactly as stored (a grounded answer is null here).
  turns: TurnRecord[]
  // Grounded results by turn id — this session only.
  groundedSession: Map<string, GroundedSessionEntry>
  storage: HistoryStorageState
  restore: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  newConversation: () => void
  startTurn: (input: NewTurn) => Promise<TurnRequestContext>
  // Re-sends the same turn with the current key config; null if the turn is gone.
  retryTurn: (turnId: string, key: TurnKey) => Promise<TurnRequestContext | null>
  settleTurn: (turnId: string, outcome: TurnOutcome) => Promise<void>
  // An egress record for this turn's request (egressFetch's onRecord). Upserts by record
  // id, so the in-flight copy is replaced by the settled one and each retry adds a row.
  appendEgress: (turnId: string, record: EgressRecord) => Promise<void>
  selectBranch: (turnId: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  deleteAllHistory: () => Promise<void>
}

function storageStateFor(err: unknown): HistoryStorageState {
  return err instanceof DOMException && err.name === 'QuotaExceededError' ? 'quota' : 'unavailable'
}

/** A turn's answer to display: stored text, else this session's grounded text, else null. */
export function answerFor(state: Pick<ChatState, 'groundedSession'>, turn: TurnRecord): string | null {
  return turn.answer ?? state.groundedSession.get(turn.id)?.answer ?? null
}

export const useChatStore = create<ChatState>((set, get) => {
  onHistoryDbEvent((event) => set({ storage: event === 'blocked' ? 'blocked' : 'outdated' }))

  // Turns with a request in flight, by id — the latest copy, whichever conversation is
  // open. A request keeps settling (and saving) after the user switches conversations;
  // `turns` only ever mirrors the open one.
  const inflight = new Map<string, TurnRecord>()

  const findTurn = (turnId: string) => inflight.get(turnId) ?? get().turns.find((t) => t.id === turnId)

  // The history / Doc N map / blend question for a turn whose ancestors are `path`.
  const contextFor = (turnId: string, path: TurnRecord[]): TurnRequestContext => ({
    turnId,
    history: historyForRequest(path),
    docLabels: docLabelsFor(path),
    previousQuestion: previousQuestionFor(path),
  })

  // Updates a turn and its conversation in memory first, then persists. A failed write
  // only flips `storage` — the in-memory conversation (and the answer on screen) stays;
  // the next successful write clears a quota/unavailable state again.
  async function commit(conversation: ConversationRecord, turn: TurnRecord) {
    if (inflight.has(turn.id)) inflight.set(turn.id, turn)
    set((s) => ({
      conversations: [conversation, ...s.conversations.filter((c) => c.id !== conversation.id)],
      turns:
        turn.conversationId !== s.activeConversationId
          ? s.turns
          : s.turns.some((t) => t.id === turn.id)
            ? s.turns.map((t) => (t.id === turn.id ? turn : t))
            : [...s.turns, turn],
    }))
    try {
      await saveTurn(conversation, turn)
      if (get().storage === 'quota' || get().storage === 'unavailable') set({ storage: 'ok' })
    } catch (err) {
      set({ storage: storageStateFor(err) })
    }
  }

  // A no-op if the turn or its conversation is gone (deleted while the request was in
  // flight) — settling must not bring a deleted conversation back.
  function updateTurn(turnId: string, patch: (turn: TurnRecord) => TurnRecord): Promise<void> {
    const turn = findTurn(turnId)
    const conversation = turn && get().conversations.find((c) => c.id === turn.conversationId)
    if (!turn || !conversation) return Promise.resolve()
    return commit({ ...conversation, updatedAt: Date.now() }, patch(turn))
  }

  return {
    conversations: [],
    activeConversationId: null,
    turns: [],
    groundedSession: new Map(),
    storage: 'ok',

    // Lists conversations and opens the most recent one — unless the user already started
    // or opened one while this was loading.
    restore: async () => {
      try {
        await sweepInterruptedTurns()
        const conversations = await getConversations()
        set({ conversations })
        if (conversations.length > 0 && get().activeConversationId === null) await get().openConversation(conversations[0].id)
      } catch (err) {
        set({ storage: storageStateFor(err) })
      }
    },

    openConversation: async (id) => {
      try {
        // An in-flight turn's in-memory copy may be ahead of its last write.
        const turns = (await getTurns(id)).map((t) => inflight.get(t.id) ?? t)
        set({ activeConversationId: id, turns })
      } catch (err) {
        set({ storage: storageStateFor(err) })
      }
    },

    newConversation: () => set({ activeConversationId: null, turns: [] }),

    startTurn: async (input) => {
      const now = Date.now()
      const s = get()
      const existing = s.conversations.find((c) => c.id === s.activeConversationId) ?? null
      const conversation: ConversationRecord = existing ?? {
        id: crypto.randomUUID(),
        title: input.question.slice(0, TITLE_LENGTH),
        createdAt: now,
        updatedAt: now,
        activeLeafId: null,
      }
      const parentId = input.parentId === undefined ? conversation.activeLeafId : input.parentId
      const path = pathTo(existing ? s.turns : [], parentId)
      const turn: TurnRecord = {
        id: crypto.randomUUID(),
        conversationId: conversation.id,
        parentId,
        createdAt: now,
        completedAt: null,
        question: input.question,
        status: 'pending',
        answer: null,
        groundingWarning: false,
        docLabels: [],
        citations: input.citations,
        scope: input.scope,
        tier: input.tier,
        provider: input.provider,
        model: input.model,
        imageIncluded: input.imageIncluded,
        webSearchRequested: input.webSearchRequested,
        webGrounded: false,
        failure: null,
        egress: [],
      }
      if (!existing) set({ activeConversationId: conversation.id, turns: [] })
      inflight.set(turn.id, turn)
      // Written as 'pending' before the request goes out, so a tab that dies mid-request
      // still leaves the turn behind (swept to 'interrupted' on a later load).
      await commit({ ...conversation, updatedAt: now, activeLeafId: turn.id }, turn)
      return contextFor(turn.id, path)
    },

    // Retry re-sends the same turn (same question, same chunks), so it reuses the record.
    retryTurn: async (turnId, key) => {
      const turn = findTurn(turnId)
      if (!turn) return null
      inflight.set(turnId, turn)
      await updateTurn(turnId, (t) => ({ ...t, ...key, status: 'pending', failure: null, completedAt: null }))
      // Retry is only offered on the open conversation's leaf, so its ancestors are in `turns`.
      return contextFor(turnId, pathTo(get().turns, turn.parentId))
    },

    settleTurn: async (turnId, outcome) => {
      const completedAt = Date.now()
      const turn = findTurn(turnId)
      if (turn && outcome.status === 'answered' && outcome.webGrounded) {
        const entry: GroundedSessionEntry = {
          conversationId: turn.conversationId,
          answer: outcome.answer,
          webSources: outcome.webSources,
          searchEntryPointHtml: outcome.searchEntryPointHtml,
        }
        set((s) => ({ groundedSession: new Map(s.groundedSession).set(turnId, entry) }))
      }
      await updateTurn(turnId, (t) => {
        switch (outcome.status) {
          case 'answered':
            return {
              ...t,
              status: 'answered',
              answer: outcome.webGrounded ? null : outcome.answer,
              groundingWarning: outcome.groundingWarning,
              docLabels: outcome.docLabels,
              provider: outcome.provider ?? t.provider,
              model: outcome.model ?? t.model,
              webGrounded: outcome.webGrounded,
              failure: null,
              completedAt,
            }
          case 'failed':
            return { ...t, status: 'failed', failure: outcome.failure, completedAt }
          case 'timed-out':
            return { ...t, status: 'timed-out', completedAt }
        }
      })
      inflight.delete(turnId)
    },

    appendEgress: (turnId, record) =>
      updateTurn(turnId, (t) => ({
        ...t,
        egress: t.egress.some((r) => r.id === record.id)
          ? t.egress.map((r) => (r.id === record.id ? record : r))
          : [...t.egress, record],
      })),

    selectBranch: async (turnId) => {
      const s = get()
      const conversation = s.conversations.find((c) => c.id === s.activeConversationId)
      if (!conversation) return
      const updated = { ...conversation, activeLeafId: latestLeafUnder(s.turns, turnId) }
      set((st) => ({ conversations: st.conversations.map((c) => (c.id === updated.id ? updated : c)) }))
      try {
        await saveConversation(updated)
      } catch (err) {
        set({ storage: storageStateFor(err) })
      }
    },

    // Rejects if the delete fails, and leaves memory as it was — the UI must not show
    // something as deleted while it's still on disk.
    deleteConversation: async (id) => {
      await deleteConversation(id)
      for (const [turnId, turn] of inflight) if (turn.conversationId === id) inflight.delete(turnId)
      set((s) => {
        const active = s.activeConversationId === id
        const groundedSession = new Map(s.groundedSession)
        for (const [turnId, entry] of groundedSession) if (entry.conversationId === id) groundedSession.delete(turnId)
        return {
          conversations: s.conversations.filter((c) => c.id !== id),
          activeConversationId: active ? null : s.activeConversationId,
          turns: active ? [] : s.turns,
          groundedSession,
        }
      })
    },

    deleteAllHistory: async () => {
      await deleteAllHistory()
      inflight.clear()
      set({ conversations: [], activeConversationId: null, turns: [], groundedSession: new Map() })
    },
  }
})
