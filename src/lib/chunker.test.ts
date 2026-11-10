import { beforeAll, describe, expect, it } from 'vitest'
import { AutoTokenizer } from '@huggingface/transformers'
import { chunkText, splitAtoms, type Tokenizer } from './chunker'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

// Real tokenizer, not an approximation — resolves the Milestone-1 `ponytail:` debt.
// One-time network fetch of tokenizer.json (~700KB), cached to disk afterwards.
let tokenizer: Tokenizer

beforeAll(async () => {
  const hfTokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
  tokenizer = {
    countTokens: (text) => hfTokenizer(text, { add_special_tokens: false }).input_ids.data.length,
  }
}, 60_000)

describe('splitAtoms', () => {
  it('splits words and punctuation into separate atoms', () => {
    expect(splitAtoms('Hello, world!')).toEqual([
      { text: 'Hello', start: 0, end: 5 },
      { text: ',', start: 5, end: 6 },
      { text: 'world', start: 7, end: 12 },
      { text: '!', start: 12, end: 13 },
    ])
  })

  it('returns empty array for whitespace-only input', () => {
    expect(splitAtoms('   \n\t  ')).toEqual([])
  })
})

describe('chunkText (real tokenizer)', () => {
  it('returns no chunks for empty text', () => {
    expect(chunkText('', tokenizer)).toEqual([])
  })

  it('returns a single chunk when the real token count is below chunkSize', () => {
    const chunks = chunkText('one two three', tokenizer, { chunkSize: 20, overlap: 2 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toBe('one two three')
    expect(chunks[0].tokenCount).toBe(tokenizer.countTokens('one two three'))
  })

  it('splits long text into multiple chunks bounded by real token counts', () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkText(words, tokenizer, { chunkSize: 50, overlap: 10 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((c) => c.tokenCount <= 50)).toBe(true)
  })

  it('reports real subword token counts, not atom counts', () => {
    // "PocketRAG" tokenizes to 2 real subword tokens on this model — verified empirically.
    const chunks = chunkText('PocketRAG', tokenizer, { chunkSize: 20, overlap: 2 })
    expect(chunks[0].tokenCount).toBeGreaterThan(1)
    expect(chunks[0].tokenCount).toBe(tokenizer.countTokens('PocketRAG'))
  })

  it('overlaps consecutive chunks by shared trailing/leading atoms', () => {
    const words = Array.from({ length: 200 }, (_, i) => `tok${i}`).join(' ')
    const chunks = chunkText(words, tokenizer, { chunkSize: 30, overlap: 8 })
    for (let i = 0; i < chunks.length - 1; i++) {
      const currentWords = chunks[i].text.split(' ')
      const nextWords = chunks[i + 1].text.split(' ')
      const overlapWord = currentWords[currentWords.length - 1]
      expect(nextWords).toContain(overlapWord)
    }
  })

  it('preserves exact original text (case, punctuation, spacing) in chunks', () => {
    const text = 'PocketRAG runs entirely client-side!'
    const chunks = chunkText(text, tokenizer, { chunkSize: 50, overlap: 5 })
    expect(chunks[0].text).toBe(text)
  })

  it('covers every atom in the source text at least once', () => {
    const words = Array.from({ length: 80 }, (_, i) => `t${i}`).join(' ')
    const sourceAtoms = words.split(' ')
    const chunks = chunkText(words, tokenizer, { chunkSize: 20, overlap: 4 })
    const covered = new Set(chunks.flatMap((c) => c.text.split(' ')))
    for (const atom of sourceAtoms) {
      expect(covered.has(atom)).toBe(true)
    }
  })

  it('assigns increasing chunk indices', () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')
    const chunks = chunkText(words, tokenizer, { chunkSize: 20, overlap: 4 })
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i))
  })

  it('always makes forward progress even when a single atom exceeds chunkSize', () => {
    const hugeAtom = 'supercalifragilisticexpialidocious'.repeat(10)
    const text = `${hugeAtom} short words after it here`
    const chunks = chunkText(text, tokenizer, { chunkSize: 3, overlap: 2 })
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0].text.startsWith(hugeAtom)).toBe(true)
  })

  it('throws when chunkSize is not positive', () => {
    expect(() => chunkText('some text', tokenizer, { chunkSize: 0 })).toThrow()
    expect(() => chunkText('some text', tokenizer, { chunkSize: -5 })).toThrow()
  })

  it('throws when overlap is negative or >= chunkSize', () => {
    expect(() => chunkText('some text', tokenizer, { chunkSize: 10, overlap: -1 })).toThrow()
    expect(() => chunkText('some text', tokenizer, { chunkSize: 10, overlap: 10 })).toThrow()
  })

  it('uses sane defaults when no options are passed', () => {
    const chunks = chunkText('just a short sentence for defaults', tokenizer)
    expect(chunks).toHaveLength(1)
  })

  it('reports where each chunk sits in the input (v1.4)', () => {
    const text = 'Alpha beta, gamma.  Delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho.'
    const chunks = chunkText(text, tokenizer, { chunkSize: 8, overlap: 2 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text)
  })
})
