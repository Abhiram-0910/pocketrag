export interface CitedPair {
  label: number
  page: number
}

export interface GroundingCheck {
  citedPairs: CitedPair[]
  // Milestone 12 Phase A: (Web N) citations, tracked separately from (Doc N, page M)
  // pairs — a web result has no page, so it can't share CitedPair's shape.
  citedWebLabels: number[]
  hasUnknownCitation: boolean
  hasUnknownWebCitation: boolean
  hasNoCitation: boolean
  groundingWarning: boolean
}

// Answers that legitimately say "not in the passages" have no citation on purpose —
// don't flag those. This is a string-pattern heuristic, not a semantic check.
const DISCLAIMER_PATTERN =
  /not (?:contain|mention|include)|cannot answer|don't know|do not know|no information|insufficient information|not (?:in|found in) the passages/i

// A citation is "(Doc N, page M)"; tolerate a comma and/or spaces between the two parts.
const CITATION_PATTERN = /Doc\s+(\d+)[\s,]*page\s+(\d+)/gi
// A web citation is "(Web N)" — no page, since a web result isn't paginated.
const WEB_CITATION_PATTERN = /Web\s+(\d+)/gi

/**
 * Citation-level groundedness check over (Doc N, page M) pairs, plus (Web N) web
 * citations (Milestone 12 Phase A). Catches a model citing a (document, page) pair
 * that wasn't in the input — which now includes citing a valid document but the wrong
 * page, or a document that wasn't provided at all — a web result label that wasn't
 * provided, or citing nothing at all without an explicit "not in the passages"
 * disclaimer. A bare "page M" or "Web N" mention with no surrounding label isn't
 * treated as a citation for the respective unknown-citation check, but either one
 * still counts as "some citation exists" so a well-cited answer isn't falsely flagged.
 * Does not catch a real (doc, page) or (Web N) being cited with content that isn't
 * actually there — that needs a second verification LLM call or human review,
 * deliberately not built (would double provider usage against the quota this rate
 * limiter exists to protect). Documented as a known limitation, not silently absent.
 *
 * `providedPairs` are the (label, page) pairs the prompt's Passages section actually
 * contained. `providedWebLabels` are the Web N numbers the prompt's Web results
 * section actually contained (defaults to none, so existing two-arg callers are
 * unaffected).
 */
export function checkGrounding(
  answer: string,
  providedPairs: CitedPair[],
  providedWebLabels: number[] = [],
): GroundingCheck {
  const providedSet = new Set(providedPairs.map((pair) => `${pair.label}:${pair.page}`))
  const providedWebSet = new Set(providedWebLabels)

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

  const seenWeb = new Set<number>()
  const citedWebLabels: number[] = []
  for (const match of answer.matchAll(WEB_CITATION_PATTERN)) {
    const label = Number(match[1])
    if (!seenWeb.has(label)) {
      seenWeb.add(label)
      citedWebLabels.push(label)
    }
  }

  const hasUnknownCitation = citedPairs.some((pair) => !providedSet.has(`${pair.label}:${pair.page}`))
  const hasUnknownWebCitation = citedWebLabels.some((label) => !providedWebSet.has(label))
  const hasNoCitation = !/page\s+\d+/i.test(answer) && !/Web\s+\d+/i.test(answer) && !DISCLAIMER_PATTERN.test(answer)

  return {
    citedPairs,
    citedWebLabels,
    hasUnknownCitation,
    hasUnknownWebCitation,
    hasNoCitation,
    groundingWarning: hasUnknownCitation || hasUnknownWebCitation || hasNoCitation,
  }
}
