import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attemptAnswer, type FetchAnswerFn, type KeyConfig } from './answerRequest'
import { WorkerRequestError } from './apiError'

const CHUNKS = [{ text: 'The mitochondrion is the powerhouse of the cell.', page: 1, score: 0.9, documentId: 'doc-1' }]
const DOC_LABELS = [{ label: 1, documentId: 'doc-1' }]
const SHARED_CONFIG: KeyConfig = { keySource: 'shared' }

/** Mimics real fetch()'s abort behavior: never resolves on its own, rejects with AbortError when the signal fires. */
function hangingFetchAnswer(): FetchAnswerFn {
  return (_question, _chunks, _keyConfig, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'))
      })
    })
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attemptAnswer', () => {
  it('resolves with the answer when fetchAnswer succeeds', async () => {
    const fetchAnswer: FetchAnswerFn = vi
      .fn()
      .mockResolvedValue({ answer: 'The cell (Doc 1, page 1).', groundingWarning: false, docLabels: DOC_LABELS })

    const result = await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)

    expect(result).toEqual({
      outcome: 'success',
      answer: 'The cell (Doc 1, page 1).',
      groundingWarning: false,
      docLabels: DOC_LABELS,
    })
  })

  it('passes the keyConfig through to fetchAnswer unchanged', async () => {
    const byokConfig: KeyConfig = { keySource: 'own', apiKey: 'user-key', provider: 'gemini', model: 'gemini-3.5-pro' }
    const fetchAnswer: FetchAnswerFn = vi
      .fn()
      .mockResolvedValue({ answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS })

    await attemptAnswer(fetchAnswer, 'q', CHUNKS, byokConfig, 60_000)

    expect(fetchAnswer).toHaveBeenCalledWith(
      'q',
      CHUNKS,
      byokConfig,
      expect.any(AbortSignal),
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it('passes the prior-turn docLabels through to fetchAnswer unchanged, and defaults to []', async () => {
    const fetchAnswer: FetchAnswerFn = vi
      .fn()
      .mockResolvedValue({ answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS })

    await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000, DOC_LABELS)
    expect(fetchAnswer).toHaveBeenCalledWith(
      'q',
      CHUNKS,
      SHARED_CONFIG,
      expect.any(AbortSignal),
      DOC_LABELS,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    )

    await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
    expect(fetchAnswer).toHaveBeenLastCalledWith(
      'q',
      CHUNKS,
      SHARED_CONFIG,
      expect.any(AbortSignal),
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it('passes the prior-turn history through to fetchAnswer unchanged, and defaults to []', async () => {
    const history = [{ question: 'What is the mitochondrion?', answer: 'The powerhouse of the cell (Doc 1, page 1).' }]
    const fetchAnswer: FetchAnswerFn = vi
      .fn()
      .mockResolvedValue({ answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS })

    await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000, DOC_LABELS, history)
    expect(fetchAnswer).toHaveBeenCalledWith(
      'q',
      CHUNKS,
      SHARED_CONFIG,
      expect.any(AbortSignal),
      DOC_LABELS,
      history,
      undefined,
      undefined,
      undefined,
      undefined,
    )

    await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
    expect(fetchAnswer).toHaveBeenLastCalledWith(
      'q',
      CHUNKS,
      SHARED_CONFIG,
      expect.any(AbortSignal),
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it('passes an image through to fetchAnswer unchanged, and defaults to undefined (Milestone 10 Phase B)', async () => {
    const image = { mimeType: 'image/jpeg', base64: 'aGVsbG8=' }
    const fetchAnswer: FetchAnswerFn = vi
      .fn()
      .mockResolvedValue({ answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS })

    await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000, DOC_LABELS, [], image)
    expect(fetchAnswer).toHaveBeenCalledWith(
      'q',
      CHUNKS,
      SHARED_CONFIG,
      expect.any(AbortSignal),
      DOC_LABELS,
      [],
      image,
      undefined,
      undefined,
      undefined,
    )

    await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
    expect(fetchAnswer).toHaveBeenLastCalledWith(
      'q',
      CHUNKS,
      SHARED_CONFIG,
      expect.any(AbortSignal),
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
    )
  })

  it('passes followMethod through to fetchAnswer (v1.1 worked examples), undefined by default', async () => {
    const fetchAnswer: FetchAnswerFn = vi
      .fn()
      .mockResolvedValue({ answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS })
    await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000, [], [], undefined, undefined, undefined, true)
    expect(vi.mocked(fetchAnswer).mock.calls[0][9]).toBe(true)
    await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
    expect(vi.mocked(fetchAnswer).mock.calls[1][9]).toBeUndefined()
  })

  describe('enableWebSearch (Milestone 12, Gemini-native grounding)', () => {
    it('passes enableWebSearch through to fetchAnswer unchanged, and defaults to undefined', async () => {
      const fetchAnswer: FetchAnswerFn = vi
        .fn()
        .mockResolvedValue({ answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS })

      await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000, DOC_LABELS, [], undefined, true)
      expect(fetchAnswer).toHaveBeenCalledWith(
        'q',
        CHUNKS,
        SHARED_CONFIG,
        expect.any(AbortSignal),
        DOC_LABELS,
        [],
        undefined,
        true,
        undefined,
        undefined,
      )

      await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
      expect(fetchAnswer).toHaveBeenLastCalledWith(
        'q',
        CHUNKS,
        SHARED_CONFIG,
        expect.any(AbortSignal),
        [],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
      )
    })

    it('surfaces webSources and searchEntryPointHtml from a successful grounded response', async () => {
      const webSources = [{ uri: 'https://example.com/result', title: 'Result' }]
      const fetchAnswer: FetchAnswerFn = vi.fn().mockResolvedValue({
        answer: 'answer',
        groundingWarning: false,
        docLabels: DOC_LABELS,
        webSources,
        searchEntryPointHtml: '<div>widget</div>',
      })

      const result = await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000, [], [], undefined, true)

      expect(result).toEqual({
        outcome: 'success',
        answer: 'answer',
        groundingWarning: false,
        docLabels: DOC_LABELS,
        webSources,
        searchEntryPointHtml: '<div>widget</div>',
      })
    })

    it('leaves webSources/searchEntryPointHtml undefined when the response omits them (non-grounded answer)', async () => {
      const fetchAnswer: FetchAnswerFn = vi
        .fn()
        .mockResolvedValue({ answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS })

      const result = await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)

      expect(result).toEqual({ outcome: 'success', answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS })
    })
  })

  it('times out and aborts the signal when fetchAnswer hangs past the timeout', async () => {
    const fetchAnswer = hangingFetchAnswer()

    const resultPromise = attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await resultPromise

    expect(result).toEqual({ outcome: 'timeout' })
  })

  it('does not time out if fetchAnswer resolves just before the deadline', async () => {
    const fetchAnswer: FetchAnswerFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ answer: 'answer', groundingWarning: false, docLabels: DOC_LABELS }), 59_000)
        }),
    )

    const resultPromise = attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
    await vi.advanceTimersByTimeAsync(59_000)
    const result = await resultPromise

    expect(result.outcome).toBe('success')
  })

  it('returns a plain error outcome for a non-timeout failure', async () => {
    const fetchAnswer: FetchAnswerFn = vi.fn().mockRejectedValue(new Error('Answer request failed (502).'))

    const result = await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)

    expect(result).toEqual({ outcome: 'error', message: 'Answer request failed (502).' })
  })

  it('the retry path works identically to the first attempt — no leftover state between calls', async () => {
    const fetchAnswer = hangingFetchAnswer()

    const first = attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await first).toEqual({ outcome: 'timeout' })

    // Retry: a fresh call with a fresh hanging fetch, same question/chunks — must also time out cleanly.
    const retryFetchAnswer = hangingFetchAnswer()
    const retry = attemptAnswer(retryFetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await retry).toEqual({ outcome: 'timeout' })
  })

  it('a retry can succeed after the first attempt timed out', async () => {
    const first = attemptAnswer(hangingFetchAnswer(), 'q', CHUNKS, SHARED_CONFIG, 60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await first).toEqual({ outcome: 'timeout' })

    const retryFetchAnswer: FetchAnswerFn = vi
      .fn()
      .mockResolvedValue({ answer: 'Recovered.', groundingWarning: false, docLabels: DOC_LABELS })
    const retry = await attemptAnswer(retryFetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)

    expect(retry).toEqual({ outcome: 'success', answer: 'Recovered.', groundingWarning: false, docLabels: DOC_LABELS })
  })

  it('passes a provider failure\'s status, code and source through to the error outcome', async () => {
    const message = 'The free shared tier is at capacity right now. Try again later, or use your own API key.'
    const fetchAnswer: FetchAnswerFn = vi
      .fn()
      .mockRejectedValue(new WorkerRequestError(message, 502, undefined, 'provider_rate_limited', 'shared'))

    const result = await attemptAnswer(fetchAnswer, 'q', CHUNKS, SHARED_CONFIG, 60_000)

    expect(result).toEqual({
      outcome: 'error',
      message,
      status: 502,
      resetAt: undefined,
      code: 'provider_rate_limited',
      source: 'shared',
    })
  })
})
