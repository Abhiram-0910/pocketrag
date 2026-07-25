import { useCallback, useState, type FormEvent } from 'react'
import { embedQuery } from '../lib/embeddingClient'
import { getChunksForDocument, type ChunkRecord } from '../lib/db'
import { rankChunks, type ScoredChunk } from '../lib/retrieval'
import { useDocumentStore } from '../store/documentStore'

const TOP_K = 3

export function QueryPanel() {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ScoredChunk<ChunkRecord>[] | null>(null)

  const status = useDocumentStore((s) => s.status)
  const documentId = useDocumentStore((s) => s.documentId)
  const canQuery = status === 'ready' && documentId != null

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      if (!canQuery || !documentId || !query.trim() || busy) return

      setBusy(true)
      setError(null)
      setResults(null)

      embedQuery(query, {
        onBackend: () => {},
        onModelProgress: () => {},
        onModelReady: () => {},
        onQueryEmbedding: (msg) => {
          getChunksForDocument(documentId)
            .then((chunks) => setResults(rankChunks(msg.embedding, chunks, TOP_K)))
            .catch((err) => setError(err instanceof Error ? err.message : 'Failed to retrieve chunks.'))
            .finally(() => setBusy(false))
        },
        onError: (msg) => {
          setError(msg.message)
          setBusy(false)
        },
      })
    },
    [canQuery, documentId, query, busy],
  )

  return (
    <div className="mt-8 text-left">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!canQuery || busy}
          placeholder={canQuery ? 'Ask a question about the document…' : 'Upload a document first'}
          className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
        />
        <button
          type="submit"
          disabled={!canQuery || busy || !query.trim()}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:bg-gray-300"
        >
          {busy ? 'Searching…' : 'Search'}
        </button>
      </form>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {results && (
        <ul className="mt-4 space-y-3">
          {results.map(({ chunk, score }) => (
            <li key={chunk.id} className="rounded border border-gray-200 p-3 text-sm text-gray-700">
              <p className="mb-1 text-xs tracking-wide text-gray-400 uppercase">
                page {chunk.page} · score {score.toFixed(3)}
              </p>
              {chunk.text}
            </li>
          ))}
        </ul>
      )}
      {results && results.length === 0 && <p className="mt-4 text-sm text-gray-500">No chunks found.</p>}
    </div>
  )
}
