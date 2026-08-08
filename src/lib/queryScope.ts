import type { DocEntry } from '../store/documentStore'

/** Whether a query can run for the given scope — "all documents" needs any ready doc, "this document" needs the selection itself to be ready. */
export function canRunQuery(
  documents: DocEntry[],
  selectedId: string | null,
  scope: 'document' | 'all',
): boolean {
  if (scope === 'all') return documents.some((doc) => doc.status === 'ready')
  return documents.some((doc) => doc.id === selectedId && doc.status === 'ready')
}
