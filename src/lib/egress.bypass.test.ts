import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Fails if any app source file makes a network request without going through egress.ts.
// A source scan rather than a lint rule: no-restricted-globals misses globalThis.fetch.
const SRC = join(import.meta.dirname, '..')
const ALLOWED = new Set(['lib/egress.ts'])
const RAW_NETWORK = [
  /\bfetch\s*\(/,
  /\b(?:globalThis|window|self)\s*\.\s*fetch\b/,
  /\bXMLHttpRequest\b/,
  /\bsendBeacon\b/,
  /\bnew\s+WebSocket\b/,
  /\bnew\s+EventSource\b/,
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

// Comments mention fetch() in prose; strip them so only code is checked.
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('egress bypass guard', () => {
  it('no src file makes a raw network call outside src/lib/egress.ts', () => {
    const offenders = sourceFiles(SRC)
      .map((path) => relative(SRC, path).replaceAll('\\', '/'))
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) => {
        const text = code(readFileSync(join(SRC, file), 'utf8'))
        return RAW_NETWORK.filter((pattern) => pattern.test(text)).map((pattern) => `${file}: ${pattern}`)
      })
    expect(offenders).toEqual([])
  })

  it('the embedding worker routes transformers.js downloads through egress.ts', () => {
    const worker = code(readFileSync(join(SRC, 'workers/embedding.worker.ts'), 'utf8'))
    expect(worker).toMatch(/\benv\.fetch\s*=\s*downloadFetch\(/)
  })
})
