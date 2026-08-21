import { beforeEach, describe, expect, it } from 'vitest'
import { getHasVisitedApp, setHasVisitedApp } from './landingVisitSetting'

// Node's vitest environment has no global localStorage — a minimal in-memory stub,
// matching the real Web Storage API surface this module actually calls.
class MemoryStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
}

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage()
})

describe('landingVisitSetting', () => {
  it('defaults to not-visited when nothing has been stored', () => {
    expect(getHasVisitedApp()).toBe(false)
  })

  it('reflects true after being set', () => {
    setHasVisitedApp()
    expect(getHasVisitedApp()).toBe(true)
  })

  it('stays true across repeated reads (one-directional — no un-visit action exists)', () => {
    setHasVisitedApp()
    setHasVisitedApp()
    expect(getHasVisitedApp()).toBe(true)
  })
})
