import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROVIDERS, PROVIDER_HOSTS } from './models'
import { parseServedBy } from './answerRequest'
import { SUPPORTED_PROVIDERS } from '../../worker/src/validate'
import { API_BASE as ANTHROPIC } from '../../worker/src/providers/anthropic'
import { API_BASE as GEMINI } from '../../worker/src/providers/gemini'
import { API_BASE as GROK } from '../../worker/src/providers/grok'
import { API_BASE as OPENAI } from '../../worker/src/providers/openai'
import { API_BASE as OPENROUTER } from '../../worker/src/providers/openrouter'

// Test-only imports of Worker code, like failureCodes.test.ts — the app never imports it.
describe('provider parity with the Worker', () => {
  it('PROVIDERS matches worker/src/validate.ts SUPPORTED_PROVIDERS', () => {
    expect([...PROVIDERS].sort()).toEqual([...SUPPORTED_PROVIDERS].sort())
  })

  it("PROVIDER_HOSTS is each provider file's API_BASE host — what Receipts show as 'Then to'", () => {
    expect(PROVIDER_HOSTS).toEqual({
      gemini: new URL(GEMINI).host,
      openai: new URL(OPENAI).host,
      anthropic: new URL(ANTHROPIC).host,
      grok: new URL(GROK).host,
      openrouter: new URL(OPENROUTER).host,
    })
  })
})

describe('parseServedBy (the Worker’s provider/model echo)', () => {
  it('keeps a well-formed echo', () => {
    expect(parseServedBy({ provider: 'gemini', model: 'gemini-3.5-flash-lite' })).toEqual({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
    })
    expect(parseServedBy({ provider: 'openrouter', model: '~anthropic/claude-x:free' })?.model).toBe('~anthropic/claude-x:free')
  })

  it('drops a missing, unknown or malformed echo', () => {
    expect(parseServedBy({})).toBeUndefined()
    expect(parseServedBy({ provider: 'gemini' })).toBeUndefined()
    expect(parseServedBy({ provider: 'evil', model: 'm' })).toBeUndefined()
    expect(parseServedBy({ provider: 'gemini', model: '<img src=x onerror=alert(1)>' })).toBeUndefined()
    expect(parseServedBy({ provider: 'gemini', model: 'x'.repeat(129) })).toBeUndefined()
    expect(parseServedBy({ provider: 'gemini', model: 42 })).toBeUndefined()
  })
})

describe('fetchAnswerFromWorker → the echo on the result', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  async function answerWith(body: Record<string, unknown>) {
    vi.stubEnv('VITE_API_BASE_URL', 'https://worker.test')
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ answer: 'a', groundingWarning: false, docLabels: [], ...body })))
    const { attemptAnswer, fetchAnswerFromWorker } = await import('./answerRequest')
    return attemptAnswer(fetchAnswerFromWorker, 'q', [], { keySource: 'shared' }, 60_000, [], [], undefined, undefined, () => {})
  }

  it('passes a valid echo through attemptAnswer', async () => {
    expect(await answerWith({ provider: 'gemini', model: 'gemini-3.5-flash-lite' })).toMatchObject({
      outcome: 'success',
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
    })
  })

  it('an older Worker (no echo) or a malformed one leaves provider and model undefined', async () => {
    for (const body of [{}, { provider: 'gemini', model: 'bad model' }]) {
      const result = await answerWith(body)
      expect(result.outcome).toBe('success')
      expect(result).not.toMatchObject({ provider: expect.anything() })
      expect(result).not.toMatchObject({ model: expect.anything() })
    }
  })
})
