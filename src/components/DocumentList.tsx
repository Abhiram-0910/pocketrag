import { useState } from 'react'
import { Trash } from '@phosphor-icons/react'
import { deleteDocument } from '../lib/db'
import { forgetSessionFile } from '../lib/sessionFiles'
import { useDocumentStore, type DocEntry } from '../store/documentStore'
import { classifyWebgpuFallback } from '../lib/errorTaxonomy'
import { StatusBanner } from './ui/StatusBanner'
import { Button } from './ui/Button'

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
    case 'ocr-uploading':
      return 'Preparing…'
    case 'ocr-processing':
      return 'Extracting text via OCR — larger scans can take a minute…'
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

interface DocumentListProps {
  source: 'document' | 'note'
}

export function DocumentList({ source }: DocumentListProps) {
  const allDocuments = useDocumentStore((s) => s.documents)
  const documents = allDocuments.filter((d) => d.source === source)
  const selectedId = useDocumentStore((s) => s.selectedId)
  const selectDocument = useDocumentStore((s) => s.selectDocument)
  const removeDocument = useDocumentStore((s) => s.removeDocument)
  const backend = useDocumentStore((s) => s.backend)
  const backendDetail = useDocumentStore((s) => s.backendDetail)
  const modelProgress = useDocumentStore((s) => s.modelProgress)

  // Only one row confirms at a time; a failed delete leaves the row in place with a
  // brief inline error rather than crashing (deletion is destructive, so no silent retry).
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null)

  if (documents.length === 0) return null

  const handleDelete = async (id: string) => {
    try {
      await deleteDocument(id)
      setConfirmingId(null)
      setDeleteError(null)
      removeDocument(id)
      forgetSessionFile(id)
    } catch (err) {
      setConfirmingId(null)
      setDeleteError({ id, message: err instanceof Error ? err.message : 'Failed to delete.' })
    }
  }

  const loadingModel = documents.some((d) => d.status === 'loading-model')
  const webgpuFallback = backend === 'wasm-unavailable' || backend === 'wasm-failed'

  return (
    <div className="text-left">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {backend === 'webgpu' && (
          <span
            className="rounded bg-slate-100 px-2 py-1 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
            title={backendDetail ?? undefined}
          >
            Backend: {BACKEND_LABEL[backend]}
          </span>
        )}
        {webgpuFallback && (
          <StatusBanner variant="info">{classifyWebgpuFallback(backend, backendDetail ?? '').message}</StatusBanner>
        )}
        {loadingModel && (
          <span className="text-slate-500 motion-safe:animate-pulse dark:text-slate-400">
            Downloading model{modelProgress != null ? ` — ${modelProgress}%` : '…'}
          </span>
        )}
      </div>

      <ul className="space-y-2">
        {documents.map((doc) => {
          const selectable = doc.status === 'ready'
          const isSelected = doc.id === selectedId
          return (
            <li key={doc.id}>
              <div className="flex items-stretch gap-2">
                <button
                  type="button"
                  disabled={!selectable}
                  onClick={() => selectDocument(doc.id)}
                  className={`flex-1 rounded border p-3 text-left transition-colors duration-150 ${
                    isSelected
                      ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950'
                      : 'border-slate-200 dark:border-slate-700'
                  } ${selectable ? 'cursor-pointer hover:border-blue-300 dark:hover:border-blue-500' : 'cursor-default'}`}
                >
                  <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{doc.fileName}</p>
                  <p
                    className={`mt-0.5 text-xs ${doc.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}
                  >
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
                    className="min-h-11 min-w-11 cursor-pointer rounded border border-slate-200 px-3 text-slate-400 hover:border-red-300 hover:text-red-600 dark:border-slate-700 dark:text-slate-500 dark:hover:border-red-500 dark:hover:text-red-400"
                  >
                    <Trash className="mx-auto size-4" weight="bold" aria-hidden="true" />
                  </button>
                )}
                {/* A ready doc is persisted, so deletion is destructive — an inline two-step
                    confirm (not window.confirm(), which blocks the tab and can't be styled). */}
                {doc.status === 'ready' && confirmingId !== doc.id && (
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmingId(doc.id)
                      setDeleteError(null)
                    }}
                    aria-label={`Delete ${doc.fileName}`}
                    className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded border border-slate-200 px-3 text-xs text-slate-400 hover:border-red-300 hover:text-red-600 dark:border-slate-700 dark:text-slate-500 dark:hover:border-red-500 dark:hover:text-red-400"
                  >
                    <Trash className="size-4" weight="bold" aria-hidden="true" />
                  </button>
                )}
                {doc.status === 'ready' && confirmingId === doc.id && (
                  <StatusBanner variant="error" className="items-center">
                    <span className="flex flex-wrap items-center gap-2">
                      Delete permanently?
                      <Button variant="destructive" onClick={() => void handleDelete(doc.id)}>
                        Delete
                      </Button>
                      <Button variant="secondary" onClick={() => setConfirmingId(null)}>
                        Cancel
                      </Button>
                    </span>
                  </StatusBanner>
                )}
              </div>
              {deleteError?.id === doc.id && <StatusBanner variant="error" className="mt-1">{deleteError.message}</StatusBanner>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
