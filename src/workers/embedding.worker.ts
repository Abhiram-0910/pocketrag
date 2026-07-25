import { AutoTokenizer, pipeline, type FeatureExtractionPipeline, type ProgressInfo } from '@huggingface/transformers'
import { chunkText, type Tokenizer } from '../lib/chunker'
import { resolveBackend } from './backend'
import type { EmbeddedChunk, WorkerRequest, WorkerResponse } from './embedding.types'

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

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

ctx.onmessage = async (event) => {
  const msg = event.data

  try {
    if (msg.type === 'embed-document') {
      const tokenizer = await getTokenizer()

      // Chunk each page independently: a chunk's page is then unambiguous —
      // no chunk ever spans a page boundary.
      const chunks: Omit<EmbeddedChunk, 'embedding'>[] = []
      for (const { page, text } of msg.pages) {
        for (const chunk of chunkText(text, tokenizer)) {
          chunks.push({ ...chunk, index: chunks.length, page })
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
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
