import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EgressRecord } from '../lib/egress'
import { makeTurn } from '../lib/historyFixtures'

const record = (overrides: Partial<EgressRecord> = {}): EgressRecord => ({
  id: 'r1',
  purpose: 'answer',
  host: 'pocketrag-answer.abhiram-dev.workers.dev',
  finalHost: 'pocketrag-answer.abhiram-dev.workers.dev',
  via: 'worker',
  upstream: 'gemini',
  method: 'POST',
  categories: ['question', 'passage-text', 'document-ids'],
  counts: { question: 1, 'passage-text': 3, 'document-ids': 2 },
  bytesSent: 3100,
  startedAt: Date.UTC(2026, 9, 19, 14, 2, 11),
  durationMs: 820,
  httpStatus: 502,
  outcome: 'http-error',
  ...overrides,
})

// Receipts.tsx reads egress.ts's module-level session log, so each test gets fresh modules.
let receipts: typeof import('./Receipts')
let egress: typeof import('../lib/egress')
beforeEach(async () => {
  vi.resetModules()
  egress = await import('../lib/egress')
  receipts = await import('./Receipts')
})

const count = (html: string, needle: string) => html.split(needle).length - 1

describe('TurnReceipt', () => {
  const failedThenRetried = makeTurn({
    model: 'gemini-3.5-flash-lite',
    egress: [record(), record({ id: 'r2', durationMs: 1400, httpStatus: 200, outcome: 'ok' })],
  })

  it('is a native disclosure titled for a non-technical reader, with the one-line total in the summary', () => {
    const html = renderToStaticMarkup(createElement(receipts.TurnReceipt, { turn: failedThenRetried }))
    expect(html.startsWith('<details')).toBe(true)
    const summary = html.slice(html.indexOf('<summary'), html.indexOf('</summary>'))
    expect(summary).toContain('Receipt')
    expect(summary).toContain('What left your browser for this answer')
    expect(summary).toContain('2 requests · 2 destinations · 6.2 kB sent')
  })

  it('lists each attempt as its own row, retries labelled, with data attributes for reconciliation', () => {
    const html = renderToStaticMarkup(createElement(receipts.TurnReceipt, { turn: failedThenRetried }))
    expect(html).toMatch(/<ol>(<li[^>]*>.*?<dl[^>]*>.*?<\/dl><\/li>){2}<\/ol>/)
    expect(count(html, 'data-egress-id=')).toBe(2)
    expect(html).toContain('data-egress-id="r1" data-host="pocketrag-answer.abhiram-dev.workers.dev" data-final-host="pocketrag-answer.abhiram-dev.workers.dev"')
    expect(html).toContain('Failed (502) · 820 ms')
    expect(html).toContain('OK · 1.4 s')
    expect(count(html, ' · retry')).toBe(1)
    expect(html).toContain('generativelanguage.googleapis.com')
    expect(html).toContain('gemini-3.5-flash-lite')
    expect(html).toContain('your question · 3 passages from your documents · 2 document IDs (random, not file names)')
    expect(html).toContain('2 requests · 6.2 kB')
  })

  it('states the limits once per panel, verbatim: the first part visible, the rest with the allowed destinations', () => {
    expect(receipts.RECEIPT_LIMITS_TEXT).toBe(
      "This lists every request that carried data for this answer. “Then to” is what PocketRAG's server is built to do with it; your browser can't see past that server, so that part is our report, not something your browser observed.",
    )
    expect(receipts.RECEIPT_NOT_SHOWN_TEXT).toBe(
      "Not listed: the browser's own permission check before each request (it carries none of your data), loading the app itself, links you click, and a fallback download the AI runtime can make from its own CDN path. Your browser's security policy limits this page's own network requests (fetch, XHR) to the destinations below. It does not govern links you click or the browser's own navigation.",
    )
    const html = renderToStaticMarkup(createElement(receipts.TurnReceipt, { turn: failedThenRetried }))
    const visible = 'This lists every request that carried data for this answer.'
    const notShown = 'a fallback download the AI runtime can make from its own CDN path'
    expect(count(html, visible)).toBe(1)
    expect(count(html, notShown)).toBe(1)
    // The remainder sits inside the nested disclosure, after its summary; the first part
    // sits outside it.
    const nested = html.slice(html.lastIndexOf('<details'))
    expect(nested).not.toContain(visible)
    expect(nested.slice(nested.indexOf('</summary>'))).toContain(notShown)
    expect(nested).toContain('What this doesn&#x27;t show · where this page may send data (5)')
    expect(nested).toContain('https://*.hf.co')
  })

  it("doesn't name a model on a row whose upstream isn't the turn's provider, and handles no records", () => {
    const switched = makeTurn({ provider: 'openai', model: 'gpt-x', egress: [record()] })
    expect(renderToStaticMarkup(createElement(receipts.TurnReceipt, { turn: switched }))).not.toContain('gpt-x')
    const empty = renderToStaticMarkup(createElement(receipts.TurnReceipt, { turn: makeTurn({ egress: [] }) }))
    expect(empty).toContain('No requests were recorded for this answer.')
    expect(empty).toContain('0 requests · 0 destinations · 0 B sent')
  })
})

describe('SessionReceipts', () => {
  it('summarises downloads, OCR uploads and model-list checks, with redirect hosts and the dropped count', () => {
    egress.recordEgress(
      record({ id: 'd1', purpose: 'embed-model-download', via: 'direct', upstream: null, host: 'huggingface.co', finalHost: 'us.aws.cdn.hf.co', categories: ['none'], counts: {}, bytesSent: 0, outcome: 'ok', httpStatus: 200 }),
    )
    egress.recordEgress(record({ id: 'o1', purpose: 'ocr', categories: ['ocr-file'], counts: { 'ocr-file': 1 }, outcome: 'ok', httpStatus: 200 }))
    egress.recordEgress(record({ id: 'm1', purpose: 'models', upstream: 'openai', categories: ['api-key'], counts: { 'api-key': 1 }, outcome: 'ok', httpStatus: 200 }))
    for (let i = 0; i < egress.MAX_SESSION_EGRESS; i++) {
      egress.recordEgress(record({ id: `x${i}`, purpose: 'runtime-download', via: 'direct', upstream: null, host: 'cdn.jsdelivr.net', categories: ['none'], counts: {} }))
    }

    const html = renderToStaticMarkup(createElement(receipts.SessionReceipts))
    expect(html).toContain('This session')
    expect(html).toContain(`${egress.MAX_SESSION_EGRESS} one-time downloads · 0 OCR uploads · 0 model-list checks`)
    expect(html).toContain('3 older entries dropped.')
    expect(count(html, 'data-egress-id=')).toBe(egress.MAX_SESSION_EGRESS)
  })

  it('shows the download redirect and the plain-language purpose', () => {
    egress.recordEgress(
      record({ id: 'd1', purpose: 'embed-model-download', via: 'direct', upstream: null, host: 'huggingface.co', finalHost: 'us.aws.cdn.hf.co', categories: ['none'], counts: {}, bytesSent: 0, outcome: 'ok', httpStatus: 200 }),
    )
    egress.recordEgress(record({ id: 'o1', purpose: 'ocr', categories: ['ocr-file'], counts: { 'ocr-file': 1 }, outcome: 'ok', httpStatus: 200 }))
    const html = renderToStaticMarkup(createElement(receipts.SessionReceipts))
    expect(html).toContain('1 one-time download · 1 OCR upload · 0 model-list checks')
    expect(html).toContain('data-host="huggingface.co" data-final-host="us.aws.cdn.hf.co"')
    expect(html).toContain('Search model download')
    expect(html).toContain('Served by')
    expect(html).toContain('nothing from you (a download)')
    expect(html).toContain('your whole file (for text extraction)')
    expect(html).toContain('0 older entries dropped.')
  })

  it('groups rows by destination + purpose with a count, one row per record, no size on downloads', () => {
    const download = (id: string, purpose: EgressRecord['purpose'], host = 'huggingface.co') =>
      record({ id, purpose, via: 'direct', upstream: null, host, finalHost: host, categories: ['none'], counts: {}, bytesSent: 0, outcome: 'ok', httpStatus: 200 })
    for (const id of ['e1', 'e2', 'e3']) egress.recordEgress(download(id, 'embed-model-download'))
    egress.recordEgress(download('j1', 'runtime-download', 'cdn.jsdelivr.net'))
    for (const id of ['k1', 'k2']) egress.recordEgress(download(id, 'rerank-model-download'))
    egress.recordEgress(record({ id: 'o1', purpose: 'ocr', categories: ['ocr-file'], counts: { 'ocr-file': 1 }, bytesSent: 2048, outcome: 'http-error', httpStatus: 500 }))

    const html = renderToStaticMarkup(createElement(receipts.SessionReceipts))
    const groups = [...html.matchAll(/data-egress-group="([^"]+)"/g)].map((m) => m[1])
    expect(groups).toEqual([
      'embed-model-download huggingface.co',
      'runtime-download cdn.jsdelivr.net',
      'rerank-model-download huggingface.co',
      'ocr pocketrag-answer.abhiram-dev.workers.dev',
    ])
    const group = (key: string) => html.slice(html.indexOf(`data-egress-group="${key}"`)).split('</details>')[0]
    expect(group('embed-model-download huggingface.co')).toContain('Search model download')
    expect(group('embed-model-download huggingface.co')).toContain('3 requests')
    expect(count(group('embed-model-download huggingface.co'), 'data-egress-id=')).toBe(3)
    expect(group('rerank-model-download huggingface.co')).toContain('Reranking model download')
    expect(count(group('rerank-model-download huggingface.co'), 'data-purpose="rerank-model-download"')).toBe(2)
    expect(count(html, 'data-egress-id=')).toBe(7)
    expect(html).toContain('data-egress-id="e1" data-host="huggingface.co" data-final-host="huggingface.co"')
    // Size only on the OCR upload, which carries your file; the failed one is called out.
    expect(count(html, '>Size<')).toBe(1)
    expect(group('ocr pocketrag-answer.abhiram-dev.workers.dev')).toContain('2 kB')
    expect(group('ocr pocketrag-answer.abhiram-dev.workers.dev')).toContain('1 failed')
  })

  it('says so when nothing has left the browser yet', () => {
    const html = renderToStaticMarkup(createElement(receipts.SessionReceipts))
    expect(html).toContain('Nothing yet')
    expect(html).toContain('Nothing has left your browser this session yet.')
  })
})
