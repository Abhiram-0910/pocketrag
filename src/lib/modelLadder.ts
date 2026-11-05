import type { ModelInfo, Provider } from './models'

// Phase 5a: the automatic BYOK model picker. Every ladder rule lives in this file. It never
// names a specific model id: it matches FAMILY patterns and parses version numbers, so a
// newer model in a known family is picked with no code change. Unknown ids are ignored,
// never guessed at. Deterministic: same input list (in any order) → same ladder.

export type Tier = 'Light' | 'Balanced' | 'Large'

export interface Rung {
  id: string
  displayName: string
  tier: Tier | null // null only for OpenRouter's router rung
}

export interface Ladder {
  rungs: Rung[] // sorted low → high
  recommendedIndex: number // -1 when there are no rungs
  // OpenRouter: the router picks the model per question, so Higher/Lower don't apply.
  routerChooses: boolean
}

// The id OpenRouter routes for us. The Worker accepts it (validate.test.ts runs every id in
// fixtures/openrouterModelIds.ts, which includes it, through the model pattern).
export const OPENROUTER_AUTO = 'openrouter/auto'

interface Parsed {
  tier: number // index into the provider's TIERS
  version: number[]
  stable: boolean // not preview/experimental/beta
  aliasRank: number // 0 bare id, 1 floating alias (-latest), 2 dated/numbered snapshot
  date: string // snapshot stamp, '' if none (newest wins among same-version snapshots)
}

interface Family {
  tiers: readonly string[] // low → high
  balanced: number // the default proposal: a sensible pick for short-passage QA, not the top
  parse: (id: string) => Parsed | null
}

const nums = (...parts: (string | undefined)[]) => parts.filter((p) => p !== undefined).map(Number)

// Gemini: gemini-<version>-<flash-lite|flash|pro>[-suffix]. Suffixes are an allow-list, so
// image/TTS/native-audio/live/computer-use/thinking variants (and any new kind) fall out.
// Embedding, AQA (retrieval), Veo/Imagen, robotics, Gemma, LearnLM never match the prefix.
function parseGemini(id: string): Parsed | null {
  const m = /^gemini-(\d+)(?:\.(\d+))?-(flash-lite|flash|pro)(?:-(.+))?$/.exec(id)
  if (!m) return null
  const tier = ['flash-lite', 'flash', 'pro'].indexOf(m[3])
  const suffix = m[4]
  const version = nums(m[1], m[2])
  if (suffix === undefined) return { tier, version, stable: true, aliasRank: 0, date: '' }
  if (/^\d{3}$/.test(suffix)) return { tier, version, stable: true, aliasRank: 2, date: suffix }
  const p = /^(?:preview|exp)(?:-([\d-]+))?$/.exec(suffix)
  if (p) return { tier, version, stable: false, aliasRank: p[1] ? 2 : 0, date: p[1] ?? '' }
  return null
}

// Anthropic: claude-<haiku|sonnet|opus>-<major>[-<minor>][-YYYYMMDD], plus the legacy
// claude-<major>[-<minor>]-<family>[-YYYYMMDD|-latest] order. Other families are ignored.
function parseAnthropic(id: string): Parsed | null {
  const tiers = ['haiku', 'sonnet', 'opus']
  const modern = /^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/.exec(id)
  if (modern) {
    const date = modern[4] ?? ''
    return { tier: tiers.indexOf(modern[1]), version: nums(modern[2], modern[3]), stable: true, aliasRank: date ? 2 : 0, date }
  }
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-(haiku|sonnet|opus)(?:-(\d{8}|latest))?$/.exec(id)
  if (legacy) {
    const s = legacy[4]
    return {
      tier: tiers.indexOf(legacy[3]),
      version: nums(legacy[1], legacy[2]),
      stable: true,
      aliasRank: s === undefined ? 0 : s === 'latest' ? 1 : 2,
      date: s === 'latest' ? '' : (s ?? ''),
    }
  }
  return null
}

// OpenAI: gpt-<version>[o][-mini|-nano][-YYYY-MM-DD|-preview[-date]]. Only gpt-* chat ids:
// the o-series, codex, search, audio, realtime, image, -turbo and -chat-latest ids don't
// match. (The Worker's request is {model, messages} only, which o-series models accept; they
// are left off simply because they sit outside the gpt-* family rule.) The Worker's own
// non-chat denylist still applies first (worker/src/providers/openai.ts).
function parseOpenAI(id: string): Parsed | null {
  const m = /^gpt-(\d+)(?:\.(\d+))?(o)?(?:-(mini|nano))?(?:-(.+))?$/.exec(id)
  if (!m) return null
  const tier = m[4] === 'nano' ? 0 : m[4] === 'mini' ? 1 : 2
  // 4o sits between 4 and 4.1.
  const version = [...nums(m[1], m[2] ?? '0'), m[3] ? 1 : 0]
  const suffix = m[5]
  if (suffix === undefined) return { tier, version, stable: true, aliasRank: 0, date: '' }
  if (/^\d{4}-\d{2}-\d{2}$/.test(suffix)) return { tier, version, stable: true, aliasRank: 2, date: suffix }
  const p = /^preview(?:-(\d{4}-\d{2}-\d{2}))?$/.exec(suffix)
  if (p) return { tier, version, stable: false, aliasRank: p[1] ? 2 : 0, date: p[1] ?? '' }
  return null
}

// Grok: grok-<major>[-.<minor>][-mini][-MMDD|-latest|-beta]. Image, vision, code, fast and
// reasoning/non-reasoning variants don't match.
function parseGrok(id: string): Parsed | null {
  const m = /^grok-(\d+)(?:[.-](\d{1,2}))?(-mini)?(?:-(.+))?$/.exec(id)
  if (!m) return null
  const tier = m[3] ? 0 : 1
  const version = nums(m[1], m[2])
  const suffix = m[4]
  if (suffix === undefined) return { tier, version, stable: true, aliasRank: 0, date: '' }
  if (suffix === 'latest') return { tier, version, stable: true, aliasRank: 1, date: '' }
  if (/^\d{4}$/.test(suffix)) return { tier, version, stable: true, aliasRank: 2, date: suffix }
  if (suffix === 'beta') return { tier, version, stable: false, aliasRank: 0, date: '' }
  return null
}

const FAMILIES: Record<Exclude<Provider, 'openrouter'>, Family> = {
  gemini: { tiers: ['flash-lite', 'flash', 'pro'], balanced: 1, parse: parseGemini },
  anthropic: { tiers: ['haiku', 'sonnet', 'opus'], balanced: 1, parse: parseAnthropic },
  openai: { tiers: ['nano', 'mini', 'base'], balanced: 1, parse: parseOpenAI },
  // Two tiers only; the default stays off the flagship.
  grok: { tiers: ['mini', 'base'], balanced: 0, parse: parseGrok },
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

// Best first: stable, then newest version, then the bare id over -latest over a snapshot,
// then the newest snapshot, then id (so ties never depend on the provider's list order).
function better(a: { p: Parsed; m: ModelInfo }, b: { p: Parsed; m: ModelInfo }): number {
  return (
    Number(b.p.stable) - Number(a.p.stable) ||
    compareVersions(b.p.version, a.p.version) ||
    a.p.aliasRank - b.p.aliasRank ||
    (b.p.date > a.p.date ? 1 : b.p.date < a.p.date ? -1 : 0) ||
    (a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0)
  )
}

function tierLabel(tier: number, family: Family): Tier {
  if (tier === family.balanced) return 'Balanced'
  return tier < family.balanced ? 'Light' : 'Large'
}

/** The rungs a key's model list supports, one per tier (low → high), and the default. */
export function buildLadder(provider: Provider, models: readonly ModelInfo[]): Ladder {
  if (provider === 'openrouter') {
    const listed = models.find((m) => m.id === OPENROUTER_AUTO)
    return {
      rungs: [{ id: OPENROUTER_AUTO, displayName: listed?.displayName ?? OPENROUTER_AUTO, tier: null }],
      recommendedIndex: 0,
      routerChooses: true,
    }
  }
  const family = FAMILIES[provider]
  const best = new Map<number, { p: Parsed; m: ModelInfo }>()
  for (const m of models) {
    const p = family.parse(m.id)
    if (!p) continue
    const cur = best.get(p.tier)
    if (!cur || better({ p, m }, cur) < 0) best.set(p.tier, { p, m })
  }
  const tiers = [...best.keys()].sort((a, b) => a - b)
  const rungs = tiers.map((t) => {
    const { m } = best.get(t)!
    return { id: m.id, displayName: m.displayName, tier: tierLabel(t, family) }
  })
  // The balanced tier if the key has it; otherwise the nearest tier below it, else the lowest.
  let recommendedIndex = -1
  tiers.forEach((t, i) => {
    if (t <= family.balanced) recommendedIndex = i
  })
  if (recommendedIndex === -1 && rungs.length > 0) recommendedIndex = 0
  return { rungs, recommendedIndex, routerChooses: false }
}

// Mirrors worker/src/validate.ts's isValidModel: Gemini puts the id in a URL path, so no
// '/', ':' or '~' there; no '..' anywhere.
export function isValidModelId(provider: Provider, id: string): boolean {
  if (id.includes('..')) return false
  return (provider === 'gemini' ? /^[A-Za-z0-9._-]{1,128}$/ : /^[A-Za-z0-9._:/~-]{1,128}$/).test(id)
}

// ---- Picker state (ByokPanel) ----

export interface PickerState {
  ladder: Ladder | null
  index: number // the rung on offer
  confirmed: string | null // the model in use; the question box stays disabled until set
  manualOpen: boolean
  // Why the picker reopened (a model the provider rejected), shown above the proposal.
  rejected: string | null
}

export const INITIAL_PICKER: PickerState = { ladder: null, index: -1, confirmed: null, manualOpen: false, rejected: null }

export type PickerAction =
  | { type: 'loaded'; ladder: Ladder }
  | { type: 'higher' }
  | { type: 'lower' }
  | { type: 'confirm' }
  | { type: 'confirm-manual'; id: string }
  | { type: 'change' } // "Change": reopen the proposal at the model in use
  | { type: 'toggle-manual'; open: boolean }
  | { type: 'model-rejected' }
  | { type: 'reset' }

export function pickerReducer(s: PickerState, a: PickerAction): PickerState {
  const n = s.ladder?.rungs.length ?? 0
  switch (a.type) {
    case 'loaded':
      // No rung qualifies → straight to manual entry.
      return { ...INITIAL_PICKER, ladder: a.ladder, index: a.ladder.recommendedIndex, manualOpen: a.ladder.rungs.length === 0 }
    case 'higher':
      return s.index < n - 1 ? { ...s, index: s.index + 1, confirmed: null } : s
    case 'lower':
      return s.index > 0 ? { ...s, index: s.index - 1, confirmed: null } : s
    case 'confirm':
      return s.index >= 0 && s.index < n ? { ...s, confirmed: s.ladder!.rungs[s.index].id, rejected: null } : s
    case 'confirm-manual':
      return { ...s, confirmed: a.id, rejected: null }
    case 'change': {
      const at = s.ladder?.rungs.findIndex((r) => r.id === s.confirmed) ?? -1
      return { ...s, confirmed: null, index: at >= 0 ? at : s.index }
    }
    case 'toggle-manual':
      return { ...s, manualOpen: a.open }
    case 'model-rejected': {
      if (s.confirmed === null) return s
      const at = s.ladder?.rungs.findIndex((r) => r.id === s.confirmed) ?? -1
      const stepDown = s.ladder !== null && !s.ladder.routerChooses && at > 0
      return stepDown
        ? { ...s, confirmed: null, rejected: s.confirmed, index: at - 1 }
        : { ...s, confirmed: null, rejected: s.confirmed, manualOpen: true }
    }
    case 'reset':
      return INITIAL_PICKER
  }
}
