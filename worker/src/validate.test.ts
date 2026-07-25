import { describe, expect, it } from 'vitest'
import { MAX_CHUNKS, MAX_CHUNK_TEXT_LENGTH, MAX_QUESTION_LENGTH, validateAnswerRequest } from './validate'

const validChunk = { text: 'The mitochondrion is the powerhouse of the cell.', page: 1, score: 0.9 }

describe('validateAnswerRequest', () => {
  it('accepts a well-formed request', () => {
    const result = validateAnswerRequest({ question: 'What is the mitochondrion?', chunks: [validChunk] })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.question).toBe('What is the mitochondrion?')
      expect(result.chunks).toEqual([validChunk])
    }
  })

  it('rejects a non-object body', () => {
    expect(validateAnswerRequest(null)).toEqual({ ok: false, error: expect.any(String) })
    expect(validateAnswerRequest('a string')).toEqual({ ok: false, error: expect.any(String) })
  })

  it('rejects an empty or missing question', () => {
    expect(validateAnswerRequest({ question: '', chunks: [validChunk] }).ok).toBe(false)
    expect(validateAnswerRequest({ question: '   ', chunks: [validChunk] }).ok).toBe(false)
    expect(validateAnswerRequest({ chunks: [validChunk] }).ok).toBe(false)
  })

  it('rejects a question over the max length', () => {
    const result = validateAnswerRequest({ question: 'x'.repeat(MAX_QUESTION_LENGTH + 1), chunks: [validChunk] })
    expect(result.ok).toBe(false)
  })

  it('rejects missing or empty chunks', () => {
    expect(validateAnswerRequest({ question: 'q', chunks: [] }).ok).toBe(false)
    expect(validateAnswerRequest({ question: 'q' }).ok).toBe(false)
    expect(validateAnswerRequest({ question: 'q', chunks: 'not an array' }).ok).toBe(false)
  })

  it('rejects malformed chunk objects', () => {
    expect(validateAnswerRequest({ question: 'q', chunks: [{ text: 'x' }] }).ok).toBe(false)
    expect(validateAnswerRequest({ question: 'q', chunks: [{ text: 'x', page: 'one', score: 1 }] }).ok).toBe(false)
  })

  it('caps chunk count server-side even if the client sends more', () => {
    const chunks = Array.from({ length: 20 }, (_, i) => ({ ...validChunk, page: i + 1 }))
    const result = validateAnswerRequest({ question: 'q', chunks })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.chunks).toHaveLength(MAX_CHUNKS)
  })

  it('caps chunk text length server-side even if the client sends more', () => {
    const chunk = { ...validChunk, text: 'x'.repeat(MAX_CHUNK_TEXT_LENGTH + 500) }
    const result = validateAnswerRequest({ question: 'q', chunks: [chunk] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.chunks[0].text).toHaveLength(MAX_CHUNK_TEXT_LENGTH)
  })

  it('trims the question', () => {
    const result = validateAnswerRequest({ question: '  what is x?  ', chunks: [validChunk] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.question).toBe('what is x?')
  })
})
