export interface TokenSpan {
  text: string
  start: number
  end: number
}

export interface Chunk {
  index: number
  text: string
  tokenCount: number
}

export interface ChunkOptions {
  /** Real model tokens per chunk, excluding [CLS]/[SEP] special tokens. */
  chunkSize?: number
  /** Real model tokens shared between consecutive chunks. */
  overlap?: number
}

/** Counts real subword tokens for a piece of text, per the embedding model's own tokenizer. */
export interface Tokenizer {
  countTokens(text: string): number
}

const DEFAULT_CHUNK_SIZE = 200
const DEFAULT_OVERLAP = 40

// Splits on the same word/punctuation boundaries BERT's basic tokenizer uses before
// WordPiece, so per-atom token counts summed below equal whole-string tokenization.
const ATOM_PATTERN = /\w+|[^\s\w]+/g

export function splitAtoms(text: string): TokenSpan[] {
  return [...text.matchAll(ATOM_PATTERN)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }))
}

interface WeightedAtom extends TokenSpan {
  tokenCount: number
}

export function chunkText(text: string, tokenizer: Tokenizer, options: ChunkOptions = {}): Chunk[] {
  const { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP } = options
  if (chunkSize <= 0) throw new Error('chunkSize must be greater than 0')
  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error('overlap must be >= 0 and less than chunkSize')
  }

  const atoms: WeightedAtom[] = splitAtoms(text).map((atom) => ({
    ...atom,
    tokenCount: tokenizer.countTokens(atom.text),
  }))
  if (atoms.length === 0) return []

  const chunks: Chunk[] = []
  let start = 0
  while (start < atoms.length) {
    let end = start
    let tokens = 0
    while (end < atoms.length && tokens + atoms[end].tokenCount <= chunkSize) {
      tokens += atoms[end].tokenCount
      end++
    }
    if (end === start) end = start + 1 // a single atom exceeds chunkSize; take it anyway

    const slice = atoms.slice(start, end)
    chunks.push({
      index: chunks.length,
      text: text.slice(slice[0].start, slice[slice.length - 1].end),
      tokenCount: slice.reduce((sum, atom) => sum + atom.tokenCount, 0),
    })

    if (end >= atoms.length) break

    let backTokens = 0
    let nextStart = end
    while (nextStart > start && backTokens < overlap) {
      nextStart--
      backTokens += atoms[nextStart].tokenCount
    }
    start = Math.max(nextStart, start + 1) // guarantee forward progress
  }
  return chunks
}
