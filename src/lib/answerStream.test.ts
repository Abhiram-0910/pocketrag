import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EgressRecord } from './egress'

// The streamed /answer end to end on the client: fetch → egressStream → readAnswerStream →
// attemptAnswer's outcome, and the Receipt record's final outcome.
const API = 'https://worker.test'
const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const meta = ev('meta', { provider: 'gemini', model: 'gemini-3.5-flash-lite' })
const done = ev('done', { groundingWarning: true, docLabels: [{ label: 1, documentId: 'd' }] })
const CHUNKS = [{ text: 't', page: 1, score: 1, documentId: 'd' }]

function sseResponse(text: string, opts: { hang?: boolean; signal?: AbortSignal | null } = {}) {
  const bytes = new TextEncoder().encode(text)
  let o = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      // Like a real fetch body: aborting the request errors the stream.
      start(c) {
        opts.signal?.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')))
      },
      pull(c) {
        if (o >= bytes.length) return opts.hang ? new Promise(() => {}) : c.close()
        c.enqueue(bytes.slice(o, o + 9))
        o += 9
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  )
}

let mod: typeof import('./answerRequest')
beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_API_BASE_URL', API)
  mod = await import('./answerRequest')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function ask(response: Response | ((init: RequestInit) => Response), keyConfig: import('./answerRequest').KeyConfig = { keySource: 'shared' }, stopSignal?: AbortSignal) {
  const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => (typeof response === 'function' ? response(init) : response))
  vi.stubGlobal('fetch', fetchSpy)
  const records: EgressRecord[] = []
  const deltas: string[] = []
  const result = await mod.attemptAnswer(mod.fetchAnswerFromWorker, 'q', CHUNKS, keyConfig, 60_000, [], [], undefined, false, (r) => records.push(r), undefined, {
    onDelta: (t) => deltas.push(t),
    stopSignal,
  })
  const sent = JSON.parse(fetchSpy.mock.calls[0][1].body as string)
  return { result, records, deltas, sent, final: records.at(-1)! }
}

describe('streamed answers (v1.3)', () => {
  it('a complete stream is a success: servedBy from meta, the late citation verdict from done, Receipt ok', async () => {
    const { result, deltas, sent, final, records } = await ask(sseResponse(meta + ev('delta', { t: 'Mito ' }) + ev('delta', { t: 'ATP.' }) + done))
    expect(sent.stream).toBe(true)
    expect(result).toEqual({ outcome: 'success', answer: 'Mito ATP.', groundingWarning: true, docLabels: [{ label: 1, documentId: 'd' }], provider: 'gemini', model: 'gemini-3.5-flash-lite' })
    expect(deltas).toEqual(['Mito ', 'ATP.'])
    expect(final).toMatchObject({ outcome: 'ok', httpStatus: 200, purpose: 'answer' })
    // While it streamed, the row was in flight with its status, never 'ok' early.
    expect(records.filter((r) => r.outcome === 'ok')).toHaveLength(1)
    expect(records.some((r) => r.outcome === 'in-flight' && r.httpStatus === 200)).toBe(true)
  })

  it("a mid-stream error event is interrupted, with the Worker's copy verbatim and the partial text; Receipt interrupted", async () => {
    const { result, final } = await ask(sseResponse(meta + ev('delta', { t: 'Mito ' }) + ev('error', { error: "The free tier couldn't respond right now.", code: 'provider_unavailable' })))
    expect(result).toEqual({ outcome: 'interrupted', partial: 'Mito ', reason: 'error', message: "The free tier couldn't respond right now.", code: 'provider_unavailable' })
    expect(final.outcome).toBe('interrupted')
  })

  it('a stream cut off without done or error is interrupted with the client copy', async () => {
    const { result, final } = await ask(sseResponse(meta + ev('delta', { t: 'Mito ' })))
    expect(result).toMatchObject({ outcome: 'interrupted', partial: 'Mito ', reason: 'error', message: mod.STREAM_CUT_MESSAGE })
    expect(final.outcome).toBe('interrupted')
  })

  it('Stop mid-stream keeps the partial text as interrupted (stopped), never a success', async () => {
    const stop = new AbortController()
    const response = (init: RequestInit) => {
      const r = sseResponse(meta + ev('delta', { t: 'Half ' }), { hang: true, signal: init.signal })
      // Stop shortly after the first text arrives.
      setTimeout(() => stop.abort(), 20)
      return r
    }
    const { result, final } = await ask(response, { keySource: 'shared' }, stop.signal)
    expect(result).toEqual({ outcome: 'interrupted', partial: 'Half ', reason: 'stopped' })
    expect(final.outcome).toBe('interrupted')
  })

  it('an invalid servedBy in meta is dropped (the Receipt never shows it)', async () => {
    const { result } = await ask(sseResponse(ev('meta', { provider: 'evil', model: 'x y' }) + ev('delta', { t: 'A.' }) + done))
    expect(result).toMatchObject({ outcome: 'success', provider: undefined, model: undefined })
  })

  it('a failure before the first byte is the normal JSON error; a JSON 2xx is the non-streaming fallback', async () => {
    const failed = await ask(new Response(JSON.stringify({ error: 'Copy', code: 'provider_unavailable' }), { status: 502, headers: { 'Content-Type': 'application/json' } }))
    expect(failed.result).toMatchObject({ outcome: 'error', message: 'Copy', code: 'provider_unavailable', status: 502 })
    expect(failed.final.outcome).toBe('http-error')
    const json = await ask(new Response(JSON.stringify({ answer: 'Whole (Doc 1, page 1).', groundingWarning: false, docLabels: [], provider: 'grok', model: 'grok-4' }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    expect(json.result).toMatchObject({ outcome: 'success', answer: 'Whole (Doc 1, page 1).', provider: 'grok' })
    expect(json.final.outcome).toBe('ok')
  })

  it('Grok/OpenRouter and web search requests are not asked to stream', async () => {
    const grok = await ask(new Response(JSON.stringify({ answer: 'A', groundingWarning: false, docLabels: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }), {
      keySource: 'own',
      apiKey: 'key-12345678',
      provider: 'grok',
      model: 'grok-4',
    })
    expect(grok.sent.stream).toBeUndefined()
    expect(mod.canStream({ keySource: 'own', apiKey: 'k', provider: 'openrouter', model: 'm' }, false)).toBe(false)
    expect(mod.canStream({ keySource: 'own', apiKey: 'k', provider: 'anthropic', model: 'm' }, false)).toBe(true)
    expect(mod.canStream({ keySource: 'own', apiKey: 'k', provider: 'gemini', model: 'm' }, true)).toBe(false)
  })
})
