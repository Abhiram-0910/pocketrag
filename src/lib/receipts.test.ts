import { describe, expect, it } from 'vitest'
import type { EgressRecord } from './egress'
import { contentsLabels, destinations, formatBytes, formatDuration, forwardedHost, receiptSummary, statusLabel } from './receipts'

const record = (overrides: Partial<EgressRecord> = {}): EgressRecord => ({
  id: 'r',
  purpose: 'answer',
  host: 'pocketrag-answer.abhiram-dev.workers.dev',
  finalHost: 'pocketrag-answer.abhiram-dev.workers.dev',
  via: 'worker',
  upstream: 'gemini',
  method: 'POST',
  categories: ['question'],
  counts: { question: 1 },
  bytesSent: 3100,
  startedAt: 1,
  durationMs: 1400,
  httpStatus: 200,
  outcome: 'ok',
  ...overrides,
})

describe('receipts', () => {
  it('labels every category in plain language, with singular and plural counts', () => {
    expect(
      contentsLabels({
        categories: ['question', 'passage-text', 'history', 'document-ids', 'page-image', 'api-key'],
        counts: { question: 1, 'passage-text': 3, history: 1, 'document-ids': 2, 'page-image': 1, 'api-key': 1 },
      }),
    ).toEqual([
      'your question',
      '3 passages from your documents',
      '1 earlier question and answer',
      '2 document IDs (random, not file names)',
      '1 page image',
      'your API key',
    ])
    expect(contentsLabels({ categories: ['passage-text', 'history', 'document-ids'], counts: { 'passage-text': 1, history: 3, 'document-ids': 1 } })).toEqual([
      '1 passage from your documents',
      '3 earlier questions and answers',
      '1 document ID (random, not file names)',
    ])
    expect(contentsLabels({ categories: ['ocr-file', 'uncategorized'], counts: { 'ocr-file': 1, uncategorized: 1 } })).toEqual([
      'your whole file (for text extraction)',
      'other data (not labelled)',
    ])
    expect(contentsLabels({ categories: ['none'], counts: {} })).toEqual(['nothing from you (a download)'])
  })

  it('names the forwarded host from the upstream provider, none for a direct download', () => {
    expect(forwardedHost({ upstream: 'gemini' })).toBe('generativelanguage.googleapis.com')
    expect(forwardedHost({ upstream: 'openrouter' })).toBe('openrouter.ai')
    expect(forwardedHost({ upstream: null })).toBeNull()
  })

  it('labels every status', () => {
    expect(statusLabel({ outcome: 'in-flight', httpStatus: null })).toBe('Sending…')
    expect(statusLabel({ outcome: 'ok', httpStatus: 200 })).toBe('OK')
    expect(statusLabel({ outcome: 'http-error', httpStatus: 502 })).toBe('Failed (502)')
    expect(statusLabel({ outcome: 'network-error', httpStatus: null })).toBe('No response (network)')
    expect(statusLabel({ outcome: 'aborted', httpStatus: null })).toBe('Stopped (timed out or cancelled)')
  })

  it('formats sizes in decimal units and durations in ms or s', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1000)).toBe('1 kB')
    expect(formatBytes(14_230)).toBe('14.2 kB')
    expect(formatBytes(1_500_000)).toBe('1.5 MB')
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(1400)).toBe('1.4 s')
    expect(formatDuration(null)).toBe('—')
  })

  it('counts each distinct host once: connected, redirected-to, and forwarded-to', () => {
    const retry = [record({ id: 'a', outcome: 'http-error', httpStatus: 502 }), record({ id: 'b' })]
    expect(destinations(retry)).toEqual(['pocketrag-answer.abhiram-dev.workers.dev', 'generativelanguage.googleapis.com'])
    const download = record({ host: 'huggingface.co', finalHost: 'us.aws.cdn.hf.co', via: 'direct', upstream: null })
    expect(destinations([download])).toEqual(['huggingface.co', 'us.aws.cdn.hf.co'])
  })

  it('summarizes an answer in one line', () => {
    expect(receiptSummary([record({ id: 'a' }), record({ id: 'b', bytesSent: 3100 })])).toBe('2 requests · 2 destinations · 6.2 kB sent')
    expect(receiptSummary([record({ bytesSent: 512 })])).toBe('1 request · 2 destinations · 512 B sent')
    expect(receiptSummary([])).toBe('0 requests · 0 destinations · 0 B sent')
  })
})
