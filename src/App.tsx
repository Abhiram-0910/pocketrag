import { useEffect, useRef, useState } from 'react'
import { DropZone } from './components/DropZone'
import { DocumentList } from './components/DocumentList'
import { QueryPanel } from './components/QueryPanel'
import { ByokPanel } from './components/ByokPanel'
import { getAllDocuments } from './lib/db'
import type { KeyConfig } from './lib/answerRequest'
import { useDocumentStore } from './store/documentStore'

function App() {
  const restoreDocuments = useDocumentStore((s) => s.restoreDocuments)
  const restored = useRef(false)
  // Matches ByokPanel's default (unchecked) state — the shared key until the user
  // opts into BYOK and completes key entry.
  const [keyConfig, setKeyConfig] = useState<KeyConfig | null>({ keySource: 'shared' })

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
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">PocketRAG</h1>
      <p className="mt-1 text-slate-500 dark:text-slate-400">Drop a PDF, then ask a question about it.</p>
      <div className="mt-6 space-y-6">
        <DropZone />
        <DocumentList />
        <ByokPanel onChange={setKeyConfig} />
        <QueryPanel keyConfig={keyConfig} />
      </div>
    </main>
  )
}

export default App
