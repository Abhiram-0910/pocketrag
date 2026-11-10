import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { citedPages, findFigures, mergeBoxes, padBox, pickFigures, transformBox, type Box, type FigureOps } from './figures'

// Arbitrary operator numbers: the logic only compares them.
const O: FigureOps = {
  save: 1,
  restore: 2,
  transform: 3,
  paintFormXObjectBegin: 4,
  paintFormXObjectEnd: 5,
  paintImageXObject: 6,
  paintInlineImageXObject: 7,
  constructPath: 8,
  fill: 9,
  eoFill: 10,
  stroke: 11,
  closeStroke: 12,
  fillStroke: 13,
  eoFillStroke: 14,
  closeFillStroke: 15,
  closeEOFillStroke: 16,
}
const ENDPATH = 99 // a clipping path: built, never painted
const A4: Box = [0, 0, 595, 842]
const list = (ops: [number, unknown[] | null][]) => ({ fnArray: ops.map((o) => o[0]), argsArray: ops.map((o) => o[1]) })
const path = (paint: number, [x0, y0, x1, y1]: Box): [number, unknown[]] => [O.constructPath, [paint, [], new Float32Array([x0, y0, x1, y1])]]

describe('transformBox', () => {
  it('scales, translates and rotates to the axis-aligned box', () => {
    expect(transformBox([200, 0, 0, 100, 50, 600], [0, 0, 1, 1])).toEqual([50, 600, 250, 700])
    // 90° rotation: (x, y) → (-y, x), then +100 in x.
    expect(transformBox([0, 1, -1, 0, 100, 0], [0, 0, 20, 10])).toEqual([90, 0, 100, 20])
  })
})

describe('findFigures', () => {
  it('finds an image as the unit square under the current transform, restoring after save/restore', () => {
    const ops = list([
      [O.save, null],
      [O.transform, [240, 0, 0, 135, 51, 582]],
      [O.paintImageXObject, ['img1', 640, 360]],
      [O.restore, null],
      [O.paintInlineImageXObject, [{}]], // identity CTM: a 1×1 pt image, too small to show
    ])
    expect(findFigures(ops, O, A4)).toEqual({ figures: [[51, 582, 291, 717]], scan: false })
  })

  it('applies a form XObject matrix, and pops it at the end of the form', () => {
    const ops = list([
      [O.paintFormXObjectBegin, [[2, 0, 0, 2, 100, 100], [0, 0, 50, 50]]],
      path(O.fill, [0, 0, 50, 40]),
      [O.paintFormXObjectEnd, null],
      path(O.fill, [300, 300, 360, 340]),
    ])
    const { figures } = findFigures(ops, O, A4)
    expect(figures).toEqual([
      [100, 100, 200, 180],
      [300, 300, 360, 340],
    ])
  })

  it('merges nearby strokes into one drawing and drops hairlines, clip paths and page-size backgrounds', () => {
    const ops = list([
      path(O.fill, [0, 0, 595, 842]), // background
      path(O.stroke, [100, 400, 160, 440]),
      path(O.stroke, [165, 400, 220, 430]), // 5 pt away: same drawing
      path(O.eoFill, [150, 445, 200, 470]), // 5 pt above
      path(O.fill, [72, 300, 500, 300.75]), // an underline / rule
      path(ENDPATH, [0, 0, 400, 400]), // clip
    ])
    expect(findFigures(ops, O, A4)).toEqual({ figures: [[100, 400, 220, 470]], scan: false })
  })

  it('calls a page covered by one image a scan', () => {
    const ops = list([
      [O.transform, [595, 0, 0, 842, 0, 0]],
      [O.paintImageXObject, ['scan', 2480, 3508]],
    ])
    expect(findFigures(ops, O, A4).scan).toBe(true)
  })

  it('reads the committed fixture: raster figure, vector figure, text only, scan', async () => {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync('eval/fixtures/figures-notes.pdf')), verbosity: 0 }).promise
    const found = []
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      found.push(findFigures(await page.getOperatorList(), OPS as unknown as FigureOps, page.view as Box))
    }
    const size = (b: Box) => [Math.round(b[2] - b[0]), Math.round(b[3] - b[1])]
    expect(found.map((f) => [f.figures.map(size), f.scan])).toEqual([
      [[[240, 135]], false], // the 320×180 px <img>
      [[[270, 152]], false], // the inline SVG's drawn shapes (its labels are text)
      [[], false],
      [[], true],
    ])
  })

  it('finds nothing on the maths fixture (fraction bars are not figures)', async () => {
    const pdf = await getDocument({ data: new Uint8Array(readFileSync('eval/fixtures/maths-notes.pdf')), verbosity: 0 }).promise
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p)
      expect(findFigures(await page.getOperatorList(), OPS as unknown as FigureOps, page.view as Box).figures).toEqual([])
    }
  })
})

describe('mergeBoxes', () => {
  it('merges transitively, including a union that grows into a neighbour', () => {
    expect(
      mergeBoxes(
        [
          [0, 0, 10, 10],
          [12, 0, 20, 10],
          [0, 30, 30, 40],
          [100, 100, 110, 110],
        ],
        2,
      ),
    ).toHaveLength(3)
    expect(
      mergeBoxes(
        [
          [0, 0, 10, 50],
          [40, 0, 50, 50],
          [5, 20, 45, 30], // bridges the two
        ],
        0,
      ),
    ).toEqual([[0, 0, 50, 50]])
  })
})

describe('pickFigures', () => {
  const near: Box = [50, 500, 300, 650]
  const far: Box = [50, 60, 300, 200]
  const passage: Box = [50, 660, 540, 760]

  it('shows figures next to the cited text, nearest first, up to max', () => {
    expect(pickFigures([far, near], passage, 842, false, 2)).toEqual({ kind: 'crop', boxes: [near] })
    expect(pickFigures([near, [50, 640, 100, 655] as Box], passage, 842, false, 1)).toEqual({ kind: 'crop', boxes: [[50, 640, 100, 655]] })
  })

  it('a far figure only when the diagram heuristic fired; the whole page when none could be isolated', () => {
    expect(pickFigures([far], passage, 842, false, 2)).toBeNull()
    expect(pickFigures([far], passage, 842, true, 2)).toEqual({ kind: 'crop', boxes: [far] })
    expect(pickFigures([], passage, 842, true, 2)).toEqual({ kind: 'page' })
    expect(pickFigures([], null, 842, false, 2)).toBeNull()
    expect(pickFigures([near], passage, 842, true, 0)).toBeNull()
  })
})

describe('padBox and citedPages', () => {
  it('pads a crop but keeps it on the page', () => {
    expect(padBox([2, 100, 590, 200], A4)).toEqual([0, 92, 595, 208])
  })

  it('lists cited (document, page) pairs in order, once each, skipping unknown labels', () => {
    const labels = [
      { label: 1, documentId: 'a' },
      { label: 2, documentId: 'b' },
    ]
    expect(citedPages('X (Doc 2, page 3). Y (Doc 1 page 1), (Doc 2, page 3), (Doc 9, page 1).', labels)).toEqual([
      { documentId: 'b', page: 3 },
      { documentId: 'a', page: 1 },
    ])
  })
})
