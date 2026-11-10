import { useEffect, useRef, useState } from 'react'
import { rememberSessionFile } from '../lib/sessionFiles'
import { useDocumentStore } from '../store/documentStore'
import { figureCaption, type FiguresState } from './useAnswerFigures'

/** Draws an ImageBitmap (CSP img-src 'self' rules out blob:/data: images, so pages are canvases). */
export function BitmapCanvas({ bitmap, label, className = '' }: { bitmap: ImageBitmap; label: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas || bitmap.width === 0) return
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  }, [bitmap])
  return <canvas ref={ref} role="img" aria-label={label} className={`block h-auto max-w-full ${className}`} />
}

/**
 * PocketRAG never stores the PDF itself, so after a reload a page can't be drawn until the
 * user picks the file again. It's kept in this tab's memory only, like a fresh upload.
 */
export function ChooseFileAgain({ documentId, fileName, note }: { documentId: string; fileName: string; note: boolean }) {
  const [wrong, setWrong] = useState<string | null>(null)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <label className="inline-flex min-h-11 cursor-pointer items-center rounded text-blue-700 underline underline-offset-2 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-blue-600 dark:text-blue-400 dark:focus-within:outline-blue-400">
        Choose {fileName} again
        <input
          type="file"
          accept={note ? 'image/*,application/pdf' : 'application/pdf'}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (!file) return
            if (file.name !== fileName) return setWrong(`That's ${file.name}, not ${fileName}.`)
            setWrong(null)
            rememberSessionFile(documentId, file)
          }}
        />
      </label>
      {wrong && (
        <span role="status" className="text-xs text-amber-800 dark:text-amber-300">
          {wrong}
        </span>
      )}
    </span>
  )
}

/** The answer card's figures and, after a reload, the way to bring the file back. */
export function AnswerFigures({ state, titleFor }: { state: FiguresState | null; titleFor: (id: string) => string }) {
  if (!state || (state.figures.length === 0 && state.missing.length === 0)) return null
  const documents = useDocumentStore.getState().documents
  return (
    <section aria-label="Figures from your documents" data-answer-figures className="space-y-2">
      {state.figures.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {state.figures.map((f, i) => {
            const caption = figureCaption(f, titleFor(f.documentId))
            return (
              <figure key={i} data-figure-kind={f.kind} className="rounded border border-slate-200 bg-white p-2 dark:border-slate-700">
                <BitmapCanvas bitmap={f.bitmap} label={`${caption}, as it appears in your file`} className="mx-auto max-h-96 w-auto" />
                <figcaption className="mt-1 text-xs text-slate-600 dark:text-slate-400">{caption}</figcaption>
              </figure>
            )
          })}
        </div>
      )}
      {state.figures.length > 0 && (
        <p className="text-xs text-slate-600 dark:text-slate-400">Cut from your own file in this browser; nothing was sent.</p>
      )}
      {state.missing.map((id) => (
        <p key={id} className="text-xs text-slate-600 dark:text-slate-400" data-figures-missing>
          This answer cites a page that may have a figure, but {titleFor(id)} isn't open in this tab (PocketRAG doesn't keep
          your files).{' '}
          <ChooseFileAgain documentId={id} fileName={titleFor(id)} note={documents.find((d) => d.id === id)?.source === 'note'} />
        </p>
      ))}
    </section>
  )
}
