// The two local search models, pinned to exact Hugging Face commits so a re-upload under the
// same name can't change what users download (or what eval/ measured). The embedding worker
// and eval/retrieval.eval.ts both read these.

// Multilingual (about 100 languages), chosen on eval/ (v1.1): English recall held, Hindi and
// Spanish rose. e5 models expect the "query: " / "passage: " prefixes.
export const EMBEDDING_MODEL = {
  id: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  queryPrefix: 'query: ',
  passagePrefix: 'passage: ',
} as const

// Stored on each document: vectors from another model must never be compared with this one's.
export const EMBEDDING_MODEL_KEY = `${EMBEDDING_MODEL.id}@${EMBEDDING_MODEL.revision}`

// English-only cross-encoder (MS MARCO). On eval/ it lifted English but cut Hindi recall@1
// from 100% to 24% on clean text, so it only reranks English questions (shouldRerank).
export const RERANK_MODEL = {
  id: 'Xenova/ms-marco-MiniLM-L-2-v2',
  revision: 'b84c4fa7efd7b4801931e75773c940f002a494f5',
} as const

const ENGLISH_WORDS = new Set([
  'the', 'is', 'are', 'was', 'were', 'what', 'which', 'who', 'why', 'when', 'where', 'how',
  'does', 'do', 'did', 'of', 'and', 'to', 'in', 'for', 'with', 'from', 'by', 'this', 'that',
  'it', 'be', 'can', 'find', 'solve', 'calculate', 'explain', 'show',
])

// ponytail: a word list, not language detection. Any non-Latin letter → not English; a
// Latin-script question needs one common English word. A German "in" slips through (it
// gets reranked, as every question did before v1.1). Upgrade path: a multilingual reranker,
// once one fits the download budget (the smallest found is ~118 MB).
export function shouldRerank(question: string): boolean {
  if (/[^\P{L}\p{Script=Latin}]/u.test(question)) return false
  const words = question.toLowerCase().match(/\p{L}+/gu) ?? []
  return words.some((word) => ENGLISH_WORDS.has(word))
}
