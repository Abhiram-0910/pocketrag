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
  const setModelProgress = useDocumentStore((s) => s.setModelProgress)
  const setBackend = useDocumentStore((s) => s.setBackend)

  // ponytail: interim single-file guard — the sequential bulk queue lands in a later commit.
  const busy = documents.some(
    (d) => d.status === 'extracting-text' || d.status === 'loading-model' || d.status === 'embedding',
  )

  const processFile = useCallback(
    async (file: File) => {
      if (file.type !== 'application/pdf') {
        setRejectMsg('Only PDF files are supported.')
        return
      }
      setRejectMsg(null)
      const id = crypto.randomUUID()
      addDocument(id, file.name)
      updateDocument(id, { status: 'extracting-text' })
      try {
        const pages = await extractPdfText(file)
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
            saveDocument(
              { id, fileName: file.name, uploadedAt: Date.now(), chunkCount: msg.chunks.length },
              chunkRecords,
            )
              .then(() =>
                updateDocument(id, { status: 'ready', chunkCount: msg.chunks.length, embedProgress: null }),
              )
              .catch((err) =>
                updateDocument(id, {
                  status: 'error',
                  error: err instanceof Error ? err.message : 'Failed to save document.',
                }),
              )
          },
          onError: (msg) => updateDocument(id, { status: 'error', error: msg.message }),
        })
      } catch (err) {
        updateDocument(id, { status: 'error', error: err instanceof Error ? err.message : 'Failed to process PDF.' })
      }
    },
    [addDocument, updateDocument, setModelProgress, setBackend],
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
        <input type="file" accept="application/pdf" className="hidden" onChange={handleFileInput} disabled={busy} />
      </label>
      {rejectMsg && <p className="text-sm text-red-600">{rejectMsg}</p>}
    </div>
  )
}
