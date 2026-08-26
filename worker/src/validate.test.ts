import { describe, expect, it } from 'vitest'
import {
  MAX_API_KEY_LENGTH,
  MAX_CHUNKS,
  MAX_CHUNK_TEXT_LENGTH,
  MAX_DOC_LABELS,
  MAX_HISTORY_ANSWER_LENGTH,
  MAX_HISTORY_TURNS,
  MAX_IMAGE_BASE64_LENGTH,
  MAX_MODEL_LENGTH,
  MAX_OCR_BASE64_LENGTH,
  MAX_QUESTION_LENGTH,
  validateAnswerRequest,
  validateModelsRequest,
  validateOcrRequest,
} from './validate'

const validChunk = { text: 'The mitochondrion is the powerhouse of the cell.', page: 1, score: 0.9, documentId: 'doc-1' }

describe('validateAnswerRequest', () => {
  it('accepts a well-formed request', () => {
    const result = validateAnswerRequest({ question: 'What is the mitochondrion?', chunks: [validChunk] })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.question).toBe('What is the mitochondrion?')
      expect(result.chunks).toEqual([validChunk])
      expect(result.keySource).toBe('shared')
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

  it('rejects a chunk with a missing or empty documentId', () => {
    const { documentId, ...noId } = validChunk
    void documentId
    expect(validateAnswerRequest({ question: 'q', chunks: [noId] }).ok).toBe(false)
    expect(validateAnswerRequest({ question: 'q', chunks: [{ ...validChunk, documentId: '' }] }).ok).toBe(false)
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

  it('defaults keySource to "shared" when omitted (backward compatible with older clients)', () => {
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.keySource).toBe('shared')
  })

  it('rejects a keySource that is neither "shared" nor "own"', () => {
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], keySource: 'stolen' })
    expect(result.ok).toBe(false)
  })

  it('accepts a well-formed BYOK request and returns the key/provider/model', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: 'my-real-key',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.keySource === 'own') {
      expect(result.apiKey).toBe('my-real-key')
      expect(result.provider).toBe('gemini')
      expect(result.model).toBe('gemini-3.5-pro')
    }
  })

  it('rejects keySource "own" with a missing apiKey', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
    })
    expect(result.ok).toBe(false)
  })

  it('rejects keySource "own" with an empty apiKey', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: '',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
    })
    expect(result.ok).toBe(false)
  })

  it('rejects keySource "own" with an apiKey over the max length', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: 'x'.repeat(MAX_API_KEY_LENGTH + 1),
      provider: 'gemini',
      model: 'gemini-3.5-pro',
    })
    expect(result.ok).toBe(false)
  })

  it('accepts a well-formed BYOK request for the openai provider', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: 'my-real-key',
      provider: 'openai',
      model: 'gpt-4o-mini',
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.keySource === 'own') {
      expect(result.provider).toBe('openai')
      expect(result.model).toBe('gpt-4o-mini')
    }
  })

  it('accepts a well-formed BYOK request for the anthropic provider', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: 'my-real-key',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.keySource === 'own') {
      expect(result.provider).toBe('anthropic')
      expect(result.model).toBe('claude-sonnet-4-5')
    }
  })

  it('accepts a well-formed BYOK request for the grok provider', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: 'my-real-key',
      provider: 'grok',
      model: 'grok-4',
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.keySource === 'own') {
      expect(result.provider).toBe('grok')
      expect(result.model).toBe('grok-4')
    }
  })

  it('accepts a well-formed BYOK request for the openrouter provider', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: 'my-real-key',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
    })
    expect(result.ok).toBe(true)
    if (result.ok && result.keySource === 'own') {
      expect(result.provider).toBe('openrouter')
      expect(result.model).toBe('openai/gpt-4o-mini')
    }
  })

  it('rejects keySource "own" with an unsupported provider', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: 'my-real-key',
      provider: 'mistral',
      model: 'mistral-x',
    })
    expect(result.ok).toBe(false)
  })

  it('rejects keySource "own" with a missing or empty model', () => {
    expect(
      validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        keySource: 'own',
        apiKey: 'my-real-key',
        provider: 'gemini',
      }).ok,
    ).toBe(false)
    expect(
      validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        keySource: 'own',
        apiKey: 'my-real-key',
        provider: 'gemini',
        model: '',
      }).ok,
    ).toBe(false)
  })

  it('rejects keySource "own" with a model over the max length', () => {
    const result = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: 'my-real-key',
      provider: 'gemini',
      model: 'x'.repeat(MAX_MODEL_LENGTH + 1),
    })
    expect(result.ok).toBe(false)
  })

  it('never echoes the raw apiKey value back in a rejection error message', () => {
    const secretKey = 'sk-super-secret-value-should-never-appear-anywhere-in-any-error-string-12345'
    const oversized = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: secretKey.repeat(3), // over MAX_API_KEY_LENGTH
      provider: 'gemini',
      model: 'gemini-3.5-pro',
    })
    expect(oversized.ok).toBe(false)
    if (!oversized.ok) expect(oversized.error).not.toContain(secretKey)

    const emptyKeyWithGarbageProvider = validateAnswerRequest({
      question: 'q',
      chunks: [validChunk],
      keySource: 'own',
      apiKey: '',
      provider: 'gemini',
      model: 'gemini-3.5-pro',
    })
    expect(emptyKeyWithGarbageProvider.ok).toBe(false)
    if (!emptyKeyWithGarbageProvider.ok) expect(emptyKeyWithGarbageProvider.error).not.toContain(secretKey)
  })

  it('defaults docLabels to an empty array when omitted', () => {
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.docLabels).toEqual([])
  })

  it('accepts a well-formed docLabels array and returns it', () => {
    const docLabels = [
      { label: 1, documentId: 'doc-a' },
      { label: 2, documentId: 'doc-b' },
    ]
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], docLabels })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.docLabels).toEqual(docLabels)
  })

  it('rejects a non-array docLabels', () => {
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], docLabels: 'not an array' })
    expect(result.ok).toBe(false)
  })

  it('caps an oversized docLabels array server-side', () => {
    const docLabels = Array.from({ length: MAX_DOC_LABELS + 5 }, (_, i) => ({
      label: i + 1,
      documentId: `doc-${i}`,
    }))
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], docLabels })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.docLabels).toHaveLength(MAX_DOC_LABELS)
  })

  it('rejects a malformed docLabels entry', () => {
    expect(
      validateAnswerRequest({ question: 'q', chunks: [validChunk], docLabels: [{ label: 'one', documentId: 'a' }] })
        .ok,
    ).toBe(false)
    expect(
      validateAnswerRequest({ question: 'q', chunks: [validChunk], docLabels: [{ label: 1 }] }).ok,
    ).toBe(false)
    expect(
      validateAnswerRequest({ question: 'q', chunks: [validChunk], docLabels: [{ label: 0, documentId: 'a' }] }).ok,
    ).toBe(false)
  })

  it('rejects docLabels with a duplicate documentId', () => {
    const docLabels = [
      { label: 1, documentId: 'doc-a' },
      { label: 2, documentId: 'doc-a' },
    ]
    expect(validateAnswerRequest({ question: 'q', chunks: [validChunk], docLabels }).ok).toBe(false)
  })

  it('rejects docLabels with a duplicate label number', () => {
    const docLabels = [
      { label: 1, documentId: 'doc-a' },
      { label: 1, documentId: 'doc-b' },
    ]
    expect(validateAnswerRequest({ question: 'q', chunks: [validChunk], docLabels }).ok).toBe(false)
  })

  it('defaults history to an empty array when omitted', () => {
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.history).toEqual([])
  })

  it('accepts a well-formed history array and returns it', () => {
    const history = [
      { question: 'What is the mitochondrion?', answer: 'The powerhouse of the cell (Doc 1, page 1).' },
    ]
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], history })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.history).toEqual(history)
  })

  it('rejects a non-array history', () => {
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], history: 'not an array' })
    expect(result.ok).toBe(false)
  })

  it('caps an oversized history array server-side', () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 5 }, (_, i) => ({
      question: `question ${i}`,
      answer: `answer ${i}`,
    }))
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], history })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.history).toHaveLength(MAX_HISTORY_TURNS)
  })

  it('truncates (not rejects) an oversized history question or answer', () => {
    const history = [
      { question: 'x'.repeat(MAX_QUESTION_LENGTH + 100), answer: 'y'.repeat(MAX_HISTORY_ANSWER_LENGTH + 100) },
    ]
    const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], history })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.history[0].question).toHaveLength(MAX_QUESTION_LENGTH)
      expect(result.history[0].answer).toHaveLength(MAX_HISTORY_ANSWER_LENGTH)
    }
  })

  it('rejects a malformed history entry', () => {
    expect(
      validateAnswerRequest({ question: 'q', chunks: [validChunk], history: [{ question: 'q only' }] }).ok,
    ).toBe(false)
    expect(
      validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        history: [{ question: 1, answer: 'a' }],
      }).ok,
    ).toBe(false)
  })

  describe('image (Milestone 10 Phase B)', () => {
    const validImage = { mimeType: 'image/jpeg', base64: 'aGVsbG8=' }

    it('accepts a well-formed image on a shared-tier request and returns it', () => {
      const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], image: validImage })
      expect(result.ok).toBe(true)
      if (result.ok && result.keySource === 'shared') expect(result.image).toEqual(validImage)
    })

    it('defaults image to undefined when omitted', () => {
      const result = validateAnswerRequest({ question: 'q', chunks: [validChunk] })
      expect(result.ok).toBe(true)
      if (result.ok && result.keySource === 'shared') expect(result.image).toBeUndefined()
    })

    it('rejects a non-object image', () => {
      expect(validateAnswerRequest({ question: 'q', chunks: [validChunk], image: 'not an object' }).ok).toBe(false)
    })

    it('rejects an image with the wrong mimeType', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        image: { mimeType: 'image/png', base64: 'aGVsbG8=' },
      })
      expect(result.ok).toBe(false)
    })

    it('rejects an image with an empty base64 string', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        image: { mimeType: 'image/jpeg', base64: '' },
      })
      expect(result.ok).toBe(false)
    })

    it('rejects an image whose base64 payload exceeds MAX_IMAGE_BASE64_LENGTH', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        image: { mimeType: 'image/jpeg', base64: 'a'.repeat(MAX_IMAGE_BASE64_LENGTH + 1) },
      })
      expect(result.ok).toBe(false)
    })

    it('accepts an image exactly at MAX_IMAGE_BASE64_LENGTH', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        image: { mimeType: 'image/jpeg', base64: 'a'.repeat(MAX_IMAGE_BASE64_LENGTH) },
      })
      expect(result.ok).toBe(true)
    })

    it('rejects an image on a BYOK (keySource: own) request outright, even for provider "gemini"', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        keySource: 'own',
        apiKey: 'my-real-key',
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        image: validImage,
      })
      expect(result.ok).toBe(false)
    })

    it('still accepts a well-formed BYOK request with no image', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        keySource: 'own',
        apiKey: 'my-real-key',
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
      })
      expect(result.ok).toBe(true)
    })
  })

  describe('enableWebSearch (Milestone 12, Gemini-native grounding — final scope: BYOK-gemini only)', () => {
    it('rejects enableWebSearch: true on a shared-tier request outright, not silently dropped', () => {
      const result = validateAnswerRequest({ question: 'q', chunks: [validChunk], enableWebSearch: true })
      expect(result.ok).toBe(false)
    })

    it('still accepts a shared-tier request when enableWebSearch is false or omitted, with no such field on the result', () => {
      const omitted = validateAnswerRequest({ question: 'q', chunks: [validChunk] })
      expect(omitted.ok).toBe(true)
      if (omitted.ok && omitted.keySource === 'shared') expect('enableWebSearch' in omitted).toBe(false)

      const explicitFalse = validateAnswerRequest({ question: 'q', chunks: [validChunk], enableWebSearch: false })
      expect(explicitFalse.ok).toBe(true)
      if (explicitFalse.ok && explicitFalse.keySource === 'shared') expect('enableWebSearch' in explicitFalse).toBe(false)
    })

    it('rejects a non-boolean enableWebSearch', () => {
      expect(validateAnswerRequest({ question: 'q', chunks: [validChunk], enableWebSearch: 'yes' }).ok).toBe(false)
    })

    it('accepts enableWebSearch: true on a BYOK request that chose provider "gemini" — their own key, their own cost', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        keySource: 'own',
        apiKey: 'my-real-key',
        provider: 'gemini',
        model: 'gemini-3.5-flash-lite',
        enableWebSearch: true,
      })
      expect(result.ok).toBe(true)
      if (result.ok && result.keySource === 'own') expect(result.enableWebSearch).toBe(true)
    })

    it('rejects enableWebSearch: true on a BYOK request for a non-Gemini provider outright, not silently dropped', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        keySource: 'own',
        apiKey: 'my-real-key',
        provider: 'openai',
        model: 'gpt-4o-mini',
        enableWebSearch: true,
      })
      expect(result.ok).toBe(false)
    })

    it('still accepts a BYOK request for a non-Gemini provider when enableWebSearch is false or omitted', () => {
      const result = validateAnswerRequest({
        question: 'q',
        chunks: [validChunk],
        keySource: 'own',
        apiKey: 'my-real-key',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
      })
      expect(result.ok).toBe(true)
    })
  })
})

describe('validateModelsRequest', () => {
  it('accepts a well-formed request', () => {
    const result = validateModelsRequest({ provider: 'gemini', apiKey: 'my-real-key' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.provider).toBe('gemini')
      expect(result.apiKey).toBe('my-real-key')
    }
  })

  it('rejects a non-object body', () => {
    expect(validateModelsRequest(null).ok).toBe(false)
    expect(validateModelsRequest('a string').ok).toBe(false)
  })

  it('accepts the openai provider', () => {
    const result = validateModelsRequest({ provider: 'openai', apiKey: 'my-real-key' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('openai')
  })

  it('accepts the anthropic provider', () => {
    const result = validateModelsRequest({ provider: 'anthropic', apiKey: 'my-real-key' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('anthropic')
  })

  it('accepts the grok provider', () => {
    const result = validateModelsRequest({ provider: 'grok', apiKey: 'my-real-key' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('grok')
  })

  it('accepts the openrouter provider', () => {
    const result = validateModelsRequest({ provider: 'openrouter', apiKey: 'my-real-key' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.provider).toBe('openrouter')
  })

  it('rejects an unsupported provider', () => {
    expect(validateModelsRequest({ provider: 'mistral', apiKey: 'my-real-key' }).ok).toBe(false)
    expect(validateModelsRequest({ apiKey: 'my-real-key' }).ok).toBe(false)
  })

  it('rejects a missing, empty, or oversized apiKey', () => {
    expect(validateModelsRequest({ provider: 'gemini' }).ok).toBe(false)
    expect(validateModelsRequest({ provider: 'gemini', apiKey: '' }).ok).toBe(false)
    expect(validateModelsRequest({ provider: 'gemini', apiKey: 'x'.repeat(MAX_API_KEY_LENGTH + 1) }).ok).toBe(false)
  })

  it('never echoes the raw apiKey value back in a rejection error message', () => {
    const secretKey = 'sk-another-secret-value-should-never-appear-anywhere-in-any-error-string-67890'
    const result = validateModelsRequest({ provider: 'gemini', apiKey: secretKey.repeat(3) })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain(secretKey)
  })
})

describe('validateOcrRequest', () => {
  it('accepts a well-formed request', () => {
    const result = validateOcrRequest({ mimeType: 'image/jpeg', base64: 'aGVsbG8=' })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.mimeType).toBe('image/jpeg')
      expect(result.base64).toBe('aGVsbG8=')
    }
  })

  it('accepts every allowed mimeType, images and PDF', () => {
    for (const mimeType of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']) {
      expect(validateOcrRequest({ mimeType, base64: 'aGVsbG8=' }).ok).toBe(true)
    }
  })

  it('rejects an unsupported mimeType', () => {
    expect(validateOcrRequest({ mimeType: 'text/plain', base64: 'aGVsbG8=' }).ok).toBe(false)
    expect(validateOcrRequest({ mimeType: 'application/msword', base64: 'aGVsbG8=' }).ok).toBe(false)
    expect(validateOcrRequest({ base64: 'aGVsbG8=' }).ok).toBe(false)
  })

  it('rejects a missing, empty, or oversized base64', () => {
    expect(validateOcrRequest({ mimeType: 'image/jpeg' }).ok).toBe(false)
    expect(validateOcrRequest({ mimeType: 'image/jpeg', base64: '' }).ok).toBe(false)
    expect(validateOcrRequest({ mimeType: 'image/jpeg', base64: 'x'.repeat(MAX_OCR_BASE64_LENGTH + 1) }).ok).toBe(
      false,
    )
  })

  it('accepts a base64 payload right at the cap', () => {
    const result = validateOcrRequest({ mimeType: 'image/jpeg', base64: 'x'.repeat(MAX_OCR_BASE64_LENGTH) })
    expect(result.ok).toBe(true)
  })

  it('rejects a non-object body', () => {
    expect(validateOcrRequest(null).ok).toBe(false)
    expect(validateOcrRequest('not an object').ok).toBe(false)
  })

  it('ignores an unexpected keySource/apiKey field rather than routing on it — the type has no such field', () => {
    // OcrRequestBody has no keySource/apiKey field at all; a client (or attacker)
    // sending one has no effect since validateOcrRequest never reads it.
    const result = validateOcrRequest({
      mimeType: 'image/jpeg',
      base64: 'aGVsbG8=',
      keySource: 'own',
      apiKey: 'sk-should-be-ignored',
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.keys(result)).toEqual(['ok', 'mimeType', 'base64'])
    }
  })
})
