import { describe, expect, it } from 'vitest'
import { createSseParser, readAnswerStream, type SseEvent } from './sse'

const body = (text: string, size = 5) => {
  const bytes = new TextEncoder().encode(text)
  let o = 0
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (o >= bytes.length) return c.close()
      c.enqueue(bytes.slice(o, o + size))
      o += size
    },
  })
}
const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

describe('createSseParser', () => {
  it('parses CRLF, comments and multi-line data, and drops an unterminated last event', () => {
    const out: SseEvent[] = []
    const p = createSseParser((e) => out.push(e))
    p.push(': keep-alive\r\nevent: delta\r\ndata: a\r\ndata: b\r\n\r\ndata: cut')
    expect(out).toEqual([{ event: 'delta', data: 'a\nb' }])
  })
})

describe('readAnswerStream', () => {
  it('collects meta, deltas (multi-byte characters split across chunks) and done', async () => {
    const deltas: string[] = []
    const text = ev('meta', { provider: 'gemini', model: 'm' }) + ev('delta', { t: 'माइटोकॉन्ड्रिया ' }) + ': ping\n\n' + ev('delta', { t: 'ATP (Doc 1, page 1).' }) + ev('done', { groundingWarning: false, docLabels: [] })
    const r = await readAnswerStream(body(text, 3), (t) => deltas.push(t))
    expect(r.text).toBe('माइटोकॉन्ड्रिया ATP (Doc 1, page 1).')
    expect(deltas).toHaveLength(2)
    expect(r.meta).toEqual({ provider: 'gemini', model: 'm' })
    expect(r.done).toEqual({ groundingWarning: false, docLabels: [] })
    expect(r.error).toBeNull()
  })

  it('reports an error event, and a cut-off stream as neither done nor error', async () => {
    const err = await readAnswerStream(body(ev('delta', { t: 'Part' }) + ev('error', { error: 'Worker copy', code: 'provider_unavailable' })), () => {})
    expect(err).toMatchObject({ text: 'Part', done: null, error: { error: 'Worker copy', code: 'provider_unavailable' } })
    const cut = await readAnswerStream(body(ev('delta', { t: 'Part' }) + 'event: delta\ndata: {"t":"lost'), () => {})
    expect(cut).toMatchObject({ text: 'Part', done: null, error: null })
  })

  it('rejects with the partial text when reading fails (an abort)', async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(ev('delta', { t: 'Half an ' })))
        controller.signal.addEventListener('abort', () => c.error(new DOMException('Aborted', 'AbortError')))
      },
    })
    const reading = readAnswerStream(stream, () => controller.abort())
    await expect(reading).rejects.toMatchObject({ name: 'AbortError', partial: 'Half an ' })
  })
})
