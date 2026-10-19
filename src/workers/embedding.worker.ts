import {
  AutoModelForSequenceClassification,
  AutoTokenizer,
  env,
  pipeline,
  type FeatureExtractionPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer,
  type ProgressInfo,
} from '@huggingface/transformers'
import { chunkText, type Tokenizer } from '../lib/chunker'
import { downloadFetch } from '../lib/egress'
import { resolveBackend } from './backend'
import type { EmbeddedChunk, RerankCandidate, RerankScore, WorkerRequest, WorkerResponse } from './embedding.types'

// transformers.js loads ONNX Runtime from jsDelivr at a pinned version path; the CSP
// restricts it to that path, but the files themselves aren't integrity-checked (see ortPin.ts).

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
// Smaller of the two common MS MARCO cross-encoder sizes (~16MB q8 vs. ~23MB for
// -L-6-v2, checked against the real published ONNX file sizes) — this app already
// downloads one ~23MB model for embeddings, so the smaller reranker keeps the total
// download from roughly doubling on first use.
const RERANK_MODEL_ID = 'Xenova/ms-marco-MiniLM-L-2-v2'

// Vite bundles this file as a module worker; `self` here is the worker global,
// not `Window` — narrow it manually instead of pulling in the `webworker` lib,
// which conflicts with the `DOM` lib already loaded for the rest of the app.
interface WorkerScope {
  postMessage(message: WorkerResponse): void
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  navigator?: { gpu?: { requestAdapter(): Promise<unknown> } }
}
const ctx = self as unknown as WorkerScope

function post(message: WorkerResponse) {
  ctx.postMessage(message)
}

// Every model file and ONNX Runtime download goes through egress.ts, which reports it to
// the main thread's egress log. egress.bypass.test.ts checks this assignment stays.
env.fetch = downloadFetch(RERANK_MODEL_ID, (record) => post({ type: 'egress', record }))

function onModelProgress(info: ProgressInfo) {
  if (info.status === 'progress_total') {
    post({ type: 'model-progress', percent: Math.round(info.progress) })
  }
}

function createExtractor(device: 'webgpu' | 'wasm'): Promise<FeatureExtractionPipeline> {
  return pipeline('feature-extraction', MODEL_ID, {
    dtype: 'q8',
    device,
    progress_callback: onModelProgress,
  })
}

let extractorPromise: ReturnType<typeof resolveBackend<FeatureExtractionPipeline>> | null = null
let tokenizerPromise: ReturnType<typeof AutoTokenizer.from_pretrained> | null = null

async function getTokenizer(): Promise<Tokenizer> {
  tokenizerPromise ??= AutoTokenizer.from_pretrained(MODEL_ID)
  const hfTokenizer = await tokenizerPromise
  return { countTokens: (text) => hfTokenizer(text, { add_special_tokens: false }).input_ids.data.length }
}

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= resolveBackend(ctx.navigator?.gpu, createExtractor)
  const { extractor, backend, detail } = await extractorPromise
  post({ type: 'backend', backend, detail })
  post({ type: 'model-ready' })
  return extractor
}

async function embedText(extractor: FeatureExtractionPipeline, text: string): Promise<number[]> {
  const output = await extractor([text], { pooling: 'mean', normalize: true })
  return output.tolist()[0] as number[]
}

interface Reranker {
  tokenizer: PreTrainedTokenizer
  model: PreTrainedModel
}

// Cross-encoders use a sequence-classification head (query+passage pair in, a single
// relevance logit out), not the feature-extraction pipeline the embedding model
// uses — confirmed against real transformers.js model docs before writing this,
// not assumed from the embedding model's own API shape.
async function createReranker(device: 'webgpu' | 'wasm'): Promise<Reranker> {
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(RERANK_MODEL_ID),
    AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL_ID, {
      dtype: 'q8',
      device,
      progress_callback: onModelProgress,
    }),
  ])
  return { tokenizer, model }
}

let rerankerPromise: ReturnType<typeof resolveBackend<Reranker>> | null = null

async function getReranker(): Promise<Reranker> {
  rerankerPromise ??= resolveBackend(ctx.navigator?.gpu, createReranker)
  // resolveBackend's return field is named `extractor` generically (shared with
  // getExtractor() above) — aliased here since this holds a {tokenizer, model} pair,
  // not an extractor.
  const { extractor: reranker, backend, detail } = await rerankerPromise
  post({ type: 'backend', backend, detail })
  post({ type: 'model-ready' })
  return reranker
}

// One batched model call for the whole candidate pool rather than one call per
// candidate — the tokenizer's text_pair accepts parallel arrays.
async function rerank(query: string, candidates: RerankCandidate[]): Promise<RerankScore[]> {
  const { tokenizer, model } = await getReranker()
  const inputs = tokenizer(
    candidates.map(() => query),
    { text_pair: candidates.map((c) => c.text), padding: true, truncation: true },
  )
  const output = (await model(inputs)) as { logits: { tolist(): number[][] } }
  const scores = output.logits.tolist()
  return candidates.map((c, i) => ({ id: c.id, score: scores[i][0] }))
}

ctx.onmessage = async (event) => {
  const msg = event.data

  try {
    if (msg.type === 'embed-document') {
      const tokenizer = await getTokenizer()

      // Chunk each page independently: a chunk's page is then unambiguous —
      // no chunk ever spans a page boundary.
      const chunks: Omit<EmbeddedChunk, 'embedding'>[] = []
      for (const { page, text, hasImage } of msg.pages) {
        for (const chunk of chunkText(text, tokenizer)) {
          chunks.push({ ...chunk, index: chunks.length, page, hasImage })
        }
      }
      post({ type: 'chunked', chunkCount: chunks.length })

      const extractor = await getExtractor()

      const embeddedChunks: EmbeddedChunk[] = []
      let dims = 0
      for (const chunk of chunks) {
        const embedding = await embedText(extractor, chunk.text)
        dims = embedding.length
        embeddedChunks.push({ ...chunk, embedding })
        post({ type: 'embed-progress', done: embeddedChunks.length, total: chunks.length })
      }

      post({ type: 'result', chunks: embeddedChunks, dims })
      return
    }

    if (msg.type === 'embed-query') {
      const extractor = await getExtractor()
      const embedding = await embedText(extractor, msg.text)
      post({ type: 'query-embedding', embedding })
      return
    }

    if (msg.type === 'rerank') {
      const scores = await rerank(msg.query, msg.candidates)
      post({ type: 'rerank-result', scores })
      return
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
