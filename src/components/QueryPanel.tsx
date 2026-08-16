import { useCallback, useState, type FormEvent } from 'react'
import { embedQuery, rerankChunks } from '../lib/embeddingClient'
import { getAllChunks, getChunksForDocument, type ChunkRecord } from '../lib/db'
import { hybridRankChunks, type ScoredChunk } from '../lib/retrieval'
import { applyRerank, type RerankScore } from '../lib/reranker'
import type { RerankCandidate } from '../workers/embedding.types'
import {
  attemptAnswer,
  fetchAnswerFromWorker,
  type DocLabel,
  type HistoryTurn,
  type KeyConfig,
} from '../lib/answerRequest'
import { buildRetrievalQuery } from '../lib/conversation'
import { isDiagramLikely } from '../lib/diagramHeuristic'
import { buildConversationPdf, type ExportSource } from '../lib/pdfExport'
import { canRunQuery } from '../lib/queryScope'
import { classify, type TaxonomyResult } from '../lib/errorTaxonomy'
import { useDocumentStore } from '../store/documentStore'
import { StatusBanner } from './ui/StatusBanner'
import { Button } from './ui/Button'

const TOP_K = 3
// Wider candidate pool handed to the cross-encoder reranker — hybrid search narrows
// the full chunk pool down to this many first, then reranking narrows it to TOP_K.
const RERANK_POOL_SIZE = 15
const ANSWER_TIMEOUT_MS = 60_000
// Client-side hygiene cap on stored conversation turns — avoids unbounded growth of
// in-memory state over a long-lived tab, not because 10+ turns would break anything
// today.
const MAX_STORED_TURNS = 10
// Only the most recent turns are sent as `history` on each request — the Worker
// independently re-caps to the same number regardless (worker/src/validate.ts's
// MAX_HISTORY_TURNS), so a mismatch here would just be wasteful, never unsafe.
const SENT_HISTORY_TURNS = 3

interface QueryPanelProps {
  keyConfig: KeyConfig | null
}

interface ConversationTurn {
  question: string
  answer: string
  groundingWarning: boolean
  docLabels: DocLabel[]
}

/**
 * Promise wrapper around the callback-based rerankChunks, for this one call site.
 * `onProgress` only ever fires on a cold model load (subsequent queries reuse the
 * already-loaded model and skip straight to the result) — surfaced in the UI so a
 * slow-connection first-time download doesn't read as a silent hang, matching
 * DocumentList's existing "Downloading model — N%" treatment for the embedding model.
 */
function rerankChunksAsync(
  question: string,
  candidates: RerankCandidate[],
  onProgress: (percent: number) => void,
): Promise<RerankScore[]> {
  return new Promise((resolve, reject) => {
    rerankChunks(question, candidates, {
      onBackend: () => {},
      onModelProgress: (msg) => onProgress(msg.percent),
      onModelReady: () => {},
      onRerankResult: (msg) => resolve(msg.scores),
      onError: (msg) => reject(new Error(msg.message)),
    })
  })
}

export function QueryPanel({ keyConfig }: QueryPanelProps) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [awaitingAnswer, setAwaitingAnswer] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ScoredChunk<ChunkRecord>[] | null>(null)
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const [groundingWarning, setGroundingWarning] = useState(false)
  const [answerError, setAnswerError] = useState<TaxonomyResult | null>(null)
  const [docLabels, setDocLabels] = useState<DocLabel[]>([])
  const [conversationTurns, setConversationTurns] = useState<ConversationTurn[]>([])
  const [scope, setScope] = useState<'document' | 'all'>('document')
  const [rerankModelProgress, setRerankModelProgress] = useState<number | null>(null)

  const documents = useDocumentStore((s) => s.documents)
  const selectedId = useDocumentStore((s) => s.selectedId)
  // "this document" queries the selected ready doc; "all documents" pools every stored
  // doc. hybridRankChunks is scope-agnostic (all embeddings are unit-normalized by the
  // same model, so cosine scores are directly comparable across documents — see
  // ARCHITECTURE.md — and BM25's IDF/avgdl are recomputed fresh over whichever pool is
  // passed in, so keyword scores are always relative to the current scope too).
  const selectedReadyId = documents.find((d) => d.id === selectedId && d.status === 'ready')?.id ?? null
  const hasReadyDoc = documents.some((d) => d.status === 'ready')
  const docsReady = canRunQuery(documents, selectedId, scope)
  const canQuery = docsReady && keyConfig !== null

  const titleFor = (id: string) => documents.find((d) => d.id === id)?.fileName ?? id

  // The currently displayed answer is the last entry in conversationTurns (pushed on
  // every successful runAnswerAttempt below); "Conversation" only ever shows what came
  // before it, so the current answer isn't rendered twice.
  const pastTurns = conversationTurns.slice(0, -1)

  const runAnswerAttempt = useCallback(
    async (question: string, chunks: ScoredChunk<ChunkRecord>[], isRetry: boolean, activeKeyConfig: KeyConfig) => {
      setAwaitingAnswer(true)
      setTimedOut(false)
      if (!isRetry) setAnswerError(null)

      const requestChunks = chunks.map(({ chunk, score }) => ({
        text: chunk.text,
        page: chunk.page,
        score,
        documentId: chunk.documentId,
      }))
      // Prompt history (Milestone 11 Phase C2) is a separate, capped field from
      // retrieval-query blending below — this crosses the wire and shapes the prompt,
      // it never touches retrieval.
      const history: HistoryTurn[] = conversationTurns
        .slice(-SENT_HISTORY_TURNS)
        .map(({ question: q, answer: a }) => ({ question: q, answer: a }))
      const result = await attemptAnswer(
        fetchAnswerFromWorker,
        question,
        requestChunks,
        activeKeyConfig,
        ANSWER_TIMEOUT_MS,
        docLabels,
        history,
      )

      if (result.outcome === 'success') {
        setAnswer(result.answer)
        setGroundingWarning(result.groundingWarning)
        setDocLabels(result.docLabels)
        setConversationTurns((prev) =>
          [
            ...prev,
            { question, answer: result.answer, groundingWarning: result.groundingWarning, docLabels: result.docLabels },
          ].slice(-MAX_STORED_TURNS),
        )
      } else if (result.outcome === 'timeout') {
        if (isRetry) {
          setAnswerError({
            type: 'unknown',
            severity: 'warning',
            message: 'Answer generation timed out again — showing raw matched passages below.',
          })
        } else {
          setTimedOut(true)
        }
      } else {
        const classified = classify({ message: result.message, status: result.status, resetAt: result.resetAt })
        setAnswerError({ ...classified, message: `${classified.message} — showing raw matched passages below.` })
      }
      setAwaitingAnswer(false)
    },
    [docLabels, conversationTurns],
  )

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const useAll = scope === 'all'
      if (!canQuery || keyConfig === null || (!useAll && !selectedReadyId) || !query.trim() || busy) return
      const activeKeyConfig = keyConfig

      const question = query.trim()
      // Retrieval-query blending (Milestone 11 Phase C2): fold the immediately
      // preceding question — and only that one — into the query used for retrieval.
      // The literal, unblended `question` below is still what's sent to the Worker as
      // the actual question being answered; the blended string never crosses the wire.
      const previousQuestion = conversationTurns.at(-1)?.question ?? null
      const retrievalQuery = buildRetrievalQuery(previousQuestion, question)
      setBusy(true)
      setError(null)
      setResults(null)
      setSubmittedQuestion(question)
      setAnswer(null)
      setAnswerError(null)
      setTimedOut(false)
      setGroundingWarning(false)
      // docLabels is intentionally NOT reset here — Milestone 11 Phase C freezes "Doc N"
      // labels for the lifetime of the conversation, so the map from the previous
      // answer carries forward and gets echoed back to the Worker in runAnswerAttempt.

      embedQuery(retrievalQuery, {
        onBackend: () => {},
        onModelProgress: () => {},
        onModelReady: () => {},
        onQueryEmbedding: (msg) => {
          const chunkSource = useAll ? getAllChunks() : getChunksForDocument(selectedReadyId as string)
          chunkSource
            .then(async (chunks) => {
              // Hybrid search narrows the full pool to a wider candidate set first,
              // using the blended retrieval query for both cosine and BM25 matching;
              // the cross-encoder reranker then narrows that down to the final TOP_K
              // using the literal question (reranking scores relevance to what's
              // actually being asked, not the blended recall-oriented query).
              const candidates = hybridRankChunks(msg.embedding, retrievalQuery, chunks, RERANK_POOL_SIZE)
              let ranked = candidates.slice(0, TOP_K)
              if (candidates.length > TOP_K) {
                try {
                  const scores = await rerankChunksAsync(
                    question,
                    candidates.map(({ chunk }) => ({ id: chunk.id, text: chunk.text })),
                    setRerankModelProgress,
                  )
                  ranked = applyRerank(
                    scores,
                    candidates.map(({ chunk }) => chunk),
                    TOP_K,
                  )
                } catch {
                  // Reranking failed (e.g. model load/inference error) — fall back to
                  // hybrid search's own top-K rather than failing the whole query.
                  ranked = candidates.slice(0, TOP_K)
                } finally {
                  setRerankModelProgress(null)
                }
              }
              setResults(ranked)
              await runAnswerAttempt(question, ranked, false, activeKeyConfig)
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
    [canQuery, keyConfig, scope, selectedReadyId, query, busy, conversationTurns, runAnswerAttempt],
  )

  const handleRetry = useCallback(() => {
    if (!submittedQuestion || !results || keyConfig === null) return
    setBusy(true)
    runAnswerAttempt(submittedQuestion, results, true, keyConfig).finally(() => setBusy(false))
  }, [submittedQuestion, results, runAnswerAttempt, keyConfig])

  // Resets the conversation itself — turn history, the frozen Doc N map (so numbering
  // restarts at Doc 1 on the next question), and the current answer/results. Document
  // selection/scope are untouched: those are library state, not conversation state.
  const handleClearConversation = useCallback(() => {
    setConversationTurns([])
    setDocLabels([])
    setAnswer(null)
    setGroundingWarning(false)
    setAnswerError(null)
    setResults(null)
    setSubmittedQuestion(null)
    setTimedOut(false)
  }, [])

  // Exports every turn currently in conversationTurns (past + current, in order) plus
  // the current turn's retrieved chunks as Sources — past turns' chunks aren't retained
  // in state, so only the current turn can carry a Sources section (see pdfExport.ts).
  const handleExportPdf = useCallback(() => {
    const sources: ExportSource[] = (results ?? []).map(({ chunk, score }) => ({
      documentId: chunk.documentId,
      page: chunk.page,
      score,
      text: chunk.text,
    }))
    buildConversationPdf(conversationTurns, sources, titleFor).save('pocketrag-conversation.pdf')
  }, [conversationTurns, results, titleFor])

  const placeholder = canQuery
    ? scope === 'all'
      ? 'Ask a question across all documents…'
      : 'Ask a question about the selected document…'
    : !docsReady
      ? !hasReadyDoc
        ? 'Upload a document first'
        : 'Select a document first'
      : 'Finish setting up your API key first'

  return (
    <div className="text-left">
      {hasReadyDoc && (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex overflow-hidden rounded border border-slate-200 text-xs dark:border-slate-700">
            {(['document', 'all'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setScope(option)}
                className={`min-h-11 cursor-pointer px-3 py-1.5 transition-colors duration-150 ${
                  scope === option
                    ? 'bg-blue-600 text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
                }`}
              >
                {option === 'document' ? 'This document' : 'All documents'}
              </button>
            ))}
          </div>
          {conversationTurns.length > 0 && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handleExportPdf}>
                Export as PDF
              </Button>
              <Button variant="secondary" onClick={handleClearConversation}>
                Clear conversation
              </Button>
            </div>
          )}
        </div>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!canQuery || busy}
          placeholder={placeholder}
          className="min-h-11 flex-1 rounded border border-slate-300 px-3 py-2 text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:disabled:bg-slate-950 dark:disabled:text-slate-600"
        />
        <Button type="submit" loading={busy} disabled={!canQuery || busy || !query.trim()}>
          {busy ? 'Searching…' : 'Search'}
        </Button>
      </form>

      {error && (
        <StatusBanner variant="error" className="mt-2">
          {error}
        </StatusBanner>
      )}

      {rerankModelProgress != null && (
        <p className="mt-4 text-sm text-slate-500 motion-safe:animate-pulse dark:text-slate-400">
          Downloading reranking model — {rerankModelProgress}%… (one-time, cached after this)
        </p>
      )}

      {awaitingAnswer && !timedOut && (
        <p className="mt-4 text-sm text-slate-500 motion-safe:animate-pulse dark:text-slate-400">
          Generating an answer… this usually takes a few seconds, but can occasionally take up to a few
          minutes on the free tier. Please don't close this tab.
        </p>
      )}

      {timedOut && (
        <StatusBanner variant="warning" className="mt-4 items-center">
          <span className="flex flex-wrap items-center gap-2">
            This is taking longer than expected.
            <Button variant="secondary" onClick={handleRetry}>
              Try again
            </Button>
          </span>
        </StatusBanner>
      )}

      {answer && (
        <div className="mt-4 space-y-2 rounded border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          <StatusBanner variant={groundingWarning ? 'warning' : 'success'}>
            {groundingWarning
              ? 'This answer may not be fully grounded in the source document — verify against the sources below.'
              : 'Grounded in your documents.'}
          </StatusBanner>
          <p className="text-sm text-slate-900 dark:text-slate-100">{answer}</p>
          {docLabels.length > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')}
            </p>
          )}
        </div>
      )}

      {pastTurns.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
            Conversation ({pastTurns.length})
          </summary>
          <ul className="mt-3 space-y-3">
            {pastTurns.map((turn, i) => (
              <li
                key={i}
                className="space-y-2 rounded border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
              >
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{turn.question}</p>
                <StatusBanner variant={turn.groundingWarning ? 'warning' : 'success'}>
                  {turn.groundingWarning
                    ? 'This answer may not be fully grounded in the source document — verify against the sources below.'
                    : 'Grounded in your documents.'}
                </StatusBanner>
                <p className="text-sm text-slate-900 dark:text-slate-100">{turn.answer}</p>
                {turn.docLabels.length > 0 && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {turn.docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {answerError && (
        <StatusBanner variant={answerError.severity} className="mt-4">
          {answerError.message}
        </StatusBanner>
      )}

      {results && results.length > 0 && (
        <details className="mt-4" open={!answer}>
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
            Sources ({results.length})
          </summary>
          <ul className="mt-3 space-y-3">
            {results.map(({ chunk, score }) => (
              <li
                key={chunk.id}
                className="rounded border border-slate-200 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300"
              >
                <p className="mb-1 text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-700 dark:text-slate-300">{titleFor(chunk.documentId)}</span> ·
                  page {chunk.page} · score {score.toFixed(3)}
                  {isDiagramLikely(chunk) && (
                    <span title="This page may contain a diagram, chart, or figure"> · 📊 may contain a diagram</span>
                  )}
                </p>
                {chunk.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      {results && results.length === 0 && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">No chunks found.</p>
      )}
    </div>
  )
}
