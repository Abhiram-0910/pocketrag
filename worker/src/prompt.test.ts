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
})
