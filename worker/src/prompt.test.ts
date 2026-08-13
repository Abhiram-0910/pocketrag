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
})
