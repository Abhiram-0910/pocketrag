import { useCallback, useState, type FormEvent } from 'react'
import { embedQuery } from '../lib/embeddingClient'
import { getChunksForDocument, type ChunkRecord } from '../lib/db'
import { rankChunks, type ScoredChunk } from '../lib/retrieval'
import { useDocumentStore } from '../store/documentStore'

const TOP_K = 3
const ANSWER_API_URL = import.meta.env.VITE_ANSWER_API_URL

interface AnswerResponse {
  answer: string
  groundingWarning: boolean
}

async function requestAnswer(question: string, chunks: ScoredChunk<ChunkRecord>[]): Promise<AnswerResponse> {
  if (!ANSWER_API_URL) {
    throw new Error('Answer generation is not configured yet (VITE_ANSWER_API_URL is unset).')
  }
  const res = await fetch(ANSWER_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question,
      chunks: chunks.map(({ chunk, score }) => ({ text: chunk.text, page: chunk.page, score })),
    }),
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(data?.error ?? `Answer request failed (${res.status}).`)
  }
  return (await res.json()) as AnswerResponse
}

export function QueryPanel() {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [awaitingAnswer, setAwaitingAnswer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ScoredChunk<ChunkRecord>[] | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const [groundingWarning, setGroundingWarning] = useState(false)
  const [answerError, setAnswerError] = useState<string | null>(null)

  const status = useDocumentStore((s) => s.status)
  const documentId = useDocumentStore((s) => s.documentId)
  const canQuery = status === 'ready' && documentId != null

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      if (!canQuery || !documentId || !query.trim() || busy) return

      const question = query.trim()
      setBusy(true)
      setError(null)
      setResults(null)
      setAnswer(null)
      setAnswerError(null)
      setGroundingWarning(false)

      embedQuery(question, {
        onBackend: () => {},
        onModelProgress: () => {},
        onModelReady: () => {},
        onQueryEmbedding: (msg) => {
          getChunksForDocument(documentId)
            .then(async (chunks) => {
              const ranked = rankChunks(msg.embedding, chunks, TOP_K)
              setResults(ranked)

              setAwaitingAnswer(true)
              try {
                const { answer: text, groundingWarning: warning } = await requestAnswer(question, ranked)
                setAnswer(text)
                setGroundingWarning(warning)
              } catch (err) {
                const reason = err instanceof Error ? err.message : 'unknown error'
                setAnswerError(`Answer generation failed (${reason}) — showing raw matched passages below.`)
              } finally {
                setAwaitingAnswer(false)
              }
            })
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

      {awaitingAnswer && (
        <p className="mt-4 text-sm text-gray-500">
          Generating an answer… this usually takes a few seconds, but can occasionally take up to a few
          minutes on the free tier. Please don't close this tab.
        </p>
      )}

      {answer && (
        <div className="mt-4 rounded border border-blue-200 bg-blue-50 p-4">
          {groundingWarning && (
            <p className="mb-2 text-xs font-medium text-amber-700">
              This answer may not be fully grounded in the source document — verify against the sources below.
            </p>
          )}
          <p className="text-sm text-gray-900">{answer}</p>
        </div>
      )}

      {answerError && <p className="mt-4 text-sm text-amber-700">{answerError}</p>}

      {results && results.length > 0 && (
        <details className="mt-4" open={!answer}>
          <summary className="cursor-pointer text-sm font-medium text-gray-700">Sources ({results.length})</summary>
          <ul className="mt-3 space-y-3">
            {results.map(({ chunk, score }) => (
              <li key={chunk.id} className="rounded border border-gray-200 p-3 text-sm text-gray-700">
                <p className="mb-1 text-xs tracking-wide text-gray-400 uppercase">
                  page {chunk.page} · score {score.toFixed(3)}
                </p>
                {chunk.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      {results && results.length === 0 && <p className="mt-4 text-sm text-gray-500">No chunks found.</p>}
    </div>
  )
}
