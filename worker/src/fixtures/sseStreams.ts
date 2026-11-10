// Test-only SSE bodies in each provider's real wire shape (v1.3 streaming). Shapes follow
// the providers' documented streaming formats: Gemini streamGenerateContent?alt=sse
// (whole GenerateContentResponse per event, finishReason on the last), OpenAI Chat
// Completions stream (choices[0].delta.content, then [DONE]), Anthropic Messages stream
// (named events, text_delta, ping keep-alives, message_stop).

const ev = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`
const g = (text: string, finishReason?: string) => ev({ candidates: [{ content: { parts: [{ text }], role: 'model' }, ...(finishReason ? { finishReason } : {}) }] })
const o = (content: string | null, finish_reason: string | null = null) => ev({ choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason }] })
const a = (text: string) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, 'content_block_delta')

export const ANSWER = 'Mitochondria produce ATP (Doc 1, page 1).'

export const SSE = {
  gemini: {
    complete: g('Mitochondria produce ') + g('ATP (Doc 1, page 1)') + g('.', 'STOP'),
    // CRLF line endings and a keep-alive comment between events.
    keepAlive: (g('Mitochondria produce ') + ': keep-alive\n\n' + g('ATP (Doc 1, page 1).', 'STOP')).replace(/\n/g, '\r\n'),
    truncated: g('Mitochondria produce ') + g('ATP'),
    malformed: g('Mitochondria produce ') + 'data: {"candidates": [\n\n',
    errorEvent: g('Mitochondria ') + ev({ error: { code: 500, message: 'Internal error with the passage text in it' } }),
    uncited: g('Mitochondria produce ATP.', 'STOP'),
  },
  openai: {
    complete: o('') + o('Mitochondria produce ') + o('ATP (Doc 1, page 1).') + o(null, 'stop') + ev('[DONE]'),
    keepAlive: o('Mitochondria produce ') + ': keep-alive\n\n' + o('ATP (Doc 1, page 1).') + ev('[DONE]'),
    truncated: o('Mitochondria produce ') + o('ATP'),
    malformed: o('Mitochondria produce ') + 'data: not json\n\n',
    errorEvent: o('Mitochondria ') + ev({ error: { message: 'The server had an error', type: 'server_error' } }),
  },
  anthropic: {
    complete:
      ev({ type: 'message_start', message: { id: 'msg_1', model: 'claude-haiku-5-5' } }, 'message_start') +
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start') +
      a('Mitochondria produce ') +
      a('ATP (Doc 1, page 1).') +
      ev({ type: 'content_block_stop', index: 0 }, 'content_block_stop') +
      ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, 'message_delta') +
      ev({ type: 'message_stop' }, 'message_stop'),
    keepAlive: a('Mitochondria produce ') + ev({ type: 'ping' }, 'ping') + a('ATP (Doc 1, page 1).') + ev({ type: 'message_stop' }, 'message_stop'),
    truncated: a('Mitochondria produce ') + a('ATP'),
    malformed: a('Mitochondria produce ') + 'event: content_block_delta\ndata: {broken\n\n',
    errorEvent: a('Mitochondria ') + ev({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'error'),
  },
}

/** A body that arrives in pieces of `size` characters, cutting events (and CRLFs) anywhere. */
export function chunked(text: string, size = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + size))
      offset += size
    },
  })
}
