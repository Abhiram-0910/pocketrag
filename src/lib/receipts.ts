import type { EgressRecord, PayloadCategory } from './egress'
import { PROVIDER_HOSTS } from './models'

// Plain-language text for the Receipts view: what a request carried, its status, size and
// time, and a one-line total per answer. Pure — the component only lays these out.

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

const CONTENT_LABELS: Record<PayloadCategory, (n: number) => string> = {
  question: () => 'your question',
  'passage-text': (n) => `${plural(n, 'passage', 'passages')} from your documents`,
  history: (n) => plural(n, 'earlier question and answer', 'earlier questions and answers'),
  'document-ids': (n) => `${plural(n, 'document ID', 'document IDs')} (random, not file names)`,
  'page-image': (n) => plural(n, 'page image', 'page images'),
  'ocr-file': () => 'your whole file (for text extraction)',
  'api-key': () => 'your API key',
  uncategorized: () => 'other data (not labelled)',
  none: () => 'nothing from you (a download)',
}

/** What a request carried, one phrase per category, in the record's category order. */
export function contentsLabels(record: Pick<EgressRecord, 'categories' | 'counts'>): string[] {
  return record.categories.map((c) => CONTENT_LABELS[c](record.counts[c] ?? 1))
}

/** Where the Worker forwards the request, or null for a direct download. */
export function forwardedHost(record: Pick<EgressRecord, 'upstream'>): string | null {
  return record.upstream === null ? null : PROVIDER_HOSTS[record.upstream]
}

export function statusLabel(record: Pick<EgressRecord, 'outcome' | 'httpStatus'>): string {
  switch (record.outcome) {
    case 'in-flight':
      // A streamed answer that has started arriving.
      return record.httpStatus === null ? 'Sending…' : 'Receiving…'
    case 'ok':
      return 'OK'
    case 'http-error':
      return `Failed (${record.httpStatus})`
    case 'network-error':
      return 'No response (network)'
    case 'aborted':
      return 'Stopped (timed out or cancelled)'
    case 'interrupted':
      return 'Interrupted (partial answer)'
  }
}

const KB = new Intl.NumberFormat('en', { style: 'unit', unit: 'kilobyte', unitDisplay: 'short', maximumFractionDigits: 1 })
const MB = new Intl.NumberFormat('en', { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 1 })

/** Decimal units, like browser devtools: 999 B, 1 kB, 14.2 kB, 1.5 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  return bytes < 1_000_000 ? KB.format(bytes / 1000) : MB.format(bytes / 1_000_000)
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`
}

/** Every host the requests reached: where the browser connected, where a redirect landed,
 * and where the Worker forwarded them. */
export function destinations(records: readonly EgressRecord[]): string[] {
  const hosts = new Set<string>()
  for (const r of records) {
    hosts.add(r.host)
    if (r.finalHost) hosts.add(r.finalHost)
    const forwarded = forwardedHost(r)
    if (forwarded) hosts.add(forwarded)
  }
  return [...hosts]
}

/** The one-line total, e.g. "2 requests · 2 destinations · 6.2 kB sent". */
export function receiptSummary(records: readonly EgressRecord[]): string {
  const bytes = records.reduce((sum, r) => sum + r.bytesSent, 0)
  return [
    plural(records.length, 'request', 'requests'),
    plural(destinations(records).length, 'destination', 'destinations'),
    `${formatBytes(bytes)} sent`,
  ].join(' · ')
}
