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
