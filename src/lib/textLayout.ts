// v1.4 click-to-verify: where a chunk sits on its page. pdf.ts builds a page's text by
// joining pdf.js's text items with one space, so a character range in that text maps to
// item indices (stored per chunk at ingest as `itemRange`), and each item's transform and
// width give a rectangle on the page. Pure, so it's unit-tested without a PDF.

import type { Box } from './figures'

/** [startItem, offset in it, endItem, end offset in it (exclusive)]. */
export type ItemRange = [number, number, number, number]

export interface TextItemBox {
  str: string
  transform: number[]
  width: number
  height: number
}

/** The items a page-text range [start, end) covers, or null for an empty range. */
export function charRangeToItems(lengths: readonly number[], start: number, end: number): ItemRange | null {
  if (end <= start || lengths.length === 0) return null
  const starts: number[] = []
  let pos = 0
  for (const len of lengths) {
    starts.push(pos)
    pos += len + 1
  }
  // The last item starting at or before `at` (a joining space belongs to the item before it).
  const itemAt = (at: number) => {
    let i = 0
    while (i + 1 < starts.length && starts[i + 1] <= at) i++
    return i
  }
  const si = itemAt(start)
  const ei = itemAt(end - 1)
  return [si, Math.min(start - starts[si], lengths[si]), ei, Math.min(end - starts[ei], lengths[ei])]
}

/**
 * Finds a stored passage in a page's text, for chunks saved before v1.4 (no itemRange):
 * exact first, then ignoring differences in whitespace. Null if it isn't there (a
 * different file, or a different pdf.js reading of it).
 */
export function locatePassage(pageText: string, passage: string): { start: number; end: number } | null {
  const exact = pageText.indexOf(passage)
  if (exact !== -1 && passage.length > 0) return { start: exact, end: exact + passage.length }
  // Collapse whitespace runs to one space, remembering where each kept character was.
  const map: number[] = []
  let norm = ''
  for (let i = 0; i < pageText.length; i++) {
    const space = /\s/.test(pageText[i])
    if (space && (norm.length === 0 || norm.endsWith(' '))) continue
    norm += space ? ' ' : pageText[i]
    map.push(i)
  }
  const needle = passage.replace(/\s+/g, ' ').trim()
  const at = needle ? norm.indexOf(needle) : -1
  if (at === -1) return null
  return { start: map[at], end: map[at + needle.length - 1] + 1 }
}

/**
 * Page-space rectangles (PDF points, origin bottom-left) for an item range, one per item;
 * the first and last items are cut in proportion to the characters covered. Horizontal
 * text only: a rotated item gets its unrotated box.
 */
export function itemRangeBoxes(items: readonly TextItemBox[], [si, so, ei, eo]: ItemRange): Box[] {
  const boxes: Box[] = []
  for (let i = si; i <= ei && i < items.length; i++) {
    const { str, transform, width } = items[i]
    if (str.length === 0 || width <= 0) continue
    const h = items[i].height || Math.hypot(transform[2], transform[3]) || 10
    const a = i === si ? so / str.length : 0
    const b = i === ei ? eo / str.length : 1
    if (b <= a) continue
    const [x, y] = [transform[4], transform[5]]
    boxes.push([x + width * a, y - h * 0.25, x + width * b, y + h * 0.9])
  }
  return boxes
}

/** The smallest box around all of them, or null if there are none. */
export function unionBox(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  return boxes.reduce<Box>(
    (u, b) => [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])],
    [...boxes[0]],
  )
}

/** The page text an item range covers (items joined by one space, as pdf.ts does). */
export function itemRangeText(strs: readonly string[], [si, so, ei, eo]: ItemRange): string {
  if (si >= strs.length || ei >= strs.length || ei < si) return ''
  if (si === ei) return strs[si].slice(so, eo)
  return [strs[si].slice(so), ...strs.slice(si + 1, ei), strs[ei].slice(0, eo)].join(' ')
}

/**
 * The item range for a stored passage on the page as read now: its stored range if that
 * still reads as the passage, otherwise found by text search (chunks from before v1.4, or
 * the stored range no longer matches). Null if the passage isn't on the page.
 */
export function resolvePassage(strs: readonly string[], passage: string, stored?: ItemRange): ItemRange | null {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
  if (stored && squash(itemRangeText(strs, stored)) === squash(passage)) return stored
  const found = locatePassage(strs.join(' '), passage)
  return found
    ? charRangeToItems(
        strs.map((s) => s.length),
        found.start,
        found.end,
      )
    : null
}
