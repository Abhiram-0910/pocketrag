export interface DiagramLikelyInput {
  text: string
  hasImage: boolean
}

// Word-boundary, case-insensitive. "fig." is split into its own alternative without a
// trailing \b: a literal "." is itself a non-word character, so \b never matches
// between it and the whitespace/text that follows — a trailing \b there would silently
// fail to match "Fig. 2", "Fig. 3", etc.
const DIAGRAM_KEYWORDS = /\bfig\.|\b(figures?|diagrams?|charts?|graphs?|tables?|illustrations?)\b/i

/**
 * Milestone 10's diagram-likely heuristic: a chunk is flagged if its page paints a
 * raster image (structural signal, from pdf.ts's getOperatorList check) OR its text
 * mentions a figure/diagram/chart/etc. (lexical signal, catches vector-drawn diagrams
 * the structural signal misses). Both directions can be wrong — a decorative image or
 * an incidental "see the chart below" false-positives; an uncaptioned vector diagram
 * with no nearby image XObject false-negatives. This is an honest heuristic, not a
 * classifier — callers should present it as a hint, not a certainty.
 */
export function isDiagramLikely({ text, hasImage }: DiagramLikelyInput): boolean {
  return hasImage || DIAGRAM_KEYWORDS.test(text)
}
