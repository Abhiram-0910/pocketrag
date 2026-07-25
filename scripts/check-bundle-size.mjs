#!/usr/bin/env node
// Fails the build loudly if a dist/ asset approaches Cloudflare Pages' hard 25 MiB
// per-file limit — the alternative is a transitive dependency (onnxruntime-web's
// WASM binary, currently ~22.5 MiB) silently growing past it and only being
// discovered at deploy time.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url))
const MIB = 1024 * 1024
const PAGES_HARD_LIMIT_BYTES = 25 * MIB
const GUARD_THRESHOLD_BYTES = 24 * MIB

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path))
    else files.push(path)
  }
  return files
}

const files = walk(DIST_DIR)
let failed = false

for (const file of files) {
  const { size } = statSync(file)
  if (size > GUARD_THRESHOLD_BYTES) {
    failed = true
    console.error(
      `✘ ${file.replace(DIST_DIR, 'dist')} is ${(size / MIB).toFixed(2)} MiB — over the ` +
        `${(GUARD_THRESHOLD_BYTES / MIB).toFixed(0)} MiB build guard ` +
        `(Cloudflare Pages' hard limit is ${(PAGES_HARD_LIMIT_BYTES / MIB).toFixed(0)} MiB per file).`,
    )
  }
}

if (failed) {
  console.error('\nBuild guard failed: an asset is approaching the Pages per-file size limit.')
  process.exit(1)
}

console.log('✓ All dist/ assets are within the Cloudflare Pages size guard.')
