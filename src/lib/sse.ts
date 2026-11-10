// v1.3: reads the Worker's answer stream (worker/src/stream.ts). The frontend never imports
// Worker code, so the small parser is duplicated here; both sides are tested on the same
// wire format.
//
//   meta  {provider, model}             delta {t}
//   done  {groundingWarning, docLabels}  error {error, code}

export interface SseEvent {
  event: string
  data: string
}

export function createSseParser(onEvent: (event: SseEvent) => void) {
  let buffer = ''
  let event = ''
  let data: string[] = []
  return {
    push(chunk: string) {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line === '') {
          if (data.length > 0) onEvent({ event: event || 'message', data: data.join('\n') })
          event = ''
          data = []
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        let value = colon === -1 ? '' : line.slice(colon + 1)
        if (value.startsWith(' ')) value = value.slice(1)
        if (field === 'data') data.push(value)
        else if (field === 'event') event = value
      }
    },
  }
}

export interface StreamedAnswer {
  text: string
  meta: { provider?: unknown; model?: unknown } | null
  done: { groundingWarning?: unknown; docLabels?: unknown } | null
  error: { error?: unknown; code?: unknown } | null
}

/**
 * Reads the stream to its end, calling `onDelta` with each piece of text and `onActivity`
 * on every chunk (keep-alives included, for an idle timeout). Resolves with what arrived;
 * `done` null and `error` null means it was cut off. Rejects only if reading itself fails
 * (an abort — Stop or the timeout — or the network), with `partial` set to the text so far.
 */
export async function readAnswerStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  onActivity: () => void = () => {},
): Promise<StreamedAnswer> {
  const result: StreamedAnswer = { text: '', meta: null, done: null, error: null }
  const json = (data: string) => {
    try {
      return JSON.parse(data) as Record<string, unknown>
    } catch {
      return null
    }
  }
  const parser = createSseParser(({ event, data }) => {
    if (result.done || result.error) return
    const value = json(data)
    if (event === 'meta') result.meta = value
    else if (event === 'delta' && typeof value?.t === 'string') {
      result.text += value.t
      onDelta(value.t)
    } else if (event === 'done') result.done = value ?? {}
    else if (event === 'error') result.error = value ?? {}
  })
  const reader = body.getReader()
  // stream: true keeps a multi-byte character split across chunks intact.
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      onActivity()
      parser.push(decoder.decode(value, { stream: true }))
      if (result.done || result.error) break
    }
  } catch (err) {
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { partial: result.text })
  }
  if (result.done || result.error) await reader.cancel().catch(() => {})
  return result
}
