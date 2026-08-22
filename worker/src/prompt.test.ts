import { describe, expect, it } from 'vitest'
import { buildPrompt } from './prompt'

describe('buildPrompt', () => {
  it('labels each passage with its Doc number and page', () => {
    const prompt = buildPrompt(
      'What powers the cell?',
      [
        { text: 'The mitochondrion is the powerhouse of the cell.', page: 1, score: 0.9, documentId: 'a' },
        { text: 'Kneading develops gluten.', page: 2, score: 0.5, documentId: 'b' },
      ],
      new Map([
        ['a', 1],
        ['b', 2],
      ]),
    )

    expect(prompt).toContain('What powers the cell?')
    expect(prompt).toContain('[Doc 1, Page 1]')
    expect(prompt).toContain('The mitochondrion is the powerhouse of the cell.')
    expect(prompt).toContain('[Doc 2, Page 2]')
    expect(prompt).toContain('Kneading develops gluten.')
  })

  it('instructs the model to stick to the passages and cite the document and page', () => {
    const prompt = buildPrompt('q', [{ text: 't', page: 1, score: 1, documentId: 'a' }], new Map([['a', 1]]))
    expect(prompt).toMatch(/only.*passages/i)
    expect(prompt).toMatch(/cite/i)
    expect(prompt).toContain('(Doc N, page M)')
    expect(prompt).toMatch(/do not use outside knowledge/i)
  })

  it('instructs the model to admit when the passages are insufficient', () => {
    const prompt = buildPrompt('q', [{ text: 't', page: 1, score: 1, documentId: 'a' }], new Map([['a', 1]]))
    expect(prompt).toMatch(/say so explicitly/i)
  })

  it('produces byte-identical output when history is empty or omitted (regression)', () => {
    const chunks = [{ text: 't', page: 1, score: 1, documentId: 'a' }]
    const labelOf = new Map([['a', 1]])
    const withoutParam = buildPrompt('q', chunks, labelOf)
    const withEmptyArray = buildPrompt('q', chunks, labelOf, [])
    expect(withoutParam).toBe(withEmptyArray)
    expect(withoutParam).not.toContain('Conversation so far')
  })

  it('interpolates a conversation-so-far section when history is given', () => {
    const prompt = buildPrompt(
      'What page is that on?',
      [{ text: 't', page: 1, score: 1, documentId: 'a' }],
      new Map([['a', 1]]),
      [{ question: 'What is the mitochondrion?', answer: 'The powerhouse of the cell (Doc 1, page 1).' }],
    )
    expect(prompt).toContain('Conversation so far')
    expect(prompt).toContain('Q: What is the mitochondrion?')
    expect(prompt).toContain('A: The powerhouse of the cell (Doc 1, page 1).')
  })

  it('instructs the model not to cite from the conversation history', () => {
    const prompt = buildPrompt(
      'q',
      [{ text: 't', page: 1, score: 1, documentId: 'a' }],
      new Map([['a', 1]]),
      [{ question: 'prior q', answer: 'prior a' }],
    )
    expect(prompt).toMatch(/do not cite from this, only from passages below/i)
  })

  it('places the conversation section before the Passages section', () => {
    const prompt = buildPrompt(
      'q',
      [{ text: 't', page: 1, score: 1, documentId: 'a' }],
      new Map([['a', 1]]),
      [{ question: 'prior q', answer: 'prior a' }],
    )
    expect(prompt.indexOf('Conversation so far')).toBeLessThan(prompt.indexOf('Passages:'))
  })

  it('renders multiple history turns in order', () => {
    const prompt = buildPrompt(
      'q',
      [{ text: 't', page: 1, score: 1, documentId: 'a' }],
      new Map([['a', 1]]),
      [
        { question: 'first q', answer: 'first a' },
        { question: 'second q', answer: 'second a' },
      ],
    )
    expect(prompt.indexOf('Q: first q')).toBeLessThan(prompt.indexOf('Q: second q'))
  })

  describe('image (Milestone 10 Phase B)', () => {
    const chunks = [{ text: 'The mitochondrion is the powerhouse of the cell.', page: 1, score: 0.9, documentId: 'doc-1' }]
    const labelOf = new Map([['doc-1', 1]])

    it('says "ONLY the passages" with no image mention when hasImage is omitted', () => {
      const prompt = buildPrompt('What is the mitochondrion?', chunks, labelOf)
      expect(prompt).toContain('Answer using only information found in the passages.')
      expect(prompt).not.toContain('attached image')
    })

    it('says "ONLY the passages" with no image mention when hasImage is explicitly false', () => {
      const prompt = buildPrompt('q', chunks, labelOf, [], false)
      expect(prompt).toContain('Answer using only information found in the passages.')
      expect(prompt).not.toContain('attached image')
    })

    it('acknowledges the attached image in every instruction sentence when hasImage is true', () => {
      const prompt = buildPrompt('What color is the bar?', chunks, labelOf, [], true)
      expect(prompt).toContain('An image of the most relevant page has also been attached')
      expect(prompt).toContain('Answer using only information found in the passages and the attached image.')
      expect(prompt).toContain('If a claim comes from the attached image, cite the page it was rendered from')
      expect(prompt).toContain('If the passages and the attached image do not contain enough information to answer')
    })

    it('never mentions the image in the citation or not-enough-information rules when hasImage is false', () => {
      const prompt = buildPrompt('q', chunks, labelOf)
      expect(prompt).not.toContain('If a claim comes from the attached image')
      expect(prompt).toContain('If the passages do not contain enough information to answer')
    })
  })

  describe('enableWebSearch (Milestone 12, Gemini-native grounding)', () => {
    const chunks = [{ text: 'The mitochondrion is the powerhouse of the cell.', page: 1, score: 0.9, documentId: 'doc-1' }]
    const labelOf = new Map([['doc-1', 1]])

    it('produces byte-identical output when enableWebSearch is false or omitted (regression)', () => {
      const withoutParam = buildPrompt('q', chunks, labelOf)
      const withExplicitFalse = buildPrompt('q', chunks, labelOf, [], false, false)
      expect(withoutParam).toBe(withExplicitFalse)
    })

    it('widens the source rule to include live web search results when enabled, resolving the "ONLY the passages" contradiction with granting the search tool', () => {
      const prompt = buildPrompt('q', chunks, labelOf, [], false, true)
      expect(prompt).toContain('Answer using only information found in the passages and the results of a live web search.')
      expect(prompt).toContain('If the passages and the results of a live web search do not contain enough information to answer')
    })

    it('does not mention web search anywhere when disabled', () => {
      const prompt = buildPrompt('q', chunks, labelOf)
      expect(prompt).not.toContain('web search')
    })

    it('combines passages, image, and web search into a single three-way source rule ("A, B, and C")', () => {
      const prompt = buildPrompt('q', chunks, labelOf, [], true, true)
      expect(prompt).toContain(
        'Answer using only information found in the passages, the attached image, and the results of a live web search.',
      )
    })

    it('adds no new prompt section — no separate "Web results" block, unlike the old (reverted) Brave-search-era design', () => {
      const prompt = buildPrompt('q', chunks, labelOf, [], false, true)
      expect(prompt).not.toContain('Web results:')
      expect(prompt).not.toContain('[Web 1]')
    })

    it('opening sentence stays fixed to "the passages below" regardless of enableWebSearch — only the Rules section varies', () => {
      const prompt = buildPrompt('q', chunks, labelOf, [], false, true)
      expect(prompt).toContain('You are answering a question using ONLY the passages below, extracted from one or more PDF documents.')
    })
  })
})
