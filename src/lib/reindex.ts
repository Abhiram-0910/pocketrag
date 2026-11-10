import { getChunksForDocument, saveDocument, type DocumentRecord } from './db'
import { embedTexts } from './embeddingClient'
import { classifyEmbeddingError } from './errorTaxonomy'
import { EMBEDDING_MODEL_KEY } from './searchModels'
import { useDocumentStore } from '../store/documentStore'

/** Whether a stored document's vectors came from the current embedding model. */
export function isCurrentModel(doc: DocumentRecord): boolean {
  return doc.embeddingModel === EMBEDDING_MODEL_KEY
}

/**
 * Re-embeds a stored document's passages with the current model, from the text already in
 * IndexedDB (the PDF isn't kept), and saves vectors and model stamp in one transaction. The
 * row shows "Updating search index" (status 'reindexing') and isn't searchable until it's
 * 'ready' again. Resolves (never rejects) when done or failed, so a queue can await it. A
 * failed model download leaves a Try again on the row, like a new upload.
 */
export function reindexDocument(doc: DocumentRecord): Promise<void> {
  const { updateDocument, setModelProgress, setBackend } = useDocumentStore.getState()
  return new Promise<void>((resolve) => {
    getChunksForDocument(doc.id)
      .then((chunks) => {
        const run = () =>
          embedTexts(
            chunks.map((chunk) => chunk.text),
            {
              onModelProgress: (msg) => setModelProgress(msg.percent, msg.loaded, msg.total),
              onBackend: (msg) => setBackend(msg.backend, msg.detail),
              onModelReady: () => {},
              onEmbedProgress: (msg) => updateDocument(doc.id, { embedProgress: { done: msg.done, total: msg.total } }),
              onResult: ({ embeddings }) => {
                // Deleted while it was re-embedding (its row is gone): don't write it back.
                if (!useDocumentStore.getState().documents.some((d) => d.id === doc.id)) return resolve()
                saveDocument(
                  { ...doc, embeddingModel: EMBEDDING_MODEL_KEY },
                  chunks.map((chunk, i) => ({ ...chunk, embedding: embeddings[i] })),
                )
                  .then(() => updateDocument(doc.id, { status: 'ready', embedProgress: null }))
                  .catch((err: unknown) =>
                    updateDocument(doc.id, {
                      status: 'error',
                      error: err instanceof Error ? err.message : "Couldn't update the search index.",
                    }),
                  )
                  .finally(resolve)
              },
              onError: (msg) => {
                const { type, message } = classifyEmbeddingError(msg)
                const retry =
                  type === 'model-download'
                    ? () => {
                        updateDocument(doc.id, { status: 'reindexing', error: null, retry: null, embedProgress: null })
                        run()
                      }
                    : null
                updateDocument(doc.id, { status: 'error', error: message, retry, embedProgress: null })
                resolve()
              },
            },
          )
        run()
      })
      .catch((err: unknown) => {
        updateDocument(doc.id, { status: 'error', error: err instanceof Error ? err.message : "Couldn't update the search index." })
        resolve()
      })
  })
}

/** Re-embeds each outdated document in turn (the embedding worker runs one request at a time). */
export async function reindexOutdated(docs: DocumentRecord[]): Promise<void> {
  for (const doc of docs.filter((d) => !isCurrentModel(d))) await reindexDocument(doc)
}
