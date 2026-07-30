import type { InputChunk } from './validate'

export interface DocLabel {
  label: number
  documentId: string
}

/**
 * Assign 1-based "Doc N" labels per distinct documentId, in first-appearance order
 * over the (already rank-ordered) chunks. The Worker owns this mapping — it builds
 * the prompt and grounds against it. Labels are per-request and NOT stable across
 * queries: the same document can be Doc 1 for one question and Doc 2 for another
 * (see ARCHITECTURE.md).
 */
export function assignDocLabels(chunks: Pick<InputChunk, 'documentId'>[]): DocLabel[] {
  const labels: DocLabel[] = []
  const seen = new Set<string>()
  for (const { documentId } of chunks) {
    if (!seen.has(documentId)) {
      seen.add(documentId)
      labels.push({ label: labels.length + 1, documentId })
    }
  }
  return labels
}
