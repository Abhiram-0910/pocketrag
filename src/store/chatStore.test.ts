import 'fake-indexeddb/auto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { STALE_PENDING_MS, getTurns, saveTurn } from '../lib/historyDb'
import { makeConversation, makeTurn } from '../lib/historyFixtures'
import { answerFor, useChatStore, type NewTurn } from './chatStore'

const newTurn = (question: string, overrides: Partial<NewTurn> = {}): NewTurn => ({
  question,
  citations: [{ chunkId: 'doc-a:0', documentId: 'doc-a', page: 1, rank: 0, score: 0.9 }],
  scope: 'document',
  tier: 'shared',
  provider: 'gemini',
  model: null,
  imageIncluded: false,
  webSearchRequested: false,
  ...overrides,
})
const answered = (answer: string, webGrounded = false) => ({
  status: 'answered' as const,
  answer,
  groundingWarning: false,
  docLabels: [{ label: 1, documentId: 'doc-a' }],
  webGrounded,
})

// A page reload: memory gone, everything comes back from IndexedDB.
async function reload(conversationId: string) {
  useChatStore.setState(useChatStore.getInitialState())
  await useChatStore.getState().restore()
  await useChatStore.getState().openConversation(conversationId)
}

describe('chatStore', () => {
  beforeEach(() => useChatStore.setState(useChatStore.getInitialState()))

  it('starts a conversation on the first turn and persists the turn as pending before any request', async () => {
    const ctx = await useChatStore.getState().startTurn(newTurn('Q1'))
    expect(ctx.history).toEqual([])
    expect(ctx.docLabels).toEqual([])
    expect(ctx.previousQuestion).toBeNull()

    const { activeConversationId, conversations } = useChatStore.getState()
    expect(conversations[0]).toMatchObject({ id: activeConversationId, title: 'Q1', activeLeafId: ctx.turnId })
    const [stored] = await getTurns(activeConversationId as string)
    expect(stored).toMatchObject({ id: ctx.turnId, status: 'pending', parentId: null, answer: null })
  })

  it("builds the next turn's history, Doc N map and blend question from the answered parent", async () => {
    const first = await useChatStore.getState().startTurn(newTurn('Q1'))
    await useChatStore.getState().settleTurn(first.turnId, answered('A1'))
    const second = await useChatStore.getState().startTurn(newTurn('Q2'))

    expect(second.history).toEqual([{ question: 'Q1', answer: 'A1' }])
    expect(second.docLabels).toEqual([{ label: 1, documentId: 'doc-a' }])
    expect(second.previousQuestion).toBe('Q1')
    const turns = useChatStore.getState().turns
    expect(turns.find((t) => t.id === second.turnId)?.parentId).toBe(first.turnId)
  })

  it('keeps a grounded answer in memory only: stored null, excluded from history, gone after reload', async () => {
    const first = await useChatStore.getState().startTurn(newTurn('Q1', { webSearchRequested: true }))
    await useChatStore.getState().settleTurn(first.turnId, answered('Grounded A1', true))

    const state = useChatStore.getState()
    const turn = state.turns.find((t) => t.id === first.turnId)!
    expect(turn.answer).toBeNull()
    expect(answerFor(state, turn)).toBe('Grounded A1')
    const conversationId = state.activeConversationId as string
    const [stored] = await getTurns(conversationId)
    expect(stored).toMatchObject({ answer: null, webGrounded: true, status: 'answered' })

    const second = await useChatStore.getState().startTurn(newTurn('Q2'))
    expect(second.history).toEqual([])

    await reload(conversationId)
    const restored = useChatStore.getState().turns.find((t) => t.id === first.turnId)!
    expect(answerFor(useChatStore.getState(), restored)).toBeNull()
  })

  it('persists a failure with its Worker copy and code, and retry reuses the same turn', async () => {
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Q1', { tier: 'own', provider: 'openai', model: 'gpt-x' }))
    const failure = {
      kind: 'provider-unavailable' as const,
      message: "The provider rejected your API key. Check that it's correct, active, and has access to this model.",
      httpStatus: 502,
      code: 'key_rejected' as const,
    }
    await useChatStore.getState().settleTurn(turnId, { status: 'failed', failure })
    const conversationId = useChatStore.getState().activeConversationId as string
    expect((await getTurns(conversationId))[0]).toMatchObject({ status: 'failed', failure, model: 'gpt-x' })

    await useChatStore.getState().retryTurn(turnId)
    const stored = await getTurns(conversationId)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ id: turnId, status: 'pending', failure: null })
  })

  it('records a timeout as its own status', async () => {
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Q1'))
    await useChatStore.getState().settleTurn(turnId, { status: 'timed-out' })
    expect(useChatStore.getState().turns[0].status).toBe('timed-out')
  })

  it('branches: a turn started with an existing parentId becomes a sibling, with history from that parent', async () => {
    const q1 = await useChatStore.getState().startTurn(newTurn('Q1'))
    await useChatStore.getState().settleTurn(q1.turnId, answered('A1'))
    const q2 = await useChatStore.getState().startTurn(newTurn('Q2'))
    await useChatStore.getState().settleTurn(q2.turnId, answered('A2'))

    const edit = await useChatStore.getState().startTurn(newTurn('Q2 edited', { parentId: q1.turnId }))
    expect(edit.history).toEqual([{ question: 'Q1', answer: 'A1' }])
    const { turns, conversations } = useChatStore.getState()
    expect(turns.filter((t) => t.parentId === q1.turnId).map((t) => t.question)).toEqual(['Q2', 'Q2 edited'])
    expect(conversations[0].activeLeafId).toBe(edit.turnId)

    await useChatStore.getState().selectBranch(q2.turnId)
    expect(useChatStore.getState().conversations[0].activeLeafId).toBe(q2.turnId)
  })

  it('restore() sweeps a stale pending turn to interrupted and lists the conversation', async () => {
    await saveTurn(
      makeConversation({ id: 'c-stale', updatedAt: Date.now() }),
      makeTurn({ id: 't-stale', conversationId: 'c-stale', status: 'pending', createdAt: Date.now() - STALE_PENDING_MS - 1 }),
    )
    await reload('c-stale')
    expect(useChatStore.getState().conversations.some((c) => c.id === 'c-stale')).toBe(true)
    expect(useChatStore.getState().turns[0].status).toBe('interrupted')
  })

  it('a restored answer carrying an <img onerror> payload renders as inert text, like a live answer', async () => {
    const payload = '<img src=x onerror="alert(1)">'
    await saveTurn(makeConversation({ id: 'c-xss' }), makeTurn({ id: 't-xss', conversationId: 'c-xss', answer: payload }))
    await reload('c-xss')

    const restored = useChatStore.getState().turns[0]
    // QueryPanel renders every answer — live or past — as a React text child of a <p>.
    const live = renderToStaticMarkup(createElement('p', null, payload))
    const html = renderToStaticMarkup(createElement('p', null, answerFor(useChatStore.getState(), restored)))
    expect(html).toBe(live)
    expect(html).toContain('&lt;img')
    expect(html).not.toContain('<img')
  })

  it('deleteConversation removes it from memory and from IndexedDB', async () => {
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Q1', { webSearchRequested: true }))
    await useChatStore.getState().settleTurn(turnId, answered('Grounded', true))
    const id = useChatStore.getState().activeConversationId as string

    await useChatStore.getState().deleteConversation(id)

    const state = useChatStore.getState()
    expect(state.conversations.some((c) => c.id === id)).toBe(false)
    expect(state.activeConversationId).toBeNull()
    expect(state.turns).toEqual([])
    expect(state.groundedText.has(turnId)).toBe(false)
    expect(await getTurns(id)).toEqual([])
  })

  it('deleteAllHistory empties memory and IndexedDB', async () => {
    await useChatStore.getState().startTurn(newTurn('Q1'))
    const id = useChatStore.getState().activeConversationId as string
    await useChatStore.getState().deleteAllHistory()
    expect(useChatStore.getState().conversations).toEqual([])
    expect(await getTurns(id)).toEqual([])
    await useChatStore.getState().restore()
    expect(useChatStore.getState().conversations).toEqual([])
  })
})
