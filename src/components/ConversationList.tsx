import { useRef, useState } from 'react'
import { CaretDown, CaretUp, ChatsCircle, Plus, Trash } from '@phosphor-icons/react'
import { deleteAllDocuments } from '../lib/db'
import { forgetSessionFile } from '../lib/sessionFiles'
import { useChatStore } from '../store/chatStore'
import { useDocumentStore } from '../store/documentStore'
import { QUESTION_INPUT_ID } from './QueryPanel'
import { StatusBanner } from './ui/StatusBanner'
import { Button } from './ui/Button'

function updatedLabel(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toDateString() === new Date().toDateString()
    ? `Today, ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Unknown error.')

/**
 * Saved conversations (chatStore): open one, start a new one, delete one, delete all
 * history, or delete everything (documents + history; the downloaded models stay cached).
 * A left rail from `lg` up; below that, the same list behind a disclosure button.
 */
export function ConversationList() {
  const conversations = useChatStore((s) => s.conversations)
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const openConversation = useChatStore((s) => s.openConversation)
  const newConversation = useChatStore((s) => s.newConversation)
  const deleteConversation = useChatStore((s) => s.deleteConversation)
  const deleteAllHistory = useChatStore((s) => s.deleteAllHistory)
  const documents = useDocumentStore((s) => s.documents)
  const removeDocument = useDocumentStore((s) => s.removeDocument)

  const [expanded, setExpanded] = useState(false)
  // Only one destructive confirm open at a time: a row id, 'history' or 'everything'.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [message, setMessage] = useState<{ variant: 'error' | 'success'; text: string } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())

  // Deleting a document while it's still being embedded would let the embed finish and
  // save it back; wait for every document to be ready or failed.
  const documentsBusy = documents.some((d) => d.status !== 'ready' && d.status !== 'error')

  const handleNew = () => {
    newConversation()
    document.getElementById(QUESTION_INPUT_ID)?.focus()
  }

  const handleDeleteOne = async (id: string) => {
    const index = conversations.findIndex((c) => c.id === id)
    const next = conversations[index + 1] ?? conversations[index - 1] ?? null
    try {
      await deleteConversation(id)
      setConfirming(null)
      setMessage(null)
      // Focus moves to the row that took its place, or the heading if none is left —
      // never dropped to <body> with the button that just unmounted.
      const target = next ? rowRefs.current.get(next.id) : null
      ;(target ?? headingRef.current)?.focus()
    } catch (err) {
      setConfirming(null)
      setMessage({ variant: 'error', text: `Couldn't delete this conversation: ${errorText(err)}` })
    }
  }

  const handleDeleteHistory = async () => {
    setConfirming(null)
    try {
      await deleteAllHistory()
      setMessage({ variant: 'success', text: 'Deleted all chat history.' })
    } catch (err) {
      setMessage({ variant: 'error', text: `Couldn't delete chat history: ${errorText(err)}` })
    }
    headingRef.current?.focus()
  }

  // Two databases, so no single transaction: each part reports separately, and a partial
  // failure says exactly what was and wasn't deleted.
  const handleDeleteEverything = async () => {
    setConfirming(null)
    let documentsError: string | null = null
    let historyError: string | null = null
    try {
      await deleteAllDocuments()
      for (const doc of documents) {
        removeDocument(doc.id)
        forgetSessionFile(doc.id)
      }
    } catch (err) {
      documentsError = errorText(err)
    }
    try {
      await deleteAllHistory()
    } catch (err) {
      historyError = errorText(err)
    }
    if (!documentsError && !historyError) {
      setMessage({ variant: 'success', text: 'Deleted all documents and chat history. The downloaded AI models stay cached.' })
    } else {
      setMessage({
        variant: 'error',
        text: [
          documentsError ? `Documents couldn't be deleted: ${documentsError}` : 'Documents deleted.',
          historyError ? `Chat history couldn't be deleted: ${historyError}` : 'Chat history deleted.',
        ].join(' '),
      })
    }
    headingRef.current?.focus()
  }

  const confirmBanner = (text: string, onConfirm: () => void) => (
    <StatusBanner variant="error" className="mt-2 items-center">
      <span className="flex flex-wrap items-center gap-2">
        {text}
        <Button variant="destructive" onClick={onConfirm}>
          Delete
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(null)}>
          Cancel
        </Button>
      </span>
    </StatusBanner>
  )

  return (
    <nav aria-labelledby="conversations-heading" className="text-left">
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-2 dark:border-slate-700">
        <h2
          id="conversations-heading"
          ref={headingRef}
          tabIndex={-1}
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600 focus:outline-none focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-slate-300"
        >
          <ChatsCircle className="size-4" weight="bold" aria-hidden="true" />
          Conversations
          <span className="font-normal tabular-nums text-slate-500 dark:text-slate-400">{conversations.length}</span>
        </h2>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          aria-controls="conversation-panel"
          className="inline-flex min-h-11 cursor-pointer items-center gap-1 rounded px-2 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-blue-600 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
        >
          {expanded ? 'Hide' : 'Show'}
          {expanded ? (
            <CaretUp className="size-3.5" weight="bold" aria-hidden="true" />
          ) : (
            <CaretDown className="size-3.5" weight="bold" aria-hidden="true" />
          )}
        </button>
      </div>

      <div id="conversation-panel" className={`${expanded ? 'block' : 'hidden'} lg:block`}>
        <Button variant="secondary" onClick={handleNew} className="mt-3 w-full">
          <Plus className="size-4" weight="bold" aria-hidden="true" />
          New conversation
        </Button>

        {conversations.length === 0 ? (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            No saved conversations yet. Questions you ask are kept here, in this browser only.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {conversations.map((c) => {
              const active = c.id === activeConversationId
              return (
                <li key={c.id}>
                  <div className="flex items-stretch gap-1">
                    <button
                      type="button"
                      ref={(el) => {
                        if (el) rowRefs.current.set(c.id, el)
                        else rowRefs.current.delete(c.id)
                      }}
                      onClick={() => void openConversation(c.id)}
                      aria-current={active ? 'true' : undefined}
                      className={`min-h-11 min-w-0 flex-1 cursor-pointer rounded border-l-2 px-2 py-1.5 text-left transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-blue-600 ${
                        active
                          ? 'border-blue-600 bg-blue-50 dark:border-blue-400 dark:bg-blue-950'
                          : 'border-transparent hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span className="block truncate text-sm text-slate-900 dark:text-slate-100">{c.title}</span>
                      <span className="block text-xs tabular-nums text-slate-500 dark:text-slate-400">{updatedLabel(c.updatedAt)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirming(c.id)
                        setMessage(null)
                      }}
                      aria-label={`Delete conversation: ${c.title}`}
                      className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded text-slate-500 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-slate-400 dark:hover:bg-red-950 dark:hover:text-red-400"
                    >
                      <Trash className="size-4" weight="bold" aria-hidden="true" />
                    </button>
                  </div>
                  {confirming === c.id && confirmBanner('Delete this conversation permanently?', () => void handleDeleteOne(c.id))}
                </li>
              )
            })}
          </ul>
        )}

        <section aria-labelledby="your-data-heading" className="mt-6 border-t border-dashed border-slate-300 pt-3 dark:border-slate-600">
          <h3
            id="your-data-heading"
            className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300"
          >
            Your data
          </h3>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">Stored in this browser only.</p>
          <div className="mt-2 flex flex-col gap-2">
            <Button
              variant="secondary"
              disabled={conversations.length === 0}
              onClick={() => {
                setConfirming('history')
                setMessage(null)
              }}
            >
              Delete all chat history
            </Button>
            {confirming === 'history' &&
              confirmBanner('Delete every saved conversation permanently?', () => void handleDeleteHistory())}
            <Button
              variant="secondary"
              disabled={documentsBusy || (documents.length === 0 && conversations.length === 0)}
              onClick={() => {
                setConfirming('everything')
                setMessage(null)
              }}
            >
              Delete everything
            </Button>
            {confirming === 'everything' &&
              confirmBanner(
                'Delete all documents and chat history permanently? The downloaded AI models stay cached.',
                () => void handleDeleteEverything(),
              )}
          </div>
          {message && (
            <StatusBanner variant={message.variant} className="mt-2">
              {message.text}
            </StatusBanner>
          )}
        </section>
      </div>
    </nav>
  )
}
