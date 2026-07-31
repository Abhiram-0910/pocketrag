import { useEffect, useRef } from 'react'
import { DropZone } from './components/DropZone'
import { DocumentList } from './components/DocumentList'
import { QueryPanel } from './components/QueryPanel'
import { getAllDocuments } from './lib/db'
import { useDocumentStore } from './store/documentStore'

function App() {
  const restoreDocuments = useDocumentStore((s) => s.restoreDocuments)
  const restored = useRef(false)

  // Restore the document list from IndexedDB on load — persisted docs are fully embedded,
  // so they come back as `ready`. We land on the list and select nothing (multi-document
  // is the model now; auto-opening one would undermine it). Ref-guarded so StrictMode's
  // double-invoke runs it once; restoreDocuments merges by id so it can't clobber a doc
  // dropped in the same instant.
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    getAllDocuments()
      .then((docs) =>
        restoreDocuments(
          docs.map((doc) => ({
            id: doc.id,
            fileName: doc.fileName,
            status: 'ready',
            error: null,
            embedProgress: null,
            chunkCount: doc.chunkCount,
          })),
        ),
      )
      .catch(() => {})
  }, [restoreDocuments])

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold text-gray-900">PocketRAG</h1>
      <p className="mt-1 text-gray-500">Drop a PDF, then ask a question about it.</p>
      <div className="mt-6">
        <DropZone />
        <DocumentList />
        <QueryPanel />
      </div>
    </main>
  )
}

export default App
