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

ctx.onmessage = async (event) => {
  const msg = event.data
  if (msg.type !== 'embed-document') return

  try {
    if (!tokenizerPromise) tokenizerPromise = AutoTokenizer.from_pretrained(MODEL_ID)
    const hfTokenizer = await tokenizerPromise
    const tokenizer: Tokenizer = {
      countTokens: (text) => hfTokenizer(text, { add_special_tokens: false }).input_ids.data.length,
    }

    const chunks = chunkText(msg.text, tokenizer)
    post({ type: 'chunked', chunkCount: chunks.length })

    if (!extractorPromise) extractorPromise = resolveBackend(ctx.navigator?.gpu, createExtractor)
    const { extractor, backend, detail } = await extractorPromise
    post({ type: 'backend', backend, detail })
    post({ type: 'model-ready' })

    const embeddedChunks: EmbeddedChunk[] = []
    let dims = 0
    for (const chunk of chunks) {
      const output = await extractor([chunk.text], { pooling: 'mean', normalize: true })
      const vector = output.tolist()[0] as number[]
      dims = vector.length
      embeddedChunks.push({ ...chunk, embedding: vector })
      post({ type: 'embed-progress', done: embeddedChunks.length, total: chunks.length })
    }

    post({ type: 'result', chunks: embeddedChunks, dims })
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
