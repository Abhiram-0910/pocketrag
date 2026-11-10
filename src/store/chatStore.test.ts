import 'fake-indexeddb/auto'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EgressRecord } from '../lib/egress'
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
const SHARED_KEY = { tier: 'shared' as const, provider: 'gemini' as const, model: null }
const answered = (answer: string, webGrounded = false) => ({
  status: 'answered' as const,
  answer,
  groundingWarning: false,
  docLabels: [{ label: 1, documentId: 'doc-a' }],
  webGrounded,
})

const egressRecord = (id: string, overrides: Partial<EgressRecord> = {}): EgressRecord => ({
  id,
  purpose: 'answer',
  host: 'worker.test',
  finalHost: null,
  via: 'worker',
  upstream: 'gemini',
  method: 'POST',
  categories: ['question'],
  counts: { question: 1 },
  bytesSent: 10,
  startedAt: 1,
  durationMs: null,
  httpStatus: null,
  outcome: 'in-flight',
  ...overrides,
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

    await useChatStore.getState().retryTurn(turnId, SHARED_KEY)
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

  it('regenerate (v1.2): a sibling with the same question; a grounded one is never stored, and history skips the sibling branch', async () => {
    const q1 = await useChatStore.getState().startTurn(newTurn('Q1'))
    await useChatStore.getState().settleTurn(q1.turnId, answered('A1'))
    const q2 = await useChatStore.getState().startTurn(newTurn('Q2'))
    await useChatStore.getState().settleTurn(q2.turnId, answered('A2'))

    const regen = await useChatStore.getState().startTurn(newTurn('Q2', { parentId: q1.turnId }))
    expect(regen.history).toEqual([{ question: 'Q1', answer: 'A1' }])
    await useChatStore.getState().settleTurn(regen.turnId, answered('Grounded A2', true))
    const conversationId = useChatStore.getState().activeConversationId as string
    const stored = await getTurns(conversationId)
    expect(stored.find((t) => t.id === regen.turnId)).toMatchObject({ answer: null, webGrounded: true, question: 'Q2' })
    expect(stored.find((t) => t.id === q2.turnId)?.answer).toBe('A2')

    // A follow-up under the grounded regeneration sends only Q1/A1: not A2 (other branch),
    // not the grounded text.
    const next = await useChatStore.getState().startTurn(newTurn('Q3'))
    expect(next.history).toEqual([{ question: 'Q1', answer: 'A1' }])
  })

  it('the active branch survives a reload (v1.2)', async () => {
    const q1 = await useChatStore.getState().startTurn(newTurn('Q1'))
    await useChatStore.getState().settleTurn(q1.turnId, answered('A1'))
    const v1 = await useChatStore.getState().startTurn(newTurn('Q2'))
    await useChatStore.getState().settleTurn(v1.turnId, answered('A2'))
    const v2 = await useChatStore.getState().startTurn(newTurn('Q2 edited', { parentId: q1.turnId }))
    await useChatStore.getState().settleTurn(v2.turnId, answered('A2 edited'))
    await useChatStore.getState().selectBranch(v1.turnId)

    // A fresh load: memory cleared, then restore() from IndexedDB.
    useChatStore.setState({ conversations: [], activeConversationId: null, turns: [] })
    await useChatStore.getState().restore()
    const s = useChatStore.getState()
    expect(s.conversations.find((c) => c.id === s.activeConversationId)?.activeLeafId).toBe(v1.turnId)
    expect(s.turns).toHaveLength(3)
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
    expect(state.groundedSession.has(turnId)).toBe(false)
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

  it('settleTurn after a conversation switch persists the turn and leaves the open conversation alone', async () => {
    const a = await useChatStore.getState().startTurn(newTurn('Question in A'))
    const conversationA = useChatStore.getState().activeConversationId as string
    useChatStore.getState().newConversation()
    const b = await useChatStore.getState().startTurn(newTurn('Question in B'))
    await useChatStore.getState().settleTurn(b.turnId, answered('Answer in B'))
    const turnsInB = useChatStore.getState().turns

    await expect(useChatStore.getState().settleTurn(a.turnId, answered('Answer in A'))).resolves.toBeUndefined()

    expect(useChatStore.getState().turns).toEqual(turnsInB)
    expect((await getTurns(conversationA))[0]).toMatchObject({ id: a.turnId, status: 'answered', answer: 'Answer in A' })
    await useChatStore.getState().openConversation(conversationA)
    expect(useChatStore.getState().turns[0]).toMatchObject({ status: 'answered', answer: 'Answer in A' })
  })

  it('appendEgress persists for a turn whose conversation is no longer open', async () => {
    const a = await useChatStore.getState().startTurn(newTurn('Q'))
    const conversationA = useChatStore.getState().activeConversationId as string
    useChatStore.getState().newConversation()

    await useChatStore.getState().appendEgress(a.turnId, egressRecord('r1', { outcome: 'ok', httpStatus: 200 }))

    expect((await getTurns(conversationA))[0].egress).toEqual([egressRecord('r1', { outcome: 'ok', httpStatus: 200 })])
  })

  it('appendEgress replaces the in-flight copy with the settled one, and a retry adds its own record', async () => {
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Q'))
    await useChatStore.getState().appendEgress(turnId, egressRecord('r1'))
    await useChatStore.getState().appendEgress(turnId, egressRecord('r1', { outcome: 'http-error', httpStatus: 502 }))
    await useChatStore.getState().settleTurn(turnId, {
      status: 'failed',
      failure: { kind: 'provider-unavailable', message: 'x', httpStatus: 502, code: 'provider_unavailable' },
    })
    await useChatStore.getState().retryTurn(turnId, SHARED_KEY)
    await useChatStore.getState().appendEgress(turnId, egressRecord('r2', { outcome: 'ok', httpStatus: 200 }))
    await useChatStore.getState().settleTurn(turnId, answered('A'))

    const [stored] = await getTurns(useChatStore.getState().activeConversationId as string)
    expect(stored.egress.map((r) => [r.id, r.outcome, r.httpStatus])).toEqual([
      ['r1', 'http-error', 502],
      ['r2', 'ok', 200],
    ])
    expect(stored.status).toBe('answered')
  })

  it('a conversation deleted mid-request is not brought back when its turn settles', async () => {
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Q'))
    const id = useChatStore.getState().activeConversationId as string
    await useChatStore.getState().deleteConversation(id)

    await useChatStore.getState().appendEgress(turnId, egressRecord('r1'))
    await useChatStore.getState().settleTurn(turnId, answered('A'))

    expect(await getTurns(id)).toEqual([])
    await useChatStore.getState().restore()
    expect(useChatStore.getState().conversations.some((c) => c.id === id)).toBe(false)
  })

  it('deleting a non-active conversation frees its grounded session entries', async () => {
    const a = await useChatStore.getState().startTurn(newTurn('Q in A', { webSearchRequested: true }))
    await useChatStore.getState().settleTurn(a.turnId, answered('Grounded A', true))
    const conversationA = useChatStore.getState().activeConversationId as string
    useChatStore.getState().newConversation()
    const b = await useChatStore.getState().startTurn(newTurn('Q in B', { webSearchRequested: true }))
    await useChatStore.getState().settleTurn(b.turnId, answered('Grounded B', true))

    await useChatStore.getState().deleteConversation(conversationA)

    const { groundedSession } = useChatStore.getState()
    expect(groundedSession.has(a.turnId)).toBe(false)
    expect(groundedSession.get(b.turnId)?.answer).toBe('Grounded B')
  })

  it('keeps a grounded turn\'s web sources and Search Suggestions in the session map, never in the record', async () => {
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Q', { tier: 'own', provider: 'gemini', model: 'm' }))
    await useChatStore.getState().settleTurn(turnId, {
      ...answered('Grounded result text', true),
      webSources: [{ uri: 'https://example.com', title: 'Example' }],
      searchEntryPointHtml: '<div>chips</div>',
    })

    expect(useChatStore.getState().groundedSession.get(turnId)).toMatchObject({
      webSources: [{ uri: 'https://example.com', title: 'Example' }],
      searchEntryPointHtml: '<div>chips</div>',
    })
    const [stored] = await getTurns(useChatStore.getState().activeConversationId as string)
    expect(JSON.stringify(stored)).not.toMatch(/example\.com|chips|Grounded result text/)
  })

  it("records the Worker-echoed model on settle, replacing the shared tier's null", async () => {
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Q'))
    await useChatStore.getState().settleTurn(turnId, { ...answered('A'), model: 'gemini-3.5-flash-lite' })
    expect((await getTurns(useChatStore.getState().activeConversationId as string))[0].model).toBe('gemini-3.5-flash-lite')
  })

  it('restore() opens the most recent conversation', async () => {
    const older = await useChatStore.getState().startTurn(newTurn('Older question'))
    await useChatStore.getState().settleTurn(older.turnId, answered('Older answer'))
    // updatedAt has millisecond resolution; same-millisecond ties fall back to the random id.
    await new Promise((resolve) => setTimeout(resolve, 5))
    useChatStore.getState().newConversation()
    const newer = await useChatStore.getState().startTurn(newTurn('Newer question'))
    await useChatStore.getState().settleTurn(newer.turnId, answered('Newer answer'))
    const newerId = useChatStore.getState().activeConversationId

    useChatStore.setState(useChatStore.getInitialState())
    await useChatStore.getState().restore()

    expect(useChatStore.getState().activeConversationId).toBe(newerId)
    expect(useChatStore.getState().turns.map((t) => t.question)).toEqual(['Newer question'])
  })

  it("restore() doesn't switch away from a conversation the user started while it loaded", async () => {
    useChatStore.setState(useChatStore.getInitialState())
    const restoring = useChatStore.getState().restore()
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Typed fast'))
    await restoring
    expect(useChatStore.getState().turns.map((t) => t.id)).toEqual([turnId])
  })

  it("retryTurn returns the request context from the turn's ancestors and records the key now in use", async () => {
    const q1 = await useChatStore.getState().startTurn(newTurn('Q1'))
    await useChatStore.getState().settleTurn(q1.turnId, answered('A1'))
    const q2 = await useChatStore.getState().startTurn(newTurn('Q2'))
    await useChatStore.getState().settleTurn(q2.turnId, { status: 'timed-out' })

    const ctx = await useChatStore.getState().retryTurn(q2.turnId, { tier: 'own', provider: 'openai', model: 'gpt-x' })

    expect(ctx).toEqual({
      turnId: q2.turnId,
      history: [{ question: 'Q1', answer: 'A1' }],
      docLabels: [{ label: 1, documentId: 'doc-a' }],
      previousQuestion: 'Q1',
    })
    const stored = (await getTurns(useChatStore.getState().activeConversationId as string)).find((t) => t.id === q2.turnId)
    expect(stored).toMatchObject({ status: 'pending', tier: 'own', provider: 'openai', model: 'gpt-x' })
    expect(await useChatStore.getState().retryTurn('no-such-turn', SHARED_KEY)).toBeNull()
  })

  it('records the echoed provider as well as the model', async () => {
    const { turnId } = await useChatStore.getState().startTurn(newTurn('Q'))
    await useChatStore.getState().settleTurn(turnId, { ...answered('A'), provider: 'gemini', model: 'gemini-3.5-flash-lite' })
    expect(useChatStore.getState().turns[0]).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash-lite' })
  })
})
