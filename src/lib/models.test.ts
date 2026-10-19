import { describe, expect, it } from 'vitest'
import { defaultModelFor, PREFERRED_GEMINI_MODEL, type ModelInfo, type Provider } from './models'

const model = (id: string): ModelInfo => ({ id, displayName: id })
const WITH_PIN = [model('gemini-2.5-flash'), model(PREFERRED_GEMINI_MODEL), model('gemini-3.5-pro')]
const WITHOUT_PIN = [model('gemini-2.5-flash'), model('gemini-3.5-pro')]

describe('defaultModelFor', () => {
  it('auto-selects Gemini\'s pinned model when the fetched list has it, wherever it sits', () => {
    expect(defaultModelFor('gemini', WITH_PIN)).toBe(PREFERRED_GEMINI_MODEL)
  })

  it('leaves Gemini unselected when the pin is missing — never falls back to fetched[0]', () => {
    expect(defaultModelFor('gemini', WITHOUT_PIN)).toBe('')
  })

  it.each<Provider>(['openai', 'anthropic', 'grok', 'openrouter'])('never auto-selects for %s', (provider) => {
    // Even a list that happens to contain the Gemini pin id.
    expect(defaultModelFor(provider, [model('some-model'), ...WITH_PIN])).toBe('')
  })

  it('returns no selection for an empty list', () => {
    expect(defaultModelFor('gemini', [])).toBe('')
  })
})
