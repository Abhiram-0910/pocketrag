import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getChunksByIds, type ChunkRecord } from '../lib/db'
import type { Citation } from '../lib/historyDb'
import { renderVerifyPage, type VerifyView } from '../lib/pageView'
import { getSessionFile, sessionFilesVersion, subscribeSessionFiles } from '../lib/sessionFiles'
import { BitmapCanvas, ChooseFileAgain } from './PageImages'
import { Button } from './ui/Button'

export interface CitationTarget {
  label: number
  documentId: string
  page: number
  // The turn's citations on this page: the passages to highlight.
  citations: Citation[]
}

const STATUS_COPY: Record<VerifyView['status'], string> = {
  highlight: 'The cited passage is highlighted.',
  scan: "This page is a scan, so the passage can't be highlighted. The page is shown as it is.",
  note: "Notes are photos or scans, so the passage can't be highlighted. Your note is shown as it is.",
  'not-found': "Couldn't find the passage on this page, so nothing is highlighted.",
}

/**
 * v1.4 point 4, click-to-verify: the cited page from the user's own file with the cited
 * passage highlighted (pdf.js text positions; pageView.ts). A native modal <dialog>: the
 * rest of the page is inert while it's open, Esc closes it, and focus goes back to the
 * citation that opened it. Drawn locally; nothing is sent.
 */
export function CitationDialog({
  target,
  fileName,
  note,
  onClose,
}: {
  target: CitationTarget
  fileName: string
  note: boolean
  onClose: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const version = useSyncExternalStore(subscribeSessionFiles, sessionFilesVersion)
  const file = getSessionFile(target.documentId)
  const [passages, setPassages] = useState<ChunkRecord[] | null>(null)
  const [view, setView] = useState<{ version: number; result: VerifyView | 'error' } | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (dialog && !dialog.open) dialog.showModal()
    return () => opener?.focus()
  }, [])

  useEffect(() => {
    let cancelled = false
    getChunksByIds(target.citations.map((c) => c.chunkId))
      .then((chunks) => !cancelled && setPassages(chunks))
      .catch(() => !cancelled && setPassages([]))
    return () => {
      cancelled = true
    }
  }, [target])

  useEffect(() => {
    if (!file || passages === null) return
    let cancelled = false
    renderVerifyPage(file, target.page, { note, passages: passages.map((c) => ({ text: c.text, itemRange: c.itemRange })) })
      .then((result) => {
        if (cancelled) result.bitmap.close()
        else setView({ version, result })
      })
      .catch(() => !cancelled && setView({ version, result: 'error' }))
    return () => {
      cancelled = true
    }
  }, [file, passages, target.page, note, version])

  // Release the page image when it's replaced or the dialog closes.
  useEffect(() => () => (view && view.result !== 'error' ? view.result.bitmap.close() : undefined), [view])

  const result = view?.version === version ? view.result : null
  // Bring the first highlight into view once the page is drawn.
  useEffect(() => {
    const box = scrollRef.current
    const canvas = box?.querySelector('canvas')
    if (!box || !canvas || !result || result === 'error' || result.highlightTop === null) return
    box.scrollTop = Math.max(0, canvas.offsetTop + result.highlightTop * canvas.clientHeight - 48)
  }, [result])

  const title = `Doc ${target.label}, page ${target.page}`
  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onKeyDown={(e) => {
        // Keep Tab inside: a modal <dialog> otherwise lets it out to the browser's own UI.
        if (e.key !== 'Tab') return
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex="0"]')]
        const [first, last] = [items[0], items.at(-1)]
        if (!first || !last) return
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }}
      aria-labelledby="citation-dialog-title"
      data-citation-dialog
      className="m-auto w-[calc(100%-2rem)] max-w-3xl rounded-lg bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-950/60 dark:bg-slate-900 dark:text-slate-100"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 p-3 dark:border-slate-700">
        <h2 id="citation-dialog-title" className="min-w-0 break-words text-sm font-semibold">
          {title} <span className="font-normal text-slate-600 dark:text-slate-400">· {fileName}</span>
        </h2>
        <Button variant="secondary" autoFocus onClick={() => dialogRef.current?.close()}>
          Close
        </Button>
      </div>
      {result && result !== 'error' && (
        <p className="border-b border-slate-200 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300" data-verify-status={result.status}>
          {STATUS_COPY[result.status]}
        </p>
      )}
      {/* Focusable so the page can be scrolled from the keyboard. */}
      <div
        ref={scrollRef}
        tabIndex={0}
        aria-label="Cited page"
        className="relative max-h-[75vh] space-y-3 overflow-y-auto p-3 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-600"
      >
        {!file ? (
          <p className="text-sm text-slate-700 dark:text-slate-300">
            PocketRAG doesn't keep your file after a reload, so the page can't be shown. Choose it again to see the page; it stays
            in this tab only. <ChooseFileAgain documentId={target.documentId} fileName={fileName} note={note} />
          </p>
        ) : result === null ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">Drawing the page…</p>
        ) : result === 'error' ? (
          <p className="text-sm text-slate-700 dark:text-slate-300">Couldn't show this page.</p>
        ) : (
          <>
            <BitmapCanvas
              bitmap={result.bitmap}
              label={`Page ${target.page} of ${fileName}${result.status === 'highlight' ? ', with the cited passage highlighted' : ''}`}
              className="w-full border border-slate-200 dark:border-slate-700"
            />
          </>
        )}
        {passages !== null && passages.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300">Cited passage{passages.length > 1 ? 's' : ''}</p>
            {passages.map((c) => (
              <blockquote key={c.id} className="mt-1 whitespace-pre-wrap break-words border-l-2 border-amber-400 pl-2 text-sm text-slate-800 dark:text-slate-200">
                {c.text}
              </blockquote>
            ))}
          </div>
        )}
      </div>
    </dialog>
  )
}
