// Retrieval eval: the app's own chunker, hybrid search and reranker over the fixture PDFs,
// with the real models (q8 ONNX, run by onnxruntime-node instead of the browser's WASM
// build — same files, scores can differ in the last decimals). Deterministic and free: no
// network call except the one-time model downloads from Hugging Face.
//
//   npm run eval                                  # every embedder × extraction × rerank
//   EVAL_EMBEDDERS=e5 EVAL_EXTRACTIONS=space EVAL_RERANK=policy npm run eval   # the app as shipped
//   EVAL_LABEL=name …                             # writes eval/results/name.json
//
// Metric: for each question, the rank of the first returned passage that holds the answer
// (see labelChunks). recall@k = share of questions with that rank <= k; MRR = mean of 1/rank
// over the 15 candidates (0 when absent). Grouped by question language; cross-lingual and
// scanned-page questions are reported apart and not part of any adoption rule.
import { describe, it } from 'vitest'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  pipeline,
  type FeatureExtractionPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { chunkText } from '../src/lib/chunker'
import { hybridRankChunks } from '../src/lib/retrieval'
import { applyRerank } from '../src/lib/reranker'
import { EMBEDDING_MODEL, RERANK_MODEL, shouldRerank } from '../src/lib/searchModels'
import { buildIdf, classifyMatch, findSourceMatch, matchFeatures } from '../src/lib/sourceMatch'
import { DOCS, QUERIES, type FixtureQuery } from './fixtures'

const ROOT = new URL('..', import.meta.url).pathname
const CACHE = join(ROOT, 'eval/.cache')
env.cacheDir = CACHE
env.allowLocalModels = false

interface Embedder {
  key: string
  id: string
  revision: string
  queryPrefix: string
  passagePrefix: string
}

// Revisions pinned so a re-run measures the same weights. 'e5' is the app's model
// (src/lib/searchModels.ts); 'minilm' is the pre-v1.1 one; 'pmini' the other candidate.
const EMBEDDERS: Embedder[] = [
  { key: 'minilm', id: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9', queryPrefix: '', passagePrefix: '' },
  { key: 'e5', ...EMBEDDING_MODEL },
  { key: 'pmini', id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900', queryPrefix: '', passagePrefix: '' },
]
const RERANKER = RERANK_MODEL
const POOL = 15 // QueryPanel's RERANK_POOL_SIZE

type Extraction = 'space' | 'native' | 'clean'

// 'space' is src/lib/pdf.ts before v1.1 (items joined with ' '); 'native' joins items the way
// pdf.js's own find controller does (no separator, a space at each end of line) and drops
// the NUL pdf.js emits for a glyph with no Unicode mapping. 'clean' skips the PDF and uses
// the fixture's own text: what a perfectly extracted PDF would give, to measure the embedder
// apart from pdf.js (which drops Devanagari vowel signs from Chromium-made PDFs).
async function extract(file: string, mode: Extraction, docId: string): Promise<{ page: number; text: string }[]> {
  if (mode === 'clean') {
    const doc = DOCS.find((d) => d.id === docId)!
    if (doc.scanned) return doc.pages.map((_, i) => ({ page: i + 1, text: '' }))
    const plain = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
    return doc.pages.map((passages, i) => ({ page: i + 1, text: passages.map((p) => plain(p.html)).join(' ') }))
  }
  const pdf = await getDocument({ data: new Uint8Array(readFileSync(file)), verbosity: 0 }).promise
  const pages = []
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent()
    const items = content.items.filter((item) => 'str' in item) as { str: string; hasEOL: boolean }[]
    const text =
      mode === 'space'
        ? items.map((item) => item.str).join(' ')
        : items.map((item) => item.str + (item.hasEOL ? ' ' : '')).join('').replaceAll('\0', '')
    pages.push({ page: n, text })
  }
  return pages
}

// --- Labelling: which fixture passage(s) a chunk holds ----------------------------------
// Character 4-grams with whitespace and NULs removed, so labelling doesn't depend on how
// the extraction spaced things (or garbled a few Devanagari vowel signs). A chunk holds a
// passage when at least 30% of the chunk's 4-grams occur in the passage, or the chunk has at
// least half of the passage's 4-grams (a short passage inside a long chunk). A chunk
// straddling two passages holds both.
const strip = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/&gt;/g, '>').replaceAll('\0', '').replace(/\s+/g, '').toLowerCase()
function grams(s: string): Set<string> {
  const out = new Set<string>()
  for (let i = 0; i + 4 <= s.length; i++) out.add(s.slice(i, i + 4))
  return out
}
const PASSAGE_GRAMS = new Map(DOCS.flatMap((d) => d.pages.flat().map((p) => [p.id, grams(strip(p.html))] as const)))
// Passage ids by document and 1-based page: a chunk never spans pages, so it can only hold
// passages from its own page (similar worked examples on other pages share many 4-grams).
const PAGE_PASSAGES = new Map(DOCS.map((d) => [d.id, d.pages.map((page) => page.map((p) => p.id))]))

function labelChunk(docId: string, page: number, text: string): string[] {
  const chunkGrams = grams(strip(text))
  if (chunkGrams.size === 0) return []
  return PAGE_PASSAGES.get(docId)![page - 1].filter((id) => {
    const passage = PASSAGE_GRAMS.get(id)!
    const shared = [...chunkGrams].filter((x) => passage.has(x)).length
    return shared / chunkGrams.size >= 0.3 || shared / passage.size >= 0.5
  })
}

// --- Models -----------------------------------------------------------------------------
function dirBytes(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).reduce(
      (sum, e) => sum + (e.isDirectory() ? dirBytes(join(dir, e.name)) : statSync(join(dir, e.name)).size),
      0,
    )
  } catch {
    return 0
  }
}

interface LoadedEmbedder {
  e: Embedder
  extractor: FeatureExtractionPipeline
  countTokens: (text: string) => number
  loadMs: number
  rssDeltaMb: number
  downloadBytes: number
}

async function loadEmbedder(e: Embedder): Promise<LoadedEmbedder> {
  // Warm the cache first so loadMs measures a cached load, as on a returning visit.
  await pipeline('feature-extraction', e.id, { dtype: 'q8', revision: e.revision }).then((p) => p.dispose())
  globalThis.gc?.()
  const rss0 = process.memoryUsage().rss
  const t0 = performance.now()
  const extractor = await pipeline('feature-extraction', e.id, { dtype: 'q8', revision: e.revision })
  const tokenizer = await AutoTokenizer.from_pretrained(e.id, { revision: e.revision })
  await extractor(['warm up'], { pooling: 'mean', normalize: true })
  const loadMs = performance.now() - t0
  const rssDeltaMb = (process.memoryUsage().rss - rss0) / 2 ** 20
  return {
    e,
    extractor,
    countTokens: (text) => tokenizer(text, { add_special_tokens: false }).input_ids.data.length,
    loadMs,
    rssDeltaMb,
    downloadBytes: dirBytes(join(CACHE, e.id, e.revision)),
  }
}

async function embed(m: LoadedEmbedder, text: string): Promise<number[]> {
  const out = await m.extractor([text], { pooling: 'mean', normalize: true })
  return out.tolist()[0] as number[]
}

let reranker: { tokenizer: PreTrainedTokenizer; model: PreTrainedModel } | null = null
async function rerankScores(query: string, candidates: { id: string; text: string }[]) {
  reranker ??= {
    tokenizer: await AutoTokenizer.from_pretrained(RERANKER.id, { revision: RERANKER.revision }),
    model: await AutoModelForSequenceClassification.from_pretrained(RERANKER.id, { dtype: 'q8', revision: RERANKER.revision }),
  }
  const { tokenizer, model } = reranker
  const inputs = tokenizer(candidates.map(() => query), { text_pair: candidates.map((c) => c.text), padding: true, truncation: true })
  const out = (await model(inputs)) as { logits: { tolist(): number[][] } }
  const scores = out.logits.tolist()
  return candidates.map((c, i) => ({ id: c.id, score: scores[i][0] }))
}

// --- Metrics ----------------------------------------------------------------------------
interface EvalChunk {
  id: string
  documentId: string
  text: string
  page: number
  embedding: number[]
  passages: string[]
}

interface Metrics {
  n: number
  r1: number
  r3: number
  r5: number
  mrr: number
}
function metrics(ranks: (number | null)[]): Metrics {
  const n = ranks.length
  const at = (k: number) => ranks.filter((r) => r !== null && r <= k).length / n
  const mrr = ranks.reduce<number>((s, r) => s + (r === null ? 0 : 1 / r), 0) / n
  const round = (x: number) => Math.round(x * 1000) / 10 // percent, 1 decimal
  return { n, r1: round(at(1)), r3: round(at(3)), r5: round(at(5)), mrr: Math.round(mrr * 1000) / 1000 }
}

function group(q: FixtureQuery): string {
  if (q.doc === 'scanned-lab') return 'scanned'
  if (q.kind === 'cross') return 'cross'
  return q.lang
}

// What the worked-example rule should do for each kind of question: show the source for
// the document's own question, follow its method for new numbers, and never show the wrong
// method's solution as the source (negatives: a method match on the right example is fine).
const EXPECTED_MATCH: Record<FixtureQuery['kind'], string> = {
  exact: 'verbatim:right-passage',
  near: 'verbatim:right-passage | none',
  numbers: 'method:right-passage',
  negative: 'method:right-passage | none',
  paraphrase: 'none',
  cross: 'none',
}

const wanted = (name: string, all: string[]) => (process.env[name] ? process.env[name]!.split(',') : all)

describe('retrieval eval', () => {
  it('measures recall@1/3/5 and MRR per language', async () => {
    const embedderKeys = wanted('EVAL_EMBEDDERS', EMBEDDERS.map((e) => e.key))
    const extractions = wanted('EVAL_EXTRACTIONS', ['space', 'native', 'clean']) as Extraction[]
    const rerankModes = wanted('EVAL_RERANK', ['on', 'off', 'policy'])
    const results: Record<string, unknown>[] = []
    const models: Record<string, unknown>[] = []
    const extractionReport: Record<string, unknown> = {}
    const sourceMatch: Record<string, unknown>[] = []

    for (const e of EMBEDDERS.filter((x) => embedderKeys.includes(x.key))) {
      const m = await loadEmbedder(e)
      models.push({ embedder: e.key, id: e.id, revision: e.revision, downloadMB: +(m.downloadBytes / 1e6).toFixed(1), cachedLoadMs: Math.round(m.loadMs), rssDeltaMB: Math.round(m.rssDeltaMb) })

      for (const mode of extractions) {
        const chunks: EvalChunk[] = []
        for (const d of DOCS) {
          const pages = await extract(join(ROOT, 'eval/fixtures', `${d.id}.pdf`), mode, d.id)
          extractionReport[`${mode}:${d.id}`] = pages.map((p) => p.text.length)
          for (const p of pages) {
            for (const c of chunkText(p.text, { countTokens: m.countTokens })) {
              chunks.push({
                id: `${d.id}#${chunks.length}`,
                documentId: d.id,
                text: c.text,
                page: p.page,
                embedding: await embed(m, e.passagePrefix + c.text),
                passages: labelChunk(d.id, p.page, c.text),
              })
            }
          }
        }
        const unlabelled = DOCS.flatMap((d) => d.pages.flat().map((p) => p.id)).filter((id) => !chunks.some((c) => c.passages.includes(id)))

        for (const rerank of rerankModes) {
          for (const scope of ['doc', 'all'] as const) {
            const perQuery: { id: string; group: string; rank: number | null }[] = []
            for (const q of QUERIES) {
              const pool = scope === 'doc' ? chunks.filter((c) => c.documentId === q.doc) : chunks
              const qEmb = await embed(m, e.queryPrefix + q.q)
              const candidates = hybridRankChunks(qEmb, q.q, pool, POOL)
              let ranked = candidates.map((c) => c.chunk)
              // 'policy' is the app since v1.1: rerank English questions only.
              const doRerank = rerank === 'on' || (rerank === 'policy' && shouldRerank(q.q))
              if (doRerank && candidates.length > 3) {
                const scores = await rerankScores(q.q, ranked.map((c) => ({ id: c.id, text: c.text })))
                ranked = applyRerank(scores, ranked, POOL).map((r) => r.chunk)
              }
              const i = ranked.findIndex((c) => c.passages.includes(q.expect))
              perQuery.push({ id: q.id, group: group(q), rank: i === -1 ? null : i + 1 })
              // Worked-example rule (src/lib/sourceMatch.ts), on the app's own configuration.
              if (e.key === 'e5' && mode !== 'native' && rerank === 'policy') {
                const top = ranked.slice(0, 3)
                const idf = buildIdf(pool)
                const match = findSourceMatch(q.q, qEmb, top, pool)
                const matched = match ? top.find((c) => c.id === match.chunkId)! : null
                sourceMatch.push({
                  extraction: mode,
                  scope,
                  id: q.id,
                  kind: q.kind,
                  match: match ? `${match.kind}:${matched!.passages.includes(q.expect) ? 'right' : 'WRONG'}-passage` : 'none',
                  expected: EXPECTED_MATCH[q.kind],
                  top3: top.map((c) => {
                    const f = matchFeatures(q.q, c, qEmb, idf)
                    const r = (x: number) => Math.round(x * 100) / 100
                    return `${c.passages.join('+') || '?'} w${r(f.wordCover)} n${r(f.numberCover)} c${r(f.cosine)} ${classifyMatch(q.q, f) ?? '-'}`
                  }),
                })
              }
            }
            const groups = [...new Set(perQuery.map((p) => p.group))]
            results.push({
              embedder: e.key,
              extraction: mode,
              rerank,
              scope,
              chunkCount: chunks.length,
              unlabelledPassages: unlabelled,
              byGroup: Object.fromEntries(groups.map((g) => [g, metrics(perQuery.filter((p) => p.group === g).map((p) => p.rank))])),
              misses: perQuery.filter((p) => p.rank !== 1).map((p) => `${p.id}:${p.rank ?? '-'}`),
            })
          }
        }
      }
      await m.extractor.dispose()
    }

    const label = process.env.EVAL_LABEL ?? 'latest'
    mkdirSync(join(ROOT, 'eval/results'), { recursive: true })
    writeFileSync(join(ROOT, 'eval/results', `${label}.json`), JSON.stringify({ label, models, extractionChars: extractionReport, results, sourceMatch }, null, 2) + '\n')

    console.log(JSON.stringify(models))
    for (const r of results as { embedder: string; extraction: string; rerank: string; scope: string; byGroup: Record<string, Metrics> }[]) {
      const cells = Object.entries(r.byGroup).map(([g, x]) => `${g}(${x.n}) r1 ${x.r1} r3 ${x.r3} r5 ${x.r5} mrr ${x.mrr}`)
      console.log(`${r.embedder.padEnd(6)} ${r.extraction.padEnd(6)} rerank:${r.rerank.padEnd(6)} ${r.scope.padEnd(3)} | ${cells.join(' | ')}`)
    }
  })
})
