import { describe, expect, it } from 'vitest'
import { buildRetrievalQuery } from './conversation'

describe('buildRetrievalQuery', () => {
  it('returns the question unchanged when there is no previous question', () => {
    expect(buildRetrievalQuery(null, 'What is the mitochondrion?')).toBe('What is the mitochondrion?')
  })

  it('blends the previous question before the current one', () => {
    expect(buildRetrievalQuery('What is the mitochondrion?', 'What page is that on?')).toBe(
      'What is the mitochondrion? What page is that on?',
    )
  })

  it('handles an empty-string previous question the same as null (falsy, no blend)', () => {
    expect(buildRetrievalQuery('', 'What page is that on?')).toBe('What page is that on?')
  })

  it('handles an empty-string current question', () => {
    expect(buildRetrievalQuery('What is the mitochondrion?', '')).toBe('What is the mitochondrion? ')
  })
})
