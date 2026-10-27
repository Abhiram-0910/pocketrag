import { describe, expect, it } from 'vitest'
import { classify, classifyPdfError, classifyWebgpuFallback } from './errorTaxonomy'

describe('classify', () => {
  it('classifies a 429 as rate-limit and formats resetAt in the local timezone', () => {
    const result = classify({ message: "You've hit today's request limit.", status: 429, resetAt: '2026-08-12T00:00:00.000Z' })
    expect(result.type).toBe('rate-limit')
    expect(result.severity).toBe('warning')
    expect(result.message).toContain('Resets at')
  })

  it('falls back to the raw message for a 429 with no resetAt', () => {
    const result = classify({ message: 'rate limited', status: 429 })
    expect(result.type).toBe('rate-limit')
    expect(result.message).toBe('rate limited')
  })

  it('classifies a 502 as provider-unavailable', () => {
    const result = classify({ message: "This provider isn't fully supported yet.", status: 502 })
    expect(result.type).toBe('provider-unavailable')
    expect(result.severity).toBe('warning')
    expect(result.message).toBe("This provider isn't fully supported yet.")
  })

  it('never treats a provider rate limit (502) as our own limit, even if the body carried a resetAt', () => {
    const message = 'Your provider account hit its rate limit, quota, or credit balance. Wait a moment or check your plan.'
    const result = classify({ message, status: 502, resetAt: '2026-08-12T00:00:00.000Z' })
    expect(result.type).toBe('provider-unavailable')
    expect(result.message).toBe(message)
    expect(result.message).not.toContain('Resets at')
  })

  it('classifies a 403 (shared tier region refusal) as region-restricted, message as-is', () => {
    const message = "The free shared tier isn't available in your region because of Google's terms. Use your own API key instead."
    expect(classify({ message, status: 403 })).toEqual({ type: 'region-restricted', severity: 'warning', message })
  })

  it('classifies any other Worker status as unknown, preserving the message', () => {
    const result = classify({ message: 'question must be a non-empty string.', status: 400 })
    expect(result.type).toBe('unknown')
    expect(result.severity).toBe('error')
    expect(result.message).toBe('question must be a non-empty string.')
  })

  it('classifies a missing status (no HTTP response at all) as network', () => {
    const result = classify({ message: 'Failed to fetch' })
    expect(result.type).toBe('network')
    expect(result.severity).toBe('error')
  })
})

describe('classifyPdfError', () => {
  it('tags a PDF-extraction failure as corrupt-pdf, error severity', () => {
    const result = classifyPdfError('Invalid PDF structure.')
    expect(result).toEqual({ type: 'corrupt-pdf', severity: 'error', message: 'Invalid PDF structure.' })
  })
})

describe('classifyWebgpuFallback', () => {
  it('classifies wasm-unavailable as info severity, not an error', () => {
    const result = classifyWebgpuFallback('wasm-unavailable', '')
    expect(result.type).toBe('webgpu-unsupported')
    expect(result.severity).toBe('info')
    expect(result.message).toContain("doesn't support WebGPU")
  })

  it('classifies wasm-failed as info severity and includes the runtime detail', () => {
    const result = classifyWebgpuFallback('wasm-failed', 'GPU adapter request denied')
    expect(result.severity).toBe('info')
    expect(result.message).toContain('WebGPU failed at runtime')
    expect(result.message).toContain('GPU adapter request denied')
  })
})
