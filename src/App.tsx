import { useEffect, useRef, useState } from 'react'
import { DropZone } from './components/DropZone'
import { NotesDropZone } from './components/NotesDropZone'
import { DocumentList } from './components/DocumentList'
import { QueryPanel } from './components/QueryPanel'
import { ByokPanel, type ByokPanelHandle } from './components/ByokPanel'
import { LandingPage } from './components/LandingPage'
import { getAllDocuments } from './lib/db'
import type { KeyConfig } from './lib/answerRequest'
import { getHasVisitedApp, setHasVisitedApp } from './lib/landingVisitSetting'
import { useDocumentStore } from './store/documentStore'

type Tab = 'documents' | 'notes'

function App() {
  const restoreDocuments = useDocumentStore((s) => s.restoreDocuments)
  const restored = useRef(false)
  // Matches ByokPanel's default (unchecked) state — the shared key until the user
  // opts into BYOK and completes key entry.
  const [keyConfig, setKeyConfig] = useState<KeyConfig | null>({ keySource: 'shared' })
  // The key and model list live only in ByokPanel's local state (never shared state), so
  // QueryPanel's answer-failure actions reach them through this handle.
  const byokPanel = useRef<ByokPanelHandle>(null)
  // Milestone 9: the tab only gates which upload/list UI is shown — QueryPanel below
  // stays visible and searches the combined pool regardless of the active tab (the
  // trust-sensitive step already happened at OCR-consent time, not at query time).
  const [tab, setTab] = useState<Tab>('documents')
  // Milestone 14: computed synchronously from localStorage at mount — zero flash, no
  // async race against the IndexedDB restore below. A returning visitor must have set
  // this flag on an earlier visit to have gotten anywhere at all, so they skip landing
  // deterministically. See landingVisitSetting.ts's doc comment for the accepted
  // edge-case trade-off (cleared localStorage but real IndexedDB documents still
  // present — shows landing once more, harmlessly, then never again).
  const [view, setView] = useState<'landing' | 'app'>(() => (getHasVisitedApp() ? 'app' : 'landing'))

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
            // Older records predate this field — see db.ts's DocumentRecord.source.
            source: doc.source ?? 'document',
          })),
        ),
      )
      .catch(() => {})
  }, [restoreDocuments])

  if (view === 'landing') {
    return (
      <main className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
        <LandingPage
          onGetStarted={() => {
            setHasVisitedApp()
            setView('app')
          }}
        />
      </main>
    )
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">PocketRAG</h1>
      <p className="mt-1 text-slate-500 dark:text-slate-400">
        {tab === 'documents' ? 'Drop a PDF, then ask a question about it.' : 'Upload a photo or PDF of handwritten or scanned notes.'}
      </p>
      <div className="mt-6 inline-flex overflow-hidden rounded border border-slate-200 text-sm dark:border-slate-700">
        {(['documents', 'notes'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setTab(option)}
            className={`min-h-11 cursor-pointer px-4 transition-colors duration-150 ${
              tab === option
                ? 'bg-blue-600 text-white'
                : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
            }`}
          >
            {option === 'documents' ? 'Documents' : 'Notes'}
          </button>
        ))}
      </div>
      <div className="mt-6 space-y-6">
        {tab === 'documents' ? (
          <>
            <DropZone />
            <DocumentList source="document" />
          </>
        ) : (
          <>
            <NotesDropZone />
            <DocumentList source="note" />
          </>
        )}
        <ByokPanel ref={byokPanel} onChange={setKeyConfig} />
        <QueryPanel keyConfig={keyConfig} onFailureAction={(action) => byokPanel.current?.handleFailureAction(action)} />
      </div>
    </main>
  )
}

export default App
