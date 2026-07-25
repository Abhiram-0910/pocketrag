import { useDocumentStore } from '../store/documentStore'
import { cosineSimilarity } from '../lib/similarity'

const BACKEND_LABEL: Record<string, string> = {
  webgpu: 'WebGPU',
  'wasm-unavailable': 'WASM (WebGPU unavailable)',
  'wasm-failed': 'WASM (WebGPU failed at runtime)',
}

export function EmbeddingProof() {
  const status = useDocumentStore((s) => s.status)
  const backend = useDocumentStore((s) => s.backend)
  const backendDetail = useDocumentStore((s) => s.backendDetail)
  const modelProgress = useDocumentStore((s) => s.modelProgress)
  const embedProgress = useDocumentStore((s) => s.embedProgress)
  const chunks = useDocumentStore((s) => s.chunks)

  if (status === 'idle') return null

  return (
    <div className="mt-4 space-y-2 text-left text-sm">
      {backend && (
        <p
          className="inline-block rounded bg-gray-100 px-2 py-1 text-xs text-gray-700"
          title={backendDetail ?? undefined}
        >
          Backend: {BACKEND_LABEL[backend] ?? backend}
        </p>
      )}
      {status === 'loading-model' && (
        <p className="text-gray-500">
          Downloading model{modelProgress != null ? ` — ${modelProgress}%` : '…'}
        </p>
      )}
      {status === 'embedding' && embedProgress && (
        <p className="text-gray-500">
          Embedding chunks — {embedProgress.done}/{embedProgress.total}
        </p>
      )}
      {status === 'ready' && chunks.length > 0 && (
        <div className="rounded border border-gray-200 p-3 text-gray-700">
          <p>Vector dimension: {chunks[0].embedding.length}</p>
          {chunks.length > 1 && (
            <p>
              Similarity(chunk 0, chunk 1) — overlapping, expect high:{' '}
              {cosineSimilarity(chunks[0].embedding, chunks[1].embedding).toFixed(3)}
            </p>
          )}
          {chunks.length > 2 && (
            <p>
              Similarity(chunk 0, chunk {chunks.length - 1}) — distant, expect lower:{' '}
              {cosineSimilarity(chunks[0].embedding, chunks[chunks.length - 1].embedding).toFixed(3)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
