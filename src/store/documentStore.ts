import { create } from 'zustand'
import type { BackendState } from '../workers/embedding.types'

// Per-document lifecycle. `queued` covers a bulk-upload file waiting its turn in
// the sequential embed queue (the embedding worker processes one document at a time).
export type DocStatus =
  | 'queued'
  | 'extracting-text'
  // Milestone 9 Phase A: Notes-tab-only phases, distinct from 'extracting-text' (which
  // stays exclusive to the Documents tab's local pdf.js extraction). 'ocr-uploading' is
  // the client-side FileReader->base64 encode step; 'ocr-processing' is the /ocr fetch
  // in flight, i.e. Gemini actually transcribing — the genuinely slow one.
  | 'ocr-uploading'
  | 'ocr-processing'
  | 'loading-model'
  | 'embedding'
  | 'ready'
  | 'error'

export interface DocEntry {
  id: string
  fileName: string
  status: DocStatus
  error: string | null
  embedProgress: { done: number; total: number } | null
  chunkCount: number | null
  // Milestone 9: which tab/pipeline this document came from — see db.ts's
  // DocumentRecord.source for the persisted counterpart.
  source: 'document' | 'note'
}

interface DocumentState {
  documents: DocEntry[]
  // The document the query panel runs against in "this document" scope.
  selectedId: string | null
  // Global/session state — the model loads once, and the backend is a property of
  // the environment, not of any single document.
  backend: BackendState | null
  backendDetail: string | null
  modelProgress: number | null
  addDocument: (id: string, fileName: string, source: DocEntry['source']) => void
  updateDocument: (id: string, patch: Partial<Omit<DocEntry, 'id'>>) => void
  removeDocument: (id: string) => void
  restoreDocuments: (entries: DocEntry[]) => void
  selectDocument: (id: string | null) => void
  setBackend: (backend: BackendState, detail: string) => void
  setModelProgress: (percent: number) => void
}

export const useDocumentStore = create<DocumentState>((set) => ({
  documents: [],
  selectedId: null,
  backend: null,
  backendDetail: null,
  modelProgress: null,
  addDocument: (id, fileName, source) =>
    set((s) => ({
      documents: [
        ...s.documents,
        { id, fileName, status: 'queued', error: null, embedProgress: null, chunkCount: null, source },
      ],
    })),
  updateDocument: (id, patch) =>
    set((s) => ({ documents: s.documents.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)) })),
  removeDocument: (id) =>
    set((s) => ({
      documents: s.documents.filter((doc) => doc.id !== id),
      selectedId: s.selectedId === id ? null : s.selectedId,
    })),
  // Merge by id (append only ids not already present) rather than replace, so a restore on
  // mount can't clobber a document a user dropped in the same instant, and it's idempotent
  // under StrictMode's double-invoke. Restored/dropped ids are disjoint UUID spaces anyway.
  restoreDocuments: (entries) =>
    set((s) => {
      const have = new Set(s.documents.map((doc) => doc.id))
      return { documents: [...s.documents, ...entries.filter((entry) => !have.has(entry.id))] }
    }),
  selectDocument: (id) => set({ selectedId: id }),
  setBackend: (backend, backendDetail) => set({ backend, backendDetail }),
  setModelProgress: (percent) => set({ modelProgress: percent }),
}))
