import { create } from 'zustand'
import type { BackendState, EmbeddedChunk } from '../workers/embedding.types'

export type Status = 'idle' | 'extracting-text' | 'loading-model' | 'embedding' | 'ready' | 'error'

interface DocumentState {
  documentId: string | null
  fileName: string | null
  chunks: EmbeddedChunk[]
  status: Status
  error: string | null
  backend: BackendState | null
  backendDetail: string | null
  modelProgress: number | null
  embedProgress: { done: number; total: number } | null
  setExtracting: () => void
  setLoadingModel: () => void
  setModelProgress: (percent: number) => void
  setBackend: (backend: BackendState, detail: string) => void
  setEmbedProgress: (done: number, total: number) => void
  setResult: (documentId: string, fileName: string, chunks: EmbeddedChunk[]) => void
  setError: (message: string) => void
}

export const useDocumentStore = create<DocumentState>((set) => ({
  documentId: null,
  fileName: null,
  chunks: [],
  status: 'idle',
  error: null,
  backend: null,
  backendDetail: null,
  modelProgress: null,
  embedProgress: null,
  setExtracting: () => set({ status: 'extracting-text', error: null, backend: null, backendDetail: null }),
  setLoadingModel: () => set({ status: 'loading-model', modelProgress: null }),
  setModelProgress: (percent) => set({ modelProgress: percent }),
  setBackend: (backend, backendDetail) => set({ backend, backendDetail }),
  setEmbedProgress: (done, total) => set({ status: 'embedding', embedProgress: { done, total } }),
  setResult: (documentId, fileName, chunks) => set({ documentId, fileName, chunks, status: 'ready' }),
  setError: (message) => set({ status: 'error', error: message }),
}))
