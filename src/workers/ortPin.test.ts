import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ORT_CDN_BASE, ORT_FILE_SHA384, ORT_VERSION } from './ortPin'

const root = new URL('../../', import.meta.url)
const ortDir = new URL('node_modules/onnxruntime-web/', root)

describe('pinned ONNX Runtime', () => {
  it('is the installed onnxruntime-web version', () => {
    const { version } = JSON.parse(readFileSync(new URL('package.json', ortDir), 'utf8'))
    expect(ORT_VERSION).toBe(version)
  })

  it.each(Object.keys(ORT_FILE_SHA384))('records the sha384 of the installed %s', (file) => {
    const digest = createHash('sha384').update(readFileSync(new URL(`dist/${file}`, ortDir))).digest('base64')
    expect(ORT_FILE_SHA384[file]).toBe(`sha384-${digest}`)
  })

  it("is the jsDelivr path public/_headers' connect-src allows", () => {
    const headers = readFileSync(new URL('public/_headers', root), 'utf8')
    const connectSrc = headers.match(/connect-src ([^;]+);/)?.[1].split(' ') ?? []
    expect(connectSrc).toContain(ORT_CDN_BASE)
  })
})
