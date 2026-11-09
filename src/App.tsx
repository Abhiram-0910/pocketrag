import { useEffect, useRef, useState } from 'react'
import { DropZone } from './components/DropZone'
import { NotesDropZone } from './components/NotesDropZone'
import { DocumentList } from './components/DocumentList'
import { QueryPanel } from './components/QueryPanel'
import { ByokPanel, type ByokPanelHandle } from './components/ByokPanel'
import { ConversationList } from './components/ConversationList'
import { LandingPage } from './components/LandingPage'
import { PrivacyPage } from './components/PrivacyPage'
import { REPO_URL } from './lib/privacyFacts'
import { getAllDocuments } from './lib/db'
import { isCurrentModel, reindexOutdated } from './lib/reindex'
import type { KeyConfig } from './lib/answerRequest'
import { getHasVisitedApp, setHasVisitedApp } from './lib/landingVisitSetting'
import { useChatStore } from './store/chatStore'
import { useDocumentStore } from './store/documentStore'

type Tab = 'documents' | 'notes'

// #privacy and its in-page anchors (#privacy-…) show the privacy + terms view.
const isPrivacyHash = () => window.location.hash.startsWith('#privacy')

const FOOTER_LINK =
  'underline underline-offset-2 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:hover:text-slate-100'

function Footer() {
  return (
    <footer className="mt-12 border-t border-slate-200 pt-4 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
      <ul className="flex flex-wrap gap-x-4 gap-y-2">
        <li>
          <a className={FOOTER_LINK} href="#privacy">
            Privacy and terms
          </a>
        </li>
        <li>
          <a className={FOOTER_LINK} href={REPO_URL} rel="noopener noreferrer" target="_blank">
            Source on GitHub
          </a>
        </li>
      </ul>
    </footer>
  )
}

function App() {
  const restoreDocuments = useDocumentStore((s) => s.restoreDocuments)
  const restoreHistory = useChatStore((s) => s.restore)
  const restored = useRef(false)
  // Matches ByokPanel's default (unchecked) state — the shared key until the user
  // opts into BYOK and completes key entry.
  const [keyConfig, setKeyConfig] = useState<KeyConfig | null>({ keySource: 'shared' })
  // The key and chosen model live only in ByokPanel's local state (never shared state), so
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
  const [privacyOpen, setPrivacyOpen] = useState(isPrivacyHash)
  useEffect(() => {
    const onHashChange = () => setPrivacyOpen(isPrivacyHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Restore the document list from IndexedDB on load — persisted docs are fully embedded,
  // so they come back as `ready` (or `reindexing`, when their vectors are from an older model). We land on the list and select nothing (multi-document
  // is the model now; auto-opening one would undermine it). Ref-guarded so StrictMode's
  // double-invoke runs it once; restoreDocuments merges by id so it can't clobber a doc
  // dropped in the same instant.
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    getAllDocuments()
      .then((docs) => {
        restoreDocuments(
          docs.map((doc) => ({
            id: doc.id,
            fileName: doc.fileName,
            // Vectors from an older embedding model are re-embedded first (reindex.ts).
            status: isCurrentModel(doc) ? 'ready' : 'reindexing',
            error: null,
            embedProgress: null,
            chunkCount: doc.chunkCount,
            // Older records predate this field — see db.ts's DocumentRecord.source.
            source: doc.source ?? 'document',
          })),
        )
        void reindexOutdated(docs)
      })
      .catch(() => {})
    // Chat history: lists conversations and opens the most recent one. Nothing is
    // focused — restoring must not move the user's focus. A failure shows the storage
    // banner (chatStore.storage), never a crash.
    void restoreHistory()
  }, [restoreDocuments, restoreHistory])

  // The app stays mounted (hidden) under the privacy view, so an in-memory key and the
  // open conversation survive a visit to it.
  const privacy = privacyOpen && (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
      <main>
        <PrivacyPage />
      </main>
    </div>
  )

  if (view === 'landing') {
    return (
      privacy || (
        <div className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
          <main>
            <LandingPage
              onGetStarted={() => {
                setHasVisitedApp()
                setView('app')
              }}
            />
          </main>
          <Footer />
        </div>
      )
    )
  }

  // Below lg: one column, the conversation list as a disclosure under the header. From lg
  // up: the list becomes a sticky left rail beside the existing max-w-2xl column.
  return (
    <>
      {privacy}
      <div hidden={privacyOpen} className="mx-auto max-w-2xl px-4 py-8 sm:px-8 lg:max-w-6xl">
        <header className="lg:ml-[17.5rem]">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">PocketRAG</h1>
          <p className="mt-1 text-slate-500 dark:text-slate-400">
            {tab === 'documents' ? 'Drop a PDF, then ask a question about it.' : 'Upload a photo or PDF of handwritten or scanned notes.'}
          </p>
        </header>
        <div className="mt-6 lg:grid lg:grid-cols-[15rem_minmax(0,42rem)] lg:gap-10">
          <aside className="mb-6 lg:sticky lg:top-8 lg:mb-0 lg:self-start">
            <ConversationList />
          </aside>
          <main className="min-w-0">
            <div className="inline-flex overflow-hidden rounded border border-slate-200 text-sm dark:border-slate-700">
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
        </div>
        <Footer />
      </div>
    </>
  )
}

export default App
