import { useCallback, useState, type FormEvent } from 'react'
import { embedQuery } from '../lib/embeddingClient'
import { getChunksForDocument, type ChunkRecord } from '../lib/db'
import { rankChunks, type ScoredChunk } from '../lib/retrieval'
import { attemptAnswer, fetchAnswerFromWorker, type DocLabel } from '../lib/answerRequest'
import { useDocumentStore } from '../store/documentStore'

const TOP_K = 3
const ANSWER_TIMEOUT_MS = 60_000

export function QueryPanel() {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [awaitingAnswer, setAwaitingAnswer] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ScoredChunk<ChunkRecord>[] | null>(null)
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const [groundingWarning, setGroundingWarning] = useState(false)
  const [answerError, setAnswerError] = useState<string | null>(null)
  const [docLabels, setDocLabels] = useState<DocLabel[]>([])

  // Query the selected document ("this document" scope). The all-documents scope
  // toggle lands in a later commit.
  const documents = useDocumentStore((s) => s.documents)
  const selectedId = useDocumentStore((s) => s.selectedId)
  const documentId = documents.find((d) => d.id === selectedId && d.status === 'ready')?.id ?? null
  const canQuery = documentId != null

  const titleFor = (id: string) => documents.find((d) => d.id === id)?.fileName ?? id

  const runAnswerAttempt = useCallback(
    async (question: string, chunks: ScoredChunk<ChunkRecord>[], isRetry: boolean) => {
      setAwaitingAnswer(true)
      setTimedOut(false)
      if (!isRetry) setAnswerError(null)

      const requestChunks = chunks.map(({ chunk, score }) => ({
        text: chunk.text,
        page: chunk.page,
        score,
        documentId: chunk.documentId,
      }))
      const result = await attemptAnswer(fetchAnswerFromWorker, question, requestChunks, ANSWER_TIMEOUT_MS)

      if (result.outcome === 'success') {
        setAnswer(result.answer)
        setGroundingWarning(result.groundingWarning)
        setDocLabels(result.docLabels)
      } else if (result.outcome === 'timeout') {
        if (isRetry) {
          setAnswerError('Answer generation timed out again — showing raw matched passages below.')
        } else {
          setTimedOut(true)
        }
      } else {
        setAnswerError(`Answer generation failed (${result.message}) — showing raw matched passages below.`)
      }
      setAwaitingAnswer(false)
    },
    [],
  )

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      if (!canQuery || !documentId || !query.trim() || busy) return

      const question = query.trim()
      setBusy(true)
      setError(null)
      setResults(null)
      setSubmittedQuestion(question)
      setAnswer(null)
      setAnswerError(null)
      setTimedOut(false)
      setGroundingWarning(false)
      setDocLabels([])

      embedQuery(question, {
        onBackend: () => {},
        onModelProgress: () => {},
        onModelReady: () => {},
        onQueryEmbedding: (msg) => {
          getChunksForDocument(documentId)
            .then(async (chunks) => {
              const ranked = rankChunks(msg.embedding, chunks, TOP_K)
              setResults(ranked)
              await runAnswerAttempt(question, ranked, false)
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
    [canQuery, documentId, query, busy, runAnswerAttempt],
  )

  const handleRetry = useCallback(() => {
    if (!submittedQuestion || !results) return
    setBusy(true)
    runAnswerAttempt(submittedQuestion, results, true).finally(() => setBusy(false))
  }, [submittedQuestion, results, runAnswerAttempt])

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

      {awaitingAnswer && !timedOut && (
        <p className="mt-4 text-sm text-gray-500">
          Generating an answer… this usually takes a few seconds, but can occasionally take up to a few
          minutes on the free tier. Please don't close this tab.
        </p>
      )}

      {timedOut && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-800">This is taking longer than expected.</p>
          <button
            type="button"
            onClick={handleRetry}
            className="mt-2 rounded bg-amber-600 px-3 py-1.5 text-sm text-white"
          >
            Try again
          </button>
        </div>
      )}

      {answer && (
        <div className="mt-4 rounded border border-blue-200 bg-blue-50 p-4">
          {groundingWarning && (
            <p className="mb-2 text-xs font-medium text-amber-700">
              This answer may not be fully grounded in the source document — verify against the sources below.
            </p>
          )}
          <p className="text-sm text-gray-900">{answer}</p>
          {docLabels.length > 0 && (
            <p className="mt-2 text-xs text-gray-500">
              {docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')}
            </p>
          )}
        </div>
      )}

      {answerError && <p className="mt-4 text-sm text-amber-700">{answerError}</p>}

      {results && results.length > 0 && (
        <details className="mt-4" open={!answer}>
          <summary className="cursor-pointer text-sm font-medium text-gray-700">Sources ({results.length})</summary>
          <ul className="mt-3 space-y-3">
            {results.map(({ chunk, score }) => (
              <li key={chunk.id} className="rounded border border-gray-200 p-3 text-sm text-gray-700">
                <p className="mb-1 text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{titleFor(chunk.documentId)}</span> · page {chunk.page} ·
                  score {score.toFixed(3)}
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
