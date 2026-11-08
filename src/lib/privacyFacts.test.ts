import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PrivacyPage } from '../components/PrivacyPage'
import { ALLOWED_DESTINATIONS } from './allowedDestinations'
import { PROVIDERS, PROVIDER_HOSTS } from './models'
import { LOCAL_STORAGE_KEYS, REGION_RESTRICTED_COUNTRIES } from './privacyFacts'
import { SUPPORTED_PROVIDERS } from '../../worker/src/validate'
import { checkRateLimit, type KVLike } from '../../worker/src/rateLimit'
import { BREAKER_KEY, MAX_BREAKER_TTL_SECONDS, tripBreaker } from '../../worker/src/breaker'
import {
  buildDiscordPayload,
  DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS,
  DISCORD_SUPPRESS_WINDOW_SECONDS,
  shouldNotify,
} from '../../worker/src/discord'
import { isDiagramLikely } from './diagramHeuristic'

// The privacy page states these lists as facts; each test fails if the code changes under it.

const root = join(__dirname, '..')
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}
const sources = sourceFiles(root).map((path) => ({ path, text: readFileSync(path, 'utf8') }))
const page = renderToStaticMarkup(createElement(PrivacyPage))
const workerSrc = join(root, '../worker/src')
const workerFile = (name: string) => readFileSync(join(workerSrc, name), 'utf8')

// Records every put, so a test can read the exact KV key and TTL the Worker writes.
function recordingKv() {
  const puts: { key: string; ttl?: number }[] = []
  const kv: KVLike = {
    get: async () => null,
    put: async (key, _value, options) => void puts.push({ key, ttl: options?.expirationTtl }),
  }
  return { kv, puts }
}

describe('privacy page facts', () => {
  it('lists exactly the localStorage keys the app writes', () => {
    const written = new Set<string>()
    for (const { path, text } of sources) {
      if (path.endsWith('privacyFacts.ts') || !text.includes('localStorage')) continue
      for (const m of text.matchAll(/'(pocketrag:[a-z0-9-]+)'/g)) written.add(m[1])
    }
    expect([...written].sort()).toEqual(LOCAL_STORAGE_KEYS.map((k) => k.key).sort())
    for (const { key } of LOCAL_STORAGE_KEYS) expect(page).toContain(key)
  })

  it('"no cookies" holds: nothing in src/ touches document.cookie or sessionStorage', () => {
    for (const { path, text } of sources) {
      expect(text, path).not.toMatch(/document\.cookie|sessionStorage/)
    }
  })

  it("matches the Worker's region-restriction country set", () => {
    const worker = readFileSync(join(root, '../worker/src/region.ts'), 'utf8')
    const block = /new Set\(\[([\s\S]*?)\]\)/.exec(worker)![1]
    const codes = [...block.matchAll(/'([A-Z]{2})'/g)].map((m) => m[1])
    expect([...REGION_RESTRICTED_COUNTRIES].sort()).toEqual(codes.sort())
    const names = new Intl.DisplayNames(['en'], { type: 'region' })
    for (const c of codes) expect(page).toContain(names.of(c))
  })

  it('shows every allowed destination', () => {
    for (const d of ALLOWED_DESTINATIONS) expect(page).toContain(d.source)
  })

  it("shows every provider and its host, matching the Worker's provider list", () => {
    expect([...PROVIDERS]).toEqual([...SUPPORTED_PROVIDERS])
    for (const p of PROVIDERS) expect(page).toContain(PROVIDER_HOSTS[p])
  })

  it('names the operator and contact without inventing an email', () => {
    expect(page).toContain('GitHub: Abhiram-0910')
    expect(page).toContain('https://github.com/Abhiram-0910/pocketrag/issues')
    expect(page).not.toMatch(/mailto:|[\w.+-]+@[a-z][\w-]*\.[a-z]{2,}\b/i)
    expect(page).toContain('A plain-language description, not legal advice.')
  })

  it('rate-limit counters: raw IP in the key, 24-hour TTL', async () => {
    const { kv, puts } = recordingKv()
    await checkRateLimit(kv, '203.0.113.7', 'shared')
    expect(puts).toHaveLength(1)
    expect(puts[0].key).toMatch(/^ratelimit:shared:203\.0\.113\.7:\d{4}-\d{2}-\d{2}$/)
    expect(puts[0].ttl).toBe(24 * 60 * 60)
    // The IP comes straight from the header, and nothing in the Worker hashes anything.
    expect(workerFile('index.ts')).toContain("const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown'")
    for (const name of readdirSync(workerSrc).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      expect(workerFile(name), name).not.toMatch(/crypto\.subtle|createHash/)
    }
    expect(page).toContain('ratelimit:shared:203.0.113.7:')
    expect(page).toContain('not hashed')
    expect(page).toContain('expires 24 hours after it was last updated')
  })

  it('shared-tier pause key and its 2-hour TTL ceiling', async () => {
    const { kv, puts } = recordingKv()
    await tripBreaker(kv, 3600, () => {})
    expect(puts.map((p) => p.key)).toEqual([BREAKER_KEY])
    expect(puts[0].ttl).toBeLessThanOrEqual(MAX_BREAKER_TTL_SECONDS)
    expect(MAX_BREAKER_TTL_SECONDS).toBe(2 * 60 * 60)
    expect(page).toContain(BREAKER_KEY)
    expect(page).toContain('for at most 2 hours')
  })

  it('alert-throttling keys and windows', async () => {
    const { kv, puts } = recordingKv()
    await shouldNotify(kv, 'gemini', 'answer', 'shared')
    expect(puts).toEqual([{ key: 'discord-notify:gemini:answer:shared', ttl: DISCORD_SUPPRESS_WINDOW_SECONDS }])
    expect(DISCORD_SUPPRESS_WINDOW_SECONDS).toBe(10 * 60)
    expect(DISCORD_SHARED_RATE_LIMIT_WINDOW_SECONDS).toBe(6 * 60 * 60)
    expect(page).toContain('discord-notify:gemini:answer:shared')
    expect(page).toMatch(/10\s+minutes, or 6 hours/)
  })

  it('Discord alerts carry exactly the listed fields, no IP or request content', () => {
    const payload = buildDiscordPayload(
      { provider: 'gemini', model: 'm', status: '500', message: 'x', tier: 'shared', code: 'c', providerCode: 'p' },
      '2026-11-08T00:00:00Z',
    ) as { embeds: { fields: { name: string }[] }[] }
    expect(payload.embeds[0].fields.map((f) => f.name)).toEqual(['Provider', 'Model', 'Status', 'Code', 'Provider code', 'Tier', 'Message'])
    expect(workerFile('index.ts')).toContain("message: 'OCR request failed.'")
    expect(page).toContain('OCR request failed.')
  })

  it('Workers Logs records every request (observability on, sampling 1)', () => {
    const wrangler = readFileSync(join(root, '../worker/wrangler.jsonc'), 'utf8')
    expect(wrangler).toMatch(/"observability":\s*\{\s*"enabled":\s*true,\s*"head_sampling_rate":\s*1\s*\}/)
    expect(page).toContain('Workers Logs is turned on for every request')
    expect(page).toContain('at most 7 days')
  })

  it('models and the ONNX runtime both land in Cache Storage "transformers-cache"', () => {
    // transformers.js defaults: Cache API on, WASM runtime cached too, under this name.
    const env = readFileSync(join(root, '../node_modules/@huggingface/transformers/src/env.js'), 'utf8')
    expect(env).toContain("cacheKey: 'transformers-cache'")
    expect(env).toMatch(/useBrowserCache: IS_WEB_CACHE_AVAILABLE,/)
    expect(env).toMatch(/useWasmCache: IS_WEB_CACHE_AVAILABLE/)
    // ...and the embedding worker overrides none of them.
    expect(readFileSync(join(root, 'workers/embedding.worker.ts'), 'utf8')).not.toMatch(/useBrowserCache|useWasmCache|cacheKey/)
    expect(page).toContain('the AI runtime, cached in your')
    expect(page).not.toContain('normal download cache')
  })

  it('the diagram image is triggered by the matched page, not the question', () => {
    expect(isDiagramLikely({ text: 'no keywords here', hasImage: true })).toBe(true)
    expect(isDiagramLikely({ text: 'see the table below', hasImage: false })).toBe(true)
    expect(page).toContain('best-matching passage is added as an image')
    expect(page).not.toContain('when a question is about')
  })
})
