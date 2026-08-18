import { beforeEach, describe, expect, it } from 'vitest'
import { getDiagramImagesEnabled, setDiagramImagesEnabled } from './diagramImageSetting'

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

describe('diagramImageSetting', () => {
  it('defaults to disabled when nothing has been stored', () => {
    expect(getDiagramImagesEnabled()).toBe(false)
  })

  it('reflects true after being explicitly enabled', () => {
    setDiagramImagesEnabled(true)
    expect(getDiagramImagesEnabled()).toBe(true)
  })

  it('reflects false after being explicitly disabled again', () => {
    setDiagramImagesEnabled(true)
    setDiagramImagesEnabled(false)
    expect(getDiagramImagesEnabled()).toBe(false)
  })
})
