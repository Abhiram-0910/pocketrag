import { describe, expect, it } from 'vitest'
import {
  SENT_HISTORY_TURNS,
  buildRetrievalQuery,
  childrenOf,
  docLabelsFor,
  historyForRequest,
  latestLeafUnder,
  pathTo,
  previousQuestionFor,
  siblingPosition,
} from './conversation'
import { makeTurn } from './historyFixtures'

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

// root ── a ── b
//      └─ a2 (edit of a, newer) ── c
const root = makeTurn({ id: 'root', parentId: null, createdAt: 1, question: 'Q0' })
const a = makeTurn({ id: 'a', parentId: 'root', createdAt: 2, question: 'Q1' })
const b = makeTurn({ id: 'b', parentId: 'a', createdAt: 3, question: 'Q2' })
const a2 = makeTurn({ id: 'a2', parentId: 'root', createdAt: 4, question: 'Q1 edited' })
const c = makeTurn({ id: 'c', parentId: 'a2', createdAt: 5, question: 'Q3' })
const tree = [c, b, a2, root, a]

describe('conversation tree', () => {
  it('childrenOf returns siblings oldest first, and roots for null', () => {
    expect(childrenOf(tree, 'root').map((t) => t.id)).toEqual(['a', 'a2'])
    expect(childrenOf(tree, null).map((t) => t.id)).toEqual(['root'])
    expect(childrenOf(tree, 'b')).toEqual([])
  })

  it('pathTo returns root-to-leaf, and [] for null or an unknown id', () => {
    expect(pathTo(tree, 'b').map((t) => t.id)).toEqual(['root', 'a', 'b'])
    expect(pathTo(tree, 'c').map((t) => t.id)).toEqual(['root', 'a2', 'c'])
    expect(pathTo(tree, null)).toEqual([])
    expect(pathTo(tree, 'missing')).toEqual([])
  })

  it('pathTo terminates on a corrupted parentId cycle', () => {
    const x = makeTurn({ id: 'x', parentId: 'y' })
    const y = makeTurn({ id: 'y', parentId: 'x' })
    expect(pathTo([x, y], 'x')).toHaveLength(2)
  })

  it('an edit (or regenerate) is a new sibling under the same parent, leaving the old branch intact', () => {
    expect(a2.parentId).toBe(a.parentId)
    expect(pathTo(tree, 'b').map((t) => t.question)).toEqual(['Q0', 'Q1', 'Q2'])
  })

  it('latestLeafUnder follows the newest child each step', () => {
    expect(latestLeafUnder(tree, 'root')).toBe('c')
    expect(latestLeafUnder(tree, 'a')).toBe('b')
    expect(latestLeafUnder(tree, 'b')).toBe('b')
  })

  it('historyForRequest sends the last answered turns only, skipping failed and grounded ones', () => {
    const path = [
      makeTurn({ question: 'q1', answer: 'a1' }),
      makeTurn({ question: 'q2', status: 'failed', answer: null }),
      makeTurn({ question: 'q3', answer: null, webGrounded: true }),
      makeTurn({ question: 'q4', answer: 'a4' }),
      makeTurn({ question: 'q5', answer: 'a5' }),
      makeTurn({ question: 'q6', answer: 'a6' }),
    ]
    expect(historyForRequest(path)).toEqual([
      { question: 'q4', answer: 'a4' },
      { question: 'q5', answer: 'a5' },
      { question: 'q6', answer: 'a6' },
    ])
    expect(SENT_HISTORY_TURNS).toBe(3)
  })

  it("historyForRequest excludes a grounded turn even when its text is still in the turn (this session's copy)", () => {
    const path = [makeTurn({ question: 'q1', answer: 'grounded text', webGrounded: true })]
    expect(historyForRequest(path)).toEqual([])
  })

  it('previousQuestionFor and docLabelsFor use the nearest answered ancestor', () => {
    const path = [
      makeTurn({ question: 'q1', docLabels: [{ label: 1, documentId: 'doc-a' }] }),
      makeTurn({ question: 'q2', status: 'failed', answer: null, docLabels: [] }),
    ]
    expect(previousQuestionFor(path)).toBe('q1')
    expect(docLabelsFor(path)).toEqual([{ label: 1, documentId: 'doc-a' }])
    expect(previousQuestionFor([])).toBeNull()
    expect(docLabelsFor([])).toEqual([])
  })
})

describe('branching (v1.2): siblings, active path, history', () => {
  // q1 → a (original answer) → q3; b is a regenerated answer to q1 (same parent as a);
  // c is an edited q1 (different question, same parent).
  const q1 = makeTurn({ id: 'q1', parentId: null, createdAt: 1 })
  const a = makeTurn({ id: 'a', parentId: 'q1', createdAt: 2, question: 'Q2', answer: 'A-original' })
  const q3 = makeTurn({ id: 'q3', parentId: 'a', createdAt: 3, question: 'Q3', answer: 'A3' })
  const b = makeTurn({ id: 'b', parentId: 'q1', createdAt: 4, question: 'Q2', answer: 'A-regenerated' })
  const c = makeTurn({ id: 'c', parentId: 'q1', createdAt: 5, question: 'Q2 edited', answer: 'A-edited' })
  const turns = [q1, a, q3, b, c]

  it('places a turn among its siblings, oldest first, with neighbours for the navigator', () => {
    expect(siblingPosition(turns, a)).toMatchObject({ index: 0, count: 3, prev: null, next: { id: 'b' } })
    expect(siblingPosition(turns, b)).toMatchObject({ index: 1, count: 3, prev: { id: 'a' }, next: { id: 'c' } })
    expect(siblingPosition(turns, c)).toMatchObject({ index: 2, count: 3, next: null })
    expect(siblingPosition(turns, q1)).toMatchObject({ index: 0, count: 1, prev: null, next: null })
  })

  it("switching to a branch opens its newest leaf, and only that path's turns become history", () => {
    expect(latestLeafUnder(turns, 'a')).toBe('q3')
    expect(latestLeafUnder(turns, 'b')).toBe('b')
    // Asking under c: history is q1 and c only — never the sibling branches a/b/q3.
    expect(historyForRequest(pathTo(turns, 'c')).map((t) => t.answer)).toEqual([q1.answer, 'A-edited'])
    expect(historyForRequest(pathTo(turns, 'q3')).map((t) => t.answer)).toEqual([q1.answer, 'A-original', 'A3'])
  })
})

