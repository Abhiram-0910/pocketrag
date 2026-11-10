// v1.3 streaming: an incremental SSE parser, one small adapter per streaming provider, and
// the pump that turns a provider's stream into ours. Minimal work per event (one JSON.parse
// of the provider's event, one JSON.stringify of ours) — the Worker plan is assumed Free,
// with 10 ms of CPU per request (measured in AGENTS.md, Session 45).
//
// Our events (text/event-stream):
//   meta  {provider, model}            first, before any text
//   delta {t}                          answer text, in order
//   done  {groundingWarning, docLabels} after the citation check on the complete text
//   error {error, code}                fixed copy; the stream ends after it

export interface SseEvent {
  event: string
  data: string
}

/** Incremental SSE parser (the WHATWG event-stream rules we need): CRLF or LF line endings,
 * comment lines (keep-alives) ignored, multi-line data joined with \n, and a trailing event
 * without its blank line discarded at the end, as the spec says. */
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

export type StreamingProvider = 'gemini' | 'openai' | 'anthropic'
export const STREAMING_PROVIDERS: readonly StreamingProvider[] = ['gemini', 'openai', 'anthropic']

// What one provider event means. `failure` is a fixed, content-free reason for logs/alerts;
// the provider's own error text is never forwarded or logged.
export interface AdapterResult {
  text?: string
  done?: boolean
  failure?: string
}

type Adapter = (event: SseEvent) => AdapterResult

function parse(data: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(data) as unknown
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// Gemini streamGenerateContent?alt=sse: each event is a whole GenerateContentResponse
// chunk; the last one carries finishReason. Thought parts are not the answer.
const gemini: Adapter = ({ data }) => {
  const json = parse(data)
  if (!json) return { failure: 'malformed event' }
  if (json.error) return { failure: 'provider error event' }
  const candidate = (json.candidates as { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[] | undefined)?.[0]
  const text = (candidate?.content?.parts ?? [])
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('')
  return { text: text || undefined, done: candidate?.finishReason !== undefined }
}

// OpenAI Chat Completions with stream: true: deltas in choices[0].delta.content, then
// `data: [DONE]`.
const openai: Adapter = ({ data }) => {
  if (data === '[DONE]') return { done: true }
  const json = parse(data)
  if (!json) return { failure: 'malformed event' }
  if (json.error) return { failure: 'provider error event' }
  const choice = (json.choices as { delta?: { content?: string | null } }[] | undefined)?.[0]
  return { text: choice?.delta?.content || undefined }
}

// Anthropic Messages with stream: true: named events; text in content_block_delta /
// text_delta, end at message_stop, `ping` keep-alives, `error` on failure.
const anthropic: Adapter = ({ event, data }) => {
  if (event === 'ping') return {}
  if (event === 'error') return { failure: 'provider error event' }
  if (event === 'message_stop') return { done: true }
  if (event !== 'content_block_delta') return {}
  const json = parse(data)
  if (!json) return { failure: 'malformed event' }
  const delta = json.delta as { type?: string; text?: string } | undefined
  return { text: delta?.type === 'text_delta' ? delta.text : undefined }
}

export const ADAPTERS: Record<StreamingProvider, Adapter> = { gemini, openai, anthropic }

const encoder = new TextEncoder()
export function encodeEvent(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

export interface PumpHooks {
  // The citation check etc. on the complete text; becomes the `done` event's data.
  onComplete(text: string): unknown
  // A mid-stream failure: the copy for the `error` event (also logs and alerts).
  onFailure(reason: string): { error: string; code: string }
}

/**
 * Reads the provider's SSE body and writes ours. Ends with exactly one `done` or `error`.
 * If the client goes away (a write fails — Stop, or a closed tab), the provider stream is
 * cancelled so it stops generating, and nothing is reported: that's the user's choice.
 */
export async function pump(
  upstream: ReadableStream<Uint8Array>,
  adapter: Adapter,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  meta: unknown,
  hooks: PumpHooks,
): Promise<void> {
  const reader = upstream.pipeThrough(new TextDecoderStream()).getReader()
  let text = ''
  let outcome: { done: true } | { failure: string } | null = null
  let clientGone = false
  // Text parsed from one upstream read goes out as ONE delta event: a provider that sends a
  // token per event (OpenAI) would otherwise cost a stringify + encode + write per token.
  let pendingText = ''
  const write = async (chunk: Uint8Array) => {
    if (clientGone) return
    try {
      await writer.write(chunk)
    } catch {
      clientGone = true
    }
  }
  const parser = createSseParser((event) => {
    if (outcome) return
    const result = adapter(event)
    if (result.failure) outcome = { failure: result.failure }
    else {
      if (result.text) {
        text += result.text
        pendingText += result.text
      }
      if (result.done) outcome = { done: true }
    }
  })

  await write(encodeEvent('meta', meta))
  try {
    while (!outcome && !clientGone) {
      const { value, done } = await reader.read()
      if (done) break
      parser.push(value)
      if (pendingText) {
        const t = pendingText
        pendingText = ''
        await write(encodeEvent('delta', { t }))
      }
    }
  } catch {
    outcome ??= { failure: 'upstream read failed' }
  }
  if (clientGone) {
    await reader.cancel().catch(() => {})
    return
  }
  if (!outcome) outcome = { failure: 'stream ended early' }
  else await reader.cancel().catch(() => {})
  if ('done' in outcome && text.trim()) await write(encodeEvent('done', hooks.onComplete(text)))
  else await write(encodeEvent('error', hooks.onFailure('failure' in outcome ? outcome.failure : 'empty answer')))
  await writer.close().catch(() => {})
}
