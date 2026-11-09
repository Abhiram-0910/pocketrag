import { cosineSimilarity } from './similarity'

// Worked-example fidelity (v1.1), client-side and deterministic — no model call:
//  - 'verbatim': a top passage contains the question almost word for word, numbers included.
//    The UI shows the source's own solution ("From your notes (page N)").
//  - 'method': the question's wording matches a worked example but its numbers differ. The
//    answer request asks the model to follow that example's method (followMethod), and the
//    UI shows the example beside the answer with an arithmetic warning.

export interface SourceMatch {
  kind: 'verbatim' | 'method'
  chunkId: string
  documentId: string
  page: number
}

export interface MatchFeatures {
  // Share of the question's words found in the passage, each word weighted by how rare it
  // is in the searched pool (IDF), so a missing "compound" costs far more than a missing "the".
  wordCover: number
  // Share of the question's numbers that appear in the passage (1 when it has none).
  numberCover: number
  questionNumbers: number
  // Cosine similarity of the question and passage vectors (the same model as retrieval).
  cosine: number
}

// Thresholds from eval/ (`npm run eval`; per-question features in eval/results/after.json →
// sourceMatch). Exact copies of a document's question score wordCover 1.0; the closest
// wrong-example near-copy (compound-interest wording, simple-interest numbers) scored 0.89,
// hence 0.95. Changed-number questions on the right example scored 0.78-1.0, while
// wrong-example method candidates reached 0.76, hence 0.80 (the 0.78 one falls back to a
// normal answer). e5 cosines sit in a narrow 0.7-0.92 band, so MIN_COSINE is only a floor.
export const VERBATIM_MIN_WORD_COVER = 0.95
export const METHOD_MIN_WORD_COVER = 0.8
export const MIN_COSINE = 0.8
// A question of a word or two ("osmosis?") would count as contained in almost anything.
// Numbers count: "Solve 2x² − 7x + 3 = 0" is two words and four numbers.
const MIN_QUESTION_TERMS = 4

const WORD = /[\p{L}\p{M}]+/gu
const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*/gu

const words = (text: string) => new Set(text.toLowerCase().match(WORD) ?? [])
// "₹12,000", "12000" and "12.000" are the same number; "1.08" becomes "108" on both sides.
const numbers = (text: string) => new Set((text.match(NUMBER) ?? []).map((n) => n.replace(/[.,]/g, '')))

/** Inverse document frequency over a pool of passages: ln(1 + N / (1 + df)). */
export function buildIdf(pool: { text: string }[]): (word: string) => number {
  const df = new Map<string, number>()
  for (const { text } of pool) for (const w of words(text)) df.set(w, (df.get(w) ?? 0) + 1)
  return (word) => Math.log(1 + pool.length / (1 + (df.get(word) ?? 0)))
}

export function matchFeatures(
  question: string,
  passage: { text: string; embedding: number[] },
  queryEmbedding: number[],
  idf: (word: string) => number,
): MatchFeatures {
  const qWords = words(question)
  const pWords = words(passage.text)
  let total = 0
  let found = 0
  for (const w of qWords) {
    total += idf(w)
    if (pWords.has(w)) found += idf(w)
  }
  const qNums = numbers(question)
  const pNums = numbers(passage.text)
  const sharedNums = [...qNums].filter((n) => pNums.has(n)).length
  return {
    wordCover: total === 0 ? 0 : found / total,
    numberCover: qNums.size === 0 ? 1 : sharedNums / qNums.size,
    questionNumbers: qNums.size,
    cosine: cosineSimilarity(queryEmbedding, passage.embedding),
  }
}

export function classifyMatch(question: string, f: MatchFeatures): SourceMatch['kind'] | null {
  if (words(question).size + f.questionNumbers < MIN_QUESTION_TERMS || f.cosine < MIN_COSINE) return null
  if (f.wordCover >= VERBATIM_MIN_WORD_COVER && f.numberCover === 1) return 'verbatim'
  if (f.wordCover >= METHOD_MIN_WORD_COVER && f.questionNumbers > 0 && f.numberCover < 1) return 'method'
  return null
}

interface MatchChunk {
  id: string
  documentId: string
  page: number
  text: string
  embedding: number[]
}

/**
 * Checks the top passages in rank order and returns the first that matches either way, so
 * a better-ranked method match beats a lower-ranked near-copy of a different example.
 * `pool` is everything searched (for IDF).
 */
export function findSourceMatch(
  question: string,
  queryEmbedding: number[],
  ranked: MatchChunk[],
  pool: { text: string }[],
): SourceMatch | null {
  const idf = buildIdf(pool)
  for (const chunk of ranked) {
    const kind = classifyMatch(question, matchFeatures(question, chunk, queryEmbedding, idf))
    if (kind) return { kind, chunkId: chunk.id, documentId: chunk.documentId, page: chunk.page }
  }
  return null
}

// The chunker overlaps consecutive chunks by ~40 tokens; a shorter shared edge is chance.
const MIN_OVERLAP = 8

/** Joins two consecutive chunks of one page, dropping the chunker's overlap (the longest). */
export function mergeOverlap(a: string, b: string): string {
  for (let i = a.indexOf(b[0]); i !== -1 && a.length - i >= MIN_OVERLAP; i = a.indexOf(b[0], i + 1)) {
    if (b.startsWith(a.slice(i))) return a.slice(0, i) + b
  }
  return `${a} ${b}`
}

interface PassageChunk {
  id: string
  page: number
  index: number
  text: string
}

const join = (chunks: PassageChunk[]) => chunks.map((c) => c.text).reduce((acc, text) => mergeOverlap(acc, text))

/**
 * The matched chunk's whole page, so a solution is never shown cut off mid-way — plus the
 * next page's first chunk when the match ends its page (the solution may run on).
 * `docChunks`: every chunk of the matched document.
 */
export function expandToPage(chunkId: string, docChunks: PassageChunk[]): { text: string; pages: number[] } | null {
  const match = docChunks.find((c) => c.id === chunkId)
  if (!match) return null
  const byIndex = [...docChunks].sort((a, b) => a.index - b.index)
  const page = byIndex.filter((c) => c.page === match.page)
  let text = join(page)
  const pages = [match.page]
  const next = byIndex.find((c) => c.page > match.page)
  if (page.at(-1)?.id === match.id && next) {
    text += `\n\n${next.text}`
    pages.push(next.page)
  }
  return { text, pages }
}

// The Worker's per-passage cap (worker/src/validate.ts MAX_CHUNK_TEXT_LENGTH).
export const MAX_PASSAGE_CHARS = 2000

/**
 * What's sent as the matched passage when the model must follow its method: the matched
 * chunk joined with the next chunk on the same page (a worked example usually runs on past
 * one chunk), capped at the Worker's 2,000-character passage limit.
 */
export function exampleForRequest(chunkId: string, docChunks: PassageChunk[]): string | null {
  const byIndex = [...docChunks].sort((a, b) => a.index - b.index)
  const i = byIndex.findIndex((c) => c.id === chunkId)
  if (i === -1) return null
  const next = byIndex[i + 1]
  const parts = next && next.page === byIndex[i].page ? [byIndex[i], next] : [byIndex[i]]
  return join(parts).slice(0, MAX_PASSAGE_CHARS)
}
