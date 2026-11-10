// v1.4: renders the user's own PDF page locally for the diagram crop and the
// click-to-verify highlight. pdf.js render + canvas only: nothing here touches the
// network, nothing is stored, and every canvas is released once its pixels are copied
// into a small ImageBitmap (which its owner closes). The PDF comes from sessionFiles.ts
// (this tab's memory), and each call opens it once and destroys it afterwards.
import * as pdfjsLib from 'pdfjs-dist'
import type { PageViewport, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import './pdf' // sets pdf.js's worker
import { findFigures, padBox, pickFigures, type Box, type FigureOps } from './figures'
import { itemRangeBoxes, resolvePassage, unionBox, type ItemRange, type TextItemBox } from './textLayout'

// Long edge of a page render, in pixels: crisp crops at about 2× for A4, ~11 MB of pixels.
const RENDER_EDGE = 1800
// Long edge of what's kept: a crop, a whole-page thumbnail, the verify view.
const FIGURE_EDGE = 1200
const THUMB_EDGE = 900
const VERIFY_EDGE = 1600

export interface CitedPassage {
  text: string
  itemRange?: ItemRange
}

export type FigureKind = 'figure' | 'not-isolated' | 'scan' | 'note'

export interface FigureImage {
  documentId: string
  page: number
  kind: FigureKind
  bitmap: ImageBitmap
}

const release = (canvas: HTMLCanvasElement) => {
  canvas.width = 0
  canvas.height = 0
}

/** Copies part of a canvas or image into an ImageBitmap no longer than maxEdge. */
async function bitmapFrom(source: CanvasImageSource, [sx, sy, sw, sh]: number[], maxEdge: number): Promise<ImageBitmap> {
  const k = Math.min(1, maxEdge / Math.max(sw, sh))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(sw * k))
  out.height = Math.max(1, Math.round(sh * k))
  out.getContext('2d')?.drawImage(source, sx, sy, sw, sh, 0, 0, out.width, out.height)
  try {
    return await createImageBitmap(out)
  } finally {
    release(out)
  }
}

async function withPdf<T>(file: File, fn: (pdf: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
  try {
    return await fn(await task.promise)
  } finally {
    void task.destroy()
  }
}

async function render(page: PDFPageProxy, longEdge: number) {
  const base = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: Math.min(3, longEdge / Math.max(base.width, base.height)) })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  await page.render({ canvas, viewport }).promise
  return { canvas, viewport }
}

/** A page-space box in canvas pixels: [sx, sy, sw, sh]. */
function toPixels(viewport: PageViewport, box: Box): number[] {
  const [x0, y0] = viewport.convertToViewportPoint(box[0], box[1]) as number[]
  const [x1, y1] = viewport.convertToViewportPoint(box[2], box[3]) as number[]
  const sx = Math.max(0, Math.floor(Math.min(x0, x1)))
  const sy = Math.max(0, Math.floor(Math.min(y0, y1)))
  return [sx, sy, Math.max(1, Math.ceil(Math.max(x0, x1)) - sx), Math.max(1, Math.ceil(Math.max(y0, y1)) - sy)]
}

async function pageText(page: PDFPageProxy): Promise<TextItemBox[]> {
  const content = await page.getTextContent()
  return content.items.map((item) =>
    'str' in item
      ? { str: item.str, transform: item.transform as number[], width: item.width, height: item.height }
      : { str: '', transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0 },
  )
}

/** Page-space boxes for the passages that could be found on the page (one list per passage). */
function passageBoxes(items: TextItemBox[], passages: readonly CitedPassage[]): Box[][] {
  const strs = items.map((i) => i.str)
  return passages.flatMap((p) => {
    const range = resolvePassage(strs, p.text, p.itemRange)
    return range ? [itemRangeBoxes(items, range)] : []
  })
}

const isImageFile = (file: File) => file.type.startsWith('image/')

async function wholeImage(file: File, maxEdge: number): Promise<ImageBitmap> {
  const full = await createImageBitmap(file)
  try {
    return await bitmapFrom(full, [0, 0, full.width, full.height], maxEdge)
  } finally {
    full.close()
  }
}

/**
 * The figures to show for one cited page, at most `max`. A note (Notes tab: a photo or a
 * scanned PDF, whose text came from OCR) and a scanned PDF page are shown whole; a typed
 * page shows its isolated figures (figures.ts), or the whole page marked "figure not
 * isolated" when the diagram heuristic fired but nothing could be isolated.
 */
export async function figuresForPage(
  file: File,
  documentId: string,
  pageNumber: number,
  opts: { note: boolean; passages: CitedPassage[]; diagramLikely: boolean; max: number },
): Promise<FigureImage[]> {
  if (opts.max <= 0) return []
  const one = (kind: FigureKind, bitmap: ImageBitmap): FigureImage[] => [{ documentId, page: pageNumber, kind, bitmap }]
  if (opts.note) {
    if (!opts.diagramLikely) return []
    if (isImageFile(file)) return one('note', await wholeImage(file, THUMB_EDGE))
  }
  return withPdf(file, async (pdf) => {
    // A note's text is the whole file's OCR as "page 1": show its first page.
    const page = await pdf.getPage(opts.note ? 1 : Math.min(pageNumber, pdf.numPages))
    const view = page.view as Box
    let pick: ReturnType<typeof pickFigures> | 'scan' | 'note'
    if (opts.note) pick = 'note'
    else {
      const opList = await page.getOperatorList()
      const found = findFigures(opList, pdfjsLib.OPS as unknown as FigureOps, view)
      if (found.scan) pick = opts.diagramLikely ? 'scan' : null
      else {
        const passage = unionBox(passageBoxes(await pageText(page), opts.passages).flat())
        pick = pickFigures(found.figures, passage, view[3] - view[1], opts.diagramLikely, opts.max)
      }
    }
    if (pick === null) return []
    const { canvas, viewport } = await render(page, RENDER_EDGE)
    try {
      const whole = [0, 0, canvas.width, canvas.height]
      if (pick === 'note' || pick === 'scan') return one(pick, await bitmapFrom(canvas, whole, THUMB_EDGE))
      if (pick.kind === 'page') return one('not-isolated', await bitmapFrom(canvas, whole, THUMB_EDGE))
      const out: FigureImage[] = []
      for (const box of pick.boxes) {
        out.push(...one('figure', await bitmapFrom(canvas, toPixels(viewport, padBox(box, view)), FIGURE_EDGE)))
      }
      return out
    } finally {
      release(canvas)
      page.cleanup()
    }
  })
}

export interface VerifyView {
  bitmap: ImageBitmap
  /** 'highlight': the passage is marked; 'scan' / 'note': shown without a highlight;
   * 'not-found': the passage couldn't be found on the page (shown without a highlight). */
  status: 'highlight' | 'scan' | 'note' | 'not-found'
  /** Top of the first highlight as a fraction of the image height, to scroll to it. */
  highlightTop: number | null
}

/** The cited page with the cited passages highlighted, for the click-to-verify dialog. */
export async function renderVerifyPage(file: File, pageNumber: number, opts: { note: boolean; passages: CitedPassage[] }): Promise<VerifyView> {
  if (opts.note && isImageFile(file)) return { bitmap: await wholeImage(file, VERIFY_EDGE), status: 'note', highlightTop: null }
  return withPdf(file, async (pdf) => {
    const page = await pdf.getPage(opts.note ? 1 : Math.min(pageNumber, pdf.numPages))
    const view = page.view as Box
    let status: VerifyView['status'] = 'note'
    let boxes: Box[] = []
    if (!opts.note) {
      const found = findFigures(await page.getOperatorList(), pdfjsLib.OPS as unknown as FigureOps, view)
      if (found.scan) status = 'scan'
      else {
        boxes = passageBoxes(await pageText(page), opts.passages).flat()
        status = boxes.length > 0 ? 'highlight' : 'not-found'
      }
    }
    const { canvas, viewport } = await render(page, VERIFY_EDGE)
    try {
      let highlightTop: number | null = null
      const ctx = canvas.getContext('2d')
      if (ctx && boxes.length > 0) {
        ctx.globalCompositeOperation = 'multiply'
        ctx.fillStyle = 'rgba(255, 213, 0, 0.55)'
        // One path, one fill: overlapping chunks (they share 40 tokens) are painted once.
        ctx.beginPath()
        for (const box of boxes) {
          const [x, y, w, h] = toPixels(viewport, box)
          ctx.rect(x, y, w, h)
          highlightTop = Math.min(highlightTop ?? 1, y / canvas.height)
        }
        ctx.fill()
      }
      return { bitmap: await bitmapFrom(canvas, [0, 0, canvas.width, canvas.height], VERIFY_EDGE), status, highlightTop }
    } finally {
      release(canvas)
      page.cleanup()
    }
  })
}
