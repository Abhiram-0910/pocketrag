import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GROUNDED_TEXT, NOT_RETAINED_TEXT, UNGROUNDED_TEXT } from '../lib/answerCopy'
import { makeTurn } from '../lib/historyFixtures'
import { TurnAnswer } from './TurnAnswer'

const render = (props: Parameters<typeof TurnAnswer>[0]) => renderToStaticMarkup(createElement(TurnAnswer, props))

describe('TurnAnswer', () => {
  it('shows the grounding banner with a retained answer', () => {
    const html = render({ turn: makeTurn(), text: 'Gluten.' })
    expect(html).toContain(GROUNDED_TEXT)
    expect(html).toContain('Gluten.')
    expect(html).not.toContain(NOT_RETAINED_TEXT)
    expect(render({ turn: makeTurn({ groundingWarning: true }), text: 'Gluten.' })).toContain(UNGROUNDED_TEXT)
  })

  it('shows only the not-retained text, no grounding banner, when the answer was not kept', () => {
    for (const groundingWarning of [false, true]) {
      const html = render({ turn: makeTurn({ groundingWarning, webGrounded: true }), text: null })
      expect(html).toContain(NOT_RETAINED_TEXT)
      expect(html).not.toContain(GROUNDED_TEXT)
      expect(html).not.toContain(UNGROUNDED_TEXT)
      expect(html).not.toContain('role="status"')
    }
  })
})

describe('TurnAnswer citations (v1.4)', () => {
  const turn = makeTurn({ docLabels: [{ label: 1, documentId: 'd1' }] })
  const text = 'ATP is made in mitochondria (Doc 1, page 2) and also (Doc 3, page 1).'

  it('makes each citation of a known document a dialog button, keeping the text intact', () => {
    const html = render({ turn, text, onCite: () => {} })
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('>Doc 1, page 2</button>')
    // Doc 3 isn't one of the turn's documents: plain text, no button.
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html.replace(/<[^>]+>/g, '')).toContain(text)
  })

  it('renders plain text without onCite', () => {
    expect(render({ turn, text })).not.toContain('<button')
  })
})
