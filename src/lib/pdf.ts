import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

export interface PageText {
  /** 1-indexed, matching pdf.js's own page numbering. */
  page: number
  text: string
}

/** Extracts plain text from a PDF file, one entry per page, so chunks can be attributed to a page. */
export async function extractPdfText(file: File): Promise<PageText[]> {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise

  const pages: PageText[] = []
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
    pages.push({ page: pageNum, text })
  }

  return pages
}
