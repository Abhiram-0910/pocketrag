// v1.4 diagram crop: finds figure regions on a PDF page from its pdf.js operator list,
// with no rendering and no model. Images are the unit square under the current transform;
// vector drawings are the bounding boxes pdf.js records for each painted path, merged
// when they touch or nearly touch. Pure (the operator constants are passed in), so it's
// unit-tested with hand-built operator lists.

/** [x0, y0, x1, y1] in PDF page space (points, origin bottom-left), x0 <= x1, y0 <= y1. */
export type Box = [number, number, number, number]
type Matrix = [number, number, number, number, number, number]

export type FigureOps = Record<
  | 'save'
  | 'restore'
  | 'transform'
  | 'paintFormXObjectBegin'
  | 'paintFormXObjectEnd'
  | 'paintImageXObject'
  | 'paintInlineImageXObject'
  | 'constructPath'
  | 'fill'
  | 'eoFill'
  | 'stroke'
  | 'closeStroke'
  | 'fillStroke'
  | 'eoFillStroke'
  | 'closeFillStroke'
  | 'closeEOFillStroke',
  number
>

export interface OperatorList {
  fnArray: readonly number[]
  argsArray: readonly unknown[]
}

// Smallest figure worth showing, in points (72 per inch): about 1.4 × 1 cm.
const MIN_WIDTH = 40
const MIN_HEIGHT = 30
// Drawn pieces this close (points) belong to one drawing.
const MERGE_GAP = 10
// An image covering this much of the page is the page: a scan.
const SCAN_COVER = 0.8
// A figure within this fraction of the page height of the cited text is "adjacent".
const ADJACENT = 1 / 6
// Padding around a crop, so labels drawn just outside the shapes come along.
export const CROP_PAD = 8

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
]

/** The axis-aligned box around [x0, y0, x1, y1] after the transform. */
export function transformBox(m: Matrix, [x0, y0, x1, y1]: Box): Box {
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ]) {
    xs.push(m[0] * x + m[2] * y + m[4])
    ys.push(m[1] * x + m[3] * y + m[5])
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1])
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
const near = (a: Box, b: Box, gap: number) =>
  a[0] <= b[2] + gap && b[0] <= a[2] + gap && a[1] <= b[3] + gap && b[1] <= a[3] + gap
const clamp = (b: Box, page: Box): Box | null => {
  const c: Box = [Math.max(b[0], page[0]), Math.max(b[1], page[1]), Math.min(b[2], page[2]), Math.min(b[3], page[3])]
  // Zero-thickness is kept: a hairline's box has no height, and it can still join a drawing.
  return c[2] >= c[0] && c[3] >= c[1] ? c : null
}

/**
 * Merges boxes closer than `gap` into one, transitively. Sort-and-sweep union-find, then
 * a repeat until no merged box touches another (a union can grow into a neighbour).
 */
export function mergeBoxes(boxes: readonly Box[], gap: number): Box[] {
  let current = boxes.map((b): Box => [...b])
  for (;;) {
    const order = current.map((_, i) => i).sort((i, j) => current[i][0] - current[j][0])
    const parent = current.map((_, i) => i)
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])))
    for (let a = 0; a < order.length; a++) {
      const i = order[a]
      for (let b = a + 1; b < order.length; b++) {
        const j = order[b]
        if (current[j][0] > current[i][2] + gap) break
        if (near(current[i], current[j], gap)) parent[root(j)] = root(i)
      }
    }
    const groups = new Map<number, Box>()
    current.forEach((box, i) => {
      const r = root(i)
      const g = groups.get(r)
      groups.set(r, g ? union(g, box) : box)
    })
    const merged = [...groups.values()]
    if (merged.length === current.length) return merged
    current = merged
  }
}

export interface PageFigures {
  /** Figure regions, largest first. */
  figures: Box[]
  /** One image covers the page: it's a scanned page, shown whole. */
  scan: boolean
}

/** Figure regions on a page whose crop box is `page` (pdf.js `page.view`). */
export function findFigures(opList: OperatorList, ops: FigureOps, page: Box): PageFigures {
  const paints = new Set([
    ops.fill,
    ops.eoFill,
    ops.stroke,
    ops.closeStroke,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ])
  const images: Box[] = []
  const paths: Box[] = []
  let ctm: Matrix = [1, 0, 0, 1, 0, 0]
  const stack: Matrix[] = []
  opList.fnArray.forEach((fn, i) => {
    const args = opList.argsArray[i] as unknown[] | null
    if (fn === ops.save) stack.push(ctm)
    else if (fn === ops.restore) ctm = stack.pop() ?? ctm
    else if (fn === ops.transform && args) ctm = multiply(ctm, args as unknown as Matrix)
    else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm)
      const matrix = args?.[0] as Matrix | null | undefined
      if (matrix && matrix.length === 6) ctm = multiply(ctm, [...matrix] as Matrix)
    } else if (fn === ops.paintFormXObjectEnd) ctm = stack.pop() ?? ctm
    else if (fn === ops.paintImageXObject || fn === ops.paintInlineImageXObject) images.push(transformBox(ctm, [0, 0, 1, 1]))
    else if (fn === ops.constructPath && args) {
      // [paint op, path data, minMax] — minMax is [minX, minY, maxX, maxY] in user space.
      const minMax = args[2] as ArrayLike<number> | null | undefined
      if (paints.has(args[0] as number) && minMax && minMax.length === 4 && Number.isFinite(minMax[0])) {
        paths.push(transformBox(ctm, [minMax[0], minMax[1], minMax[2], minMax[3]]))
      }
    }
  })

  const pageArea = area(page)
  const onPage = (boxes: Box[]) =>
    boxes.flatMap((b) => {
      const c = clamp(b, page)
      return c ? [c] : []
    })
  const pageImages = onPage(images)
  const scan = pageImages.some((b) => area(b) >= SCAN_COVER * pageArea)
  // A page-size rectangle is a background or a frame, not a figure.
  const pieces = [...pageImages, ...mergeBoxes(onPage(paths).filter((b) => area(b) < SCAN_COVER * pageArea), MERGE_GAP)].filter(
    (b) => area(b) < SCAN_COVER * pageArea,
  )
  const figures = mergeBoxes(pieces, 0)
    .filter((b) => b[2] - b[0] >= MIN_WIDTH && b[3] - b[1] >= MIN_HEIGHT)
    .sort((a, b) => area(b) - area(a))
  return { figures, scan }
}

export type FigurePick = { kind: 'crop'; boxes: Box[] } | { kind: 'page' } | null

const verticalGap = (a: Box, b: Box) => Math.max(0, a[1] - b[3], b[1] - a[3])

/**
 * What to show for one cited page: the figures next to the cited text (nearest first);
 * otherwise, if the diagram heuristic fired, the nearest figure, or the whole page when
 * no figure could be isolated; otherwise nothing.
 */
export function pickFigures(figures: readonly Box[], passage: Box | null, pageHeight: number, diagramLikely: boolean, max: number): FigurePick {
  if (max <= 0) return null
  const gap = (b: Box) => (passage ? verticalGap(b, passage) : Number.POSITIVE_INFINITY)
  const ranked = [...figures].sort((a, b) => gap(a) - gap(b))
  const adjacent = ranked.filter((b) => gap(b) <= pageHeight * ADJACENT)
  if (adjacent.length > 0) return { kind: 'crop', boxes: adjacent.slice(0, max) }
  if (!diagramLikely) return null
  return ranked.length > 0 ? { kind: 'crop', boxes: ranked.slice(0, 1) } : { kind: 'page' }
}

/** A crop box with padding, kept on the page. */
export function padBox(b: Box, page: Box, pad = CROP_PAD): Box {
  return [Math.max(page[0], b[0] - pad), Math.max(page[1], b[1] - pad), Math.min(page[2], b[2] + pad), Math.min(page[3], b[3] + pad)]
}

const CITATION = /Doc\s+(\d+)[\s,]*page\s+(\d+)/gi

/** The (document, page) pairs an answer cites, in order of first mention; unknown labels skipped. */
export function citedPages(answer: string, docLabels: readonly { label: number; documentId: string }[]): { documentId: string; page: number }[] {
  const seen = new Set<string>()
  const out: { documentId: string; page: number }[] = []
  for (const m of answer.matchAll(CITATION)) {
    const documentId = docLabels.find((d) => d.label === Number(m[1]))?.documentId
    const page = Number(m[2])
    if (!documentId || seen.has(`${documentId}:${page}`)) continue
    seen.add(`${documentId}:${page}`)
    out.push({ documentId, page })
  }
  return out
}
