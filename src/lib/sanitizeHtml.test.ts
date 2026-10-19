// @vitest-environment jsdom
import DOMPurify from 'dompurify'
import { describe, expect, it, vi } from 'vitest'
import { sanitizeGroundingHtml } from './sanitizeHtml'

describe('sanitizeGroundingHtml', () => {
  it('strips a script tag', () => {
    const out = sanitizeGroundingHtml('<div>hi</div><script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('alert')
  })

  it('strips an onerror-style event handler attribute', () => {
    const out = sanitizeGroundingHtml('<img src="x" onerror="alert(1)">')
    expect(out).not.toContain('onerror')
  })

  it('strips a javascript: URI', () => {
    const out = sanitizeGroundingHtml('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain('javascript:')
  })

  it('preserves benign structural and style content the widget actually needs', () => {
    const widget =
      '<div class="chip"><style>.chip{color:blue}@media(prefers-color-scheme:dark){.chip{color:white}}</style>' +
      '<a href="https://google.com/search?q=test">Search suggestion</a></div>'
    const out = sanitizeGroundingHtml(widget)
    expect(out).toContain('<style>')
    expect(out).toContain('prefers-color-scheme')
    expect(out).toContain('href="https://google.com/search?q=test"')
    expect(out).toContain('Search suggestion')
  })

  it('sanitizes a given input once and returns the cached result on re-render', () => {
    const spy = vi.spyOn(DOMPurify, 'sanitize')
    const html = '<div class="memo-check"><a href="https://google.com/search?q=memo">memo</a></div>'
    const first = sanitizeGroundingHtml(html)
    const second = sanitizeGroundingHtml(html)
    expect(second).toBe(first)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})
