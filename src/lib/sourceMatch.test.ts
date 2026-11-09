import { describe, expect, it } from 'vitest'
import {
  MAX_PASSAGE_CHARS,
  buildIdf,
  classifyMatch,
  exampleForRequest,
  expandToPage,
  findSourceMatch,
  matchFeatures,
  mergeOverlap,
} from './sourceMatch'

// Passage text as pdf.js extracts it from eval/fixtures/maths-notes.pdf (page 2).
const SI = "Worked Example 3 — Simple interest  Question:   Find the simple interest on ₹5,000 at 6% per annum for 4 years.  Solution:  Step 1: Write the formula SI =   P × R × T 100   . Step 2: Substitute P = 5000, R = 6 and T = 4."
const CI = 'Worked Example 1 — Compound interest  Question:   Find the amount and the compound interest when ₹12,000 is invested at 8% per annum, compounded annually, for 3 years.  Solution:  Step 1: Write the formula A = P(1 +   r 100 ) n'
const OTHER = 'Osmosis is the movement of water molecules across a partially permeable membrane.'
const POOL = [{ text: SI }, { text: CI }, { text: OTHER }, { text: 'Mitochondria produce ATP.' }]
const idf = buildIdf(POOL)
const v = [1, 0]
const near = [0.9, 0.436] // cosine 0.9 with v

const kindOf = (question: string, text: string, embedding = near) =>
  classifyMatch(question, matchFeatures(question, { text, embedding }, v, idf))

describe('sourceMatch', () => {
  it("the document's own question → verbatim", () => {
    expect(kindOf('Find the simple interest on ₹5,000 at 6% per annum for 4 years.', SI)).toBe('verbatim')
    // Number formatting doesn't matter: ₹5,000 = 5000.
    expect(kindOf('Find the simple interest on 5000 at 6% per annum for 4 years', SI)).toBe('verbatim')
  })

  it('same wording, new numbers → method', () => {
    expect(kindOf('Find the simple interest on ₹9,000 at 5% per annum for 3 years.', SI)).toBe('method')
  })

  it("another method's wording with this example's numbers is never verbatim", () => {
    expect(kindOf('Find the compound interest on ₹5,000 at 6% per annum for 4 years.', SI)).not.toBe('verbatim')
  })

  it('paraphrases, short questions and unrelated passages → no match', () => {
    expect(kindOf('How do I work out simple interest?', SI)).toBeNull()
    expect(kindOf('simple interest?', SI)).toBeNull()
    expect(kindOf('Find the simple interest on ₹5,000 at 6% per annum for 4 years.', OTHER)).toBeNull()
    // Lexically perfect but semantically far (cosine under the floor).
    expect(kindOf('Find the simple interest on ₹5,000 at 6% per annum for 4 years.', SI, [0, 1])).toBeNull()
  })

  it('counts numbers toward the minimum question size (equations have few words)', () => {
    const quad = 'Question: Solve 2x² − 7x + 3 = 0. Solution: Step 1: Compare with ax² + bx + c = 0: a = 2, b = −7, c = 3.'
    expect(kindOf('Solve 2x² − 7x + 3 = 0.', quad)).toBe('verbatim')
    expect(kindOf('Solve 3x² - 10x + 8 = 0', quad)).toBe('method')
  })

  it('takes the first match in rank order, so a better-ranked method match wins', () => {
    const ranked = [
      { id: 'ci', documentId: 'd', page: 1, text: CI, embedding: near },
      { id: 'si', documentId: 'd', page: 2, text: SI, embedding: near },
    ]
    expect(findSourceMatch('Find the amount and the compound interest when ₹2,000 is invested at 5% per annum, compounded annually, for 2 years.', v, ranked, POOL)).toEqual({
      kind: 'method',
      chunkId: 'ci',
      documentId: 'd',
      page: 1,
    })
    expect(findSourceMatch('What do mitochondria produce?', v, ranked, POOL)).toBeNull()
  })

  it('merges overlapping chunks without repeating the overlap', () => {
    expect(mergeOverlap('Step 1: write the formula. Step 2: substitute', 'Step 2: substitute the values. Step 3')).toBe(
      'Step 1: write the formula. Step 2: substitute the values. Step 3',
    )
    expect(mergeOverlap('no overlap here', 'something else')).toBe('no overlap here something else')
    // A shared edge shorter than the chunker's overlap is chance, not overlap ("the" + "end").
    expect(mergeOverlap('see the', 'end of it')).toBe('see the end of it')
  })

  const doc = [
    { id: 'd:0', page: 1, index: 0, text: 'Example 1. Question: find x. Step 1: write' },
    { id: 'd:1', page: 1, index: 1, text: 'Step 1: write the rule. Step 2: solve.' },
    { id: 'd:2', page: 2, index: 2, text: 'Step 3: check the answer.' },
    { id: 'd:3', page: 2, index: 3, text: 'Unrelated next topic.' },
  ]

  it("expands a match to its whole page, plus the next page's first chunk when it ends the page", () => {
    expect(expandToPage('d:0', doc)).toEqual({ text: 'Example 1. Question: find x. Step 1: write the rule. Step 2: solve.', pages: [1] })
    expect(expandToPage('d:1', doc)).toEqual({ text: 'Example 1. Question: find x. Step 1: write the rule. Step 2: solve.\n\nStep 3: check the answer.', pages: [1, 2] })
    expect(expandToPage('d:2', doc)).toEqual({ text: 'Step 3: check the answer. Unrelated next topic.', pages: [2] })
    expect(expandToPage('gone', doc)).toBeNull()
  })

  it('sends the matched chunk plus the next one on the same page, capped at the Worker limit', () => {
    expect(exampleForRequest('d:0', doc)).toBe('Example 1. Question: find x. Step 1: write the rule. Step 2: solve.')
    expect(exampleForRequest('d:1', doc)).toBe('Step 1: write the rule. Step 2: solve.')
    const long = [{ id: 'l', page: 1, index: 0, text: 'x'.repeat(3000) }]
    expect(exampleForRequest('l', long)).toHaveLength(MAX_PASSAGE_CHARS)
  })
})

describe('the 2,000-character example cap', () => {
  it("equals the Worker's per-passage cap and what the privacy page says", async () => {
    const { readFileSync } = await import('node:fs')
    const worker = readFileSync(new URL('../../worker/src/validate.ts', import.meta.url), 'utf8')
    expect(worker).toContain(`MAX_CHUNK_TEXT_LENGTH = ${MAX_PASSAGE_CHARS}`)
    const privacy = readFileSync(new URL('../components/PrivacyPage.tsx', import.meta.url), 'utf8')
    expect(privacy.replace(/\s+/g, ' ')).toContain(`at most ${MAX_PASSAGE_CHARS.toLocaleString('en-US')} characters`)
  })
})
