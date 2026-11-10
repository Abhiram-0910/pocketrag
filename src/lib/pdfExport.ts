import { jsPDF } from 'jspdf'
import type { DocLabel } from './answerRequest'
import { GROUNDED_TEXT, NOT_RETAINED_TEXT, UNGROUNDED_TEXT } from './answerCopy'

const PAGE_MARGIN = 40
const TITLE_FONT_SIZE = 16
const QUESTION_FONT_SIZE = 11
const BODY_FONT_SIZE = 11
const LABEL_FONT_SIZE = 9
// jsPDF's own default (confirmed via doc.getLineHeightFactor()) — kept explicit here
// since ensureSpace()'s page-break math depends on it matching what text() actually uses.
const LINE_HEIGHT_FACTOR = 1.15
const SECTION_GAP = 14
const PARAGRAPH_GAP = 6


export interface ExportTurn {
  question: string
  // null: a web-grounded answer that wasn't retained — placeholder only, no grounding line.
  answer: string | null
  groundingWarning: boolean
  docLabels: DocLabel[]
}

// v1.4: a figure cut from the user's page for the current answer, as a JPEG data URL.
export interface ExportFigure {
  dataUrl: string
  width: number
  height: number
  caption: string
}

// Largest figure in the export, in points.
const FIGURE_MAX_HEIGHT = 320

export interface ExportSource {
  documentId: string
  page: number
  score: number
  text: string
}

/**
 * Renders a full conversation (all turns, in order) to a jsPDF document, with the
 * current (last) turn's retrieved chunks appended as a Sources section — older turns'
 * source chunks aren't retained by QueryPanel's state, only the current turn's are, so
 * only the current turn can show them here.
 *
 * jsPDF does not paginate text on its own; ensureSpace() below is the real page-break
 * logic (checks remaining vertical space before every line, calls addPage() and resets
 * the cursor when a line wouldn't fit) — exercised directly by pdfExport.test.ts with a
 * conversation long enough to force a page break, not assumed to work.
 */
export function buildConversationPdf(
  turns: ExportTurn[],
  currentSources: ExportSource[],
  titleFor: (documentId: string) => string,
  now: Date = new Date(),
  // Shown under the last turn (the current answer), like the Sources.
  currentFigures: ExportFigure[] = [],
): jsPDF {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const contentWidth = pageWidth - PAGE_MARGIN * 2
  const cursor = { y: PAGE_MARGIN }

  const ensureSpace = (height: number) => {
    if (cursor.y + height > pageHeight - PAGE_MARGIN) {
      doc.addPage()
      cursor.y = PAGE_MARGIN
    }
  }

  const writeWrapped = (text: string, fontSize: number) => {
    doc.setFontSize(fontSize)
    const lineHeight = fontSize * LINE_HEIGHT_FACTOR
    const lines = doc.splitTextToSize(text, contentWidth) as string[]
    for (const line of lines) {
      ensureSpace(lineHeight)
      doc.text(line, PAGE_MARGIN, cursor.y)
      cursor.y += lineHeight
    }
  }

  writeWrapped('PocketRAG — Conversation Export', TITLE_FONT_SIZE)
  writeWrapped(`Exported ${now.toLocaleString()}`, LABEL_FONT_SIZE)
  cursor.y += SECTION_GAP

  turns.forEach((turn, i) => {
    if (i > 0) {
      ensureSpace(SECTION_GAP)
      doc.setDrawColor(200)
      doc.line(PAGE_MARGIN, cursor.y, pageWidth - PAGE_MARGIN, cursor.y)
      cursor.y += SECTION_GAP
    }

    writeWrapped(`Q: ${turn.question}`, QUESTION_FONT_SIZE)
    cursor.y += PARAGRAPH_GAP
    if (turn.answer === null) {
      writeWrapped(NOT_RETAINED_TEXT, BODY_FONT_SIZE)
    } else {
      writeWrapped(turn.groundingWarning ? UNGROUNDED_TEXT : GROUNDED_TEXT, LABEL_FONT_SIZE)
      cursor.y += PARAGRAPH_GAP
      writeWrapped(turn.answer, BODY_FONT_SIZE)
    }

    if (turn.docLabels.length > 0) {
      cursor.y += PARAGRAPH_GAP
      const legend = turn.docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')
      writeWrapped(legend, LABEL_FONT_SIZE)
    }

    if (i === turns.length - 1) {
      for (const figure of currentFigures) {
        const k = Math.min(1, contentWidth / figure.width, FIGURE_MAX_HEIGHT / figure.height)
        const [w, h] = [figure.width * k, figure.height * k]
        cursor.y += PARAGRAPH_GAP
        ensureSpace(h)
        doc.addImage(figure.dataUrl, 'JPEG', PAGE_MARGIN, cursor.y, w, h)
        cursor.y += h + PARAGRAPH_GAP
        writeWrapped(figure.caption, LABEL_FONT_SIZE)
      }
    }
  })

  if (currentSources.length > 0) {
    cursor.y += SECTION_GAP
    writeWrapped('Sources (current answer only)', QUESTION_FONT_SIZE)
    cursor.y += PARAGRAPH_GAP
    currentSources.forEach((source, i) => {
      const header = `${i + 1}. ${titleFor(source.documentId)} · page ${source.page} · score ${source.score.toFixed(3)}`
      writeWrapped(header, LABEL_FONT_SIZE)
      writeWrapped(source.text, BODY_FONT_SIZE)
      cursor.y += PARAGRAPH_GAP
    })
  }

  return doc
}
