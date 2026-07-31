import { useCallback, useState, type ChangeEvent, type DragEvent } from 'react'
import { extractPdfText } from '../lib/pdf'
import { embedDocument } from '../lib/embeddingClient'
import { saveDocument, type ChunkRecord } from '../lib/db'
import { useDocumentStore } from '../store/documentStore'

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
        extractPdfText(file)
          .then((pages) => {
            updateDocument(id, { status: 'loading-model' })
            embedDocument(pages, {
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
                }))
                saveDocument({ id, fileName: file.name, uploadedAt: Date.now(), chunkCount: msg.chunks.length }, chunkRecords)
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
                updateDocument(id, { status: 'error', error: msg.message })
                resolve()
              },
            })
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
        addDocument(id, file.name)
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
      className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
        isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300'
      }`}
    >
      <p className="text-gray-600">Drag PDFs here, or</p>
      <label className="cursor-pointer text-blue-600 underline">
        browse
        <input
          type="file"
          accept="application/pdf"
          multiple
          className="hidden"
          onChange={handleFileInput}
          disabled={busy}
        />
      </label>
      {rejectMsg && <p className="text-sm text-red-600">{rejectMsg}</p>}
    </div>
  )
}
