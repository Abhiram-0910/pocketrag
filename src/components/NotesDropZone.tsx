import { useCallback, useEffect, useState, type ChangeEvent, type DragEvent } from 'react'
import { UploadSimple } from '@phosphor-icons/react'
import { embedDocument } from '../lib/embeddingClient'
import { saveDocument, type ChunkRecord } from '../lib/db'
import { attemptOcr, fetchOcrFromWorker } from '../lib/ocrRequest'
import { retryCopy, retryTimingFor } from '../lib/retryTiming'
import { useDocumentStore } from '../store/documentStore'
import { StatusBanner } from './ui/StatusBanner'
import { Button } from './ui/Button'

// Mirrors worker/src/validate.ts's OCR_ALLOWED_MIME_TYPES. Phase A: images. Phase B
// added application/pdf for multi-page scans.
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
// Longer than QueryPanel's ANSWER_TIMEOUT_MS (60s) — OCR has real work to do (tiling/
// reading a full image or document), not just composing from a few short chunks.
// Live-verified against a real 23-page scanned PDF (daa-unit2.pdf, Phase B): ~20s for
// the /ocr call itself, well under this cap — left unchanged, not derived from that one
// data point, since a longer real scan is plausible and there's no cost to the margin.
const OCR_TIMEOUT_MS = 120_000

/**
 * Reads a File as base64 (no `data:...;base64,` prefix) via FileReader. No canvas step,
 * unlike pageRender.ts's page render — OCR needs the original file bytes untouched, not
 * a re-encoded rendering, so pixels are never decoded/touched client-side.
 */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'))
    reader.readAsDataURL(file)
  })
}

export function NotesDropZone() {
  const [isDragging, setIsDragging] = useState(false)
  const [rejectMsg, setRejectMsg] = useState<string | null>(null)
  // Strict per-file consent: only one file is ever "pending" a decision at a time.
  // Additional files selected in the same batch wait in `queue` — see the effect below,
  // which pops the next one only after the current file's consent is decided (accept
  // or cancel), never all at once.
  const [pendingConsent, setPendingConsent] = useState<File | null>(null)
  const [queue, setQueue] = useState<File[]>([])

  const documents = useDocumentStore((s) => s.documents)
  const addDocument = useDocumentStore((s) => s.addDocument)
  const updateDocument = useDocumentStore((s) => s.updateDocument)
  const selectDocument = useDocumentStore((s) => s.selectDocument)
  const setModelProgress = useDocumentStore((s) => s.setModelProgress)
  const setBackend = useDocumentStore((s) => s.setBackend)

  const busy = documents.some(
    (d) =>
      d.source === 'note' &&
      (d.status === 'ocr-uploading' || d.status === 'ocr-processing' || d.status === 'loading-model' || d.status === 'embedding'),
  )

  useEffect(() => {
    if (pendingConsent === null && queue.length > 0) {
      setPendingConsent(queue[0])
      setQueue((q) => q.slice(1))
    }
  }, [pendingConsent, queue])

  // Runs one file end-to-end, starting from the base64 read (consent has already been
  // given by the time this is called). Resolves (never rejects) once the document
  // reaches `ready` or `error`.
  const processFile = useCallback(
    (file: File, id: string): Promise<void> =>
      new Promise<void>((resolve) => {
        updateDocument(id, { status: 'ocr-uploading' })
        fileToBase64(file)
          .then((base64) => {
            updateDocument(id, { status: 'ocr-processing' })
            return attemptOcr(fetchOcrFromWorker, file.type, base64, OCR_TIMEOUT_MS)
          })
          .then((result) => {
            if (result.outcome === 'timeout') {
              updateDocument(id, { status: 'error', error: 'OCR timed out — please try again.' })
              resolve()
              return
            }
            if (result.outcome === 'error') {
              // A known wait becomes absolute times in the status (no ticking here); OCR has
              // no own-key path, so the copy never offers one.
              const timing = retryTimingFor(result, Date.now())
              const copy = timing ? retryCopy(timing, result.message, { ownKeyOption: false }) : null
              updateDocument(id, { status: 'error', error: copy ? [copy.message, ...copy.lines].join(' ') : result.message })
              resolve()
              return
            }

            updateDocument(id, { status: 'loading-model' })
            // A single "page" — the whole file's transcribed text — plugs directly into
            // the same chunker/embedder pipeline DropZone.tsx uses for typed PDFs.
            // hasImage is false: Milestone 10's diagram-likely hint is about charts/
            // diagrams in typed PDFs, not handwriting, so reusing it here would be a
            // category error.
            embedDocument([{ page: 1, text: result.text, hasImage: false }], {
              onModelProgress: (msg) => setModelProgress(msg.percent),
              onBackend: (msg) => setBackend(msg.backend, msg.detail),
              onModelReady: () => {},
              onChunked: () => {},
              onEmbedProgress: (msg) =>
                updateDocument(id, { status: 'embedding', embedProgress: { done: msg.done, total: msg.total } }),
              onResult: (msg) => {
                const chunkRecords: ChunkRecord[] = msg.chunks.map((chunk) => ({
                  id: `${id}:${chunk.index}`,
                  documentId: id,
                  index: chunk.index,
                  text: chunk.text,
                  tokenCount: chunk.tokenCount,
                  page: chunk.page,
                  embedding: chunk.embedding,
                  hasImage: chunk.hasImage,
                }))
                saveDocument(
                  { id, fileName: file.name, uploadedAt: Date.now(), chunkCount: msg.chunks.length, source: 'note' },
                  chunkRecords,
                )
                  .then(() => {
                    updateDocument(id, { status: 'ready', chunkCount: msg.chunks.length, embedProgress: null })
                    if (useDocumentStore.getState().selectedId == null) selectDocument(id)
                  })
                  .catch((err) =>
                    updateDocument(id, {
                      status: 'error',
                      error: err instanceof Error ? err.message : 'Failed to save document.',
                    }),
                  )
                  .finally(() => resolve())
              },
              onError: (msg) => {
                updateDocument(id, { status: 'error', error: msg.message })
                resolve()
              },
            })
          })
          .catch((err) => {
            updateDocument(id, { status: 'error', error: err instanceof Error ? err.message : 'Failed to read file.' })
            resolve()
          })
      }),
    [updateDocument, selectDocument, setModelProgress, setBackend],
  )

  const processFiles = useCallback((fileList: FileList) => {
    const files = Array.from(fileList)
    const allowed = files.filter((file) => ALLOWED_MIME_TYPES.includes(file.type))
    const skipped = files.length - allowed.length
    setRejectMsg(skipped > 0 ? `Skipped ${skipped} unsupported file${skipped === 1 ? '' : 's'}.` : null)
    if (allowed.length > 0) setQueue((prev) => [...prev, ...allowed])
  }, [])

  const handleConfirm = useCallback(() => {
    const file = pendingConsent
    if (!file) return
    setPendingConsent(null)
    const id = crypto.randomUUID()
    addDocument(id, file.name, 'note')
    void processFile(file, id)
  }, [pendingConsent, addDocument, processFile])

  const handleCancel = useCallback(() => {
    // Nothing was ever sent — the file is discarded, not added to the store at all.
    setPendingConsent(null)
  }, [])

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragging(false)
      if (busy) return
      if (e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files)
    },
    [processFiles, busy],
  )

  const handleFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) processFiles(e.target.files)
    },
    [processFiles],
  )

  return (
    <div>
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 text-center transition-colors duration-150 sm:p-10 ${
          isDragging
            ? 'border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950'
            : 'border-slate-300 dark:border-slate-700'
        }`}
      >
        <UploadSimple className="size-6 text-slate-400 dark:text-slate-500" weight="bold" aria-hidden="true" />
        <p className="text-slate-600 dark:text-slate-400">Drag photos or PDFs of handwritten or scanned notes here, or</p>
        <label className="inline-flex min-h-11 cursor-pointer items-center rounded text-blue-600 underline underline-offset-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-600 dark:text-blue-400 dark:focus-within:outline-blue-400">
          browse
          <input
            type="file"
            accept={ALLOWED_MIME_TYPES.join(',')}
            multiple
            className="sr-only"
            onChange={handleFileInput}
            disabled={busy || pendingConsent !== null}
          />
        </label>
        {rejectMsg && (
          <StatusBanner variant="warning" className="w-full text-left">
            {rejectMsg}
          </StatusBanner>
        )}
      </div>

      {pendingConsent && (
        <StatusBanner variant="info" className="mt-2 items-start">
          <span className="flex flex-col gap-2">
            <span>
              <strong>{pendingConsent.name}</strong> will be uploaded to Google's Gemini API to extract its text
              (OCR). Unlike the Documents tab, this file's actual content leaves your browser — not just a
              snippet. PocketRAG's server never stores it.
            </span>
            <span className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={handleConfirm}>
                Upload for OCR
              </Button>
              <Button variant="secondary" onClick={handleCancel}>
                Cancel
              </Button>
            </span>
          </span>
        </StatusBanner>
      )}
    </div>
  )
}
