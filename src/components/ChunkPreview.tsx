import { useDocumentStore } from '../store/documentStore'

const PREVIEW_COUNT = 3

export function ChunkPreview() {
  const fileName = useDocumentStore((s) => s.fileName)
  const chunks = useDocumentStore((s) => s.chunks)
  const status = useDocumentStore((s) => s.status)
  const error = useDocumentStore((s) => s.error)

  if (status === 'error') {
    return <p className="mt-6 text-red-600">{error}</p>
  }
  if (status !== 'ready' || chunks.length === 0) return null

  return (
    <div className="mt-6 text-left">
      <p className="font-medium text-gray-900">
        {fileName} — {chunks.length} chunk{chunks.length === 1 ? '' : 's'}
      </p>
      <ul className="mt-3 space-y-3">
        {chunks.slice(0, PREVIEW_COUNT).map((chunk) => (
          <li
            key={chunk.index}
            className="rounded border border-gray-200 p-3 text-sm text-gray-700"
          >
            <p className="mb-1 text-xs tracking-wide text-gray-400 uppercase">
              Chunk {chunk.index} · page {chunk.page} · {chunk.tokenCount} tokens
            </p>
            {chunk.text}
          </li>
        ))}
      </ul>
    </div>
  )
}
