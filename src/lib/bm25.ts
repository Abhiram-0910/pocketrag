export interface BM25Document {
  id: string
  text: string
}

export interface BM25Result {
  id: string
  score: number
}

// Lucene/Elasticsearch defaults — k1 controls term-frequency saturation, b controls
// document-length normalization.
const K1 = 1.2
const B = 0.75

const WORD_PATTERN = /\w+/g

function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_PATTERN) ?? []
}

/**
 * Scores every document against a query using BM25. IDF and average document length
 * are computed fresh over the given pool on every call — no persistent index, since
 * this runs entirely client-side over a small, single-user chunk pool (no server-side
 * search index exists or is needed here).
 */
export function bm25Score<T extends BM25Document>(query: string, documents: T[]): BM25Result[] {
  const queryTerms = tokenize(query)
  if (documents.length === 0 || queryTerms.length === 0) {
    return documents.map((doc) => ({ id: doc.id, score: 0 }))
  }

  const docTokens = documents.map((doc) => tokenize(doc.text))
  const docLengths = docTokens.map((tokens) => tokens.length)
  const avgDocLength = docLengths.reduce((sum, len) => sum + len, 0) / documents.length

  const docFrequency = new Map<string, number>()
  for (const term of new Set(queryTerms)) {
    docFrequency.set(term, docTokens.filter((tokens) => tokens.includes(term)).length)
  }

  return documents.map((doc, i) => {
    const termCounts = new Map<string, number>()
    for (const token of docTokens[i]) termCounts.set(token, (termCounts.get(token) ?? 0) + 1)

    let score = 0
    for (const term of queryTerms) {
      const tf = termCounts.get(term) ?? 0
      if (tf === 0) continue
      const df = docFrequency.get(term) ?? 0
      // +1 inside the log keeps IDF non-negative for very common terms — the classic
      // Robertson-Sparck Jones IDF can go negative when a term appears in more than
      // half the pool.
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))
      score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + B * (docLengths[i] / avgDocLength)))
    }
    return { id: doc.id, score }
  })
}
