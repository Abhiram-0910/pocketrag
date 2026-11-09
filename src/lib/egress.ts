import type { Provider } from './models'

// Every network request the app itself makes goes through this file: Worker calls via
// egressFetch, model and ONNX Runtime downloads via downloadFetch (installed as
// transformers.js's env.fetch in the embedding worker). egress.bypass.test.ts fails if any
// other src file calls fetch/XMLHttpRequest/sendBeacon/WebSocket/EventSource directly.
// What this can't see (ORT's fallback XHR/import(), browser-initiated loads, navigations)
// and how the CSP bounds it: ARCHITECTURE.md and SECURITY_REVIEW.md §8.

export type EgressPurpose = 'answer' | 'models' | 'ocr' | 'embed-model-download' | 'rerank-model-download' | 'runtime-download'

export type PayloadCategory =
  | 'question'
  | 'passage-text'
  | 'history'
  | 'document-ids'
  | 'page-image'
  | 'ocr-file'
  | 'api-key'
  // Production only: a body key missing from KEY_CATEGORIES (dev and tests throw instead).
  | 'uncategorized'
  | 'none'

export interface EgressRecord {
  id: string
  purpose: EgressPurpose
  // What the browser connected to.
  host: string
  // The host the response came from after redirects (Hugging Face → its CDN); null until
  // a response arrives, or if none did.
  finalHost: string | null
  via: 'worker' | 'direct'
  // Where the Worker forwards the request; null for a direct download.
  upstream: Provider | null
  method: string
  categories: PayloadCategory[]
  // How many of each, for plain-language receipts ("3 passages"): array length, distinct
  // document ids across chunks and docLabels, 1 for anything else.
  counts: Partial<Record<PayloadCategory, number>>
  // UTF-8 bytes of the request body. Headers aren't counted (BYOK's key is in the body).
  bytesSent: number
  startedAt: number
  durationMs: number | null
  httpStatus: number | null
  outcome: 'in-flight' | 'ok' | 'http-error' | 'network-error' | 'aborted'
}

// Every top-level request-body key any outbound call sends, and what kind of data it
// carries. A key with an empty value (undefined, [], '') carries none of it.
const KEY_CATEGORIES: Record<string, readonly PayloadCategory[]> = {
  question: ['question'],
  chunks: ['passage-text', 'document-ids'],
  docLabels: ['document-ids'],
  history: ['history'],
  image: ['page-image'],
  base64: ['ocr-file'],
  apiKey: ['api-key'],
  // Settings, not user data: tier, provider, model, the web-search and follow-method flags,
  // the OCR file type.
  keySource: [],
  provider: [],
  model: [],
  enableWebSearch: [],
  followMethod: [],
  mimeType: [],
}

const CATEGORY_ORDER: readonly PayloadCategory[] = [
  'question',
  'passage-text',
  'history',
  'document-ids',
  'page-image',
  'ocr-file',
  'api-key',
  'uncategorized',
]

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)
}

function documentIdsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => (typeof item?.documentId === 'string' ? [item.documentId] : []))
}

/**
 * The data categories a JSON request body carries, and how many of each. A key not in
 * KEY_CATEGORIES throws outside production, so a new request field can't ship without a
 * ledger decision; in production the request still goes out and the record says
 * 'uncategorized'.
 */
export function describePayload(
  body: Record<string, unknown>,
  mode: string = import.meta.env.MODE,
): Pick<EgressRecord, 'categories' | 'counts'> {
  const counts: Partial<Record<PayloadCategory, number>> = {}
  const documentIds = new Set<string>()
  for (const [key, value] of Object.entries(body)) {
    // JSON.stringify drops undefined-valued keys, so they're never sent.
    if (value === undefined) continue
    if (!Object.hasOwn(KEY_CATEGORIES, key)) {
      if (mode !== 'production') {
        throw new Error(`Request body key "${key}" has no payload category — add it to KEY_CATEGORIES in src/lib/egress.ts.`)
      }
      counts.uncategorized = (counts.uncategorized ?? 0) + 1
      continue
    }
    if (isEmpty(value)) continue
    for (const category of KEY_CATEGORIES[key]) {
      if (category === 'document-ids') documentIdsIn(value).forEach((id) => documentIds.add(id))
      else counts[category] = (counts[category] ?? 0) + (Array.isArray(value) ? value.length : 1)
    }
  }
  if (documentIds.size > 0) counts['document-ids'] = documentIds.size
  const categories = CATEGORY_ORDER.filter((c) => counts[c] !== undefined)
  return categories.length === 0 ? { categories: ['none'], counts: {} } : { categories, counts }
}

/** Just the categories — see describePayload. */
export function payloadCategories(body: Record<string, unknown>, mode: string = import.meta.env.MODE): PayloadCategory[] {
  return describePayload(body, mode).categories
}

// The session log: everything that isn't one answer's request — model and runtime
// downloads, OCR uploads, model-list checks. Memory only (gone after a reload). Capped so a
// long session can't grow it without bound; the oldest record goes first, and `dropped`
// says how many went.
export const MAX_SESSION_EGRESS = 200

export interface SessionEgress {
  records: readonly EgressRecord[]
  dropped: number
}

// Replaced (never mutated) on every change, so it works as a useSyncExternalStore snapshot.
let session: SessionEgress = { records: [], dropped: 0 }
const listeners = new Set<() => void>()

export function getSessionEgress(): SessionEgress {
  return session
}

export function subscribeSessionEgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Adds a record to the session log, or replaces the earlier copy of the same request
 * (in-flight → settled). An 'answer' record never goes here: answers are recorded on their
 * turn (chatStore.appendEgress, via egressFetch's onRecord), so nothing is listed twice.
 */
export function recordEgress(record: EgressRecord): void {
  if (record.purpose === 'answer') return
  const i = session.records.findIndex((r) => r.id === record.id)
  let records = i === -1 ? [...session.records, record] : session.records.map((r, j) => (j === i ? record : r))
  let dropped = session.dropped
  if (records.length > MAX_SESSION_EGRESS) {
    dropped += records.length - MAX_SESSION_EGRESS
    records = records.slice(-MAX_SESSION_EGRESS)
  }
  session = { records, dropped }
  for (const listener of listeners) listener()
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError'
}

/** Emits the record before the request goes out, then again once it settles. */
async function send(url: string, init: RequestInit, record: EgressRecord, emit: (r: EgressRecord) => void): Promise<Response> {
  emit(record)
  const started = performance.now()
  const durationMs = () => Math.round(performance.now() - started)
  try {
    const res = await fetch(url, init)
    emit({
      ...record,
      // res.url is empty for a constructed Response (tests); the request URL is then the best known.
      finalHost: res.url ? new URL(res.url).host : record.host,
      durationMs: durationMs(),
      httpStatus: res.status,
      outcome: res.ok ? 'ok' : 'http-error',
    })
    return res
  } catch (err) {
    emit({ ...record, durationMs: durationMs(), outcome: isAbortError(err) ? 'aborted' : 'network-error' })
    throw err
  }
}

function newRecord(
  url: string,
  purpose: EgressPurpose,
  via: EgressRecord['via'],
  upstream: Provider | null,
  method: string,
  payload: Pick<EgressRecord, 'categories' | 'counts'>,
  bytesSent: number,
): EgressRecord {
  return {
    id: crypto.randomUUID(),
    purpose,
    host: new URL(url).host,
    finalHost: null,
    via,
    upstream,
    method,
    ...payload,
    bytesSent,
    startedAt: Date.now(),
    durationMs: null,
    httpStatus: null,
    outcome: 'in-flight',
  }
}

/** A JSON POST to our Worker. Each record goes to `onRecord` — a turn's appendEgress for
 * an answer — or by default to the session log. */
export function egressFetch(
  url: string,
  init: { json: Record<string, unknown>; signal?: AbortSignal },
  meta: { purpose: 'answer' | 'models' | 'ocr'; upstream: Provider },
  onRecord: (record: EgressRecord) => void = recordEgress,
): Promise<Response> {
  const body = JSON.stringify(init.json)
  const record = newRecord(
    url,
    meta.purpose,
    'worker',
    meta.upstream,
    'POST',
    describePayload(init.json),
    new TextEncoder().encode(body).byteLength,
  )
  return send(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: init.signal }, record, onRecord)
}

/**
 * transformers.js's `env.fetch` for the embedding worker: every model file and ONNX
 * Runtime .wasm/.mjs it downloads (on the normal path — see the file comment above).
 * `emit` posts each record to the main thread. Cache hits never reach env.fetch.
 */
export function downloadFetch(rerankModelId: string, emit: (record: EgressRecord) => void) {
  return (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const purpose: EgressPurpose =
      new URL(url).host === 'cdn.jsdelivr.net'
        ? 'runtime-download'
        : url.includes(rerankModelId)
          ? 'rerank-model-download'
          : 'embed-model-download'
    const record = newRecord(url, purpose, 'direct', null, init?.method ?? 'GET', { categories: ['none'], counts: {} }, 0)
    return send(url, init ?? {}, record, emit)
  }
}
