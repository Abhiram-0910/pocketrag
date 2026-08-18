import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attemptOcr, type FetchOcrFn } from './ocrRequest'

/** Mimics real fetch()'s abort behavior: never resolves on its own, rejects with AbortError when the signal fires. */
function hangingFetchOcr(): FetchOcrFn {
  return (_mimeType, _base64, signal) =>
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

describe('attemptOcr', () => {
  it('resolves with the transcribed text when fetchOcr succeeds', async () => {
    const fetchOcr: FetchOcrFn = vi.fn().mockResolvedValue({ text: 'Meeting notes: buy milk.' })

    const result = await attemptOcr(fetchOcr, 'image/jpeg', 'aGVsbG8=', 120_000)

    expect(result).toEqual({ outcome: 'success', text: 'Meeting notes: buy milk.' })
  })

  it('passes mimeType and base64 through to fetchOcr unchanged', async () => {
    const fetchOcr: FetchOcrFn = vi.fn().mockResolvedValue({ text: 'text' })

    await attemptOcr(fetchOcr, 'image/png', 'ZmFrZQ==', 120_000)

    expect(fetchOcr).toHaveBeenCalledWith('image/png', 'ZmFrZQ==', expect.any(AbortSignal))
  })

  it('times out and aborts the signal when fetchOcr hangs past the timeout', async () => {
    const fetchOcr = hangingFetchOcr()

    const resultPromise = attemptOcr(fetchOcr, 'image/jpeg', 'aGVsbG8=', 120_000)
    await vi.advanceTimersByTimeAsync(120_000)
    const result = await resultPromise

    expect(result).toEqual({ outcome: 'timeout' })
  })

  it('does not time out if fetchOcr resolves just before the deadline', async () => {
    const fetchOcr: FetchOcrFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ text: 'text' }), 119_000)
        }),
    )

    const resultPromise = attemptOcr(fetchOcr, 'image/jpeg', 'aGVsbG8=', 120_000)
    await vi.advanceTimersByTimeAsync(119_000)
    const result = await resultPromise

    expect(result.outcome).toBe('success')
  })

  it('returns a plain error outcome for a non-timeout failure', async () => {
    const fetchOcr: FetchOcrFn = vi.fn().mockRejectedValue(new Error('OCR request failed (502).'))

    const result = await attemptOcr(fetchOcr, 'image/jpeg', 'aGVsbG8=', 120_000)

    expect(result).toEqual({ outcome: 'error', message: 'OCR request failed (502).' })
  })

  it('a retry can succeed after the first attempt timed out', async () => {
    const first = attemptOcr(hangingFetchOcr(), 'image/jpeg', 'aGVsbG8=', 120_000)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await first).toEqual({ outcome: 'timeout' })

    const retryFetchOcr: FetchOcrFn = vi.fn().mockResolvedValue({ text: 'Recovered.' })
    const retry = await attemptOcr(retryFetchOcr, 'image/jpeg', 'aGVsbG8=', 120_000)

    expect(retry).toEqual({ outcome: 'success', text: 'Recovered.' })
  })
})
