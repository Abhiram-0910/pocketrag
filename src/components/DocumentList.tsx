import { useDocumentStore, type DocEntry } from '../store/documentStore'

const BACKEND_LABEL: Record<string, string> = {
  webgpu: 'WebGPU',
  'wasm-unavailable': 'WASM (WebGPU unavailable)',
  'wasm-failed': 'WASM (WebGPU failed at runtime)',
}

/** One-line status text for a document row. */
function statusText(doc: DocEntry): string {
  switch (doc.status) {
    case 'queued':
      return 'Queued…'
    case 'extracting-text':
      return 'Extracting text…'
    case 'loading-model':
      return 'Loading model…'
    case 'embedding':
      return doc.embedProgress ? `Embedding ${doc.embedProgress.done}/${doc.embedProgress.total}` : 'Embedding…'
    case 'ready':
      return `${doc.chunkCount} chunk${doc.chunkCount === 1 ? '' : 's'}`
    case 'error':
      return doc.error ?? 'Failed'
  }
}

export function DocumentList() {
  const documents = useDocumentStore((s) => s.documents)
  const selectedId = useDocumentStore((s) => s.selectedId)
  const selectDocument = useDocumentStore((s) => s.selectDocument)
  const removeDocument = useDocumentStore((s) => s.removeDocument)
  const backend = useDocumentStore((s) => s.backend)
  const backendDetail = useDocumentStore((s) => s.backendDetail)
  const modelProgress = useDocumentStore((s) => s.modelProgress)

  if (documents.length === 0) return null

  const loadingModel = documents.some((d) => d.status === 'loading-model')

  return (
    <div className="mt-6 text-left">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
        {backend && (
          <span className="rounded bg-gray-100 px-2 py-1 text-gray-700" title={backendDetail ?? undefined}>
            Backend: {BACKEND_LABEL[backend] ?? backend}
          </span>
        )}
        {loadingModel && <span>Downloading model{modelProgress != null ? ` — ${modelProgress}%` : '…'}</span>}
      </div>

      <ul className="space-y-2">
        {documents.map((doc) => {
          const selectable = doc.status === 'ready'
          const isSelected = doc.id === selectedId
          return (
            <li key={doc.id} className="flex items-stretch gap-2">
              <button
                type="button"
                disabled={!selectable}
                onClick={() => selectDocument(doc.id)}
                className={`flex-1 rounded border p-3 text-left transition-colors ${
                  isSelected ? 'border-blue-500 bg-blue-50' : 'border-gray-200'
                } ${selectable ? 'cursor-pointer hover:border-blue-300' : 'cursor-default'}`}
              >
                <p className="truncate text-sm font-medium text-gray-900">{doc.fileName}</p>
                <p className={`mt-0.5 text-xs ${doc.status === 'error' ? 'text-red-600' : 'text-gray-500'}`}>
                  {statusText(doc)}
                </p>
              </button>
              {/* A failed file was never persisted, so removing it just clears the in-memory
                  notice — retry is re-dropping the file (see ARCHITECTURE.md / TODO.md). */}
              {doc.status === 'error' && (
                <button
                  type="button"
                  onClick={() => removeDocument(doc.id)}
                  aria-label={`Remove ${doc.fileName}`}
                  className="rounded border border-gray-200 px-3 text-gray-400 hover:border-red-300 hover:text-red-600"
                >
                  ✕
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
