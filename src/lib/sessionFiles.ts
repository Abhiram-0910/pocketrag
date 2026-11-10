// Milestone 10 Phase B: keeps the raw File for a document uploaded *this tab session*
// only, so a page can be re-rendered on demand (diagram-aware Q&A, and v1.4's figure
// crop and click-to-verify). Deliberately never persisted to IndexedDB — this project
// stores only small derived data (text + embeddings), never source bytes; see the
// Milestone 10 plan for the full reasoning. A document restored via db.ts's
// restore-on-reload flow was never uploaded this session, so it has no entry here until
// the user chooses the file again (v1.4) — callers must treat a missing entry as
// "the page can't be shown right now," not an error.
const sessionFiles = new Map<string, File>()
// v1.4: a version number that changes on every add/remove, so React can re-read.
let version = 0
const listeners = new Set<() => void>()
const changed = () => {
  version++
  for (const listener of listeners) listener()
}

export function rememberSessionFile(documentId: string, file: File): void {
  sessionFiles.set(documentId, file)
  changed()
}

export function getSessionFile(documentId: string): File | undefined {
  return sessionFiles.get(documentId)
}

export function forgetSessionFile(documentId: string): void {
  if (sessionFiles.delete(documentId)) changed()
}

/** For useSyncExternalStore: re-render when a file is added or removed. */
export function subscribeSessionFiles(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function sessionFilesVersion(): number {
  return version
}
