import { describe, expect, it } from 'vitest'
import { corsHeaders, resolveCorsOrigin } from './cors'

describe('resolveCorsOrigin', () => {
  it('allows localhost:5173 (Vite dev) regardless of production origin', () => {
    expect(resolveCorsOrigin('http://localhost:5173', '')).toBe('http://localhost:5173')
  })

  it('allows the configured production origin', () => {
    expect(resolveCorsOrigin('https://pocketrag.pages.dev', 'https://pocketrag.pages.dev')).toBe(
      'https://pocketrag.pages.dev',
    )
  })

  it('rejects an unrecognized origin', () => {
    expect(resolveCorsOrigin('https://evil.example.com', 'https://pocketrag.pages.dev')).toBeNull()
  })

  it('rejects when there is no Origin header', () => {
    expect(resolveCorsOrigin(null, 'https://pocketrag.pages.dev')).toBeNull()
  })

  it('does not allow the production origin when none is configured yet', () => {
    expect(resolveCorsOrigin('https://pocketrag.pages.dev', '')).toBeNull()
  })
})

describe('corsHeaders', () => {
  it('returns no headers for a null origin', () => {
    expect(corsHeaders(null)).toEqual({})
  })

  it('returns Access-Control headers for an allowed origin', () => {
    const headers = corsHeaders('http://localhost:5173') as Record<string, string>
    expect(headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173')
    expect(headers['Access-Control-Allow-Methods']).toContain('POST')
  })
})
