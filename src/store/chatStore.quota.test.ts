import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { saveTurn } from '../lib/historyDb'
import { answerFor, useChatStore } from './chatStore'

vi.mock('../lib/historyDb', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/historyDb')>()),
  saveTurn: vi.fn(),
}))

const newTurn = {
  question: 'Q1',
  citations: [],
  scope: 'all' as const,
  tier: 'shared' as const,
  provider: 'gemini' as const,
  model: null,
  imageIncluded: false,
  webSearchRequested: false,
}

describe('chatStore when a history write fails', () => {
  it('QuotaExceededError flips storage to quota and keeps the conversation and answer in memory', async () => {
    vi.mocked(saveTurn).mockRejectedValue(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))

    const { turnId } = await useChatStore.getState().startTurn(newTurn)
    expect(useChatStore.getState().storage).toBe('quota')
    await useChatStore.getState().settleTurn(turnId, {
      status: 'answered',
      answer: 'A1',
      groundingWarning: false,
      docLabels: [],
      webGrounded: false,
    })

    const state = useChatStore.getState()
    expect(state.turns).toHaveLength(1)
    expect(answerFor(state, state.turns[0])).toBe('A1')
  })

  it('any other write error flips storage to unavailable', async () => {
    useChatStore.setState(useChatStore.getInitialState())
    vi.mocked(saveTurn).mockRejectedValue(new Error('InvalidStateError'))
    await useChatStore.getState().startTurn(newTurn)
    expect(useChatStore.getState().storage).toBe('unavailable')
  })
})
