import { useCallback, useState, type ChangeEvent, type DragEvent } from 'react'
import { extractPdfText } from '../lib/pdf'
import { embedDocument } from '../lib/embeddingClient'
import { saveDocument, type ChunkRecord } from '../lib/db'
import { useDocumentStore } from '../store/documentStore'

export function DropZone() {
  const [isDragging, setIsDragging] = useState(false)
  const status = useDocumentStore((s) => s.status)
  const setExtracting = useDocumentStore((s) => s.setExtracting)
  const setLoadingModel = useDocumentStore((s) => s.setLoadingModel)
  const setModelProgress = useDocumentStore((s) => s.setModelProgress)
  const setBackend = useDocumentStore((s) => s.setBackend)
  const setEmbedProgress = useDocumentStore((s) => s.setEmbedProgress)
  const setResult = useDocumentStore((s) => s.setResult)
  const setError = useDocumentStore((s) => s.setError)

  const busy = status === 'extracting-text' || status === 'loading-model' || status === 'embedding'

  const processFile = useCallback(
    async (file: File) => {
      if (file.type !== 'application/pdf') {
        setError('Only PDF files are supported.')
        return
      }
      setExtracting()
      try {
        const pages = await extractPdfText(file)
        setLoadingModel()
        embedDocument(pages, {
          onModelProgress: (msg) => setModelProgress(msg.percent),
          onBackend: (msg) => setBackend(msg.backend, msg.detail),
          onModelReady: () => {},
          onChunked: () => {},
          onEmbedProgress: (msg) => setEmbedProgress(msg.done, msg.total),
          onResult: (msg) => {
            const documentId = crypto.randomUUID()
            const chunkRecords: ChunkRecord[] = msg.chunks.map((chunk) => ({
              id: `${documentId}:${chunk.index}`,
              documentId,
              index: chunk.index,
              text: chunk.text,
              tokenCount: chunk.tokenCount,
              page: chunk.page,
              embedding: chunk.embedding,
            }))
            saveDocument(
              { id: documentId, fileName: file.name, uploadedAt: Date.now(), chunkCount: msg.chunks.length },
              chunkRecords,
            )
              .then(() => setResult(documentId, file.name, msg.chunks))
              .catch((err) => setError(err instanceof Error ? err.message : 'Failed to save document.'))
          },
          onError: (msg) => setError(msg.message),
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to process PDF.')
      }
    },
    [setExtracting, setLoadingModel, setModelProgress, setBackend, setEmbedProgress, setResult, setError],
  )

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      setIsDragging(false)
      if (busy) return
      const file = e.dataTransfer.files[0]
      if (file) void processFile(file)
    },
    [processFile, busy],
  )

  const handleFileInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (file) void processFile(file)
    },
    [processFile],
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
      <p className="text-gray-600">Drag a PDF here, or</p>
      <label className="cursor-pointer text-blue-600 underline">
        browse
        <input
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={handleFileInput}
          disabled={busy}
        />
      </label>
      {status === 'extracting-text' && <p className="text-sm text-gray-500">Extracting text…</p>}
    </div>
  )
}
