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
  type ImageAttachment,
  type KeyConfig,
  type WebSource,
} from '../lib/answerRequest'
import { buildRetrievalQuery } from '../lib/conversation'
import { isDiagramLikely } from '../lib/diagramHeuristic'
import { getDiagramImagesEnabled, setDiagramImagesEnabled } from '../lib/diagramImageSetting'
import { getWebSearchEnabled, setWebSearchEnabled } from '../lib/webSearchSetting'
import { renderPageToImage } from '../lib/pageRender'
import { buildConversationPdf, type ExportSource } from '../lib/pdfExport'
import { canRunQuery } from '../lib/queryScope'
import { classify, type TaxonomyResult } from '../lib/errorTaxonomy'
import { getSessionFile } from '../lib/sessionFiles'
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
  // Milestone 10 Phase B: whether a page image was included in this specific turn's
  // request — tracked per turn, not just for the current answer, so the always-visible
  // indicator stays accurate when scrolling back through "Conversation."
  imageIncluded: boolean
  // Milestone 12 (Gemini-native grounding): real, structured sources from Gemini's own
  // groundingChunks for this specific turn — undefined/empty when grounding wasn't
  // enabled, or was enabled but Gemini chose not to search. Tracked per turn, same
  // reasoning as imageIncluded above.
  webSources?: WebSource[]
  searchEntryPointHtml?: string
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
  // Milestone 10 Phase B state. diagramImagesEnabled reads localStorage once at mount;
  // the toggle handler keeps it and localStorage in sync on every change.
  const [diagramImagesEnabled, setDiagramImagesEnabledState] = useState(() => getDiagramImagesEnabled())
  const [imageIncluded, setImageIncluded] = useState(false)
  // The image actually resolved for the *current* submitted question (or undefined) —
  // stored so a retry resends the same image rather than re-rendering the page again.
  const [pendingImage, setPendingImage] = useState<ImageAttachment | undefined>(undefined)
  // Milestone 12 (Gemini-native grounding) state. Same localStorage-once-at-mount
  // pattern as diagramImagesEnabled above, default OFF.
  const [webSearchEnabled, setWebSearchEnabledState] = useState(() => getWebSearchEnabled())
  const [webSources, setWebSources] = useState<WebSource[] | undefined>(undefined)
  const [searchEntryPointHtml, setSearchEntryPointHtml] = useState<string | undefined>(undefined)
  // The toggle state actually used for the *current* submitted question — stored so a
  // retry resends the same choice, even if the checkbox changed in between (same
  // "pending" pattern pendingImage above already established).
  const [pendingWebSearchEnabled, setPendingWebSearchEnabled] = useState(false)
  // Non-blocking, always-visible note for the one failure mode that must never be
  // silent: a diagram-likely chunk matched, but the file isn't in memory to render it
  // (most commonly a document restored from a prior session — see sessionFiles.ts).
  const [diagramFallbackNote, setDiagramFallbackNote] = useState<string | null>(null)

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
  // Milestone 9: combined retrieval pool means a single answer can draw on both
  // Documents-tab (local-only) and Notes-tab (OCR'd) chunks — this badge keeps which
  // trust model applied to which source always visible, not just knowable from the tab.
  const sourceFor = (id: string) => documents.find((d) => d.id === id)?.source ?? 'document'

  // Milestone 10 Phase B: default OFF, persisted to localStorage on every change so
  // the choice survives a reload. Only ever rendered in JSX when keyConfig is
  // shared-Gemini — not just disabled for BYOK, entirely absent from the DOM.
  const handleToggleDiagramImages = useCallback((enabled: boolean) => {
    setDiagramImagesEnabledState(enabled)
    setDiagramImagesEnabled(enabled)
  }, [])

  // Milestone 12 final scope: grounding is BYOK-gemini-only (see the Worker's
  // validate.ts) — never the shared tier, never any other BYOK provider. Narrowed
  // from an earlier shared-tier-eligible design: free-tier Google Search grounding
  // appears to require a billing-linked Google Cloud project to unlock any real
  // quota (three separate free keys/accounts all returned 429 RESOURCE_EXHAUSTED on
  // every grounded call attempted, while non-grounded calls on the same keys
  // succeeded instantly — consistent with multiple reports on Google's own developer
  // forums), so shipping this on the shared tier would mean shipping a feature that
  // doesn't work for anyone using it. A BYOK user supplying their own billing-enabled
  // Gemini key isn't affected by that constraint. The toggle is only ever rendered in
  // JSX when this is true — entirely absent from the DOM otherwise, same as the
  // diagram-image checkbox's shared-tier gate.
  const isGeminiEffective = keyConfig !== null && keyConfig.keySource === 'own' && keyConfig.provider === 'gemini'

  const handleToggleWebSearch = useCallback((enabled: boolean) => {
    setWebSearchEnabledState(enabled)
    setWebSearchEnabled(enabled)
  }, [])

  // The currently displayed answer is the last entry in conversationTurns (pushed on
  // every successful runAnswerAttempt below); "Conversation" only ever shows what came
  // before it, so the current answer isn't rendered twice.
  const pastTurns = conversationTurns.slice(0, -1)

  const runAnswerAttempt = useCallback(
    async (
      question: string,
      chunks: ScoredChunk<ChunkRecord>[],
      isRetry: boolean,
      activeKeyConfig: KeyConfig,
      image?: ImageAttachment,
      enableWebSearch?: boolean,
    ) => {
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
        image,
        enableWebSearch,
      )

      if (result.outcome === 'success') {
        setAnswer(result.answer)
        setGroundingWarning(result.groundingWarning)
        setDocLabels(result.docLabels)
        setImageIncluded(image !== undefined)
        setWebSources(result.webSources)
        setSearchEntryPointHtml(result.searchEntryPointHtml)
        setConversationTurns((prev) =>
          [
            ...prev,
            {
              question,
              answer: result.answer,
              groundingWarning: result.groundingWarning,
              docLabels: result.docLabels,
              imageIncluded: image !== undefined,
              webSources: result.webSources,
              searchEntryPointHtml: result.searchEntryPointHtml,
            },
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
      // Milestone 12: captured once at submit time, same "pending" pattern as
      // pendingImage — a retry resends this exact choice, even if the checkbox
      // changes in between.
      const activeWebSearchEnabled = isGeminiEffective && webSearchEnabled
      setPendingWebSearchEnabled(activeWebSearchEnabled)
      setBusy(true)
      setError(null)
      setResults(null)
      setSubmittedQuestion(question)
      setAnswer(null)
      setAnswerError(null)
      setTimedOut(false)
      setGroundingWarning(false)
      setDiagramFallbackNote(null)
      setWebSources(undefined)
      setSearchEntryPointHtml(undefined)
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

              // Milestone 10 Phase B: at most one image, for the single top-ranked
              // chunk, only when the opt-in toggle is on and the active key config is
              // literally shared-Gemini (re-checked here, not just gated by the
              // toggle's own conditional rendering — the Worker independently enforces
              // this too, but this avoids even attempting a pointless render/request).
              let image: ImageAttachment | undefined
              if (diagramImagesEnabled && activeKeyConfig.keySource === 'shared' && ranked.length > 0) {
                const topChunk = ranked[0].chunk
                if (isDiagramLikely(topChunk)) {
                  const file = getSessionFile(topChunk.documentId)
                  if (file) {
                    try {
                      image = await renderPageToImage(file, topChunk.page)
                    } catch {
                      // Rendering failed (e.g. a corrupt/oversized page) — proceed
                      // text-only rather than failing the whole query, but say so.
                      setDiagramFallbackNote(
                        "Couldn't render this page as an image — continuing with text only.",
                      )
                    }
                  } else {
                    // Most commonly: this document was restored from a prior session
                    // (Milestone 6's restore-on-reload keeps text/embeddings, never
                    // the file itself — see sessionFiles.ts). Must never be silent.
                    setDiagramFallbackNote(
                      "This document's page image isn't available after a reload — re-upload it to enable image answers for it.",
                    )
                  }
                }
              }
              setPendingImage(image)

              await runAnswerAttempt(question, ranked, false, activeKeyConfig, image, activeWebSearchEnabled)
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
    [
      canQuery,
      keyConfig,
      scope,
      selectedReadyId,
      query,
      busy,
      conversationTurns,
      runAnswerAttempt,
      diagramImagesEnabled,
      isGeminiEffective,
      webSearchEnabled,
    ],
  )

  const handleRetry = useCallback(() => {
    if (!submittedQuestion || !results || keyConfig === null) return
    setBusy(true)
    runAnswerAttempt(submittedQuestion, results, true, keyConfig, pendingImage, pendingWebSearchEnabled).finally(() =>
      setBusy(false),
    )
  }, [submittedQuestion, results, runAnswerAttempt, keyConfig, pendingImage, pendingWebSearchEnabled])

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
    setImageIncluded(false)
    setPendingImage(undefined)
    setDiagramFallbackNote(null)
    setWebSources(undefined)
    setSearchEntryPointHtml(undefined)
    setPendingWebSearchEnabled(false)
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
      {hasReadyDoc && keyConfig?.keySource === 'shared' && (
        <label className="mb-2 flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={diagramImagesEnabled}
            onChange={(e) => handleToggleDiagramImages(e.target.checked)}
            className="h-4 w-4 cursor-pointer"
          />
          Send a page image when a matched chunk looks like it has a diagram
        </label>
      )}
      {hasReadyDoc && isGeminiEffective && (
        <label className="mb-2 flex items-start gap-2 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={webSearchEnabled}
            onChange={(e) => handleToggleWebSearch(e.target.checked)}
            className="mt-0.5 h-4 w-4 cursor-pointer"
          />
          <span>
            Allow Gemini to search the web (Experimental)
            <span className="block text-slate-400 dark:text-slate-500">
              Lets Gemini check the live web when useful. Not yet verified against a live billing-enabled
              account — if something goes wrong, you'll see a generic error message.
            </span>
          </span>
        </label>
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

      {diagramFallbackNote && (
        <StatusBanner variant="warning" className="mt-2">
          {diagramFallbackNote}
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
          minutes on the free tier.
          {pendingImage !== undefined && ' A page image was included, which can take a bit longer.'} Please
          don't close this tab.
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
          {imageIncluded && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              🖼️ A page image was included in this request.
            </p>
          )}
          <p className="text-sm text-slate-900 dark:text-slate-100">{answer}</p>
          {docLabels.length > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')}
            </p>
          )}
          {webSources && webSources.length > 0 && (
            <div className="text-xs text-slate-500 dark:text-slate-400">
              <p>🌐 Includes results from a live web search:</p>
              <ul className="ml-4 list-disc">
                {webSources.map((source, i) => (
                  <li key={i}>
                    <a
                      href={source.uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 underline dark:text-blue-400"
                    >
                      {source.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {searchEntryPointHtml && (
            // Google's Grounding ToS (ai.google.dev/gemini-api/terms#grounding-with-
            // google-search) requires displaying this "Search Suggestions" widget,
            // unmodified, alongside any grounded result shown to an end user — trusted
            // content from our own configured Gemini API response, not user-supplied.
            <div dangerouslySetInnerHTML={{ __html: searchEntryPointHtml }} />
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
                {turn.imageIncluded && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    🖼️ A page image was included in this request.
                  </p>
                )}
                <p className="text-sm text-slate-900 dark:text-slate-100">{turn.answer}</p>
                {turn.docLabels.length > 0 && (
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {turn.docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')}
                  </p>
                )}
                {turn.webSources && turn.webSources.length > 0 && (
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    <p>🌐 Includes results from a live web search:</p>
                    <ul className="ml-4 list-disc">
                      {turn.webSources.map((source, i) => (
                        <li key={i}>
                          <a
                            href={source.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 underline dark:text-blue-400"
                          >
                            {source.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {turn.searchEntryPointHtml && <div dangerouslySetInnerHTML={{ __html: turn.searchEntryPointHtml }} />}
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
                  <span
                    title={sourceFor(chunk.documentId) === 'note' ? 'From the Notes tab — OCR extracted' : 'From the Documents tab — local only'}
                  >
                    {sourceFor(chunk.documentId) === 'note' ? '📝' : '📄'}
                  </span>{' '}
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
