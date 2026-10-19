import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ALLOWED_DESTINATIONS } from './allowedDestinations'

describe('ALLOWED_DESTINATIONS', () => {
  it("is exactly public/_headers' connect-src list", () => {
    const headers = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8')
    const connectSrc = headers.match(/connect-src ([^;]+);/)?.[1].trim().split(/\s+/) ?? []
    expect(connectSrc.length).toBeGreaterThan(0)
    expect(ALLOWED_DESTINATIONS.map((d) => d.source).sort()).toEqual([...connectSrc].sort())
  })
})
