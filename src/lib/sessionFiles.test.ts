import { describe, expect, it } from 'vitest'
import { forgetSessionFile, getSessionFile, rememberSessionFile, sessionFilesVersion, subscribeSessionFiles } from './sessionFiles'

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

  it('notifies subscribers and bumps the version on add and remove (v1.4)', () => {
    let calls = 0
    const unsubscribe = subscribeSessionFiles(() => calls++)
    const before = sessionFilesVersion()
    rememberSessionFile('doc-c', makeFile('c.pdf'))
    forgetSessionFile('doc-c')
    forgetSessionFile('doc-c') // nothing to remove: no change
    unsubscribe()
    rememberSessionFile('doc-d', makeFile('d.pdf'))
    expect(calls).toBe(2)
    expect(sessionFilesVersion()).toBe(before + 3)
  })
})
