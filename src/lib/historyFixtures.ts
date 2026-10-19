import type { ConversationRecord, TurnRecord } from './historyDb'

// Shared builders for the history tests (historyDb, conversation tree, chatStore).
export function makeConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return { id: 'conv-1', title: 'Q', createdAt: 1, updatedAt: 1, activeLeafId: null, ...overrides }
}

export function makeTurn(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    id: 'turn-1',
    conversationId: 'conv-1',
    parentId: null,
    createdAt: 1,
    completedAt: 2,
    question: 'What is the mitochondrion?',
    status: 'answered',
    answer: 'The powerhouse of the cell (Doc 1, page 1).',
    groundingWarning: false,
    docLabels: [{ label: 1, documentId: 'doc-a' }],
    citations: [{ chunkId: 'doc-a:0', documentId: 'doc-a', page: 1, rank: 0, score: 0.9 }],
    scope: 'document',
    tier: 'shared',
    provider: 'gemini',
    model: null,
    imageIncluded: false,
    webSearchRequested: false,
    webGrounded: false,
    failure: null,
    egress: [],
    ...overrides,
  }
}
