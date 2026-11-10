import { describe, it, expect } from 'vitest'
import type { jsPDF } from 'jspdf'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import { buildConversationPdf, type ExportTurn, type ExportSource } from './pdfExport'
import { findFigures, type Box, type FigureOps } from './figures'

function titleFor(documentId: string): string {
  return documentId === 'doc-1' ? 'biology.pdf' : documentId === 'doc-2' ? 'cooking.pdf' : documentId
}

/** Real round-trip through pdf.js (already a project dependency) — extracts each page's
 * actual rendered text, so tests assert on what a reader would really see per page,
 * not just that some internal method was called. */
async function extractPages(doc: jsPDF): Promise<string[]> {
  const bytes = new Uint8Array(doc.output('arraybuffer'))
  const pdf = await pdfjsLib.getDocument({ data: bytes, useSystemFonts: true }).promise
  const pages: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    pages.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '))
  }
  return pages
}

function makeTurn(overrides: Partial<ExportTurn> = {}): ExportTurn {
  return {
    question: 'What gives bread its chewy texture?',
    answer: 'Gluten gives bread its chewy texture.',
    groundingWarning: false,
    docLabels: [],
    ...overrides,
  }
}

describe('buildConversationPdf', () => {
  it('renders a single turn on one page with question and answer text', async () => {
    const doc = buildConversationPdf([makeTurn()], [], titleFor)
    const pages = await extractPages(doc)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain('What gives bread its chewy texture?')
    expect(pages[0]).toContain('Gluten gives bread its chewy texture.')
    expect(pages[0]).toContain('Grounded in your documents.')
    expect(pages[0]).not.toContain('Sources')
  })

  it('shows the ungrounded warning text instead of the grounded text when flagged', async () => {
    const doc = buildConversationPdf([makeTurn({ groundingWarning: true })], [], titleFor)
    const [page] = await extractPages(doc)
    expect(page).toContain('may not be fully grounded')
    expect(page).not.toContain('Grounded in your documents.')
  })

  it('writes only the not-retained text, no grounding line, for an answer that was not kept', async () => {
    const doc = buildConversationPdf([makeTurn({ answer: null })], [], titleFor)
    const [page] = await extractPages(doc)
    expect(page).toContain('Web-grounded answer, not retained (Google terms)')
    expect(page).not.toContain('Grounded in your documents.')
    expect(page).not.toContain('may not be fully grounded')
  })

  it('renders the Doc N legend resolved to real filenames', async () => {
    const doc = buildConversationPdf(
      [
        makeTurn({
          docLabels: [
            { label: 1, documentId: 'doc-1' },
            { label: 2, documentId: 'doc-2' },
          ],
        }),
      ],
      [],
      titleFor,
    )
    const [page] = await extractPages(doc)
    expect(page).toContain('Doc 1 = biology.pdf')
    expect(page).toContain('Doc 2 = cooking.pdf')
  })

  it('renders the current-turn Sources section only when sources are passed', async () => {
    const sources: ExportSource[] = [
      { documentId: 'doc-2', page: 1, score: 0.485, text: 'Kneading develops gluten strands.' },
    ]
    const withSources = await extractPages(buildConversationPdf([makeTurn()], sources, titleFor))
    const withoutSources = await extractPages(buildConversationPdf([makeTurn()], [], titleFor))

    expect(withSources[0]).toContain('Sources (current answer only)')
    expect(withSources[0]).toContain('cooking.pdf')
    expect(withSources[0]).toContain('page 1')
    expect(withSources[0]).toContain('0.485')
    expect(withSources[0]).toContain('Kneading develops gluten strands.')
    expect(withoutSources[0]).not.toContain('Sources')
  })

  it('renders multiple turns in order with a separator between them', async () => {
    const doc = buildConversationPdf(
      [makeTurn({ question: 'First question?' }), makeTurn({ question: 'Second question?' })],
      [],
      titleFor,
    )
    const [page] = await extractPages(doc)
    expect(page.indexOf('First question?')).toBeGreaterThanOrEqual(0)
    expect(page.indexOf('Second question?')).toBeGreaterThan(page.indexOf('First question?'))
  })

  it('forces a real page break for a long answer, with content actually continuing on page 2', async () => {
    const longAnswer = `${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(150)}FINAL-MARKER-END`
    const doc = buildConversationPdf([makeTurn({ answer: longAnswer })], [], titleFor)
    const pages = await extractPages(doc)

    expect(pages.length).toBeGreaterThanOrEqual(2)
    expect(pages[0]).not.toContain('FINAL-MARKER-END')
    expect(pages[pages.length - 1]).toContain('FINAL-MARKER-END')
    // The question (written before the long answer) must stay on page 1 — proves the
    // break happened mid-answer, not that everything got pushed to page 2 wholesale.
    expect(pages[0]).toContain('What gives bread its chewy texture?')
  })

  it('places the current answer\'s figures (v1.4) under the last turn, with their captions', async () => {
    // A 4×3 JPEG, as QueryPanel draws it from a figure's bitmap.
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAADAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdAHrB/9k='
    const doc = buildConversationPdf([makeTurn({ question: 'First?' }), makeTurn({ question: 'Second?' })], [], titleFor, new Date(0), [
      { dataUrl, width: 400, height: 300, caption: 'Figure from page 2 · biology.pdf' },
    ])
    const [text] = await extractPages(doc)
    expect(text.indexOf('Figure from page 2 · biology.pdf')).toBeGreaterThan(text.indexOf('Second?'))
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(doc.output('arraybuffer')) }).promise
    const page = await pdf.getPage(1)
    const { figures } = findFigures(await page.getOperatorList(), pdfjsLib.OPS as unknown as FigureOps, page.view as Box)
    // One image, scaled down to fit the column (400×300 px → at most the content width).
    expect(figures).toHaveLength(1)
    const [x0, y0, x1, y1] = figures[0]
    expect(Math.round((x1 - x0) / (y1 - y0) * 3)).toBe(4)
  })
})
