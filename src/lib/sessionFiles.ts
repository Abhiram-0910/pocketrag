// Milestone 10 Phase B: keeps the raw File for a document uploaded *this tab session*
// only, so a page can be re-rendered on demand for diagram-aware Q&A. Deliberately
// never persisted to IndexedDB — this project stores only small derived data (text +
// embeddings), never source bytes; see the Milestone 10 plan for the full reasoning.
// A document restored via db.ts's restore-on-reload flow was never uploaded this
// session, so it simply has no entry here — callers must treat a missing entry as
// "diagram-aware answering unavailable for this document right now," not an error.
const sessionFiles = new Map<string, File>()

export function rememberSessionFile(documentId: string, file: File): void {
  sessionFiles.set(documentId, file)
}

export function getSessionFile(documentId: string): File | undefined {
  return sessionFiles.get(documentId)
}

export function forgetSessionFile(documentId: string): void {
  sessionFiles.delete(documentId)
}
