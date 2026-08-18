import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker

// Bounds both the provider-side image-token cost and the request payload size.
// Empirically derived (Milestone 10 Phase B planning): a real pdf.js render → canvas →
// JPEG pipeline at this resolution/quality, across a representative chart-like page and
// a rougher photo-like page, produced 88KB-101KB. worker/src/validate.ts's
// MAX_IMAGE_BASE64_LENGTH is sized against that same measurement — changing either
// constant without re-measuring would silently invalidate the other's derivation.
const LONG_EDGE_PX = 1024
const JPEG_QUALITY = 0.8

export interface RenderedPage {
  base64: string
  mimeType: 'image/jpeg'
}

/**
 * Renders one page of an in-memory PDF File to a bounded-resolution JPEG, on demand.
 * Never persisted, never cached — re-opens the PDF and re-renders on every call. This
 * is the only place a page's raster content is ever produced; see sessionFiles.ts for
 * where the File itself comes from (session-only, never IndexedDB).
 */
export async function renderPageToImage(file: File, pageNumber: number): Promise<RenderedPage> {
  const buffer = await file.arrayBuffer()
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise
  const page = await pdf.getPage(pageNumber)

  const baseViewport = page.getViewport({ scale: 1 })
  const longEdge = Math.max(baseViewport.width, baseViewport.height)
  const viewport = page.getViewport({ scale: LONG_EDGE_PX / longEdge })

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  await page.render({ canvas, viewport }).promise

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
  if (!blob) throw new Error('Failed to encode the rendered page as JPEG.')

  return { base64: await blobToBase64(blob), mimeType: 'image/jpeg' }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => {
      const result = reader.result as string
      // Strip the "data:image/jpeg;base64," prefix — callers/Worker only want the raw payload.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the rendered page.'))
    reader.readAsDataURL(blob)
  })
}
