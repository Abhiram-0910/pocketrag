import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ChunkRecord } from '../lib/db'
import { isDiagramLikely } from '../lib/diagramHeuristic'
import { citedPages } from '../lib/figures'
import type { TurnRecord } from '../lib/historyDb'
import { figuresForPage, type FigureImage, type FigureKind } from '../lib/pageView'
import { getSessionFile, sessionFilesVersion, subscribeSessionFiles } from '../lib/sessionFiles'
import { useDocumentStore } from '../store/documentStore'

// v1.4 point 2: at most this many figures per answer.
export const MAX_FIGURES = 2

export interface FiguresState {
  key: string
  figures: FigureImage[]
  // Documents with a diagram-likely cited page whose file isn't in this tab.
  missing: string[]
}

/**
 * The figures for an answered turn (v1.4 point 2): for each page the answer cites, in
 * order, what figures.ts picks there, cut from the user's own PDF in this browser. No
 * network, no model. Bitmaps are closed when the answer changes or the panel unmounts.
 */
export function useAnswerFigures(
  turn: Pick<TurnRecord, 'id' | 'docLabels'> | null,
  text: string | null,
  chunks: readonly { chunk: ChunkRecord }[] | null,
): FiguresState | null {
  const version = useSyncExternalStore(subscribeSessionFiles, sessionFilesVersion)
  const [state, setState] = useState<FiguresState | null>(null)
  const turnId = turn?.id ?? null
  const docLabels = turn?.docLabels
  const key = `${turnId}:${version}`

  useEffect(() => {
    if (turnId === null || text === null || !chunks || !docLabels) return
    let cancelled = false
    const made: FigureImage[] = []
    void (async () => {
      const missing = new Set<string>()
      for (const { documentId, page } of citedPages(text, docLabels)) {
        if (made.length >= MAX_FIGURES || cancelled) break
        const onPage = chunks.map((c) => c.chunk).filter((c) => c.documentId === documentId && c.page === page)
        const doc = useDocumentStore.getState().documents.find((d) => d.id === documentId)
        if (onPage.length === 0 || !doc) continue
        const diagramLikely = onPage.some(isDiagramLikely)
        const file = getSessionFile(documentId)
        if (!file) {
          if (diagramLikely) missing.add(documentId)
          continue
        }
        try {
          made.push(
            ...(await figuresForPage(file, documentId, page, {
              note: doc.source === 'note',
              passages: onPage.map((c) => ({ text: c.text, itemRange: c.itemRange })),
              diagramLikely,
              max: MAX_FIGURES - made.length,
            })),
          )
        } catch {
          // An unreadable page (or an image format the browser can't decode): nothing for it.
        }
      }
      if (cancelled) made.forEach((f) => f.bitmap.close())
      else setState({ key: `${turnId}:${version}`, figures: made, missing: [...missing] })
    })()
    return () => {
      cancelled = true
    }
  }, [turnId, text, chunks, docLabels, version])

  // Close a set of bitmaps once it's replaced or the panel goes away.
  useEffect(() => () => state?.figures.forEach((f) => f.bitmap.close()), [state])

  return state?.key === key ? state : null
}

export const figureCaption = (f: FigureImage, fileName: string) => `${CAPTIONS[f.kind](f.page)} · ${fileName}`

const CAPTIONS: Record<FigureKind, (page: number) => string> = {
  figure: (page) => `Figure from page ${page}`,
  'not-isolated': (page) => `Page ${page} (figure not isolated)`,
  scan: (page) => `Scanned page ${page}`,
  note: () => 'Your note',
}

