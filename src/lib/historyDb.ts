import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { DocLabel } from './answerRequest'
import type { FailureCode, FailureSource } from './apiError'
import type { EgressRecord } from './egress'
import type { ErrorTaxonomyType } from './errorTaxonomy'
import type { Provider } from './models'
import { requestPersistOnce } from './db'

export interface ConversationRecord {
  id: string
  // The first question, truncated — set once when the conversation is created.
  title: string
  createdAt: number
  updatedAt: number
  // The turn whose root-to-leaf path is the branch currently shown.
  activeLeafId: string | null
}

// 'interrupted' is a 'pending' turn whose tab went away mid-request (see sweepInterruptedTurns).
export type TurnStatus = 'pending' | 'answered' | 'failed' | 'timed-out' | 'interrupted'

// One per chunk sent with the question. References only — the passage text stays in the
// documents DB, so deleting a document doesn't leave a copy of its text here.
export interface Citation {
  chunkId: string
  documentId: string
  page: number
  rank: number
  score: number
}

export interface TurnFailure {
  kind: ErrorTaxonomyType | 'timeout'
  // The Worker's fixed `error` copy. Stored because the UI shows it verbatim and never
  // rebuilds copy from `code` client-side (AGENTS.md, Step B rules).
  message: string
  httpStatus?: number
  code?: FailureCode
  source?: FailureSource
  resetAt?: string
}

export interface TurnRecord {
  id: string
  conversationId: string
  // null = a root turn. Editing or regenerating a turn adds a sibling under the same parent.
  parentId: string | null
  createdAt: number
  completedAt: number | null
  question: string
  status: TurnStatus
  // Always null when webGrounded — see saveTurn.
  answer: string | null
  groundingWarning: boolean
  // The full label map the Worker returned after this turn; a child turn echoes it back.
  docLabels: DocLabel[]
  citations: Citation[]
  scope: 'document' | 'all'
  tier: 'shared' | 'own'
  // The shared tier is always Gemini (the Worker's contract); its model is the Worker's
  // choice and isn't reported back, so it's null rather than guessed.
  provider: Provider
  model: string | null
  imageIncluded: boolean
  webSearchRequested: boolean
  // Gemini returned grounding metadata. webSources and searchEntryPointHtml have no field
  // here on purpose: the Gemini terms don't let us store them.
  webGrounded: boolean
  failure: TurnFailure | null
  // Every request made for this turn, retries included — what the Receipts view will show.
  // Always [] for now: records go to egress.ts's session log until the UI is wired.
  egress: EgressRecord[]
}

interface HistoryDB extends DBSchema {
  conversations: { key: string; value: ConversationRecord; indexes: { updatedAt: number } }
  turns: { key: string; value: TurnRecord; indexes: { conversationId: string } }
}

// A separate database from db.ts's 'pocketrag' (documents and chunks), which stays at
// version 1. A frontend rollback to a build that predates history then never opens this
// one, and its documents DB still opens at the version it expects. See ARCHITECTURE.md.
const DB_NAME = 'pocketrag-history'
export const HISTORY_DB_VERSION = 1

// A turn still 'pending' this long after it was created belonged to a tab that closed or
// crashed mid-request. A younger one may be another open tab's request still in flight.
export const STALE_PENDING_MS = 5 * 60 * 1000

export type HistoryDbEvent = 'blocked' | 'blocking'
let onEvent: (event: HistoryDbEvent) => void = () => {}

/** 'blocked': an older version is open in another tab, so an upgrade here waits. 'blocking':
 * another tab wants a newer version — this tab's connection has already been closed. */
export function onHistoryDbEvent(listener: (event: HistoryDbEvent) => void): void {
  onEvent = listener
}

let dbPromise: Promise<IDBPDatabase<HistoryDB>> | null = null

function getDB(): Promise<IDBPDatabase<HistoryDB>> {
  dbPromise ??= openDB<HistoryDB>(DB_NAME, HISTORY_DB_VERSION, {
    // HARD RULE: never await anything but this upgrade transaction's own requests in here.
    // The whole upgrade is one versionchange transaction, so a throw rolls everything back
    // to the previous version; awaiting a non-IndexedDB promise lets the transaction
    // auto-commit half-done, the one way to get a partial migration. Add each future
    // version as its own `if (oldVersion < N)` step.
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore('conversations', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
        db.createObjectStore('turns', { keyPath: 'id' }).createIndex('conversationId', 'conversationId')
      }
    },
    blocked() {
      onEvent('blocked')
    },
    // Shipped with version 1 because a build already deployed can't be patched later: a
    // future version's upgrade in another tab would otherwise wait until this tab closes.
    blocking() {
      void dbPromise?.then((db) => db.close())
      dbPromise = null
      onEvent('blocking')
    },
  }).catch((err: unknown) => {
    // Don't cache a failed open: the next call retries.
    dbPromise = null
    throw err
  })
  return dbPromise
}

/**
 * Saves a turn and its conversation in one transaction. A grounded turn's answer is
 * dropped here, not left to callers: the Gemini terms limit what may be stored of a
 * grounded result, so this app keeps that text in memory for the session only.
 * Rejects with the DOMException (e.g. QuotaExceededError) if the write fails.
 */
export async function saveTurn(conversation: ConversationRecord, turn: TurnRecord): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['conversations', 'turns'], 'readwrite')
  await Promise.all([
    tx.objectStore('conversations').put(conversation),
    tx.objectStore('turns').put(turn.webGrounded ? { ...turn, answer: null } : turn),
    tx.done,
  ])
  requestPersistOnce()
}

export async function saveConversation(conversation: ConversationRecord): Promise<void> {
  const db = await getDB()
  await db.put('conversations', conversation)
}

/** Every conversation, most recently updated first. */
export async function getConversations(): Promise<ConversationRecord[]> {
  const db = await getDB()
  return (await db.getAllFromIndex('conversations', 'updatedAt')).reverse()
}

export async function getTurns(conversationId: string): Promise<TurnRecord[]> {
  const db = await getDB()
  return db.getAllFromIndex('turns', 'conversationId', conversationId)
}

/** Deletes a conversation and every one of its turns in a single transaction. */
export async function deleteConversation(conversationId: string): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['conversations', 'turns'], 'readwrite')
  const turnKeys = await tx.objectStore('turns').index('conversationId').getAllKeys(conversationId)
  await Promise.all([
    tx.objectStore('conversations').delete(conversationId),
    ...turnKeys.map((key) => tx.objectStore('turns').delete(key)),
    tx.done,
  ])
}

export async function deleteAllHistory(): Promise<void> {
  const db = await getDB()
  const tx = db.transaction(['conversations', 'turns'], 'readwrite')
  await Promise.all([tx.objectStore('conversations').clear(), tx.objectStore('turns').clear(), tx.done])
}

/** Marks stale 'pending' turns 'interrupted'; returns how many. Run once on load. */
export async function sweepInterruptedTurns(now: number = Date.now()): Promise<number> {
  const db = await getDB()
  const tx = db.transaction('turns', 'readwrite')
  // ponytail: full scan of every turn, fine at chat-history sizes; add a status index if it ever shows up in load time.
  const stale = (await tx.store.getAll()).filter((t) => t.status === 'pending' && t.createdAt < now - STALE_PENDING_MS)
  await Promise.all([...stale.map((t) => tx.store.put({ ...t, status: 'interrupted' })), tx.done])
  return stale.length
}
