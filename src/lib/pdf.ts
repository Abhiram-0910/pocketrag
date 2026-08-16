import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

export interface PageText {
  /** 1-indexed, matching pdf.js's own page numbering. */
  page: number
  text: string
  /** Whether this page's content stream paints any raster image (Milestone 10's
   * structural diagram-likely signal — see diagramHeuristic.ts). Doesn't catch
   * vector-drawn diagrams; that's the lexical signal's job. */
  hasImage: boolean
}

// Any operator that paints a raster image onto the page — normal XObject images,
// inline images (small images embedded directly in the content stream, common for
// scanned diagrams), and repeated-XObject images (the same image reused via a
// pattern). Deliberately excludes paintImageMaskXObject — a mask alone (no image
// data) doesn't itself indicate diagram-like raster content.
const IMAGE_PAINT_OPS: ReadonlySet<number> = new Set([
  pdfjsLib.OPS.paintImageXObject,
  pdfjsLib.OPS.paintImageXObjectRepeat,
  pdfjsLib.OPS.paintInlineImageXObject,
])

/** Pure check over a page's operator list — kept separate from the pdf.js I/O above so it's unit-testable without a real PDF. */
export function pageHasImage(operatorList: { fnArray: readonly number[] }): boolean {
  return operatorList.fnArray.some((fn) => IMAGE_PAINT_OPS.has(fn))
}

/** Extracts plain text from a PDF file, one entry per page, so chunks can be attributed to a page. */
export async function extractPdfText(file: File): Promise<PageText[]> {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise

  const pages: PageText[] = []
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const [content, operatorList] = await Promise.all([page.getTextContent(), page.getOperatorList()])
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
    pages.push({ page: pageNum, text, hasImage: pageHasImage(operatorList) })
  }

  return pages
}
