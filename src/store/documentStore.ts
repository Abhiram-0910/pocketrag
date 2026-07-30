import { create } from 'zustand'
import type { BackendState } from '../workers/embedding.types'

// Per-document lifecycle. `queued` covers a bulk-upload file waiting its turn in
// the sequential embed queue (the embedding worker processes one document at a time).
export type DocStatus =
  | 'queued'
  | 'extracting-text'
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
}

interface DocumentState {
  documents: DocEntry[]
  // Global/session state — the model loads once, and the backend is a property of
  // the environment, not of any single document.
  backend: BackendState | null
  backendDetail: string | null
  modelProgress: number | null
  addDocument: (id: string, fileName: string) => void
  updateDocument: (id: string, patch: Partial<Omit<DocEntry, 'id'>>) => void
  setBackend: (backend: BackendState, detail: string) => void
  setModelProgress: (percent: number) => void
}

export const useDocumentStore = create<DocumentState>((set) => ({
  documents: [],
  backend: null,
  backendDetail: null,
  modelProgress: null,
  addDocument: (id, fileName) =>
    set((s) => ({
      documents: [
        ...s.documents,
        { id, fileName, status: 'queued', error: null, embedProgress: null, chunkCount: null },
      ],
    })),
  updateDocument: (id, patch) =>
    set((s) => ({ documents: s.documents.map((doc) => (doc.id === id ? { ...doc, ...patch } : doc)) })),
  setBackend: (backend, backendDetail) => set({ backend, backendDetail }),
  setModelProgress: (percent) => set({ modelProgress: percent }),
}))
