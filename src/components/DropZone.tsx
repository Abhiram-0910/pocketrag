import { useCallback, useState, type ChangeEvent, type DragEvent } from 'react'
import { classifyEmbeddingError } from '../lib/errorTaxonomy'
import { UploadSimple } from '@phosphor-icons/react'
import { extractPdfText } from '../lib/pdf'
import { embedDocument } from '../lib/embeddingClient'
import { saveDocument, type ChunkRecord } from '../lib/db'
import { EMBEDDING_MODEL_KEY } from '../lib/searchModels'
import { rememberSessionFile } from '../lib/sessionFiles'
import { charRangeToItems } from '../lib/textLayout'
import { useDocumentStore } from '../store/documentStore'
import { StatusBanner } from './ui/StatusBanner'

export function DropZone() {
  const [isDragging, setIsDragging] = useState(false)
  const [rejectMsg, setRejectMsg] = useState<string | null>(null)
  const documents = useDocumentStore((s) => s.documents)
  const addDocument = useDocumentStore((s) => s.addDocument)
  const updateDocument = useDocumentStore((s) => s.updateDocument)
  const selectDocument = useDocumentStore((s) => s.selectDocument)
  const setModelProgress = useDocumentStore((s) => s.setModelProgress)
  const setBackend = useDocumentStore((s) => s.setBackend)

  const busy = documents.some(
    (d) => d.status === 'extracting-text' || d.status === 'loading-model' || d.status === 'embedding',
  )

  // Runs one file end-to-end. Resolves (never rejects) once the document reaches `ready`
  // or `error`, so the bulk queue can await it and one failing file can't block the rest.
  const processFile = useCallback(
    (file: File, id: string): Promise<void> =>
      new Promise<void>((resolve) => {
        updateDocument(id, { status: 'extracting-text' })
        rememberSessionFile(id, file)
        extractPdfText(file)
          .then((pages) => {
            updateDocument(id, { status: 'loading-model' })
            const embed = () => embedDocument(pages, {
              onModelProgress: (msg) => setModelProgress(msg.percent, msg.loaded, msg.total),
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
                  itemRange: charRangeToItems(pages[chunk.page - 1]?.itemLengths ?? [], chunk.start, chunk.end) ?? undefined,
                }))
                saveDocument(
                  { id, fileName: file.name, uploadedAt: Date.now(), chunkCount: msg.chunks.length, source: 'document', embeddingModel: EMBEDDING_MODEL_KEY },
                  chunkRecords,
                )
                  .then(() => {
                    updateDocument(id, { status: 'ready', chunkCount: msg.chunks.length, embedProgress: null })
                    // Auto-select the first ready document so a single upload is immediately
                    // queryable; multi-document switching stays explicit. Reads live state so
                    // restore-on-reload (which merges docs directly, never this path) can't trip it.
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
                const { type, message } = classifyEmbeddingError(msg)
                const retry =
                  type === 'model-download'
                    ? () => {
                        updateDocument(id, { status: 'loading-model', error: null, retry: null })
                        embed()
                      }
                    : null
                updateDocument(id, { status: 'error', error: message, retry })
                resolve()
              },
            })
            embed()
          })
          .catch((err) => {
            updateDocument(id, { status: 'error', error: err instanceof Error ? err.message : 'Failed to process PDF.' })
            resolve()
          })
      }),
    [updateDocument, selectDocument, setModelProgress, setBackend],
  )

  const processFiles = useCallback(
    async (fileList: FileList) => {
      const files = Array.from(fileList)
      const pdfs = files.filter((file) => file.type === 'application/pdf')
      const skipped = files.length - pdfs.length
      setRejectMsg(skipped > 0 ? `Skipped ${skipped} non-PDF file${skipped === 1 ? '' : 's'}.` : null)

      // Queue the whole batch up front so every file is visible immediately, then embed
      // them one at a time — the embedding worker has a single message handler, so only
      // one document can embed at once (and concurrency wouldn't be faster anyway).
      const jobs = pdfs.map((file) => {
        const id = crypto.randomUUID()
        addDocument(id, file.name, 'document')
        return { file, id }
      })
      for (const { file, id } of jobs) {
        await processFile(file, id)
      }
    },
    [addDocument, processFile],
  )

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragging(false)
      if (busy) return
      if (e.dataTransfer.files.length > 0) void processFiles(e.dataTransfer.files)
    },
    [processFiles, busy],
  )

  const handleFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) void processFiles(e.target.files)
    },
    [processFiles],
  )

  return (
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
      <p className="text-slate-600 dark:text-slate-400">Drag PDFs here, or</p>
      <label className="inline-flex min-h-11 cursor-pointer items-center rounded text-blue-600 underline underline-offset-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-600 dark:text-blue-400 dark:focus-within:outline-blue-400">
        browse
        {/* sr-only (not `hidden`/display:none) so the native file input stays keyboard-
            focusable and tabbable — display:none removes an element from the tab order
            entirely, which would make this trigger mouse-only. */}
        <input
          type="file"
          accept="application/pdf"
          multiple
          className="sr-only"
          onChange={handleFileInput}
          disabled={busy}
        />
      </label>
      {rejectMsg && (
        <StatusBanner variant="warning" className="w-full text-left">
          {rejectMsg}
        </StatusBanner>
      )}
    </div>
  )
}
