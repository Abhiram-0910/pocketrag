import { describe, expect, it } from 'vitest'
import { buildLadder, INITIAL_PICKER, isValidModelId, OPENROUTER_AUTO, pickerReducer, type PickerAction, type PickerState } from './modelLadder'
import type { ModelInfo, Provider } from './models'

const ids = (...list: string[]): ModelInfo[] => list.map((id) => ({ id, displayName: id }))

// Realistic /models outputs (after the Worker's own filtering), junk included: non-chat
// models, previews, dated snapshots, floating aliases, fine-tunes, other families.
const GEMINI = ids(
  'gemini-2.0-flash', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'gemini-2.0-flash-lite-001',
  'gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite',
  'gemini-2.5-flash-preview-09-2025', 'gemini-2.5-flash-lite-preview-09-2025',
  'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts',
  'gemini-3-pro-preview', 'gemini-3-pro-image-preview', 'gemini-4-pro-preview',
  'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-pro',
  'gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-pro-latest',
  'gemini-2.5-computer-use-preview-10-2025', 'gemini-robotics-er-1.5-preview', 'gemini-2.0-flash-exp',
  'gemini-2.0-flash-thinking-exp-01-21', 'gemini-live-2.5-flash-preview', 'gemini-2.5-flash-native-audio-latest',
  'gemini-embedding-001', 'aqa', 'veo-3.0-generate-001', 'imagen-4.0-generate-001', 'gemma-3-27b-it',
  'learnlm-2.0-flash-experimental', 'gemini-exp-1206', 'nano-banana-pro-preview',
)
const ANTHROPIC: ModelInfo[] = [
  ['claude-opus-5-5', 'Claude Opus 5.5'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5'], ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  ['claude-fable-5-1', 'Claude Fable 5.1'], ['claude-opus-4-6', 'Claude Opus 4.6'], ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
  ['claude-opus-4-5-20251101', 'Claude Opus 4.5'], ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
  ['claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5'], ['claude-sonnet-4-5', 'Claude Sonnet 4.5'],
  ['claude-opus-4-1-20250805', 'Claude Opus 4.1'], ['claude-opus-4-20250514', 'Claude Opus 4'],
  ['claude-sonnet-4-20250514', 'Claude Sonnet 4'], ['claude-3-7-sonnet-20250219', 'Claude Sonnet 3.7'],
  ['claude-3-5-haiku-20241022', 'Claude Haiku 3.5'], ['claude-3-5-sonnet-latest', 'Claude Sonnet 3.5'],
  ['claude-3-haiku-20240307', 'Claude Haiku 3'],
].map(([id, displayName]) => ({ id, displayName }))
const OPENAI = ids(
  'gpt-4o', 'gpt-4o-2024-08-06', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
  'gpt-4.1-2025-04-14', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5-2025-08-07', 'gpt-5-mini-2025-08-07',
  'gpt-5-chat-latest', 'gpt-5.1', 'gpt-5.1-chat-latest', 'gpt-5.1-codex-mini', 'gpt-4o-search-preview',
  'gpt-4o-mini-search-preview', 'gpt-3.5-turbo', 'gpt-3.5-turbo-16k', 'gpt-4-turbo', 'gpt-4-0613', 'gpt-4',
  'gpt-4.5-preview', 'gpt-5-search-api', 'o1', 'o3', 'o3-mini', 'o4-mini', 'chatgpt-4o-latest', 'gpt-oss-120b',
  'codex-mini-latest', 'ft:gpt-4o-mini-2024-07-18:acme::abc123', 'gpt-5.2-preview',
)
const GROK = ids(
  'grok-4', 'grok-4-0709', 'grok-4-latest', 'grok-3', 'grok-3-latest', 'grok-3-mini', 'grok-3-mini-latest',
  'grok-3-mini-fast', 'grok-3-fast', 'grok-4-fast-reasoning', 'grok-4-fast-non-reasoning', 'grok-4-1-fast-reasoning',
  'grok-code-fast-1', 'grok-2-image-1212', 'grok-2-vision-1212', 'grok-2-1212',
)

const CASES: { provider: Provider; list: ModelInfo[]; rungs: string[]; recommended: string; excluded: string[] }[] = [
  {
    provider: 'gemini',
    list: GEMINI,
    rungs: ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.5-pro'],
    recommended: 'gemini-3.5-flash',
    excluded: ['gemini-4-pro-preview', 'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-live-2.5-flash-preview',
      'gemini-2.5-flash-native-audio-latest', 'gemini-robotics-er-1.5-preview', 'aqa', 'gemini-embedding-001', 'veo-3.0-generate-001',
      'gemini-2.5-computer-use-preview-10-2025', 'gemini-flash-latest'],
  },
  {
    provider: 'anthropic',
    list: ANTHROPIC,
    rungs: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    recommended: 'claude-sonnet-5-5',
    excluded: ['claude-fable-5-1', 'claude-sonnet-4-5-20250929'],
  },
  {
    provider: 'openai',
    list: OPENAI,
    rungs: ['gpt-5-nano', 'gpt-5-mini', 'gpt-5.1'],
    recommended: 'gpt-5-mini',
    excluded: ['gpt-5.1-codex-mini', 'gpt-5.1-chat-latest', 'gpt-5.2-preview', 'o3', 'o4-mini', 'gpt-4o-mini-search-preview',
      'gpt-5-search-api', 'ft:gpt-4o-mini-2024-07-18:acme::abc123'],
  },
  {
    provider: 'grok',
    list: GROK,
    rungs: ['grok-3-mini', 'grok-4'],
    recommended: 'grok-3-mini',
    excluded: ['grok-4-1-fast-reasoning', 'grok-2-image-1212', 'grok-2-vision-1212', 'grok-code-fast-1', 'grok-4-latest'],
  },
]

const shuffled = <T,>(a: T[], seed: number): T[] => {
  const out = [...a]
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 9301 + 49297) % 233280
    const j = Math.floor((seed / 233280) * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const TIER_ORDER = ['Light', 'Balanced', 'Large']

describe.each(CASES)('buildLadder — $provider', ({ provider, list, rungs, recommended, excluded }) => {
  const ladder = buildLadder(provider, list)

  it('builds the expected rungs, low → high, and recommends the balanced tier', () => {
    expect(ladder.rungs.map((r) => r.id)).toEqual(rungs)
    expect(ladder.rungs[ladder.recommendedIndex].id).toBe(recommended)
    expect(ladder.rungs[ladder.recommendedIndex].tier).toBe('Balanced')
    expect(ladder.routerChooses).toBe(false)
  })

  it('is monotonic: one rung per tier, tiers strictly rising', () => {
    const order = ladder.rungs.map((r) => TIER_ORDER.indexOf(r.tier!))
    expect(order.every((t, i) => t >= 0 && (i === 0 || t > order[i - 1]))).toBe(true)
  })

  it('never chooses an excluded id', () => {
    for (const id of excluded) expect(ladder.rungs.map((r) => r.id)).not.toContain(id)
  })

  it('is deterministic regardless of list order', () => {
    for (const seed of [1, 7, 42, 1234]) expect(buildLadder(provider, shuffled(list, seed))).toEqual(ladder)
  })

  it('keeps the provider display name', () => {
    for (const r of ladder.rungs) expect(r.displayName).toBe(list.find((m) => m.id === r.id)!.displayName)
  })
})

describe('buildLadder — a NEW newer-version model in a known family is picked with no code change', () => {
  it.each<[Provider, ModelInfo[], string, number]>([
    ['gemini', [...GEMINI, ...ids('gemini-4-flash')], 'gemini-4-flash', 1],
    ['anthropic', [...ANTHROPIC, ...ids('claude-sonnet-6')], 'claude-sonnet-6', 1],
    ['anthropic', [...ANTHROPIC, ...ids('claude-opus-5-7-20270101')], 'claude-opus-5-7-20270101', 2],
    ['openai', [...OPENAI, ...ids('gpt-6-mini')], 'gpt-6-mini', 1],
    ['grok', [...GROK, ...ids('grok-5')], 'grok-5', 1],
  ])('%s: %s', (provider, list, id, index) => {
    expect(buildLadder(provider, list).rungs[index].id).toBe(id)
  })
})

describe('buildLadder — rules', () => {
  it('prefers stable over preview, but uses a preview when a tier has nothing else', () => {
    expect(buildLadder('gemini', ids('gemini-3.5-pro', 'gemini-4-pro-preview')).rungs.map((r) => r.id)).toEqual(['gemini-3.5-pro'])
    expect(buildLadder('gemini', ids('gemini-4-pro-preview')).rungs.map((r) => r.id)).toEqual(['gemini-4-pro-preview'])
  })

  it('prefers the undated alias over a dated snapshot of the same version', () => {
    expect(buildLadder('anthropic', ids('claude-sonnet-4-5-20250929', 'claude-sonnet-4-5')).rungs[0].id).toBe('claude-sonnet-4-5')
    expect(buildLadder('gemini', ids('gemini-2.0-flash-001', 'gemini-2.0-flash')).rungs[0].id).toBe('gemini-2.0-flash')
    expect(buildLadder('openai', ids('gpt-4o-2024-08-06', 'gpt-4o')).rungs[0].id).toBe('gpt-4o')
  })

  it('only dated snapshots → the newest one', () => {
    expect(buildLadder('anthropic', ids('claude-opus-4-20250514', 'claude-opus-4-20250101')).rungs[0].id).toBe('claude-opus-4-20250514')
  })

  it('without the balanced tier, recommends the nearest tier below it, else the lowest', () => {
    const lowAndHigh = buildLadder('anthropic', ids('claude-haiku-5-5', 'claude-opus-5-5'))
    expect(lowAndHigh.rungs[lowAndHigh.recommendedIndex].id).toBe('claude-haiku-5-5')
    const highOnly = buildLadder('anthropic', ids('claude-opus-5-5'))
    expect(highOnly.recommendedIndex).toBe(0)
  })

  it('junk only → no rungs (manual entry)', () => {
    expect(buildLadder('gemini', ids('gemini-embedding-001', 'gemini-2.5-flash-image', 'aqa'))).toEqual({
      rungs: [],
      recommendedIndex: -1,
      routerChooses: false,
    })
    expect(buildLadder('openai', [])).toMatchObject({ rungs: [], recommendedIndex: -1 })
  })

  it('OpenRouter: one router rung, whatever the catalog holds', () => {
    const ladder = buildLadder('openrouter', ids('openai/gpt-4o-mini', 'anthropic/claude-sonnet-4-5'))
    expect(ladder).toEqual({ rungs: [{ id: OPENROUTER_AUTO, displayName: OPENROUTER_AUTO, tier: null }], recommendedIndex: 0, routerChooses: true })
  })
})

describe('isValidModelId (mirrors the Worker pattern)', () => {
  it.each<[Provider, string, boolean]>([
    ['gemini', 'gemini-3.5-flash', true],
    ['gemini', 'models/gemini-3.5-flash', false],
    ['openrouter', 'openai/gpt-4o:free', true],
    ['openrouter', '~openai/gpt-mini-latest', true],
    ['openai', 'gpt..5', false],
    ['openai', 'gpt 5', false],
    ['openai', '', false],
    ['anthropic', 'x'.repeat(129), false],
  ])('%s %s → %s', (provider, id, ok) => expect(isValidModelId(provider, id)).toBe(ok))
})

describe('pickerReducer', () => {
  const ladder = buildLadder('anthropic', ANTHROPIC) // haiku, sonnet (recommended), opus
  const run = (...actions: PickerAction[]): PickerState => actions.reduce(pickerReducer, INITIAL_PICKER)
  const loaded: PickerAction = { type: 'loaded', ladder }

  it('proposes the recommended rung, unconfirmed', () => {
    expect(run(loaded)).toMatchObject({ index: 1, confirmed: null, manualOpen: false })
  })

  it('propose → higher → lower → confirm', () => {
    const s = run(loaded, { type: 'higher' }, { type: 'lower' }, { type: 'confirm' })
    expect(s.confirmed).toBe('claude-sonnet-5-5')
  })

  it('each step needs confirming again', () => {
    expect(run(loaded, { type: 'confirm' }, { type: 'change' }, { type: 'higher' }).confirmed).toBeNull()
  })

  it('stops at both ends', () => {
    expect(run(loaded, { type: 'higher' }, { type: 'higher' }, { type: 'higher' }).index).toBe(2)
    expect(run(loaded, { type: 'lower' }, { type: 'lower' }, { type: 'lower' }).index).toBe(0)
  })

  it('model rejected → proposes the next LOWER rung, unconfirmed, naming the rejected model', () => {
    const s = run(loaded, { type: 'confirm' }, { type: 'model-rejected' })
    expect(s).toMatchObject({ index: 0, confirmed: null, rejected: 'claude-sonnet-5-5', manualOpen: false })
    expect(pickerReducer(s, { type: 'confirm' }).confirmed).toBe('claude-haiku-5-5')
  })

  it('model rejected at the lowest rung, or a manual model → manual entry', () => {
    expect(run(loaded, { type: 'lower' }, { type: 'confirm' }, { type: 'model-rejected' })).toMatchObject({ manualOpen: true, confirmed: null })
    expect(run(loaded, { type: 'confirm-manual', id: 'my-model' }, { type: 'model-rejected' })).toMatchObject({ manualOpen: true, rejected: 'my-model' })
  })

  it('OpenRouter router rung rejected → manual entry', () => {
    const s = run({ type: 'loaded', ladder: buildLadder('openrouter', []) }, { type: 'confirm' }, { type: 'model-rejected' })
    expect(s).toMatchObject({ manualOpen: true, confirmed: null, rejected: OPENROUTER_AUTO })
  })

  it('no rungs → manual entry open from the start', () => {
    expect(run({ type: 'loaded', ladder: buildLadder('gemini', []) })).toMatchObject({ manualOpen: true, index: -1 })
    expect(run({ type: 'loaded', ladder: buildLadder('gemini', []) }, { type: 'confirm' }).confirmed).toBeNull()
  })

  it('reset clears everything', () => {
    expect(run(loaded, { type: 'confirm' }, { type: 'reset' })).toEqual(INITIAL_PICKER)
  })
})
