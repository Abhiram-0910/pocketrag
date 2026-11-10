import { describe, expect, it } from 'vitest'
import { ADAPTERS, createSseParser, pump, type SseEvent, type StreamingProvider } from './stream'
import { ANSWER, SSE, chunked } from './fixtures/sseStreams'

function parseAll(text: string): SseEvent[] {
  const events: SseEvent[] = []
  const parser = createSseParser((e) => events.push(e))
  for (let i = 0; i < text.length; i += 3) parser.push(text.slice(i, i + 3))
  return events
}

// Runs pump over a provider fixture and returns our events, decoded.
async function run(provider: StreamingProvider, body: string, size = 7) {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const failures: string[] = []
  const done = pump(chunked(body, size), ADAPTERS[provider], writable.getWriter(), { provider, model: 'm' }, {
    onComplete: (text) => ({ text }),
    onFailure: (reason) => {
      failures.push(reason)
      return { error: 'fixed copy', code: 'provider_unavailable' }
    },
  })
  const out = parseAll(await new Response(readable).text())
  await done
  return { events: out.map((e) => ({ event: e.event, data: JSON.parse(e.data) })), failures }
}

describe('createSseParser', () => {
  it('handles CRLF, comments, multi-line data, named events, and events cut across chunks', () => {
    const events = parseAll(': hello\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: x\n\n: keep-alive\n\n')
    expect(events).toEqual([
      { event: 'a', data: 'one\ntwo' },
      { event: 'message', data: 'x' },
    ])
  })

  it('discards a trailing event that never got its blank line', () => {
    expect(parseAll('data: complete\n\ndata: cut off')).toEqual([{ event: 'message', data: 'complete' }])
  })
})

describe.each(['gemini', 'openai', 'anthropic'] as const)('pump: %s', (provider) => {
  it('streams meta, the deltas in order, then done with the complete text', async () => {
    const { events, failures } = await run(provider, SSE[provider].complete)
    expect(events[0]).toEqual({ event: 'meta', data: { provider, model: 'm' } })
    const text = events.filter((e) => e.event === 'delta').map((e) => e.data.t).join('')
    expect(text).toBe(ANSWER)
    expect(events.at(-1)).toEqual({ event: 'done', data: { text: ANSWER } })
    expect(failures).toEqual([])
  })

  it('ignores keep-alives (comments, Anthropic ping), even with CRLF and 1-byte chunks', async () => {
    const { events } = await run(provider, SSE[provider].keepAlive, 1)
    expect(events.filter((e) => e.event === 'delta').map((e) => e.data.t).join('')).toBe(ANSWER)
    expect(events.at(-1)?.event).toBe('done')
  })

  it.each([
    ['truncated', 'stream ended early'],
    ['malformed', 'malformed event'],
    ['errorEvent', 'provider error event'],
  ] as const)('%s → one error event with the fixed copy, after the text that did arrive', async (kind, reason) => {
    const { events, failures } = await run(provider, SSE[provider][kind])
    expect(events.at(-1)).toEqual({ event: 'error', data: { error: 'fixed copy', code: 'provider_unavailable' } })
    expect(events.filter((e) => e.event === 'done')).toEqual([])
    expect(failures).toEqual([reason])
    // Nothing from the provider's error text reaches our stream.
    expect(JSON.stringify(events)).not.toMatch(/Internal error|server had an error|Overloaded/)
  })
})

describe('pump: the client goes away (Stop)', () => {
  it('cancels the provider stream and reports nothing', async () => {
    let cancelled = false
    let sent = 0
    const upstream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // An endless provider stream: it only ends if we cancel it.
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: `x${sent++}` }] } }] })}\n\n`))
      },
      cancel() {
        cancelled = true
      },
    })
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const failures: string[] = []
    const done = pump(upstream, ADAPTERS.gemini, writable.getWriter(), {}, {
      onComplete: () => ({}),
      onFailure: (r) => (failures.push(r), { error: '', code: '' }),
    })
    const reader = readable.getReader()
    await reader.read() // meta
    await reader.read() // first delta
    await reader.cancel()
    await done
    expect(cancelled).toBe(true)
    expect(failures).toEqual([])
  })
})
