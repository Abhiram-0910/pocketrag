import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { embedQuery, rerankChunks } from '../lib/embeddingClient'
import { getAllChunks, getChunksByIds, getChunksForDocument, type ChunkRecord } from '../lib/db'
import { hybridRankChunks, type ScoredChunk } from '../lib/retrieval'
import { applyRerank, type RerankScore } from '../lib/reranker'
import type { RerankCandidate } from '../workers/embedding.types'
import { attemptAnswer, fetchAnswerFromWorker, type ImageAttachment, type KeyConfig } from '../lib/answerRequest'
import { buildRetrievalQuery, pathTo, previousQuestionFor } from '../lib/conversation'
import { isDiagramLikely } from '../lib/diagramHeuristic'
import { getDiagramImagesEnabled, setDiagramImagesEnabled } from '../lib/diagramImageSetting'
import { getWebSearchEnabled, setWebSearchEnabled } from '../lib/webSearchSetting'
import { renderPageToImage } from '../lib/pageRender'
import { sanitizeGroundingHtml } from '../lib/sanitizeHtml'
import { buildConversationPdf, type ExportSource } from '../lib/pdfExport'
import { canRunQuery } from '../lib/queryScope'
import { classify, type TaxonomyResult } from '../lib/errorTaxonomy'
import { failureAction, type FailureAction } from '../lib/apiError'
import { getSessionFile } from '../lib/sessionFiles'
import type { TurnRecord } from '../lib/historyDb'
import { useDocumentStore } from '../store/documentStore'
import { answerFor, useChatStore, type HistoryStorageState, type TurnKey, type TurnRequestContext } from '../store/chatStore'
import { SessionReceipts, TurnReceipt } from './Receipts'
import { StatusBanner } from './ui/StatusBanner'
import { Button } from './ui/Button'

const TOP_K = 3
// Wider candidate pool handed to the cross-encoder reranker — hybrid search narrows
// the full chunk pool down to this many first, then reranking narrows it to TOP_K.
const RERANK_POOL_SIZE = 15
const ANSWER_TIMEOUT_MS = 60_000

// ConversationList's "New conversation" focuses the question input through this id.
export const QUESTION_INPUT_ID = 'question-input'

interface QueryPanelProps {
  keyConfig: KeyConfig | null
  // Answer-failure actions that act on the BYOK panel (check key, choose model, use own
  // key); 'retry' is handled here.
  onFailureAction?: (action: FailureAction) => void
}

const FAILURE_ACTION_LABELS: Record<FailureAction, string> = {
  'check-key': 'Check your key',
  'use-own-key': 'Use your own key',
  'choose-model': 'Choose another model',
  retry: 'Try again',
}

const STORAGE_COPY: Record<Exclude<HistoryStorageState, 'ok'>, { variant: 'warning' | 'info'; text: string }> = {
  unavailable: {
    variant: 'warning',
    text: "Chat history can't be saved in this browser right now. This conversation still works, but won't be here after a reload.",
  },
  quota: {
    variant: 'warning',
    text: "This site's storage in your browser is full, so this conversation isn't being saved. Delete old conversations or documents to make room.",
  },
  blocked: {
    variant: 'info',
    text: "PocketRAG is open in another tab running an older version. Close that tab to finish updating; history isn't saved until then.",
  },
  outdated: {
    variant: 'info',
    text: 'A newer version of PocketRAG opened in another tab. Reload this tab to keep saving history.',
  },
}

const GROUNDED_TEXT = 'Grounded in your documents.'
const UNGROUNDED_TEXT =
  'This answer may not be fully grounded in the source document — verify against the sources below.'
// A grounded answer is never stored (Gemini terms — SECURITY_REVIEW.md §1.1); after a
// reload only this placeholder is left.
export const NOT_RETAINED_TEXT = 'Web-grounded answer, not retained (Google terms)'

// The answer request goes out with whichever key is active now.
function turnKeyFor(keyConfig: KeyConfig): TurnKey {
  return keyConfig.keySource === 'own'
    ? { tier: 'own', provider: keyConfig.provider, model: keyConfig.model }
    : { tier: 'shared', provider: 'gemini', model: null }
}

/** Banner text for a stored failure. A turn restored from an earlier session shows the
 * Worker's stored message as-is — no "Resets at" time, which would be stale by now. */
function storedFailureBanner(turn: TurnRecord, restored: boolean): TaxonomyResult & { action: FailureAction | null } {
  const f = turn.failure
  if (!f) return { type: 'unknown', severity: 'warning', message: 'This answer failed.', action: null }
  const classified = classify({ message: f.message, status: f.httpStatus, resetAt: restored ? undefined : f.resetAt })
  return { ...classified, action: failureAction(f.code, f.source) }
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

// Session-only UI state below is keyed by turn id, so it only shows while that turn is
// the open conversation's leaf — switching conversations hides it without a reset.
interface TurnSources {
  turnId: string
  chunks: ScoredChunk<ChunkRecord>[]
  // False when a restored turn cites a chunk that's since been deleted — retry is then
  // replaced by "Ask again", since the same request can't be rebuilt.
  complete: boolean
}

export function QueryPanel({ keyConfig, onFailureAction }: QueryPanelProps) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [awaitingAnswer, setAwaitingAnswer] = useState(false)
  const queryInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [scope, setScope] = useState<'document' | 'all'>('document')
  const [rerankModelProgress, setRerankModelProgress] = useState<number | null>(null)
  // The turn submitted or retried in this session. Its failure renders inside the
  // always-mounted live region (announced); any other turn's stored failure renders
  // outside it, so opening an old conversation announces nothing.
  const [liveTurnId, setLiveTurnId] = useState<string | null>(null)
  const [answerError, setAnswerError] = useState<(TaxonomyResult & { turnId: string; action: FailureAction | null }) | null>(null)
  const [timedOutTurnId, setTimedOutTurnId] = useState<string | null>(null)
  const [sources, setSources] = useState<TurnSources | null>(null)
  // Milestone 10 Phase B state. diagramImagesEnabled reads localStorage once at mount;
  // the toggle handler keeps it and localStorage in sync on every change.
  const [diagramImagesEnabled, setDiagramImagesEnabledState] = useState(() => getDiagramImagesEnabled())
  // The image and web-search choice actually used for a turn — stored so a retry resends
  // the same ones, even if the toggles changed in between.
  const [pendingImage, setPendingImage] = useState<{ turnId: string; image: ImageAttachment } | null>(null)
  // Milestone 12 (Gemini-native grounding) state. Same localStorage-once-at-mount
  // pattern as diagramImagesEnabled above, default OFF.
  const [webSearchEnabled, setWebSearchEnabledState] = useState(() => getWebSearchEnabled())
  const [pendingWebSearch, setPendingWebSearch] = useState<{ turnId: string; enabled: boolean } | null>(null)
  // Non-blocking, always-visible note for the one failure mode that must never be
  // silent: a diagram-likely chunk matched, but the file isn't in memory to render it
  // (most commonly a document restored from a prior session — see sessionFiles.ts).
  const [diagramFallbackNote, setDiagramFallbackNote] = useState<string | null>(null)

  const documents = useDocumentStore((s) => s.documents)
  const selectedId = useDocumentStore((s) => s.selectedId)
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const turns = useChatStore((s) => s.turns)
  const groundedSession = useChatStore((s) => s.groundedSession)
  const storage = useChatStore((s) => s.storage)
  const startTurn = useChatStore((s) => s.startTurn)
  const retryTurn = useChatStore((s) => s.retryTurn)
  const settleTurn = useChatStore((s) => s.settleTurn)
  const appendEgress = useChatStore((s) => s.appendEgress)
  const newConversation = useChatStore((s) => s.newConversation)

  // Linear history: the open conversation's active root-to-leaf path. The leaf is the
  // current answer; everything before it is "Conversation".
  const activeLeafId = conversations.find((c) => c.id === activeConversationId)?.activeLeafId ?? null
  const path = useMemo(() => pathTo(turns, activeLeafId), [turns, activeLeafId])
  const leaf = path.at(-1) ?? null
  const pastTurns = path.slice(0, -1)
  const isLive = leaf !== null && leaf.id === liveTurnId
  const leafSources = sources !== null && sources.turnId === leaf?.id ? sources : null

  // "this document" queries the selected ready doc; "all documents" pools every stored
  // doc. hybridRankChunks is scope-agnostic (all embeddings are unit-normalized by the
  // same model, so cosine scores are directly comparable across documents — see
  // ARCHITECTURE.md — and BM25's IDF/avgdl are recomputed fresh over whichever pool is
  // passed in, so keyword scores are always relative to the current scope too).
  const selectedReadyId = documents.find((d) => d.id === selectedId && d.status === 'ready')?.id ?? null
  const hasReadyDoc = documents.some((d) => d.status === 'ready')
  const docsReady = canRunQuery(documents, selectedId, scope)
  const canQuery = docsReady && keyConfig !== null

  // A restored turn can cite a document deleted since — label it rather than show its id.
  const titleFor = useCallback((id: string) => documents.find((d) => d.id === id)?.fileName ?? 'deleted document', [documents])
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

  // A turn restored from IndexedDB has no ranked chunks in memory: rebuild its Sources
  // (and what a retry would resend) from its citations. Chunks deleted since are skipped.
  const leafId = leaf?.id ?? null
  const leafCitations = leaf?.citations
  const sourcesTurnId = sources?.turnId ?? null
  useEffect(() => {
    if (leafId === null || !leafCitations || leafId === sourcesTurnId) return
    let cancelled = false
    const citations = [...leafCitations].sort((a, b) => a.rank - b.rank)
    getChunksByIds(citations.map((c) => c.chunkId))
      .then((found) => {
        if (cancelled) return
        const byId = new Map(found.map((chunk) => [chunk.id, chunk]))
        const chunks = citations.flatMap((c) => {
          const chunk = byId.get(c.chunkId)
          return chunk ? [{ chunk, score: c.score }] : []
        })
        setSources({ turnId: leafId, chunks, complete: chunks.length === citations.length })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [leafId, leafCitations, sourcesTurnId])

  const runAnswerAttempt = useCallback(
    async (
      turnId: string,
      context: TurnRequestContext,
      question: string,
      chunks: ScoredChunk<ChunkRecord>[],
      isRetry: boolean,
      activeKeyConfig: KeyConfig,
      image?: ImageAttachment,
      enableWebSearch?: boolean,
    ) => {
      setAwaitingAnswer(true)
      setTimedOutTurnId(null)
      // Cleared on retry too: a retry can now come from a failure banner's "Try again",
      // and a stale failure must not sit beside the answer that retry produced.
      setAnswerError(null)

      const requestChunks = chunks.map(({ chunk, score }) => ({
        text: chunk.text,
        page: chunk.page,
        score,
        documentId: chunk.documentId,
      }))
      // Prompt history (Milestone 11 Phase C2) comes from the store: the last answered
      // turns on this turn's path, never a grounded one. Every attempt's egress — retries
      // included — is recorded on the turn.
      const result = await attemptAnswer(
        fetchAnswerFromWorker,
        question,
        requestChunks,
        activeKeyConfig,
        ANSWER_TIMEOUT_MS,
        context.docLabels,
        context.history,
        image,
        enableWebSearch,
        (record) => void appendEgress(turnId, record),
      )

      if (result.outcome === 'success') {
        await settleTurn(turnId, {
          status: 'answered',
          answer: result.answer,
          groundingWarning: result.groundingWarning,
          docLabels: result.docLabels,
          webGrounded: (result.webSources?.length ?? 0) > 0 || result.searchEntryPointHtml !== undefined,
          provider: result.provider,
          model: result.model,
          webSources: result.webSources,
          searchEntryPointHtml: result.searchEntryPointHtml,
        })
      } else if (result.outcome === 'timeout') {
        if (isRetry) {
          setAnswerError({
            turnId,
            type: 'unknown',
            severity: 'warning',
            message: 'Answer generation timed out again.',
            action: null,
          })
        } else {
          setTimedOutTurnId(turnId)
        }
        await settleTurn(turnId, { status: 'timed-out' })
      } else {
        const classified = classify({ message: result.message, status: result.status, resetAt: result.resetAt })
        setAnswerError({ turnId, ...classified, action: failureAction(result.code, result.source) })
        await settleTurn(turnId, {
          status: 'failed',
          failure: {
            kind: classified.type,
            message: result.message,
            httpStatus: result.status,
            code: result.code,
            source: result.source,
            resetAt: result.resetAt,
          },
        })
      }
      setAwaitingAnswer(false)
    },
    [appendEgress, settleTurn],
  )

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault()
      const useAll = scope === 'all'
      if (!canQuery || keyConfig === null || (!useAll && !selectedReadyId) || !query.trim() || busy) return
      const activeKeyConfig = keyConfig

      const question = query.trim()
      // Retrieval-query blending (Milestone 11 Phase C2): fold the nearest answered
      // ancestor's question — and only that one — into the query used for retrieval.
      // The literal, unblended `question` below is still what's sent to the Worker as
      // the actual question being answered; the blended string never crosses the wire.
      const retrievalQuery = buildRetrievalQuery(previousQuestionFor(path), question)
      // Milestone 12: captured once at submit time — a retry resends this exact choice,
      // even if the checkbox changes in between.
      const activeWebSearchEnabled = isGeminiEffective && webSearchEnabled
      setBusy(true)
      setError(null)
      setDiagramFallbackNote(null)

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

              // Saved as 'pending' before the request goes out (chatStore.startTurn).
              const context = await startTurn({
                question,
                citations: ranked.map(({ chunk, score }, rank) => ({
                  chunkId: chunk.id,
                  documentId: chunk.documentId,
                  page: chunk.page,
                  rank,
                  score,
                })),
                scope,
                ...turnKeyFor(activeKeyConfig),
                imageIncluded: image !== undefined,
                webSearchRequested: activeWebSearchEnabled,
              })
              const turnId = context.turnId
              setLiveTurnId(turnId)
              setSources({ turnId, chunks: ranked, complete: true })
              setPendingImage(image ? { turnId, image } : null)
              setPendingWebSearch({ turnId, enabled: activeWebSearchEnabled })

              await runAnswerAttempt(turnId, context, question, ranked, false, activeKeyConfig, image, activeWebSearchEnabled)
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
      path,
      startTurn,
      runAnswerAttempt,
      diagramImagesEnabled,
      isGeminiEffective,
      webSearchEnabled,
    ],
  )

  // Re-sends the leaf turn: its chunks from this session, or rebuilt from its citations
  // for a restored turn (no page image then — it was never stored).
  const handleRetry = useCallback(async () => {
    if (!leaf || !leafSources || keyConfig === null) return
    const turnId = leaf.id
    const wasLive = liveTurnId === turnId
    setLiveTurnId(turnId)
    setBusy(true)
    const context = await retryTurn(turnId, turnKeyFor(keyConfig))
    if (!context) {
      setBusy(false)
      return
    }
    const image = pendingImage?.turnId === turnId ? pendingImage.image : undefined
    const enableWebSearch =
      pendingWebSearch?.turnId === turnId ? pendingWebSearch.enabled : leaf.webSearchRequested && isGeminiEffective
    await runAnswerAttempt(turnId, context, leaf.question, leafSources.chunks, wasLive, keyConfig, image, enableWebSearch)
    // The banner holding "Try again" unmounts when the retry starts, dropping focus to
    // <body>; the input is disabled while busy, so re-enable it first, then focus it.
    flushSync(() => setBusy(false))
    queryInputRef.current?.focus()
  }, [leaf, leafSources, keyConfig, liveTurnId, retryTurn, pendingImage, pendingWebSearch, isGeminiEffective, runAnswerAttempt])

  // When the same request can't be rebuilt (interrupted, or its cited chunks are gone):
  // put the question back in the input for the user to ask again.
  const handleAskAgain = useCallback((question: string) => {
    setQuery(question)
    queryInputRef.current?.focus()
  }, [])

  // Starts a fresh conversation; the old one stays in history (ConversationList deletes).
  // Document selection/scope are untouched: those are library state, not conversation state.
  const handleNewConversation = useCallback(() => {
    newConversation()
    setError(null)
    setDiagramFallbackNote(null)
    queryInputRef.current?.focus()
  }, [newConversation])

  // Exports the active path's answered turns, in order, plus the leaf's Sources (the
  // only turn whose chunks are loaded — see pdfExport.ts).
  const handleExportPdf = useCallback(() => {
    const exportSources: ExportSource[] = (leafSources?.chunks ?? []).map(({ chunk, score }) => ({
      documentId: chunk.documentId,
      page: chunk.page,
      score,
      text: chunk.text,
    }))
    const exportTurns = path
      .filter((t) => t.status === 'answered')
      .map((t) => ({
        question: t.question,
        answer: answerFor({ groundedSession }, t) ?? NOT_RETAINED_TEXT,
        groundingWarning: t.groundingWarning,
        docLabels: t.docLabels,
      }))
    buildConversationPdf(exportTurns, exportSources, titleFor).save('pocketrag-conversation.pdf')
  }, [leafSources, path, groundedSession, titleFor])

  const liveError = answerError !== null && answerError.turnId === leaf?.id ? answerError : null
  const answerAction = liveError?.action ?? null
  const leafTimedOut = leaf !== null && timedOutTurnId === leaf.id
  const grounded = leaf ? groundedSession.get(leaf.id) : undefined
  // The question just submitted is still in the input; a restored one isn't anywhere else.
  const showLeafQuestion = leaf !== null && !isLive

  const placeholder = canQuery
    ? scope === 'all'
      ? 'Ask a question across all documents…'
      : 'Ask a question about the selected document…'
    : !docsReady
      ? !hasReadyDoc
        ? 'Upload a document first'
        : 'Select a document first'
      : 'Finish setting up your API key first'

  const answerText = (turn: TurnRecord) => {
    const text = answerFor({ groundedSession }, turn)
    return text !== null ? (
      <p className="text-sm text-slate-900 dark:text-slate-100">{text}</p>
    ) : (
      <p className="text-sm italic text-slate-600 dark:text-slate-400">{NOT_RETAINED_TEXT}</p>
    )
  }

  // A stored failure / timeout / interruption of a turn that isn't this session's live
  // one: same copy and actions, rendered outside the live region (inLiveRegion drops the
  // banner's own role) so opening an old conversation doesn't announce it.
  const restoredOutcome = (turn: TurnRecord, actionable: boolean) => {
    const canRebuild = actionable && leafSources !== null && leafSources.complete && leafSources.chunks.length > 0
    const askAgain = (
      <Button variant="secondary" className="mt-2" onClick={() => handleAskAgain(turn.question)}>
        Ask again
      </Button>
    )
    if (turn.status === 'failed') {
      const banner = storedFailureBanner(turn, true)
      const action = banner.action
      return (
        <StatusBanner variant={banner.severity} inLiveRegion>
          <span className="block">{banner.message}</span>
          {canRebuild && <span className="block">Showing raw matched passages below.</span>}
          {actionable &&
            action &&
            (action !== 'retry' ? (
              <Button variant="secondary" className="mt-2" onClick={() => onFailureAction?.(action)}>
                {FAILURE_ACTION_LABELS[action]}
              </Button>
            ) : canRebuild ? (
              <Button variant="secondary" className="mt-2" onClick={() => void handleRetry()}>
                {FAILURE_ACTION_LABELS.retry}
              </Button>
            ) : (
              askAgain
            ))}
        </StatusBanner>
      )
    }
    if (turn.status === 'timed-out') {
      return (
        <StatusBanner variant="warning" inLiveRegion>
          <span className="block">This answer timed out.</span>
          {actionable &&
            (canRebuild ? (
              <Button variant="secondary" className="mt-2" onClick={() => void handleRetry()}>
                {FAILURE_ACTION_LABELS.retry}
              </Button>
            ) : (
              askAgain
            ))}
        </StatusBanner>
      )
    }
    if (turn.status === 'interrupted' || turn.status === 'pending') {
      return (
        <StatusBanner variant="info" inLiveRegion>
          <span className="block">
            {turn.status === 'interrupted'
              ? 'This answer was interrupted — the tab closed before it arrived.'
              : 'No answer was received for this question yet.'}
          </span>
          {actionable && askAgain}
        </StatusBanner>
      )
    }
    return null
  }

  return (
    <div className="text-left">
      <div aria-live="polite" aria-atomic="true">
        {storage !== 'ok' && (
          <StatusBanner variant={STORAGE_COPY[storage].variant} className="mb-2" inLiveRegion>
            <span className="block">{STORAGE_COPY[storage].text}</span>
            {storage === 'outdated' && (
              <Button variant="secondary" className="mt-2" onClick={() => window.location.reload()}>
                Reload
              </Button>
            )}
          </StatusBanner>
        )}
      </div>
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
          {path.length > 0 && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={handleExportPdf}>
                Export as PDF
              </Button>
              <Button variant="secondary" onClick={handleNewConversation}>
                New conversation
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
              Lets Gemini check the live web when useful. Not yet verified end to end with a billing-enabled
              API key, so it may not work.
            </span>
          </span>
        </label>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row">
        <input
          ref={queryInputRef}
          id={QUESTION_INPUT_ID}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={!canQuery || busy}
          placeholder={placeholder}
          aria-label="Question"
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

      {awaitingAnswer && !leafTimedOut && isLive && (
        <p className="mt-4 text-sm text-slate-500 motion-safe:animate-pulse dark:text-slate-400">
          Generating an answer… this usually takes a few seconds, but can occasionally take up to a few
          minutes on the free tier.
          {pendingImage?.turnId === leaf?.id && ' A page image was included, which can take a bit longer.'} Please
          don't close this tab.
        </p>
      )}

      {leafTimedOut && isLive && leaf?.status === 'timed-out' && (
        <StatusBanner variant="warning" className="mt-4 items-center">
          <span className="flex flex-wrap items-center gap-2">
            This is taking longer than expected.
            <Button variant="secondary" onClick={() => void handleRetry()}>
              Try again
            </Button>
          </span>
        </StatusBanner>
      )}

      {leaf?.status === 'answered' && (
        <div className="mt-4 space-y-2 rounded border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
          {showLeafQuestion && <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{leaf.question}</p>}
          <StatusBanner variant={leaf.groundingWarning ? 'warning' : 'success'}>
            {leaf.groundingWarning ? UNGROUNDED_TEXT : GROUNDED_TEXT}
          </StatusBanner>
          {leaf.imageIncluded && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              🖼️ A page image was included in this request.
            </p>
          )}
          {answerText(leaf)}
          {leaf.docLabels.length > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {leaf.docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')}
            </p>
          )}
          {grounded?.webSources && grounded.webSources.length > 0 && (
            <div className="text-xs text-slate-500 dark:text-slate-400">
              <p>🌐 Includes results from a live web search:</p>
              <ul className="ml-4 list-disc">
                {grounded.webSources.map((source, i) => (
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
          {grounded?.searchEntryPointHtml && (
            // Google's Grounding ToS (ai.google.dev/gemini-api/terms#grounding-with-
            // google-search) requires displaying this "Search Suggestions" widget
            // alongside any grounded result shown to an end user. Google's docs never
            // state this HTML is safe to inject unsanitized (checked directly — see
            // SECURITY_REVIEW.md), so it's sanitized before render like any other
            // externally-sourced content reaching this origin's DOM. Kept in memory for
            // this session only (chatStore.groundedSession), never stored.
            <div dangerouslySetInnerHTML={{ __html: sanitizeGroundingHtml(grounded.searchEntryPointHtml) }} />
          )}
          <TurnReceipt turn={leaf} />
        </div>
      )}

      {leaf !== null && leaf.status !== 'answered' && !isLive && (
        <div className="mt-4 space-y-2">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{leaf.question}</p>
          {restoredOutcome(leaf, true)}
          <TurnReceipt turn={leaf} />
        </div>
      )}

      {pastTurns.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
            Conversation ({pastTurns.length})
          </summary>
          <ul className="mt-3 space-y-3">
            {pastTurns.map((turn) => (
              <li
                key={turn.id}
                className="space-y-2 rounded border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
              >
                <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{turn.question}</p>
                {turn.status === 'answered' ? (
                  <>
                    <StatusBanner variant={turn.groundingWarning ? 'warning' : 'success'}>
                      {turn.groundingWarning ? UNGROUNDED_TEXT : GROUNDED_TEXT}
                    </StatusBanner>
                    {turn.imageIncluded && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        🖼️ A page image was included in this request.
                      </p>
                    )}
                    {answerText(turn)}
                    {turn.docLabels.length > 0 && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {turn.docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')}
                      </p>
                    )}
                    {groundedSession.get(turn.id)?.webSources?.length ? (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        <p>🌐 Includes results from a live web search:</p>
                        <ul className="ml-4 list-disc">
                          {groundedSession.get(turn.id)?.webSources?.map((source, i) => (
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
                    ) : null}
                    {groundedSession.get(turn.id)?.searchEntryPointHtml && (
                      <div
                        dangerouslySetInnerHTML={{
                          __html: sanitizeGroundingHtml(groundedSession.get(turn.id)?.searchEntryPointHtml as string),
                        }}
                      />
                    )}
                  </>
                ) : (
                  restoredOutcome(turn, false)
                )}
                <TurnReceipt turn={turn} />
              </li>
            ))}
          </ul>
        </details>
      )}

      <div aria-live="polite" aria-atomic="true">
        {liveError && (
          <StatusBanner variant={liveError.severity} className="mt-4" inLiveRegion>
            <span className="block">{liveError.message}</span>
            <span className="block">Showing raw matched passages below.</span>
            {answerAction && (
              <Button
                variant="secondary"
                className="mt-2"
                onClick={() => (answerAction === 'retry' ? void handleRetry() : onFailureAction?.(answerAction))}
              >
                {FAILURE_ACTION_LABELS[answerAction]}
              </Button>
            )}
          </StatusBanner>
        )}
      </div>

      {/* This session's own failed, timed-out or in-flight answer: its receipt sits under
          the live region (the banner above it is what gets announced). */}
      {leaf !== null && leaf.status !== 'answered' && isLive && leaf.egress.length > 0 && <TurnReceipt turn={leaf} />}

      {leafSources && leafSources.chunks.length > 0 && (
        <details className="mt-4" open={leaf?.status !== 'answered'}>
          <summary className="cursor-pointer text-sm font-medium text-slate-700 dark:text-slate-300">
            Sources ({leafSources.chunks.length})
          </summary>
          <ul className="mt-3 space-y-3">
            {leafSources.chunks.map(({ chunk, score }) => (
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
      {leafSources && leafSources.chunks.length === 0 && leaf?.citations.length === 0 && (
        <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">No chunks found.</p>
      )}
      {leafSources && !leafSources.complete && (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          Some sources for this answer came from a document that has since been deleted.
        </p>
      )}

      <SessionReceipts />
    </div>
  )
}
