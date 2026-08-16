import { describe, expect, it } from 'vitest'
import { isDiagramLikely } from './diagramHeuristic'

describe('isDiagramLikely', () => {
  it('flags a chunk whose page has a raster image, regardless of text', () => {
    expect(isDiagramLikely({ text: 'Plain prose with no keywords.', hasImage: true })).toBe(true)
  })

  it('does not flag a chunk with no image and no keyword', () => {
    expect(isDiagramLikely({ text: 'Plain prose with no keywords.', hasImage: false })).toBe(false)
  })

  it.each(['Figure', 'figures', 'Fig.', 'diagram', 'Diagrams', 'chart', 'graph', 'Table', 'illustration'])(
    'flags a keyword match on its own: %s',
    (keyword) => {
      expect(isDiagramLikely({ text: `See ${keyword} 3 for details.`, hasImage: false })).toBe(true)
    },
  )

  it('does not flag a keyword as a mid-word substring', () => {
    expect(isDiagramLikely({ text: 'The configuration prefigures a change.', hasImage: false })).toBe(false)
  })

  it('matches the "Fig." abbreviation even though it ends in punctuation', () => {
    expect(isDiagramLikely({ text: 'As shown in Fig. 2, the trend reverses.', hasImage: false })).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isDiagramLikely({ text: 'DIAGRAM below.', hasImage: false })).toBe(true)
  })
})
