/// <reference types="vitest/config" />
import { defaultClientConditions, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // onnxruntime-web's default ("bundle") entry carries a new URL() fallback that makes
  // Vite emit its ~22.5 MiB asyncify wasm into dist/, though transformers.js always loads
  // ORT from jsDelivr instead (src/workers/ortPin.ts). This export condition picks ORT's
  // entry without that fallback, so the unused copy isn't deployed. It changes nothing
  // about where ORT loads from or how it's checked: the jsDelivr files are not
  // integrity-checked either way.
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
