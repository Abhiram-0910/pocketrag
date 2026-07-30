export interface CitedPair {
  label: number
  page: number
}

export interface GroundingCheck {
  citedPairs: CitedPair[]
  hasUnknownCitation: boolean
  hasNoCitation: boolean
  groundingWarning: boolean
}

// Answers that legitimately say "not in the passages" have no citation on purpose —
// don't flag those. This is a string-pattern heuristic, not a semantic check.
const DISCLAIMER_PATTERN =
  /not (?:contain|mention|include)|cannot answer|don't know|do not know|no information|insufficient information|not (?:in|found in) the passages/i

// A citation is "(Doc N, page M)"; tolerate a comma and/or spaces between the two parts.
const CITATION_PATTERN = /Doc\s+(\d+)[\s,]*page\s+(\d+)/gi

/**
 * Citation-level groundedness check over (Doc N, page M) pairs. Catches a model citing
 * a (document, page) pair that wasn't in the input — which now includes citing a valid
 * document but the wrong page, or a document that wasn't provided at all — or citing
 * nothing without admitting the gap. Does NOT catch a model citing a real (doc, page)
 * but misattributing content to it — that needs a second verification pass (not built;
 * see ARCHITECTURE.md).
 *
 * `providedPairs` are the (label, page) pairs the prompt actually contained. Bare
 * "page M" mentions with no Doc label are intentionally not treated as citations for
 * the unknown-citation check, but they do count as "some citation exists" so a
 * well-cited answer isn't falsely flagged as uncited.
 */
export function checkGrounding(answer: string, providedPairs: CitedPair[]): GroundingCheck {
  const providedSet = new Set(providedPairs.map((pair) => `${pair.label}:${pair.page}`))

  const seen = new Set<string>()
  const citedPairs: CitedPair[] = []
  for (const match of answer.matchAll(CITATION_PATTERN)) {
    const pair = { label: Number(match[1]), page: Number(match[2]) }
    const key = `${pair.label}:${pair.page}`
    if (!seen.has(key)) {
      seen.add(key)
      citedPairs.push(pair)
    }
  }

  const hasUnknownCitation = citedPairs.some((pair) => !providedSet.has(`${pair.label}:${pair.page}`))
  const hasNoCitation = !/page\s+\d+/i.test(answer) && !DISCLAIMER_PATTERN.test(answer)

  return {
    citedPairs,
    hasUnknownCitation,
    hasNoCitation,
    groundingWarning: hasUnknownCitation || hasNoCitation,
  }
}
