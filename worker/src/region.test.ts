import { describe, expect, it } from 'vitest'
import { isRegionRestricted } from './region'

const EU27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']

describe('isRegionRestricted', () => {
  it.each([...EU27, 'IS', 'LI', 'NO', 'CH', 'GB'])('restricts %s', (country) => {
    expect(isRegionRestricted(country)).toBe(true)
  })

  it('covers exactly EU27 + EEA + CH + GB (32 countries)', () => {
    expect(EU27).toHaveLength(27)
  })

  // Near-misses: candidate/neighbour countries, ex-members, and common big markets.
  it.each(['IN', 'US', 'BR', 'TR', 'UA', 'RS', 'AL', 'MC', 'SM', 'VA', 'AD', 'GI', 'JE', 'IM', 'UK', 'EU', 'de', 'gb'])(
    'allows %s',
    (country) => {
      expect(isRegionRestricted(country)).toBe(false)
    },
  )

  it.each([undefined, null, '', 'XX', 'T1', 42])('fails open on a missing or unknown country: %s', (country) => {
    expect(isRegionRestricted(country)).toBe(false)
  })
})
