import type { DocLabel, InputChunk } from './validate'

/**
 * Assign 1-based "Doc N" labels per distinct documentId, in first-appearance order
 * over the (already rank-ordered) chunks. The Worker owns this mapping — it builds
 * the prompt and grounds against it. `existing` is the label map carried over from
 * prior turns in the same conversation (Milestone 11 Phase C): entries already in it
 * are never reassigned or reordered, only appended to for documents seen for the
 * first time this call — this is what keeps "Doc N" frozen across a conversation
 * instead of being recomputed fresh per request (see ARCHITECTURE.md).
 */
export function assignDocLabels(
  chunks: Pick<InputChunk, 'documentId'>[],
  existing: DocLabel[] = [],
): DocLabel[] {
  const labels: DocLabel[] = [...existing]
  const seen = new Set(existing.map((d) => d.documentId))
  let nextLabel = existing.reduce((max, d) => Math.max(max, d.label), 0) + 1
  for (const { documentId } of chunks) {
    if (!seen.has(documentId)) {
      seen.add(documentId)
      labels.push({ label: nextLabel++, documentId })
    }
  }
  return labels
}
