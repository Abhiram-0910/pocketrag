import { useSyncExternalStore, type ReactNode } from 'react'
import { CaretDown, CheckCircle, CircleNotch, Receipt, Warning, XCircle, type Icon } from '@phosphor-icons/react'
import { getSessionEgress, subscribeSessionEgress, type EgressPurpose, type EgressRecord } from '../lib/egress'
import type { TurnRecord } from '../lib/historyDb'
import { ALLOWED_DESTINATIONS } from '../lib/allowedDestinations'
import {
  contentsLabels,
  formatBytes,
  formatDuration,
  forwardedHost,
  receiptSummary,
  statusLabel,
} from '../lib/receipts'

// "What left your browser" for one answer (TurnReceipt), and for everything else this
// session (SessionReceipts). Every row carries data-egress-id / data-host /
// data-final-host so the e2e can reconcile them against the network requests it observed.

// Verbatim, once per Receipt panel (not per row): the first part always visible, the
// rest inside the allowed-destinations disclosure it introduces.
export const RECEIPT_LIMITS_TEXT =
  "This lists every request that carried data for this answer. “Then to” is what PocketRAG's server is built to do with it; your browser can't see past that server, so that part is our report, not something your browser observed."
export const RECEIPT_NOT_SHOWN_TEXT =
  "Not listed: the browser's own permission check before each request (it carries none of your data), loading the app itself, links you click, and a fallback download the AI runtime can make from its own CDN path. Your browser's security policy limits this page's own network requests (fetch, XHR) to the destinations below. It does not govern links you click or the browser's own navigation."

const STATUS_STYLE: Record<EgressRecord['outcome'], { icon: Icon; className: string }> = {
  'in-flight': { icon: CircleNotch, className: 'text-slate-600 dark:text-slate-300' },
  ok: { icon: CheckCircle, className: 'text-green-700 dark:text-green-400' },
  'http-error': { icon: XCircle, className: 'text-red-700 dark:text-red-400' },
  'network-error': { icon: XCircle, className: 'text-red-700 dark:text-red-400' },
  aborted: { icon: Warning, className: 'text-amber-700 dark:text-amber-400' },
  interrupted: { icon: Warning, className: 'text-amber-700 dark:text-amber-400' },
}

const PURPOSE_LABEL: Record<EgressPurpose, string> = {
  answer: 'Answer',
  models: 'Model list check',
  ocr: 'Text extraction (OCR upload)',
  'embed-model-download': 'Search model download',
  'rerank-model-download': 'Reranking model download',
  'runtime-download': 'AI runtime download',
}

const LABEL = 'text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400'
// On a phone each label stacks above its value; the gap above the label keeps pairs apart.
const DT = `${LABEL} mt-1.5 first:mt-0 sm:mt-0`
const PERFORATION = 'border-dashed border-slate-300 dark:border-slate-600'

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function Row({ record, heading, model }: { record: EgressRecord; heading: string; model: string | null }) {
  const status = STATUS_STYLE[record.outcome]
  const forwarded = forwardedHost(record)
  return (
    <li
      className={`border-b py-3 last:border-b-0 ${PERFORATION}`}
      data-egress-id={record.id}
      data-host={record.host}
      data-final-host={record.finalHost ?? ''}
      data-purpose={record.purpose}
      data-outcome={record.outcome}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-semibold tabular-nums text-slate-800 dark:text-slate-200">{heading}</span>
        <span className={`inline-flex items-center gap-1 text-xs font-medium tabular-nums ${status.className}`}>
          <status.icon className="size-3.5 shrink-0" weight="bold" aria-hidden="true" />
          {statusLabel(record)} · {formatDuration(record.durationMs)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-0.5 text-xs sm:grid-cols-[5.5rem_minmax(0,1fr)] sm:gap-y-1">
        <dt className={DT}>To</dt>
        <dd className="break-all font-medium text-slate-900 dark:text-slate-100">{record.host}</dd>
        {record.finalHost && record.finalHost !== record.host && (
          <>
            <dt className={DT}>Served by</dt>
            <dd className="break-all text-slate-800 dark:text-slate-200">{record.finalHost}</dd>
          </>
        )}
        {forwarded && (
          <>
            <dt className={DT}>Then to</dt>
            <dd className="break-all text-slate-800 dark:text-slate-200">
              {forwarded}
              {model && <span className="block text-slate-600 dark:text-slate-400">{model}</span>}
            </dd>
          </>
        )}
        <dt className={DT}>Sent</dt>
        <dd className="text-slate-800 dark:text-slate-200">{contentsLabels(record).join(' · ')}</dd>
        {/* A download carries nothing from you ("Sent" says so): no size to show. */}
        {record.via !== 'direct' && (
          <>
            <dt className={DT}>Size</dt>
            <dd className="tabular-nums text-slate-800 dark:text-slate-200">{formatBytes(record.bytesSent)}</dd>
          </>
        )}
      </dl>
    </li>
  )
}

function Limits() {
  return (
    <div className={`mt-3 border-t pt-3 text-xs text-slate-600 dark:text-slate-400 ${PERFORATION}`}>
      <p>{RECEIPT_LIMITS_TEXT}</p>
      <details className="mt-2">
        <summary className="cursor-pointer font-medium text-slate-700 focus-visible:outline-2 focus-visible:outline-blue-600 dark:text-slate-300">
          What this doesn't show · where this page may send data ({ALLOWED_DESTINATIONS.length})
        </summary>
        <p className="mt-2">{RECEIPT_NOT_SHOWN_TEXT}</p>
        <ul className="mt-2 space-y-1.5">
          {ALLOWED_DESTINATIONS.map((d) => (
            <li key={d.source}>
              <code className="break-all text-slate-800 dark:text-slate-200">{d.source}</code>
              <span className="block">{d.label}</span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

function Disclosure({ title, subtitle, summary, children }: { title: string; subtitle: string; summary: string; children: ReactNode }) {
  return (
    <details className={`group mt-3 border-t pt-3 ${PERFORATION}`} data-receipt>
      <summary className="flex cursor-pointer list-none items-start gap-2 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 [&::-webkit-details-marker]:hidden">
        <Receipt className="mt-0.5 size-4 shrink-0 text-slate-600 dark:text-slate-300" weight="bold" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className={`block ${LABEL} text-slate-700 dark:text-slate-300`}>{title}</span>
          <span className="block text-sm text-slate-800 dark:text-slate-200">{subtitle}</span>
          <span className="block text-xs tabular-nums text-slate-600 dark:text-slate-400">{summary}</span>
        </span>
        <CaretDown
          className="mt-1 size-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180 motion-reduce:transition-none"
          weight="bold"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-2">{children}</div>
    </details>
  )
}

/** One answer's receipt: every request made for it (each retry its own row), its total,
 * and what the list can't show. Restored turns show their persisted records. */
export function TurnReceipt({ turn }: { turn: TurnRecord }) {
  const records = turn.egress
  const total = records.reduce((sum, r) => sum + r.bytesSent, 0)
  return (
    <Disclosure title="Receipt" subtitle="What left your browser for this answer" summary={receiptSummary(records)}>
      {records.length === 0 ? (
        <p className="text-xs text-slate-600 dark:text-slate-400">No requests were recorded for this answer.</p>
      ) : (
        <>
          <ol>
            {records.map((r, i) => (
              <Row
                key={r.id}
                record={r}
                heading={`${i + 1} · ${clock(r.startedAt)}${i > 0 ? ' · retry' : ''}`}
                model={r.upstream === turn.provider ? turn.model : null}
              />
            ))}
          </ol>
          <div className="flex items-baseline justify-between border-t-4 border-double border-slate-300 pt-2 text-xs tabular-nums dark:border-slate-600">
            <span className={LABEL}>Total</span>
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {records.length} {records.length === 1 ? 'request' : 'requests'} · {formatBytes(total)}
            </span>
          </div>
        </>
      )}
      <Limits />
    </Disclosure>
  )
}

const countLabel = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Records grouped by destination + purpose, groups in order of first request. */
function groupRecords(records: readonly EgressRecord[]): { key: string; records: EgressRecord[] }[] {
  const groups = new Map<string, EgressRecord[]>()
  for (const r of records) {
    const key = `${r.purpose} ${r.host}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups].map(([key, records]) => ({ key, records }))
}

/** Everything this session that isn't one answer's request: model and runtime downloads,
 * OCR uploads, model-list checks. Memory only. */
export function SessionReceipts() {
  const { records, dropped } = useSyncExternalStore(subscribeSessionEgress, getSessionEgress, getSessionEgress)
  const downloads = records.filter((r) => r.via === 'direct').length
  const ocr = records.filter((r) => r.purpose === 'ocr').length
  const models = records.filter((r) => r.purpose === 'models').length
  const summary =
    records.length === 0
      ? 'Nothing yet'
      : [
          countLabel(downloads, 'one-time download', 'one-time downloads'),
          countLabel(ocr, 'OCR upload', 'OCR uploads'),
          countLabel(models, 'model-list check', 'model-list checks'),
        ].join(' · ')
  return (
    <section aria-label="This session" className="mt-6">
      <Disclosure title="This session" subtitle="Downloads, OCR uploads and model-list checks" summary={summary}>
        {records.length === 0 ? (
          <p className="text-xs text-slate-600 dark:text-slate-400">Nothing has left your browser this session yet.</p>
        ) : (
          <ul>
            {groupRecords(records).map((group) => {
              const failed = group.records.filter((r) => r.outcome !== 'ok' && r.outcome !== 'in-flight').length
              return (
                <li key={group.key} className={`border-b py-2 last:border-b-0 ${PERFORATION}`}>
                  <details className="group/egress" data-egress-group={group.key}>
                    <summary className="flex cursor-pointer list-none items-baseline gap-2 rounded text-xs focus-visible:outline-2 focus-visible:outline-blue-600 [&::-webkit-details-marker]:hidden">
                      <CaretDown
                        className="size-3 shrink-0 self-center text-slate-500 transition-transform group-open/egress:rotate-180 motion-reduce:transition-none"
                        weight="bold"
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 font-semibold text-slate-800 dark:text-slate-200">
                        {PURPOSE_LABEL[group.records[0].purpose]}
                        <span className="font-normal text-slate-600 dark:text-slate-400"> · {group.records[0].host}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-slate-600 dark:text-slate-400">
                        {countLabel(group.records.length, 'request', 'requests')}
                        {failed > 0 && <span className="text-red-700 dark:text-red-400"> · {failed} failed</span>}
                      </span>
                    </summary>
                    <ol className="mt-1 pl-3">
                      {group.records.map((r, i) => (
                        <Row key={r.id} record={r} heading={`${i + 1} · ${clock(r.startedAt)}`} model={null} />
                      ))}
                    </ol>
                  </details>
                </li>
              )
            })}
          </ul>
        )}
        <p className={`mt-3 border-t pt-3 text-xs text-slate-600 dark:text-slate-400 ${PERFORATION}`}>
          Not kept after a reload. {countLabel(dropped, 'older entry', 'older entries')} dropped.
        </p>
      </Disclosure>
    </section>
  )
}
