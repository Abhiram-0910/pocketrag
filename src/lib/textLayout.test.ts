import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { chunkText, splitAtoms } from './chunker'
import { charRangeToItems, itemRangeBoxes, itemRangeText, locatePassage, resolvePassage, unionBox } from './textLayout'

const strs = ['Mitochondria make', '', 'ATP for', 'the cell.']
const text = strs.join(' ') // "Mitochondria make  ATP for the cell."

describe('charRangeToItems and itemRangeText', () => {
  it('maps a page-text range to items and back', () => {
    const start = text.indexOf('make')
    const end = text.indexOf(' cell') // "make  ATP for the"
    const range = charRangeToItems(
      strs.map((s) => s.length),
      start,
      end,
    )
    expect(range).toEqual([0, 13, 3, 3])
    expect(itemRangeText(strs, range!)).toBe('make  ATP for the')
    expect(charRangeToItems([5], 3, 3)).toBeNull()
  })

  it('keeps a range inside one item', () => {
    expect(charRangeToItems([17, 0, 7], 19, 22)).toEqual([2, 0, 2, 3])
    expect(itemRangeText(strs, [2, 0, 2, 3])).toBe('ATP')
  })
})

describe('locatePassage and resolvePassage', () => {
  it('finds a passage exactly, then ignoring whitespace, else null', () => {
    expect(locatePassage(text, 'ATP for')).toEqual({ start: 19, end: 26 })
    const loose = locatePassage(text, 'make ATP\nfor')!
    expect(text.slice(loose.start, loose.end)).toBe('make  ATP for')
    expect(locatePassage(text, 'chloroplast')).toBeNull()
  })

  it('uses a stored range only while it still reads as the passage', () => {
    expect(resolvePassage(strs, 'ATP', [2, 0, 2, 3])).toEqual([2, 0, 2, 3])
    // Stale (a different reading of the file): found again by search.
    expect(resolvePassage(strs, 'the cell.', [0, 0, 0, 3])).toEqual([3, 0, 3, 9])
    expect(resolvePassage(strs, 'nucleus', undefined)).toBeNull()
  })
})

describe('itemRangeBoxes', () => {
  it('cuts the first and last items in proportion and skips empty items', () => {
    const items = [
      { str: 'abcd', transform: [10, 0, 0, 10, 100, 700], width: 40, height: 10 },
      { str: '', transform: [1, 0, 0, 1, 0, 0], width: 0, height: 0 },
      { str: 'efgh', transform: [10, 0, 0, 10, 100, 686], width: 40, height: 10 },
    ]
    const boxes = itemRangeBoxes(items, [0, 2, 2, 1])
    expect(boxes).toEqual([
      [120, 697.5, 140, 709],
      [100, 683.5, 110, 695],
    ])
    expect(unionBox(boxes)).toEqual([100, 683.5, 140, 709])
    expect(unionBox([])).toBeNull()
  })
})

// The fixtures as the app reads them: chunk each page (a word-count tokenizer stands in for
// the model's; ranges don't depend on where chunks break), store each chunk's item range
// the way DropZone does, and check both ways of finding it again.
describe('every fixture chunk resolves', () => {
  it('stored ranges read back as the chunk, and text search finds the chunk (pre-v1.4 path)', async () => {
    let chunks = 0
    let stored = 0
    let searched = 0
    for (const name of readdirSync('eval/fixtures').filter((f) => f.endsWith('.pdf'))) {
      const pdf = await getDocument({ data: new Uint8Array(readFileSync(`eval/fixtures/${name}`)), verbosity: 0 }).promise
      for (let p = 1; p <= pdf.numPages; p++) {
        const content = await (await pdf.getPage(p)).getTextContent()
        const pageStrs = content.items.map((i) => ('str' in i ? i.str : ''))
        const pageText = pageStrs.join(' ')
        for (const chunk of chunkText(pageText, { countTokens: (t) => splitAtoms(t).length }, { chunkSize: 60, overlap: 10 })) {
          chunks++
          const range = charRangeToItems(
            pageStrs.map((s) => s.length),
            chunk.start,
            chunk.end,
          )
          if (range && itemRangeText(pageStrs, range) === chunk.text) stored++
          if (resolvePassage(pageStrs, chunk.text)) searched++
        }
      }
    }
    expect(chunks).toBeGreaterThan(30)
    expect(stored).toBe(chunks)
    expect(searched).toBe(chunks)
  })
})
