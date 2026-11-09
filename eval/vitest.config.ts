import { defineConfig } from 'vitest/config'

// `npm run eval`: the retrieval harness, kept out of `npm run test` (it downloads models).
export default defineConfig({
  test: {
    root: new URL('..', import.meta.url).pathname,
    include: ['eval/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 60 * 60 * 1000,
    hookTimeout: 60 * 60 * 1000,
  },
})
