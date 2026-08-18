import { describe, expect, it } from 'vitest'
import { forgetSessionFile, getSessionFile, rememberSessionFile } from './sessionFiles'

function makeFile(name: string): File {
  return new File(['pdf bytes'], name, { type: 'application/pdf' })
}

describe('sessionFiles', () => {
  it('returns undefined for a document never remembered', () => {
    expect(getSessionFile('never-seen')).toBeUndefined()
  })

  it('returns the exact File instance that was remembered', () => {
    const file = makeFile('a.pdf')
    rememberSessionFile('doc-a', file)
    expect(getSessionFile('doc-a')).toBe(file)
  })

  it('forgetting removes the entry', () => {
    rememberSessionFile('doc-b', makeFile('b.pdf'))
    forgetSessionFile('doc-b')
    expect(getSessionFile('doc-b')).toBeUndefined()
  })
})
