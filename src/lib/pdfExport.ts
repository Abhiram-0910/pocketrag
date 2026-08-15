import { jsPDF } from 'jspdf'
import type { DocLabel } from './answerRequest'

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

const GROUNDED_TEXT = 'Grounded in your documents.'
const UNGROUNDED_TEXT =
  'This answer may not be fully grounded in the source document — verify against the sources below.'

export interface ExportTurn {
  question: string
  answer: string
  groundingWarning: boolean
  docLabels: DocLabel[]
}

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
    writeWrapped(turn.groundingWarning ? UNGROUNDED_TEXT : GROUNDED_TEXT, LABEL_FONT_SIZE)
    cursor.y += PARAGRAPH_GAP
    writeWrapped(turn.answer, BODY_FONT_SIZE)

    if (turn.docLabels.length > 0) {
      cursor.y += PARAGRAPH_GAP
      const legend = turn.docLabels.map((d) => `Doc ${d.label} = ${titleFor(d.documentId)}`).join(' · ')
      writeWrapped(legend, LABEL_FONT_SIZE)
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
