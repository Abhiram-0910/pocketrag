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
})
