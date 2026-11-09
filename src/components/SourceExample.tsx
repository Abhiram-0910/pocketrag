import { useEffect, useState } from 'react'
import { getChunksForDocument } from '../lib/db'
import { expandToPage, type SourceMatch } from '../lib/sourceMatch'

/**
 * The source's own text for a worked-example match (v1.1): for 'verbatim', the solution as
 * written in the user's notes; for 'method', the example the answer was asked to follow,
 * with a warning about the arithmetic. Quoted exactly as stored, in its own language; the
 * whole page, so a solution is never cut off. Renders nothing if the document is gone.
 */
export function SourceExample({ match, fileName }: { match: SourceMatch; fileName: string }) {
  const [passage, setPassage] = useState<{ key: string; text: string; pages: number[] } | null>(null)
  const key = `${match.documentId}/${match.chunkId}`

  useEffect(() => {
    let cancelled = false
    getChunksForDocument(match.documentId)
      .then((chunks) => {
        const expanded = expandToPage(match.chunkId, chunks)
        if (!cancelled && expanded) setPassage({ key: `${match.documentId}/${match.chunkId}`, ...expanded })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [match.documentId, match.chunkId])

  if (passage?.key !== key) return null
  const where = passage.pages.length > 1 ? `pages ${passage.pages[0]}–${passage.pages.at(-1)}` : `page ${passage.pages[0]}`
  return (
    <section
      data-source-match={match.kind}
      className="rounded border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-950"
    >
      <p className="text-xs font-medium text-slate-700 dark:text-slate-300">
        {match.kind === 'verbatim' ? `From your notes (${where})` : `Method from your notes (${where})`}
        <span className="font-normal text-slate-500 dark:text-slate-400"> · {fileName}</span>
      </p>
      <blockquote className="mt-2 whitespace-pre-wrap text-slate-800 dark:text-slate-200">{passage.text}</blockquote>
      {match.kind === 'method' && (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
          Check the arithmetic: the model can make calculation mistakes.
        </p>
      )}
    </section>
  )
}
