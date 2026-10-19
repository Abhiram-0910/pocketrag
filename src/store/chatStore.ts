import { create } from 'zustand'
import type { DocLabel, HistoryTurn } from '../lib/answerRequest'
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

export type TurnOutcome =
  | { status: 'answered'; answer: string; groundingWarning: boolean; docLabels: DocLabel[]; webGrounded: boolean }
  | { status: 'failed'; failure: TurnFailure }
  | { status: 'timed-out' }

interface ChatState {
  conversations: ConversationRecord[]
  activeConversationId: string | null
  // The active conversation's turns, exactly as stored (a grounded answer is null here).
  turns: TurnRecord[]
  // Grounded answer text, by turn id — this session only, never written to IndexedDB.
  groundedText: Map<string, string>
  storage: HistoryStorageState
  restore: () => Promise<void>
  openConversation: (id: string) => Promise<void>
  newConversation: () => void
  startTurn: (input: NewTurn) => Promise<TurnRequestContext>
  retryTurn: (turnId: string) => Promise<void>
  settleTurn: (turnId: string, outcome: TurnOutcome) => Promise<void>
  selectBranch: (turnId: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  deleteAllHistory: () => Promise<void>
}

function storageStateFor(err: unknown): HistoryStorageState {
  return err instanceof DOMException && err.name === 'QuotaExceededError' ? 'quota' : 'unavailable'
}

/** A turn's answer to display: stored text, else this session's grounded text, else null. */
export function answerFor(state: Pick<ChatState, 'groundedText'>, turn: TurnRecord): string | null {
  return turn.answer ?? state.groundedText.get(turn.id) ?? null
}

export const useChatStore = create<ChatState>((set, get) => {
  onHistoryDbEvent((event) => set({ storage: event === 'blocked' ? 'blocked' : 'outdated' }))

  const activeConversation = () => get().conversations.find((c) => c.id === get().activeConversationId) ?? null

  // Updates a turn and its conversation in memory first, then persists. A failed write
  // only flips `storage` — the in-memory conversation (and the answer on screen) stays.
  async function commit(conversation: ConversationRecord, turn: TurnRecord) {
    set((s) => ({
      conversations: [conversation, ...s.conversations.filter((c) => c.id !== conversation.id)],
      activeConversationId: conversation.id,
      turns: s.turns.some((t) => t.id === turn.id) ? s.turns.map((t) => (t.id === turn.id ? turn : t)) : [...s.turns, turn],
    }))
    try {
      await saveTurn(conversation, turn)
    } catch (err) {
      set({ storage: storageStateFor(err) })
    }
  }

  function updateTurn(turnId: string, patch: (turn: TurnRecord) => TurnRecord) {
    const turn = get().turns.find((t) => t.id === turnId)
    const conversation = activeConversation()
    if (!turn || !conversation) throw new Error(`Unknown turn ${turnId}`)
    return commit({ ...conversation, updatedAt: Date.now() }, patch(turn))
  }

  return {
    conversations: [],
    activeConversationId: null,
    turns: [],
    groundedText: new Map(),
    storage: 'ok',

    restore: async () => {
      try {
        await sweepInterruptedTurns()
        set({ conversations: await getConversations() })
      } catch (err) {
        set({ storage: storageStateFor(err) })
      }
    },

    openConversation: async (id) => {
      try {
        const turns = await getTurns(id)
        set({ activeConversationId: id, turns })
      } catch (err) {
        set({ storage: storageStateFor(err) })
      }
    },

    newConversation: () => set({ activeConversationId: null, turns: [] }),

    startTurn: async (input) => {
      const now = Date.now()
      const existing = activeConversation()
      const conversation: ConversationRecord = existing ?? {
        id: crypto.randomUUID(),
        title: input.question.slice(0, TITLE_LENGTH),
        createdAt: now,
        updatedAt: now,
        activeLeafId: null,
      }
      const parentId = input.parentId === undefined ? conversation.activeLeafId : input.parentId
      const path = pathTo(existing ? get().turns : [], parentId)
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
      }
      if (!existing) set({ turns: [] })
      // Written as 'pending' before the request goes out, so a tab that dies mid-request
      // still leaves the turn behind (swept to 'interrupted' on a later load).
      await commit({ ...conversation, updatedAt: now, activeLeafId: turn.id }, turn)
      return {
        turnId: turn.id,
        history: historyForRequest(path),
        docLabels: docLabelsFor(path),
        previousQuestion: previousQuestionFor(path),
      }
    },

    // Retry re-sends the same turn (same question, same chunks), so it reuses the record.
    retryTurn: (turnId) => updateTurn(turnId, (t) => ({ ...t, status: 'pending', failure: null, completedAt: null })),

    settleTurn: (turnId, outcome) => {
      const completedAt = Date.now()
      if (outcome.status === 'answered' && outcome.webGrounded) {
        set((s) => ({ groundedText: new Map(s.groundedText).set(turnId, outcome.answer) }))
      }
      return updateTurn(turnId, (t) => {
        switch (outcome.status) {
          case 'answered':
            return {
              ...t,
              status: 'answered',
              answer: outcome.webGrounded ? null : outcome.answer,
              groundingWarning: outcome.groundingWarning,
              docLabels: outcome.docLabels,
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
    },

    selectBranch: async (turnId) => {
      const conversation = activeConversation()
      if (!conversation) return
      const updated = { ...conversation, activeLeafId: latestLeafUnder(get().turns, turnId) }
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === updated.id ? updated : c)) }))
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
      set((s) => {
        const active = s.activeConversationId === id
        const groundedText = new Map(s.groundedText)
        if (active) for (const t of s.turns) groundedText.delete(t.id)
        return {
          conversations: s.conversations.filter((c) => c.id !== id),
          activeConversationId: active ? null : s.activeConversationId,
          turns: active ? [] : s.turns,
          groundedText,
        }
      })
    },

    deleteAllHistory: async () => {
      await deleteAllHistory()
      set({ conversations: [], activeConversationId: null, turns: [], groundedText: new Map() })
    },
  }
})
