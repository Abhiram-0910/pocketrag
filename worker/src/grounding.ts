export interface GroundingCheck {
  citedPages: number[]
  hasUnknownCitation: boolean
  hasNoCitation: boolean
  groundingWarning: boolean
}

// Answers that legitimately say "not in the passages" have no citation on purpose —
// don't flag those. This is a string-pattern heuristic, not a semantic check.
const DISCLAIMER_PATTERN =
  /not (?:contain|mention|include)|cannot answer|don't know|do not know|no information|insufficient information|not (?:in|found in) the passages/i

/**
 * Citation-level groundedness check: catches a model citing a page that wasn't in
 * the input, or citing nothing at all without admitting the gap. Does NOT catch a
 * model citing a real page but misattributing content to it — that needs a second
 * verification pass (not built; see ARCHITECTURE.md).
 */
export function checkGrounding(answer: string, providedPages: number[]): GroundingCheck {
  const citedPages = [...new Set([...answer.matchAll(/page\s+(\d+)/gi)].map((match) => Number(match[1])))]
  const providedSet = new Set(providedPages)
  const hasUnknownCitation = citedPages.some((page) => !providedSet.has(page))
  const hasNoCitation = citedPages.length === 0 && !DISCLAIMER_PATTERN.test(answer)

  return {
    citedPages,
    hasUnknownCitation,
    hasNoCitation,
    groundingWarning: hasUnknownCitation || hasNoCitation,
  }
}
